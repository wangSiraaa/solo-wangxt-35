import { DirectedGraph } from 'graphology';
import type { LngLat, RoadsFC } from './types';
import { haversineM, lineLengthM } from './geo';

export interface EdgeRec {
  id: string;
  name: string;
  highway: string;
  oneway: 'yes' | '-1' | 'no';
  stairs: boolean;
  bridge: boolean;
  lengthM: number;
  coords: LngLat[];
  nodeA: string;
  nodeB: string;
  /** 原始 schedule 属性（未解析），由 td.ts 校验与解析 */
  scheduleRaw?: unknown;
}

export interface BuiltNetwork {
  graph: DirectedGraph;
  edges: Map<string, EdgeRec>;
  /** 可通行（禁台阶）图上的连通分量：nodeId -> 分量号 */
  componentOf: Map<string, number>;
  /** 把台阶也算作连通时的分量（用于诊断“仅台阶相连”） */
  componentWithStairs: Map<string, number>;
  mainComponent: number;
  stats: {
    nodes: number;
    edges: number;
    directedEdges: number;
    components: number;
    stairsEdges: number;
    onewayEdges: number;
    isolatedEdges: string[];
  };
}

const keyOf = (c: LngLat) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    let r = this.parent.get(x) ?? x;
    if (r !== x) {
      r = this.find(r);
      this.parent.set(x, r);
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
}

/**
 * 把 GeoJSON 路网构造成有向图。
 * - 折线端点与多条线共享的顶点成为节点，线在节点处打断；
 * - oneway=yes/-1 只保留顺/逆向通行；
 * - highway=steps 视为台阶，不进入可通行图，但保留用于诊断。
 */
