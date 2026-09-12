import type { LngLat, SnapCandidate, SnapResult } from './types';
import type { EdgeRec } from './graphBuild';
import { haversineM, pointToSegmentM, segmentsIntersect } from './geo';

/** 吸附上限：超过则认为离路网太远（疑似数据缺失），不强行吸附 */
export const SNAP_MAX_M = 100;
const CANDIDATE_COUNT = 5;

/**
 * 把点吸附到路网：
 * - 返回最近的若干候选边（含距离、投影点、两端候选节点），由用户确认；
 * - 若“点击点→投影点”的连线穿过水体等屏障，标记 crossesBarrier，
 *   自动选择时优先不穿屏障的候选，避免吸到河对岸。
 */
export function snapToNetwork(
  point: LngLat,
  edges: Map<string, EdgeRec>,
  barrierLines: LngLat[][],
  maxDistM = SNAP_MAX_M
): SnapResult {
  const all: SnapCandidate[] = [];
  for (const e of edges.values()) {
    if (e.stairs) continue; // 台阶禁行，不作为吸附目标
    let best = { distM: Infinity, t: 0, proj: e.coords[0]! as LngLat };
    let acc = 0;
    let accAtBest = 0;
    for (let i = 1; i < e.coords.length; i++) {
      const r = pointToSegmentM(point, e.coords[i - 1]!, e.coords[i]!);
      const segLen = haversineM(e.coords[i - 1]!, e.coords[i]!);
      if (r.distM < best.distM) {
        best = r;
        accAtBest = acc + segLen * r.t;
      }
      acc += segLen;
    }
    if (acc === 0) continue;
    const fraction = Math.min(1, Math.max(0, accAtBest / acc));
    const crossesBarrier = barrierLines.some((ring) => {
      for (let i = 1; i < ring.length; i++) {
        if (segmentsIntersect(point, best.proj, ring[i - 1]!, ring[i]!, point)) return true;
      }
      return false;
    });
    all.push({
      edgeId: e.id,
      name: e.name,
      highway: e.highway,
      distM: best.distM,
      proj: best.proj,
      fraction,
      crossesBarrier,
      nodes: [
        { id: e.nodeA, distM: haversineM(point, e.coords[0]!) },
        { id: e.nodeB, distM: haversineM(point, e.coords[e.coords.length - 1]!) }
      ]
    });
  }
  all.sort((a, b) => a.distM - b.distM);
  const candidates = all.slice(0, CANDIDATE_COUNT);
  const usable = candidates.filter((c) => c.distM <= maxDistM);
  const best = usable.find((c) => !c.crossesBarrier) ?? null;
  return { point, candidates, best };
}
