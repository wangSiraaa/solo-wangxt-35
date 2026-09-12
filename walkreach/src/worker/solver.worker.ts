import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { Calendar, ContextData, LngLat, RoadsFC, WaitEvent } from '../lib/types';
import type { SolveReq, SolveTdReq, WorkerReq } from '../lib/workerProtocol';
import { buildNetwork, type BuiltNetwork, type EdgeRec } from '../lib/graphBuild';
import { snapToNetwork } from '../lib/snap';
import { dijkstraFromEdge, evaluateFacility, isochroneFeatures, type FacilityInput } from '../lib/solve';
import {
  arriveOnEdgePoint,
  collectWaits,
  evaluateFacilityTd,
  tdDijkstra,
  tdIsochrone
} from '../lib/solveTd';
import {
  makeWaitFn,
  parseSchedule,
  validateTdData,
  weekdayOfDate,
  type ParsedSchedule,
  type WaitFn
} from '../lib/td';
import { haversineM, pointInPolygonRings, sliceLine } from '../lib/geo';

let net: BuiltNetwork | null = null;
let barrierLines: LngLat[][] = [];
let extentRings: LngLat[][][] = [];
let waitFns: Map<string, WaitFn> = new Map();
let calendar: Calendar = { timezone: '', date: '' };

function polygonRings(fc: FeatureCollection<Polygon | MultiPolygon> | null): LngLat[][][] {
  const out: LngLat[][][] = [];
  if (!fc) return out;
  for (const f of fc.features) {
    if (!f.geometry) continue;
    if (f.geometry.type === 'Polygon') out.push(f.geometry.coordinates as LngLat[][]);
    else if (f.geometry.type === 'MultiPolygon') out.push(...(f.geometry.coordinates as LngLat[][][]));
  }
  return out;
}

function insideExtent(p: LngLat): boolean {
  if (extentRings.length === 0) return true;
  return extentRings.some((rings) => pointInPolygonRings(p, rings));
}

/** 把 path（起点应落在 edge 的某端点）前面接上 fromPoint→该端点的边片段 */
function prependEdge(path: LngLat[], edge: EdgeRec, fraction: number, fromPoint: LngLat): LngLat[] {
  if (path.length === 0) return [fromPoint];
  const A = edge.coords[0]!;
  const B = edge.coords[edge.coords.length - 1]!;
  const start = path[0]!;
  if (haversineM(start, A) < 1) {
    return [fromPoint, ...sliceLine(edge.coords, 0, fraction).reverse(), ...path.slice(1)];
  }
  if (haversineM(start, B) < 1) {
    return [fromPoint, ...sliceLine(edge.coords, fraction, 1), ...path.slice(1)];
  }
  return [fromPoint, ...path];
}

function facilityInputs(facilities: SolveReq['facilities']): FacilityInput[] {
  return facilities.features.map((f) => {
    const coord = f.geometry.coordinates as LngLat;
    const snap = snapToNetwork(coord, net!.edges, barrierLines);
    const best = snap.best;
    return {
      id: String(f.properties?.id ?? ''),
      coord,
      snap: best ? { edgeId: best.edgeId, fraction: best.fraction, distM: best.distM } : null,
      insideExtent: insideExtent(coord)
    };
  });
}

const ctx = self as unknown as Worker;

