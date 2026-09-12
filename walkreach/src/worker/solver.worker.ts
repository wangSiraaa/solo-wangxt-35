import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { ContextData, LngLat, RoadsFC } from '../lib/types';
import type { SolveReq, WorkerReq } from '../lib/workerProtocol';
import { buildNetwork, type BuiltNetwork } from '../lib/graphBuild';
import { snapToNetwork } from '../lib/snap';
import { dijkstraFromEdge, evaluateFacility, isochroneFeatures, type FacilityInput } from '../lib/solve';
import { haversineM, pointInPolygonRings, sliceLine } from '../lib/geo';

let net: BuiltNetwork | null = null;
let barrierLines: LngLat[][] = [];
let extentRings: LngLat[][][] = []; // 每个多边形一组环

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
  if (extentRings.length === 0) return true; // 没有范围数据时不做范围判定
  return extentRings.some((rings) => pointInPolygonRings(p, rings));
}

const ctx = self as unknown as Worker;

ctx.onmessage = (ev: MessageEvent<WorkerReq>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      net = buildNetwork(msg.roads as RoadsFC);
      const context = msg.context as ContextData;
      barrierLines = polygonRings(context.water).flatMap((rings) => rings);
      extentRings = polygonRings(context.boundary);
      ctx.postMessage({
        type: 'loaded',
        req: msg.req,
        stats: net.stats,
        isolatedLines: net.stats.isolatedEdges
          .map((id) => net!.edges.get(id)?.coords)
          .filter((c): c is LngLat[] => !!c)
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
      const inputs: FacilityInput[] = m.facilities.features.map((f) => {
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
      const facilities = inputs.map((fi) => evaluateFacility(net!, dj, fi, speed, maxSeconds));
      // 把路径两端补全：起点侧补上“起点→所在边端点”的部分边，末端接到设施点本身
      const A = originEdge.coords[0]!;
      const B = originEdge.coords[originEdge.coords.length - 1]!;
      for (let i = 0; i < facilities.length; i++) {
        const res = facilities[i]!;
        if (!res.path || res.path.length === 0) continue;
        const start = res.path[0]!;
        if (haversineM(start, A) < 1) {
          const seg = sliceLine(originEdge.coords, 0, m.origin.fraction).reverse();
          res.path = [m.origin.point, ...seg, ...res.path.slice(1)];
        } else if (haversineM(start, B) < 1) {
          const seg = sliceLine(originEdge.coords, m.origin.fraction, 1);
          res.path = [m.origin.point, ...seg, ...res.path.slice(1)];
        }
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
  } catch (err) {
    ctx.postMessage({ type: 'error', req: msg.req, message: err instanceof Error ? err.message : String(err) });
  }
};

export {};
