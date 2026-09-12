import type { LngLat } from './types';

const R = 6371000;
const DEG = Math.PI / 180;

export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLng = (b[0] - a[0]) * DEG;
  const la1 = a[1] * DEG;
  const la2 = b[1] * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 局部等距圆柱投影：把经纬度换成以 ref 为原点的平面米坐标，短距离内足够精确 */
export function toXY(p: LngLat, ref: LngLat): [number, number] {
  const kx = 111320 * Math.cos(ref[1] * DEG);
  return [(p[0] - ref[0]) * kx, (p[1] - ref[1]) * 110540];
}

export function toLngLat(x: number, y: number, ref: LngLat): LngLat {
  const kx = 111320 * Math.cos(ref[1] * DEG);
  return [ref[0] + x / kx, ref[1] + y / 110540];
}

/** 点到线段的最近点；返回距离(米)、参数 t∈[0,1] 与投影点 */
export function pointToSegmentM(p: LngLat, a: LngLat, b: LngLat): { distM: number; t: number; proj: LngLat } {
  const pp = toXY(p, p);
  const pa = toXY(a, p);
  const pb = toXY(b, p);
  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((pp[0] - pa[0]) * dx + (pp[1] - pa[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = toLngLat(pa[0] + t * dx, pa[1] + t * dy, p);
  return { distM: haversineM(p, proj), t, proj };
}

export function lineLengthM(coords: LngLat[]): number {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversineM(coords[i - 1]!, coords[i]!);
  return s;
}

/** 沿折线按比例 f∈[0,1]（占总长）取点 */
export function pointAtFraction(coords: LngLat[], f: number): LngLat {
  if (coords.length === 0) return [0, 0];
  if (f <= 0) return coords[0]!;
  if (f >= 1) return coords[coords.length - 1]!;
  const total = lineLengthM(coords);
  let target = total * f;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const seg = haversineM(a, b);
    if (target <= seg && seg > 0) {
      const t = target / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    target -= seg;
  }
  return coords[coords.length - 1]!;
}

/** 截取折线的 [f0, f1] 比例段 */
export function sliceLine(coords: LngLat[], f0: number, f1: number): LngLat[] {
  if (f1 < f0) [f0, f1] = [f1, f0];
  f0 = Math.max(0, f0);
  f1 = Math.min(1, f1);
  const total = lineLengthM(coords);
  if (total === 0) return [coords[0] ?? [0, 0]];
  const d0 = total * f0;
  const d1 = total * f1;
  const out: LngLat[] = [];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const seg = haversineM(a, b);
    const s0 = acc;
    const s1 = acc + seg;
    if (s1 >= d0 && s0 <= d1 && seg > 0) {
      const t0 = Math.max(0, (d0 - s0) / seg);
      const t1 = Math.min(1, (d1 - s0) / seg);
      const p0: LngLat = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1: LngLat = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      if (out.length === 0) out.push(p0);
      out.push(p1);
    }
    acc = s1;
    if (acc > d1) break;
  }
  if (out.length === 1) out.push(out[0]!);
  return out.length >= 2 ? out : [pointAtFraction(coords, f0), pointAtFraction(coords, f1)];
}

function orient(a: [number, number], b: [number, number], c: [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSeg(a: [number, number], b: [number, number], p: [number, number]): boolean {
  return (
    Math.min(a[0], b[0]) - 1e-12 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-12 &&
    Math.min(a[1], b[1]) - 1e-12 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-12
  );
}

/** 平面线段相交判定（在 ref 附近的局部投影下） */
export function segmentsIntersect(p1: LngLat, p2: LngLat, p3: LngLat, p4: LngLat, ref: LngLat): boolean {
  const a = toXY(p1, ref);
  const b = toXY(p2, ref);
  const c = toXY(p3, ref);
  const d = toXY(p4, ref);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (Math.abs(o1) < 1e-9 && onSeg(a, b, c)) return true;
  if (Math.abs(o2) < 1e-9 && onSeg(a, b, d)) return true;
  if (Math.abs(o3) < 1e-9 && onSeg(c, d, a)) return true;
  if (Math.abs(o4) < 1e-9 && onSeg(c, d, b)) return true;
  return false;
}

/** 射线法点在环内（ring 为闭合或不闭合的经纬度环） */
export function pointInRing(pt: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygonRings(pt: LngLat, rings: LngLat[][]): boolean {
  if (rings.length === 0 || !pointInRing(pt, rings[0]!)) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(pt, rings[i]!)) return false;
  return true;
}

export function bboxOfLines(lines: LngLat[][]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}