export function buildNetwork(roads: RoadsFC): BuiltNetwork {
  // 第一遍：统计每个坐标被多少条线使用，确定节点集合
  const usage = new Map<string, { count: number; coord: LngLat }>();
  const lines: LngLat[][] = [];
  for (const f of roads.features) {
    if (!f.geometry || f.geometry.type !== 'LineString') continue;
    const coords = (f.geometry.coordinates as LngLat[]).filter(
      (c) => Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])
    );
    if (coords.length < 2) continue;
    lines.push(coords);
    coords.forEach((c, i) => {
      const k = keyOf(c);
      const u = usage.get(k);
      if (u) {
        // 端点恒为节点；中间点被多条线共享时才是交叉口
        u.count += i === 0 || i === coords.length - 1 ? 2 : 1;
      } else {
        usage.set(k, { count: i === 0 || i === coords.length - 1 ? 2 : 1, coord: c });
      }
    });
  }
  const isNode = (c: LngLat) => (usage.get(keyOf(c))?.count ?? 0) >= 2;

  // 第二遍：在节点处打断，生成边记录
  const edges = new Map<string, EdgeRec>();
  let seq = 0;
  for (let li = 0; li < lines.length; li++) {
    const coords = lines[li]!;
    const props = (roads.features[li]?.properties ?? {}) as Record<string, unknown>;
    const highway = String(props.highway ?? 'road');
    const owRaw = String(props.oneway ?? 'no');
    const oneway = owRaw === 'yes' || owRaw === '-1' ? owRaw : 'no';
    let segStart = 0;
    for (let i = 1; i < coords.length; i++) {
      if (i === coords.length - 1 || isNode(coords[i]!)) {
        const seg = coords.slice(segStart, i + 1);
        if (seg.length >= 2) {
          const id = `e${seq++}`;
          const rec: EdgeRec = {
            id,
            name: String(props.name ?? `路段 ${id}`),
            highway,
            oneway,
            stairs: highway === 'steps',
            bridge: String(props.bridge ?? '') === 'yes',
            lengthM: lineLengthM(seg),
            coords: seg,
            nodeA: keyOf(seg[0]!),
            nodeB: keyOf(seg[seg.length - 1]!)
          };
          if (props.schedule !== undefined) rec.scheduleRaw = props.schedule;
          edges.set(id, rec);
        }
        segStart = i;
      }
    }
  }

  // 建图（graphology 有向图）
  const graph = new DirectedGraph();
  const nodeCoord = new Map<string, LngLat>();
  for (const e of edges.values()) {
    if (!nodeCoord.has(e.nodeA)) nodeCoord.set(e.nodeA, e.coords[0]!);
    if (!nodeCoord.has(e.nodeB)) nodeCoord.set(e.nodeB, e.coords[e.coords.length - 1]!);
  }
  for (const [id, coord] of nodeCoord) graph.addNode(id, { lng: coord[0], lat: coord[1] });

  let directedEdges = 0;
  let onewayEdges = 0;
  let stairsEdges = 0;
  for (const e of edges.values()) {
    if (e.stairs) {
      stairsEdges++;
      continue; // 台阶禁行：不进入可通行图
    }
    if (e.oneway === 'yes') {
      graph.addDirectedEdgeWithKey(`${e.id}>`, e.nodeA, e.nodeB, { edgeId: e.id, lengthM: e.lengthM });
      directedEdges++;
      onewayEdges++;
    } else if (e.oneway === '-1') {
      graph.addDirectedEdgeWithKey(`${e.id}<`, e.nodeB, e.nodeA, { edgeId: e.id, lengthM: e.lengthM });
      directedEdges++;
      onewayEdges++;
    } else {
      graph.addDirectedEdgeWithKey(`${e.id}>`, e.nodeA, e.nodeB, { edgeId: e.id, lengthM: e.lengthM });
      graph.addDirectedEdgeWithKey(`${e.id}<`, e.nodeB, e.nodeA, { edgeId: e.id, lengthM: e.lengthM });
      directedEdges += 2;
    }
  }

  // 连通分量（可通行图 / 含台阶图）
  const ufWalk = new UnionFind();
  const ufAll = new UnionFind();
  for (const id of nodeCoord.keys()) {
    ufWalk.add(id);
    ufAll.add(id);
  }
  for (const e of edges.values()) {
    ufAll.union(e.nodeA, e.nodeB);
    if (!e.stairs) ufWalk.union(e.nodeA, e.nodeB);
  }
  const compIndex = (uf: UnionFind) => {
    const roots = new Map<string, number>();
    const map = new Map<string, number>();
    let n = 0;
    for (const id of nodeCoord.keys()) {
      const r = uf.find(id);
      if (!roots.has(r)) roots.set(r, n++);
      map.set(id, roots.get(r)!);
    }
    return { map, count: n, sizes: roots };
  };
  const walk = compIndex(ufWalk);
  const all = compIndex(ufAll);

  // 主分量 = 节点最多的分量
  const counts = new Map<number, number>();
  for (const c of walk.map.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
  let mainComponent = 0;
  let best = -1;
  for (const [c, n] of counts) {
    if (n > best) {
      best = n;
      mainComponent = c;
    }
  }
  const isolatedEdges: string[] = [];
  for (const e of edges.values()) {
    if (!e.stairs && walk.map.get(e.nodeA) !== mainComponent) isolatedEdges.push(e.id);
  }

  return {
    graph,
    edges,
    componentOf: walk.map,
    componentWithStairs: all.map,
    mainComponent,
    stats: {
      nodes: nodeCoord.size,
      edges: edges.size,
      directedEdges,
      components: walk.count,
      stairsEdges,
      onewayEdges,
      isolatedEdges
    }
  };
}

/** 沿有向边从 from 节点出发的坐标序列（按通行方向） */
export function directedCoords(e: EdgeRec, fromNode: string): LngLat[] {
  return fromNode === e.nodeA ? e.coords : [...e.coords].reverse();
}

export function nodeOfCoord(c: LngLat): string {
  return keyOf(c);
}

export { haversineM };
