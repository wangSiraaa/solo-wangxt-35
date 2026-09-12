import type { Feature, FeatureCollection, LineString } from 'geojson';
import type { FacilityResult, LngLat, OriginChoice, ReachStatus } from './types';
import type { BuiltNetwork, EdgeRec } from './graphBuild';
import { directedCoords } from './graphBuild';
import { haversineM, pointAtFraction, sliceLine } from './geo';

/** 二叉堆 (cost, node) */
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

interface Prev {
  from: string;
  dirEdgeKey: string;
}

export interface DijkstraResult {
  /** nodeId -> 最短耗时（秒） */
  dist: Map<string, number>;
  prev: Map<string, Prev>;
}

/**
 * 从“边上的吸附点”出发的 Dijkstra。
 * 起点位于 originEdge 的 fraction 处，只能沿该边允许的方向离开（单行道受限）。
 */
export function dijkstraFromEdge(
  net: BuiltNetwork,
  originEdge: EdgeRec,
  fraction: number,
  speedMps: number
): DijkstraResult {
  const dist = new Map<string, number>();
  const prev = new Map<string, Prev>();
  const heap = new Heap();
  const seed = (node: string, sec: number) => {
    if (sec < (dist.get(node) ?? Infinity)) {
      dist.set(node, sec);
      heap.push([sec, node]);
    }
  };
  const tA = (fraction * originEdge.lengthM) / speedMps;
  const tB = ((1 - fraction) * originEdge.lengthM) / speedMps;
  if (originEdge.oneway === 'yes') {
    seed(originEdge.nodeB, tB);
  } else if (originEdge.oneway === '-1') {
    seed(originEdge.nodeA, tA);
  } else {
    seed(originEdge.nodeA, tA);
    seed(originEdge.nodeB, tB);
  }
  const g = net.graph;
  while (heap.size > 0) {
    const [d, u] = heap.pop()!;
    if (d > (dist.get(u) ?? Infinity)) continue;
    g.forEachOutEdge(u, (edgeKey, attrs, _s, target) => {
      const nd = d + (attrs as { lengthM: number }).lengthM / speedMps;
      if (nd < (dist.get(target) ?? Infinity)) {
        dist.set(target, nd);
        prev.set(target, { from: u, dirEdgeKey: edgeKey });
        heap.push([nd, target]);
      }
    });
  }
  return { dist, prev };
}

export interface IsochroneOptions {
  bandMinutes: number;
}

/**
 * 由 Dijkstra 结果生成“沿路网”的等时圈：
 * 对每条有向边，若从 u 出发在预算内，输出从 u 起可覆盖的部分（预算耗尽处截断），
 * 时间属性用于前端按时间带着色。绝不退化为圆/凸包。
 */
export function isochroneFeatures(
  net: BuiltNetwork,
  dj: DijkstraResult,
  speedMps: number,
  maxSeconds: number,
  opts: IsochroneOptions
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  net.graph.forEachDirectedEdge((key, attrs, source, target) => {
    const du = dj.dist.get(source);
    if (du === undefined || du > maxSeconds) return;
    const e = net.edges.get((attrs as { edgeId: string }).edgeId);
    if (!e) return;
    const edgeSec = e.lengthM / speedMps;
    const reachF = Math.min(1, (maxSeconds - du) / edgeSec);
    if (reachF <= 0) return;
    const dir = directedCoords(e, source);
    const coords = reachF >= 1 ? dir : sliceLine(dir, 0, reachF);
    if (coords.length < 2) return;
    const t1 = Math.min(maxSeconds, du + edgeSec);
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        edge: e.id,
        time0: +(du / 60).toFixed(2),
        time1: +(t1 / 60).toFixed(2),
        band: Math.min(Math.floor(du / 60 / opts.bandMinutes), 3),
        partial: reachF < 1
      }
    });
  });
  return { type: 'FeatureCollection', features };
}