ctx.onmessage = (ev: MessageEvent<WorkerReq>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      net = buildNetwork(msg.roads as RoadsFC);
      const context = msg.context as ContextData;
      calendar = msg.calendar;
      barrierLines = polygonRings(context.water).flatMap((rings) => rings);
      extentRings = polygonRings(context.boundary);

      // 解析时间表并构建等待函数；同时进行 FIFO 校验
      const schedules = new Map<string, ParsedSchedule>();
      const tdErrors: string[] = [];
      for (const e of net.edges.values()) {
        if (e.scheduleRaw === undefined) continue;
        const { sched, error } = parseSchedule(e.scheduleRaw);
        if (error) tdErrors.push(`${e.name}: ${error}`);
        else if (sched) schedules.set(e.id, sched);
      }
      const wd = weekdayOfDate(calendar.date);
      waitFns = new Map();
      for (const e of net.edges.values()) {
        waitFns.set(e.id, makeWaitFn(schedules.get(e.id) ?? null, wd ?? 0));
      }
      tdErrors.push(...validateTdData(msg.roads as RoadsFC, calendar, net.edges, waitFns, 5 / 3.6));

      ctx.postMessage({
        type: 'loaded',
        req: msg.req,
        stats: net.stats,
        isolatedLines: net.stats.isolatedEdges
          .map((id) => net!.edges.get(id)?.coords)
          .filter((c): c is LngLat[] => !!c),
        tdErrors,
        tdEdges: schedules.size
      });
      return;
    }
    if (!net) throw new Error('路网尚未加载');
    if (msg.type === 'snap') {
      const result = snapToNetwork(msg.point, net.edges, barrierLines);
      ctx.postMessage({ type: 'snapResult', req: msg.req, result });
      return;
    }
    if (msg.type === 'solve') {
      const t0 = performance.now();
      const m = msg as SolveReq;
      const originEdge = net.edges.get(m.origin.edgeId);
      if (!originEdge) throw new Error('起点所在路段已不存在，请重新设置起点');
      const speed = Math.max(0.3, m.speedMps);
      const maxSeconds = m.maxMinutes * 60;
      const dj = dijkstraFromEdge(net, originEdge, m.origin.fraction, speed);
      const bandMinutes = Math.max(1, Math.round(m.maxMinutes / 4));
      const isochrone = isochroneFeatures(net, dj, speed, maxSeconds, { bandMinutes });
      const inputs = facilityInputs(m.facilities);
      const facilities = inputs.map((fi) => evaluateFacility(net!, dj, fi, speed, maxSeconds));
      for (let i = 0; i < facilities.length; i++) {
        const res = facilities[i]!;
        if (!res.path || res.path.length === 0) continue;
        res.path = prependEdge(res.path, originEdge, m.origin.fraction, m.origin.point);
        res.path.push(inputs[i]!.coord);
      }
      ctx.postMessage({
        type: 'solved',
        req: msg.req,
        isochrone,
        facilities,
        solveMs: Math.round(performance.now() - t0)
      });
      return;
    }
    if (msg.type === 'solveTd') {
      const t0 = performance.now();
      const m = msg as SolveTdReq;
      const originEdge = net.edges.get(m.origin.edgeId);
      if (!originEdge) throw new Error('起点所在路段已不存在，请重新设置起点');
      const speed = Math.max(0.3, m.speedMps);
      const budgetAbs = m.departureMin + m.maxMinutes;
      const bandMinutes = Math.max(1, Math.round(m.maxMinutes / 4));

      // 第一段：起点 → （接送点）
      const dj1 = tdDijkstra(net, waitFns, originEdge, m.origin.fraction, m.departureMin, speed);
      const inputs = facilityInputs(m.facilities);

      let dj2: ReturnType<typeof tdDijkstra> | null = null;
      let viaInfo: { arrivalMin: number; departMin: number } | null = null;
      let viaPath: LngLat[] = [];
      let viaWaits: WaitEvent[] = [];
      let viaEdge: EdgeRec | null = null;

      if (m.via) {
        viaEdge = net.edges.get(m.via.choice.edgeId) ?? null;
        if (viaEdge) {
          const hit = arriveOnEdgePoint(net, dj1, waitFns, viaEdge, m.via.choice.fraction, speed);
          if (hit) {
            viaInfo = { arrivalMin: hit.arrive, departMin: hit.arrive + m.via.dwellMin };
            // 第一段路径：起点 → 接送点（作为虚拟设施评估）
            const viaEval = evaluateFacilityTd(
              net,
              dj1,
              waitFns,
              {
                id: '__via__',
                coord: m.via.choice.point,
                snap: { edgeId: viaEdge.id, fraction: m.via.choice.fraction, distM: 0 },
                insideExtent: true
              },
              speed,
              Infinity,
              m.departureMin
            );
            viaPath = prependEdge(viaEval.path ?? [], originEdge, m.origin.fraction, m.origin.point);
            viaPath.push(m.via.choice.point);
            viaWaits = viaEval.waits ?? [];
            // 第二段：从 实际到达 + 停留 后的时刻起算
            dj2 = tdDijkstra(net, waitFns, viaEdge, m.via.choice.fraction, viaInfo.departMin, speed);
          }
        }
      }

      const djF = dj2 ?? dj1;
      const iso1 = tdIsochrone(
        net,
        dj1,
        waitFns,
        speed,
        viaInfo ? Math.min(viaInfo.arrivalMin, budgetAbs) : budgetAbs,
        m.departureMin,
        bandMinutes
      );
      const iso2 = dj2 ? tdIsochrone(net, dj2, waitFns, speed, budgetAbs, m.departureMin, bandMinutes) : null;
      const isoWaits = [...collectWaits(net, dj1), ...(dj2 ? collectWaits(net, dj2) : [])];

      const facilities = inputs.map((fi) => {
        if (m.via && !viaInfo) return { id: fi.id, status: 'via-unreachable' as const };
        const r = evaluateFacilityTd(net!, djF, waitFns, fi, speed, budgetAbs, m.departureMin);
        if (dj2 && viaInfo && viaEdge && r.path) {
          // 拼接：第一段路径 + 接送点停留 + 第二段路径
          const leg2 = prependEdge(r.path, viaEdge, m.via!.choice.fraction, m.via!.choice.point);
          r.path = [...viaPath, ...leg2.slice(1)];
          const dwell: WaitEvent = {
            at: m.via!.choice.point,
            waitMin: m.via!.dwellMin,
            kind: 'dwell',
            label: '接送点停留',
            clockMin: viaInfo.arrivalMin
          };
          r.waits = [...viaWaits, dwell, ...(r.waits ?? [])];
          r.waitMin = +(r.waits.reduce((s, w) => s + w.waitMin, 0)).toFixed(2);
        }
        return r;
      });

      ctx.postMessage({
        type: 'solvedTd',
        req: msg.req,
        iso1,
        iso2,
        isoWaits,
        facilities,
        viaInfo,
        solveMs: Math.round(performance.now() - t0)
      });
      return;
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', req: msg.req, message: err instanceof Error ? err.message : String(err) });
  }
};

export {};
