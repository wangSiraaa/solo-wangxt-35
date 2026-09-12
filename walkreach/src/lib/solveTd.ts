import type { Feature, FeatureCollection, LineString } from 'geojson';
import type { FacilityResult, LngLat, ReachStatus, WaitEvent } from './types';
import type { BuiltNetwork, EdgeRec } from './graphBuild';
import { directedCoords } from './graphBuild';
import { haversineM, sliceLine } from './geo';
import { arriveOnEdge, HORIZON_MIN, type WaitFn } from './td';
import type { FacilityInput } from './solve';

/**
 * 时变（FIFO）求解：标号设定的 time-dependent Dijkstra。
 * 所有时刻为场景日零点起的分钟数（可跨午夜，>1440 表示次日）。
 */

export interface TdPrev {
  from: string;
  edgeId: string;
  /** 在该边入口等待的分钟数 */
  wait: number;
}

export interface TdDijkstra {
  /** nodeId -> 最早到达时刻（绝对分钟） */
  arr: Map<string, number>;
  prev: Map<string, TdPrev>;
}

class Heap {
  private items: [number, string][] = [];
  get size() {
    return this.items.length;
  }
  push(item: [number, string]) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p]![0] <= this.items[i]![0]) break;
      [this.items[p], this.items[i]] = [this.items[i]!, this.items[p]!];
      i = p;
    }
  }
  pop(): [number, string] | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.items[l]![0] < this.items[m]![0]) m = l;
        if (r < this.items.length && this.items[r]![0] < this.items[m]![0]) m = r;
        if (m === i) break;
        [this.items[m], this.items[i]] = [this.items[i]!, this.items[m]!];
        i = m;
      }
    }
    return top;
  }
}

const ttOf = (e: EdgeRec, speedMps: number) => e.lengthM / speedMps / 60;
const waitOf = (waitFns: Map<string, WaitFn>, id: string) => waitFns.get(id) ?? (() => 0);

/** 从边上一点（起点或接送点）在 departMin 时刻出发的时变 Dijkstra */
export function tdDijkstra(
  net: BuiltNetwork,
  waitFns: Map<string, WaitFn>,
  originEdge: EdgeRec,
  fraction: number,
  departMin: number,
  speedMps: number
): TdDijkstra {
  const arr = new Map<string, number>();
  const prev = new Map<string, TdPrev>();
  const heap = new Heap();
  const tt = ttOf(originEdge, speedMps);
  const w0 = waitOf(waitFns, originEdge.id)(departMin);
  const seed = (node: string, t: number) => {
    if (isFinite(t) && t < (arr.get(node) ?? Infinity)) {
      arr.set(node, t);
      heap.push([t, node]);
    }
  };
  // 从边上一点离开同样受时刻表约束：先在原地等到开放
  const depart0 = isFinite(w0) && w0 <= HORIZON_MIN ? departMin + w0 : Infinity;
  if (originEdge.oneway === 'yes') {
    seed(originEdge.nodeB, depart0 + (1 - fraction) * tt);
  } else if (originEdge.oneway === '-1') {
    seed(originEdge.nodeA, depart0 + fraction * tt);
  } else {
    seed(originEdge.nodeA, depart0 + fraction * tt);
    seed(originEdge.nodeB, depart0 + (1 - fraction) * tt);
  }
  const g = net.graph;
  while (heap.size > 0) {
    const [d, u] = heap.pop()!;
    if (d > (arr.get(u) ?? Infinity)) continue;
    g.forEachOutEdge(u, (_key, attrs, _s, target) => {
      const e = net.edges.get((attrs as { edgeId: string }).edgeId);
      if (!e) return;
      const w = waitOf(waitFns, e.id)(d);
      if (!isFinite(w) || w > HORIZON_MIN) return;
      const nd = d + w + ttOf(e, speedMps);
      if (nd < (arr.get(target) ?? Infinity)) {
        arr.set(target, nd);
        prev.set(target, { from: u, edgeId: e.id, wait: w });
        heap.push([nd, target]);
      }
    });
  }
  return { arr, prev };
}

/** 时变等时圈：沿路网、含入口等待；wait>0 的段在属性中标记 */
export function tdIsochrone(
  net: BuiltNetwork,
  dj: TdDijkstra,
  waitFns: Map<string, WaitFn>,
  speedMps: number,
  budgetAbsMin: number,
  departMin: number,
  bandMinutes: number
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  net.graph.forEachDirectedEdge((_key, attrs, source, _target) => {
    const du = dj.arr.get(source);
    if (du === undefined || du > budgetAbsMin) return;
    const e = net.edges.get((attrs as { edgeId: string }).edgeId);
    if (!e) return;
    const w = waitOf(waitFns, e.id)(du);
    if (!isFinite(w) || w > HORIZON_MIN) return;
    const enter = du + w;
    if (enter >= budgetAbsMin) return;
    const tt = ttOf(e, speedMps);
    const reachF = Math.min(1, (budgetAbsMin - enter) / tt);
    if (reachF <= 0) return;
    const dir = directedCoords(e, source);
    const coords = reachF >= 1 ? dir : sliceLine(dir, 0, reachF);
    if (coords.length < 2) return;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        edge: e.id,
        enter: +enter.toFixed(2),
        wait: +w.toFixed(2),
        band: Math.min(Math.max(0, Math.floor((enter - departMin) / bandMinutes)), 3),
        partial: reachF < 1
      }
    });
  });
  return { type: 'FeatureCollection', features };
}

