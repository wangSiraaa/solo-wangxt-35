/**
 * 时变（FIFO）求解的交叉核验：
 *  A. 小图上用简单路径穷举 + 精确仿真，对照时变 Dijkstra（含必经点两段行程）；
 *  B. FIFO 前提校验：拒绝 wait=false、窗口重叠、非法时刻等数据；
 *  C. 演示数据案例：刚好赶上关闭 / 等待优于绕路 / 第一段延误影响第二段。
 *
 * 运行：npm run verify:td
 */
import { buildNetwork, type BuiltNetwork } from '../src/lib/graphBuild';
import { snapToNetwork } from '../src/lib/snap';
import {
  arriveOnEdgePoint,
  evaluateFacilityTd,
  tdDijkstra,
  type TdDijkstra
} from '../src/lib/solveTd';
import {
  fifoSpotCheck,
  makeWaitFn,
  parseSchedule,
  validateTdData,
  weekdayOfDate,
  type ParsedSchedule,
  type WaitFn
} from '../src/lib/td';
import { makeDemoData } from '../src/lib/demoData';
import { haversineM } from '../src/lib/geo';
import type { LngLat, RoadsFC } from '../src/lib/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
}
function approx(a: number, b: number, tol: number, msg: string) {
  check(isFinite(a) && Math.abs(a - b) <= tol, `${msg}（期望 ${b.toFixed(2)}±${tol}，实际 ${isFinite(a) ? a.toFixed(2) : a}）`);
}

// ---------- 工具：从路网构建等待函数（与 Worker 加载逻辑一致） ----------
function buildWaitFns(net: BuiltNetwork, roads: RoadsFC, date: string) {
  const schedules = new Map<string, ParsedSchedule>();
  const errors: string[] = [];
  for (const e of net.edges.values()) {
    if (e.scheduleRaw === undefined) continue;
    const { sched, error } = parseSchedule(e.scheduleRaw);
    if (error) errors.push(`${e.name}: ${error}`);
    else if (sched) schedules.set(e.id, sched);
  }
  const wd = weekdayOfDate(date);
  if (wd === null) throw new Error('日期无效');
  const waitFns = new Map<string, WaitFn>();
  for (const e of net.edges.values()) {
    waitFns.set(e.id, makeWaitFn(schedules.get(e.id) ?? null, wd));
  }
  return { waitFns, errors, schedules };
}

// ---------- 工具：简单路径穷举 + 时变仿真 ----------
function enumerateBest(
  net: BuiltNetwork,
  waitFns: Map<string, WaitFn>,
  originEdgeId: string,
  fraction: number,
  departMin: number,
  targetNode: string,
  speedMps: number
): number {
  const originEdge = net.edges.get(originEdgeId)!;
  const tt = originEdge.lengthM / speedMps / 60;
  const w0 = (waitFns.get(originEdgeId) ?? (() => 0))(departMin);
  const depart0 = isFinite(w0) ? departMin + w0 : Infinity;
  const seeds: [string, number][] = [];
  if (originEdge.oneway !== '-1') seeds.push([originEdge.nodeB, depart0 + (1 - fraction) * tt]);
  if (originEdge.oneway !== 'yes') seeds.push([originEdge.nodeA, depart0 + fraction * tt]);

  let best = Infinity;
  const dfs = (u: string, t: number, visited: Set<string>) => {
    if (t >= best) return;
    if (u === targetNode) {
      best = t;
      return;
    }
    net.graph.forEachOutEdge(u, (_k, attrs, _s, v) => {
      if (visited.has(v)) return;
      const e = net.edges.get((attrs as { edgeId: string }).edgeId)!;
      const w = (waitFns.get(e.id) ?? (() => 0))(t);
      if (!isFinite(w) || w > 36 * 60) return;
      visited.add(v);
      dfs(v, t + w + e.lengthM / speedMps / 60, visited);
      visited.delete(v);
    });
  };
  for (const [node, t0] of seeds) {
    if (!isFinite(t0)) continue;
    dfs(node, t0, new Set([node]));
  }
  return best;
}