/** 重建到某节点的路径坐标（沿道路，含方向） */
function pathToNode(net: BuiltNetwork, dj: DijkstraResult, node: string): LngLat[] {
  const chain: { node: string; from: string }[] = [];
  let cur = node;
  const guard = 100000;
  let n = 0;
  while (dj.prev.has(cur) && n++ < guard) {
    const p = dj.prev.get(cur)!;
    chain.push({ node: cur, from: p.from });
    cur = p.from;
  }
  chain.reverse();
  const out: LngLat[] = [];
  for (const step of chain) {
    const dirKey = dj.prev.get(step.node)!.dirEdgeKey;
    const e = net.edges.get(net.graph.getEdgeAttributes(dirKey).edgeId as string);
    if (!e) continue;
    const coords = directedCoords(e, step.from);
    for (const c of coords) {
      const last = out[out.length - 1];
      if (!last || haversineM(last, c) > 0.01) out.push(c);
    }
  }
  return out;
}

export interface FacilityInput {
  id: string;
  coord: LngLat;
  /** 吸附结果（可能为 null = 离路网太远） */
  snap: { edgeId: string; fraction: number; distM: number } | null;
  insideExtent: boolean;
}

export function evaluateFacility(
  net: BuiltNetwork,
  dj: DijkstraResult,
  f: FacilityInput,
  speedMps: number,
  maxSeconds: number
): FacilityResult {
  if (!f.insideExtent) {
    return { id: f.id, status: 'outside-extent' };
  }
  if (!f.snap) {
    return { id: f.id, status: 'data-gap' };
  }
  const e = net.edges.get(f.snap.edgeId);
  if (!e) return { id: f.id, status: 'data-gap' };

  // 到达边上吸附点：必须从允许的方向进入该边
  const tA = dj.dist.get(e.nodeA);
  const tB = dj.dist.get(e.nodeB);
  const canAB = e.oneway !== '-1';
  const canBA = e.oneway !== 'yes';
  const edgeSec = e.lengthM / speedMps;
  let best: { sec: number; via: 'A' | 'B' } | null = null;
  if (canAB && tA !== undefined) {
    const sec = tA + f.snap.fraction * edgeSec;
    best = { sec, via: 'A' };
  }
  if (canBA && tB !== undefined) {
    const sec = tB + (1 - f.snap.fraction) * edgeSec;
    if (!best || sec < best.sec) best = { sec, via: 'B' };
  }

  if (!best) {
    // 网络中到不了这条边：区分“断开”与“仅台阶相连”
    const anyOriginNode = dj.dist.keys().next().value as string | undefined;
    const oc = anyOriginNode ? net.componentOf.get(anyOriginNode) : undefined;
    const ocS = anyOriginNode ? net.componentWithStairs.get(anyOriginNode) : undefined;
    const comp = net.componentOf.get(e.nodeA);
    const compStairs = net.componentWithStairs.get(e.nodeA);
    const status: ReachStatus =
      ocS !== undefined && compStairs === ocS && comp !== oc ? 'stairs-only' : 'disconnected';
    return { id: f.id, status, snapDistM: f.snap.distM };
  }

  const timeMin = best.sec / 60;
  const viaNode = best.via === 'A' ? e.nodeA : e.nodeB;
  const path = pathToNode(net, dj, viaNode);
  // 从节点沿边走到吸附点
  const dir = directedCoords(e, viaNode);
  const frac = best.via === 'A' ? f.snap.fraction : 1 - f.snap.fraction;
  const onEdge = sliceLine(dir, 0, frac);
  for (const c of onEdge) {
    const last = path[path.length - 1];
    if (!last || haversineM(last, c) > 0.01) path.push(c);
  }
  const distanceM = best.sec * speedMps;
  const status: ReachStatus = best.sec <= maxSeconds ? 'ok' : 'beyond-time';
  return {
    id: f.id,
    status,
    timeMin: +timeMin.toFixed(1),
    distanceM: Math.round(distanceM),
    path,
    snapDistM: Math.round(f.snap.distM)
  };
}

/** 起点自身的几何：吸附点 + 到两端的部分边（用于地图显示） */
export function originGeometry(origin: OriginChoice, e: EdgeRec): { point: LngLat; proj: LngLat } {
  return { point: origin.point, proj: pointAtFraction(e.coords, origin.fraction) };
}