/** 重建到某节点的时变路径：坐标 + 等待事件（等待发生在边入口节点处） */
export function tdPathToNode(
  net: BuiltNetwork,
  dj: TdDijkstra,
  node: string
): { coords: LngLat[]; waits: WaitEvent[] } {
  const chain: { node: string; prev: TdPrev }[] = [];
  let cur = node;
  let guard = 0;
  while (dj.prev.has(cur) && guard++ < 100000) {
    const p = dj.prev.get(cur)!;
    chain.push({ node: cur, prev: p });
    cur = p.from;
  }
  chain.reverse();
  const coords: LngLat[] = [];
  const waits: WaitEvent[] = [];
  for (const step of chain) {
    const e = net.edges.get(step.prev.edgeId);
    if (!e) continue;
    if (step.prev.wait > 1e-6) {
      const a = net.graph.getNodeAttributes(step.prev.from);
      waits.push({
        at: [a.lng as number, a.lat as number],
        waitMin: step.prev.wait,
        kind: 'wait',
        label: e.name,
        clockMin: dj.arr.get(step.prev.from) ?? 0
      });
    }
    for (const c of directedCoords(e, step.prev.from)) {
      const last = coords[coords.length - 1];
      if (!last || haversineM(last, c) > 0.01) coords.push(c);
    }
  }
  return { coords, waits };
}

/** 到达边上某点（接送点/设施吸附点）：考虑方向限制与入口等待 */
export function arriveOnEdgePoint(
  net: BuiltNetwork,
  dj: TdDijkstra,
  waitFns: Map<string, WaitFn>,
  edge: EdgeRec,
  fraction: number,
  speedMps: number
): { arrive: number; endpoint: string; wait: number } | null {
  const tt = ttOf(edge, speedMps);
  const wf = waitOf(waitFns, edge.id);
  let best: { arrive: number; endpoint: string; wait: number } | null = null;
  const tryDir = (endpoint: string, frac: number) => {
    const t0 = dj.arr.get(endpoint);
    if (t0 === undefined) return;
    const w = wf(t0);
    if (!isFinite(w) || w > HORIZON_MIN) return;
    const arrive = t0 + w + frac * tt;
    if (!best || arrive < best.arrive) best = { arrive, endpoint, wait: w };
  };
  if (edge.oneway !== '-1') tryDir(edge.nodeA, fraction);
  if (edge.oneway !== 'yes') tryDir(edge.nodeB, 1 - fraction);
  return best;
}

/** 时变设施评估：到达时刻、总耗时、等待明细、路径 */
export function evaluateFacilityTd(
  net: BuiltNetwork,
  dj: TdDijkstra,
  waitFns: Map<string, WaitFn>,
  f: FacilityInput,
  speedMps: number,
  budgetAbsMin: number,
  departMin: number
): FacilityResult {
  if (!f.insideExtent) return { id: f.id, status: 'outside-extent' };
  if (!f.snap) return { id: f.id, status: 'data-gap' };
  const e = net.edges.get(f.snap.edgeId);
  if (!e) return { id: f.id, status: 'data-gap' };

  const hit = arriveOnEdgePoint(net, dj, waitFns, e, f.snap.fraction, speedMps);
  if (!hit) {
    const anyNode = dj.arr.keys().next().value as string | undefined;
    const oc = anyNode ? net.componentOf.get(anyNode) : undefined;
    const ocS = anyNode ? net.componentWithStairs.get(anyNode) : undefined;
    const comp = net.componentOf.get(e.nodeA);
    const compStairs = net.componentWithStairs.get(e.nodeA);
    const status: ReachStatus =
      ocS !== undefined && compStairs === ocS && comp !== oc ? 'stairs-only' : 'disconnected';
    return { id: f.id, status, snapDistM: f.snap.distM };
  }

  const { coords, waits } = tdPathToNode(net, dj, hit.endpoint);
  if (hit.wait > 1e-6) {
    const a = net.graph.getNodeAttributes(hit.endpoint);
    waits.push({
      at: [a.lng as number, a.lat as number],
      waitMin: hit.wait,
      kind: 'wait',
      label: e.name,
      clockMin: dj.arr.get(hit.endpoint) ?? 0
    });
  }
  const dir = directedCoords(e, hit.endpoint);
  const frac = hit.endpoint === e.nodeA ? f.snap.fraction : 1 - f.snap.fraction;
  for (const c of sliceLine(dir, 0, frac)) {
    const last = coords[coords.length - 1];
    if (!last || haversineM(last, c) > 0.01) coords.push(c);
  }
  const waitMin = waits.reduce((s, w) => s + w.waitMin, 0);
  return {
    id: f.id,
    status: hit.arrive <= budgetAbsMin ? 'ok' : 'beyond-time',
    timeMin: +(hit.arrive - departMin).toFixed(1),
    arrivalMin: +hit.arrive.toFixed(2),
    waitMin: +waitMin.toFixed(2),
    waits,
    path: coords,
    snapDistM: Math.round(f.snap.distM)
  };
}

/** 收集 Dijkstra 结果中所有发生等待的节点（等时圈等待热力点） */
export function collectWaits(
  net: BuiltNetwork,
  dj: TdDijkstra
): { at: LngLat; waitMin: number; label: string; clockMin: number }[] {
  const out: { at: LngLat; waitMin: number; label: string; clockMin: number }[] = [];
  for (const [node, p] of dj.prev) {
    if (p.wait > 1e-6) {
      const e = net.edges.get(p.edgeId);
      const a = net.graph.getNodeAttributes(p.from);
      out.push({
        at: [a.lng as number, a.lat as number],
        waitMin: +p.wait.toFixed(2),
        label: e?.name ?? p.edgeId,
        clockMin: dj.arr.get(p.from) ?? 0
      });
    }
    void node;
  }
  return out;
}