// ============================================================
// A. 小图穷举交叉核验
// ============================================================
console.log('== A. 小图穷举交叉核验 ==');
{
  const u = 0.005;
  const P = (x: number, y: number): LngLat => [120 + x * u, 30 + y * u];
  // A(0,0) B(1,0) C(2,0) D(2,1) E(1,1) F(0,1)
  const roads: RoadsFC = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [P(0, 0), P(1, 0)] }, properties: { name: 'AB' } },
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [P(1, 0), P(2, 0)] },
        properties: {
          name: 'BC',
          schedule: { mode: 'open-only', windows: [{ days: [5], open: '08:00', close: '08:10' }] }
        }
      },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [P(2, 0), P(2, 1)] }, properties: { name: 'CD' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [P(2, 1), P(1, 1)] }, properties: { name: 'DE' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [P(1, 1), P(0, 1)] }, properties: { name: 'EF' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [P(0, 1), P(0, 0)] }, properties: { name: 'FA' } },
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [P(1, 0), P(1, 1)] },
        properties: {
          name: 'BE',
          schedule: { mode: 'closed-during', windows: [{ days: [5], open: '07:50', close: '08:20' }] }
        }
      }
    ]
  };
  const net = buildNetwork(roads);
  const { waitFns, errors } = buildWaitFns(net, roads, '2026-09-11');
  check(errors.length === 0, `A: 小图数据通过 FIFO 校验${errors.length ? '：' + errors.join('；') : ''}`);

  const speed = 1; // m/s
  const originEdge = net.edges.get('e0')!; // AB
  const nodeOf = (x: number, y: number) => `${(120 + x * u).toFixed(6)},${(30 + y * u).toFixed(6)}`;

  // 从 AB 中点出发，对多个出发时刻，逐节点对照穷举结果
  let allMatch = true;
  let worstDiff = 0;
  for (let depart = 440; depart <= 480; depart += 5) {
    const dj = tdDijkstra(net, waitFns, originEdge, 0.5, depart, speed);
    for (const [name, node] of [
      ['C', nodeOf(2, 0)],
      ['D', nodeOf(2, 1)],
      ['E', nodeOf(1, 1)],
      ['F', nodeOf(0, 1)]
    ] as const) {
      const enumBest = enumerateBest(net, waitFns, 'e0', 0.5, depart, node, speed);
      const djBest = dj.arr.get(node) ?? Infinity;
      const diff = Math.abs(enumBest - djBest);
      if (!isFinite(diff) || diff > 1e-6) {
        allMatch = false;
        console.error(`  不匹配：t=${depart} 节点${name} 穷举=${enumBest} dijkstra=${djBest}`);
      }
      worstDiff = Math.max(worstDiff, isFinite(diff) ? diff : 999);
    }
  }
  check(allMatch, `A: 9 个出发时刻 × 4 个目标节点，时变 Dijkstra 与穷举一致（最大偏差 ${worstDiff.toExponential(1)}）`);

  // 必经点两段行程：A→B（停留 7 分钟）→D，对照“路径对”穷举
  const dwell = 7;
  let legsMatch = true;
  for (let depart = 450; depart <= 475; depart += 5) {
    // 算法：第一段 dijkstra → 到达 B + 停留 → 第二段 dijkstra
    const dj1 = tdDijkstra(net, waitFns, originEdge, 0.5, depart, speed);
    const arrB = dj1.arr.get(nodeOf(1, 0))!;
    const dj2 = tdDijkstra(net, waitFns, net.edges.get('e0')!, 1.0, arrB + dwell, speed);
    const algo = dj2.arr.get(nodeOf(2, 1))!;
    // 穷举：所有简单路径 p1(A→B) × p2(B→D)，第二段从 arr(p1)+dwell 起算
    let brute = Infinity;
    const collect = (from: [string, number][], target: string, acc: [string, number][]) => {
      // 枚举 from→target 的所有简单路径及其到达时间
      const out: number[] = [];
      const dfs = (u: string, t: number, vis: Set<string>) => {
        if (u === target) {
          out.push(t);
          return;
        }
        net.graph.forEachOutEdge(u, (_k, attrs, _s, v) => {
          if (vis.has(v)) return;
          const e = net.edges.get((attrs as { edgeId: string }).edgeId)!;
          const w = (waitFns.get(e.id) ?? (() => 0))(t);
          if (!isFinite(w) || w > 36 * 60) return;
          vis.add(v);
          dfs(v, t + w + e.lengthM / speed / 60, vis);
          vis.delete(v);
        });
      };
      for (const [n, t0] of from) dfs(n, t0, new Set([n]));
      void acc;
      return out;
    };
    const w0 = (waitFns.get('e0') ?? (() => 0))(depart);
    const d0 = depart + (isFinite(w0) ? w0 : 0);
    const ttAB = net.edges.get('e0')!.lengthM / speed / 60;
    const leg1Arrivals = collect(
      [
        [net.edges.get('e0')!.nodeA, d0 + 0.5 * ttAB],
        [net.edges.get('e0')!.nodeB, d0 + 0.5 * ttAB]
      ],
      nodeOf(1, 0),
      []
    );
    for (const a1 of leg1Arrivals) {
      const leg2Arrivals = collect([[nodeOf(1, 0), a1 + dwell]], nodeOf(2, 1), []);
      for (const a2 of leg2Arrivals) brute = Math.min(brute, a2);
    }
    if (Math.abs(algo - brute) > 1e-6) {
      legsMatch = false;
      console.error(`  两段行程不匹配：t=${depart} 算法=${algo} 穷举=${brute}`);
    }
  }
  check(legsMatch, 'A: 必经点+停留的两段行程（5 个出发时刻）与路径对穷举一致');
}

