/**
 * 冒烟测试：在 Node 中跑一遍 Worker 的核心链路。
 * npx esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
 */
import { makeDemoData } from '../src/lib/demoData';
import { buildNetwork } from '../src/lib/graphBuild';
import { snapToNetwork } from '../src/lib/snap';
import { dijkstraFromEdge, evaluateFacility, isochroneFeatures, type FacilityInput } from '../src/lib/solve';
import { pointInPolygonRings } from '../src/lib/geo';
import type { LngLat } from '../src/lib/types';
import type { MultiPolygon, Polygon } from 'geojson';

const demo = makeDemoData();
const net = buildNetwork(demo.roads);

console.log('== 图统计 ==');
console.log(net.stats);

const rings = (fc: typeof demo.context.water) => {
  const out: LngLat[][][] = [];
  for (const f of fc?.features ?? []) {
    if (f.geometry.type === 'Polygon') out.push(f.geometry.coordinates as LngLat[][]);
    else out.push(...(f.geometry as MultiPolygon).coordinates as LngLat[][][]);
  }
  return out;
};
const barriers = rings(demo.context.water).flatMap((r) => r);
const extent = rings(demo.context.boundary as typeof demo.context.water);
const inside = (p: LngLat) => extent.some((r) => pointInPolygonRings(p, r));

// 起点吸附
const snap = snapToNetwork(demo.defaultOrigin, net.edges, barriers);
console.log('\n== 起点吸附 ==');
console.log('best:', snap.best?.edgeId, snap.best?.name, snap.best?.distM.toFixed(1) + 'm');
if (!snap.best) throw new Error('起点吸附失败');

// 河对岸吸附测试：点击落在河面上，两侧候选都应被标记为穿屏障，best 应为空
const riverTest: LngLat = [120.0 + 2.44 * 0.0026, 30.0 + 3 * 0.00225];
const snapRiver = snapToNetwork(riverTest, net.edges, barriers);
console.log('\n== 河边吸附候选（前3）==');
for (const c of snapRiver.candidates.slice(0, 3)) {
  console.log(`  ${c.edgeId} ${c.name} dist=${c.distM.toFixed(0)}m barrier=${c.crossesBarrier}`);
}
if (snapRiver.best !== null) {
  console.error('✗ 河面点击不应自动吸附（所有候选都穿屏障）');
  process.exitCode = 1;
} else {
  console.log('✓ 河面点击未自动吸附到对岸');
}
if (net.stats.components !== 3 || net.stats.stairsEdges !== 2 || net.stats.onewayEdges !== 12) {
  console.error('✗ 图统计不符合预期（components/stairs/oneway）');
  process.exitCode = 1;
}

// 求解
const speed = 5 / 3.6;
const maxMin = 15;
const originEdge = net.edges.get(snap.best.edgeId)!;
const dj = dijkstraFromEdge(net, originEdge, snap.best.fraction, speed);
const iso = isochroneFeatures(net, dj, speed, maxMin * 60, { bandMinutes: 4 });
console.log(`\n== 等时圈 == ${iso.features.length} 个可达路段要素（沿路网，非圆形）`);

const inputs: FacilityInput[] = demo.facilities.features.map((f) => {
  const coord = f.geometry.coordinates as LngLat;
  const s = snapToNetwork(coord, net.edges, barriers);
  return {
    id: String(f.properties?.id),
    coord,
    snap: s.best ? { edgeId: s.best.edgeId, fraction: s.best.fraction, distM: s.best.distM } : null,
    insideExtent: inside(coord)
  };
});
console.log('\n== 设施判定 ==');
const results = new Map<string, string>();
for (const fi of inputs) {
  const r = evaluateFacility(net, dj, fi, speed, maxMin * 60);
  results.set(fi.id, r.status);
  const name = demo.facilities.features.find((f) => f.properties?.id === fi.id)?.properties?.name;
  console.log(
    `  ${fi.id} ${name}: ${r.status}` +
      (r.timeMin !== undefined ? ` (${r.timeMin} min, ${r.distanceM} m, 路径点 ${r.path?.length})` : '')
  );
}

// 断言关键语义
const expect = (id: string, status: string) => {
  const got = results.get(id);
  if (got !== status) {
    console.error(`✗ ${id} 期望 ${status}，实际 ${got}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${id} = ${status}`);
  }
};
console.log('\n== 断言 ==');
expect('f1', 'ok'); // 图书馆：同侧可达
expect('f7', 'stairs-only'); // 社区活动室：仅台阶相连
expect('f8', 'disconnected'); // 快递柜：断开小巷
expect('f10', 'outside-extent'); // 体育馆：范围外
expect('f11', 'data-gap'); // 变电站：离路网太远
expect('f12', 'outside-extent'); // 北门菜场：范围外
expect('f5', 'beyond-time'); // 超市：可达但 15 分钟不够
expect('f6', 'ok'); // 养老院：过桥可达
if (iso.features.length === 0) {
  console.error('✗ 等时圈为空');
  process.exitCode = 1;
}
console.log(process.exitCode ? '\n存在失败断言' : '\n全部通过');