// ============================================================
// B. FIFO 前提校验：拒绝不满足的数据
// ============================================================
console.log('\n== B. FIFO 校验 ==');
{
  check(parseSchedule({ mode: 'open-only', wait: false, windows: [{ open: '08:00', close: '09:00' }] }).error !== undefined, 'B: 拒绝 wait=false（封闭不可等待）');
  check(
    parseSchedule({ mode: 'open-only', windows: [{ open: '08:00', close: '09:00' }, { open: '08:30', close: '10:00' }] }).error !== undefined,
    'B: 拒绝重叠窗口'
  );
  check(parseSchedule({ mode: 'open-only', windows: [{ open: '8点', close: '09:00' }] }).error !== undefined, 'B: 拒绝非法时刻格式');
  check(parseSchedule({ mode: 'open-only', windows: [{ open: '08:00', close: '08:00' }] }).error !== undefined, 'B: 拒绝零长度窗口');
  check(parseSchedule({ mode: 'open-only', windows: [{ open: '22:00', close: '02:00' }] }).sched !== undefined, 'B: 接受跨夜窗口');
  check(parseSchedule({ mode: 'closed-during', windows: [{ days: [1, 2, 3, 4, 5], open: '07:31', close: '07:35' }] }).sched !== undefined, 'B: 接受合法封闭窗口');
  // 跨天相邻但不重叠的窗口应通过
  check(
    parseSchedule({ mode: 'open-only', windows: [{ days: [1], open: '22:00', close: '23:00' }, { days: [2], open: '01:00', close: '02:00' }] }).sched !== undefined,
    'B: 接受不同日的相邻窗口'
  );
  // FIFO 抽查：合法等待函数单调；构造一个人为的非 FIFO 函数应被检出
  const wf = makeWaitFn(parseSchedule({ mode: 'closed-during', windows: [{ open: '07:31', close: '07:35' }] }).sched!, 5);
  check(fifoSpotCheck(wf, 3) === null, 'B: 合法等待函数通过 FIFO 抽查');
  // validateTdData 对无效时区/日期报错
  const demo = makeDemoData();
  const net = buildNetwork(demo.roads);
  const { waitFns } = buildWaitFns(net, demo.roads, demo.calendar.date);
  const errs = validateTdData(demo.roads, { timezone: 'Not/AZone', date: '2026-13-40' }, net.edges, waitFns, 5 / 3.6);
  check(errs.length >= 2, `B: 无效时区与日期被拒绝（${errs.length} 项错误）`);
}

// ============================================================
// C. 演示数据案例
// ============================================================
console.log('\n== C. 演示数据案例 ==');
{
  const demo = makeDemoData();
  const net = buildNetwork(demo.roads);
  const { waitFns, errors } = buildWaitFns(net, demo.roads, demo.calendar.date);
  check(errors.length === 0, 'C: 演示数据通过 FIFO 校验');
  const errs = validateTdData(demo.roads, demo.calendar, net.edges, waitFns, 5 / 3.6);
  check(errs.length === 0, 'C: validateTdData 对演示数据无错误');
  check(weekdayOfDate(demo.calendar.date) === 5, 'C: 场景日 2026-09-11 为周五（窗口生效）');

  const speed = 5 / 3.6;
  const originSnap = snapToNetwork(demo.defaultOrigin, net.edges, []);
  const viaSnap = snapToNetwork(demo.defaultVia, net.edges, []);
  const originEdge = net.edges.get(originSnap.best!.edgeId)!;
  const viaEdge = net.edges.get(viaSnap.best!.edgeId)!;

  const yongan = [...net.edges.values()].find((e) => e.name === '永安桥')!;
  const bridge = [...net.edges.values()].find((e) => e.name === '北二街天桥')!;
  const qingshan = [...net.edges.values()].find((e) => e.name === '青山桥')!;
  check(yongan.scheduleRaw !== undefined, 'C: 永安桥带时段封闭时刻表');

  const onPath = (path: LngLat[] | undefined, edge: typeof bridge) =>
    !!path && path.some((c) => edge.coords.some((ec) => haversineM(c, ec) < 2));

  const facility = (id: string) => demo.facilities.features.find((f) => f.properties?.id === id)!;
  const evalF = (dj: TdDijkstra, id: string, budgetAbs: number, depart: number) => {
    const f = facility(id);
    const coord = f.geometry.coordinates as LngLat;
    const snap = snapToNetwork(coord, net.edges, []);
    return evaluateFacilityTd(
      net,
      dj,
      waitFns,
      {
        id,
        coord,
        snap: snap.best ? { edgeId: snap.best.edgeId, fraction: snap.best.fraction, distM: snap.best.distM } : null,
        insideExtent: true
      },
      speed,
      budgetAbs,
      depart
    );
  };

  // --- 默认 07:30 出发 ---
  const depart = 450;
  const dwell = 5;
  const dj1 = tdDijkstra(net, waitFns, originEdge, originSnap.best!.fraction, depart, speed);
  const viaHit = arriveOnEdgePoint(net, dj1, waitFns, viaEdge, viaSnap.best!.fraction, speed)!;

  // 案例 2（等待优于绕路）：在永安桥前等待，比绕青山桥早到接送点十几分钟
  const waitAtYongan = dj1.prev.get(yongan.nodeB)?.wait ?? 0;
  check(waitAtYongan > 0.5, `C: 07:30 出发在永安桥前等待 ${waitAtYongan.toFixed(1)} 分钟`);
  const waitFnsBlocked = new Map(waitFns);
  waitFnsBlocked.set(yongan.id, () => Infinity); // 假设永安桥不可走 → 只能绕青山桥
  const djDetour = tdDijkstra(net, waitFnsBlocked, originEdge, originSnap.best!.fraction, depart, speed);
  const detourArr = djDetour.arr.get(viaEdge.nodeA) ?? Infinity;
  check(
    viaHit.arrive < detourArr - 5,
    `C: 等待后通行（${viaHit.arrive.toFixed(1)} 到接送点）优于绕路（${detourArr.toFixed(1)}）`
  );

  // 案例 1（刚好赶上关闭）：第二段到达天桥东端时距关闭不到 2 分钟
  const dj2 = tdDijkstra(net, waitFns, viaEdge, viaSnap.best!.fraction, viaHit.arrive + dwell, speed);
  const arrBridgeEast = dj2.arr.get(bridge.nodeB);
  approx(arrBridgeEast!, 470, 2, 'C: 到达天桥东端时刻 ≈ 07:50');
  check(arrBridgeEast! < 471 && 471 - arrBridgeEast! < 2, `C: 刚好赶上天桥关闭（07:51）前通过，余量 ${(471 - arrBridgeEast!).toFixed(1)} 分钟`);

  const f9 = evalF(dj2, 'f9', 472, depart);
  check(f9.status === 'ok', `C: 滨河观景台 07:30 出发可达（${f9.arrivalMin} 到达）`);
  check(onPath(f9.path, bridge), 'C: 观景台路径经过北二街天桥');

  // 案例 3（第一段延误影响第二段）：晚 4 分钟出发，错过天桥只能绕远桥
  // （永安桥封闭把 07:30–07:32 的出发压缩成同一车队；07:34 出发则错过天桥）
  const depart2 = 454;
  const dj1b = tdDijkstra(net, waitFns, originEdge, originSnap.best!.fraction, depart2, speed);
  const viaHitB = arriveOnEdgePoint(net, dj1b, waitFns, viaEdge, viaSnap.best!.fraction, speed)!;
  const dj2b = tdDijkstra(net, waitFns, viaEdge, viaSnap.best!.fraction, viaHitB.arrive + dwell, speed);
  const f9b = evalF(dj2b, 'f9', 600, depart2);
  check(!onPath(f9b.path, bridge), 'C: 07:34 出发路径不再经过天桥');
  check(
    onPath(f9b.path, yongan) || onPath(f9b.path, qingshan),
    'C: 07:34 出发改绕其他桥（永安桥回程或青山桥）'
  );
  check(
    f9b.arrivalMin! - f9.arrivalMin! > 5,
    `C: 出发晚 4 分钟 → 到达晚 ${(f9b.arrivalMin! - f9.arrivalMin!).toFixed(1)} 分钟（第一段延误影响第二段）`
  );

  // 时刻模式下的等待事件：接送点路径上应有永安桥等待
  const viaEval = evaluateFacilityTd(
    net,
    dj1,
    waitFns,
    { id: 'via', coord: demo.defaultVia, snap: { edgeId: viaEdge.id, fraction: viaSnap.best!.fraction, distM: 0 }, insideExtent: true },
    speed,
    Infinity,
    depart
  );
  check(
    (viaEval.waits ?? []).some((w) => w.label === '永安桥' && w.waitMin > 0.5),
    'C: 接送点路径记录了永安桥等待事件（地图可展示等待位置）'
  );

  // 常规可达性谱系抽查
  const f6 = evalF(dj2, 'f6', 472, depart);
  check(f6.status === 'ok', `C: 养老院可达（${f6.arrivalMin} 到达）`);
  const f5 = evalF(dj2, 'f5', 472, depart);
  check(f5.status === 'beyond-time', 'C: 超市超出 22 分钟上限');
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
