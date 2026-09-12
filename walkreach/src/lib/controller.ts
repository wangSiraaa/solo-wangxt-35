import { get } from 'svelte/store';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { SolverClient } from './workerClient';
import { makeDemoData } from './demoData';
import { bboxOfLines } from './geo';
import { deleteScenario, listScenarios, loadScenario, saveScenario } from './db';
import type { ContextData, FacilitiesFC, LngLat, RoadsFC, ScenarioRecord } from './types';
import {
  clickMode,
  context,
  facilities,
  facilityResults,
  graphStats,
  isolatedLines,
  isochrone,
  origin,
  pendingSnap,
  roads,
  scenarios,
  selectedFacilityId,
  settings,
  solveMs,
  solving,
  statusMessage
} from './stores';

let client: SolverClient | null = null;
let solveTimer: ReturnType<typeof setTimeout> | null = null;

export function initController() {
  client = new SolverClient();
  void refreshScenarios();
}

export async function refreshScenarios() {
  try {
    scenarios.set(await listScenarios());
  } catch {
    statusMessage.set('IndexedDB 不可用，场景无法保存');
  }
}

function emptyContext(): ContextData {
  return { water: null, boundary: null, boundaryApprox: false };
}

/** 由路网包围盒生成近似数据范围（导入数据缺少边界时的兜底，并明确标注为近似） */
function approxBoundary(r: RoadsFC): ContextData['boundary'] {
  const lines = r.features.map((f) => f.geometry.coordinates as LngLat[]);
  const [minX, minY, maxX, maxY] = bboxOfLines(lines);
  const pad = 0.001;
  const ring: LngLat[] = [
    [minX - pad, minY - pad],
    [maxX + pad, minY - pad],
    [maxX + pad, maxY + pad],
    [minX - pad, maxY + pad],
    [minX - pad, minY - pad]
  ];
  const feat: Feature<Polygon> = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { name: '数据范围（按路网包围盒近似）' }
  };
  return { type: 'FeatureCollection', features: [feat] };
}

export async function loadAll(
  roadsData: RoadsFC,
  facilitiesData: FacilitiesFC,
  contextData: ContextData | null,
  originPoint: LngLat | null = null
) {
  if (!client) return;
  const ctxData = contextData ?? emptyContext();
  if (!ctxData.boundary) {
    ctxData.boundary = approxBoundary(roadsData);
    ctxData.boundaryApprox = true;
  }
  roads.set(roadsData);
  facilities.set(facilitiesData);
  context.set(ctxData);
  origin.set(null);
  pendingSnap.set(null);
  selectedFacilityId.set(null);
  isochrone.set({ type: 'FeatureCollection', features: [] });
  facilityResults.set([]);
  statusMessage.set('正在构建路网图…');
  try {
    const res = await client.load(roadsData, ctxData);
    graphStats.set(res.stats);
    isolatedLines.set(res.isolatedLines);
    const s = res.stats;
    statusMessage.set(
      `路网已加载：${s.nodes} 节点 / ${s.edges} 路段 / ${s.components} 个连通分量` +
        (s.stairsEdges ? `，${s.stairsEdges} 段台阶已禁行` : '') +
        (s.isolatedEdges.length ? `，${s.isolatedEdges.length} 段与主网断开` : '')
    );
  } catch (e) {
    statusMessage.set(`路网构建失败：${e instanceof Error ? e.message : e}`);
    return;
  }
  if (originPoint) await requestSnap(originPoint, true);
}

export async function loadDemo() {
  const d = makeDemoData();
  await loadAll(d.roads, d.facilities, d.context, d.defaultOrigin);
}

/** 点击地图设置起点：先吸附并展示候选 */
export async function requestSnap(point: LngLat, autoPickBest = false) {
  if (!client) return;
  try {
    const { result } = await client.snap(point);
    pendingSnap.set(result);
    if (autoPickBest && result.best) {
      chooseOrigin(result.best.edgeId);
    } else if (!result.best) {
      statusMessage.set('附近 100 米内没有可通行道路，请换个位置（该区域可能缺少道路数据）');
    }
  } catch (e) {
    statusMessage.set(`吸附失败：${e instanceof Error ? e.message : e}`);
  }
}

/** 用户确认某个候选边作为起点 */
export function chooseOrigin(edgeId: string) {
  const snap = get(pendingSnap);
  if (!snap) return;
  const c = snap.candidates.find((x) => x.edgeId === edgeId);
  if (!c) return;
  origin.set({ point: snap.point, edgeId: c.edgeId, fraction: c.fraction, proj: c.proj });
  pendingSnap.set(null);
  clickMode.set('inspect');
  scheduleSolve();
}

export function cancelSnap() {
  pendingSnap.set(null);
  clickMode.set('inspect');
}

export function scheduleSolve() {
  if (solveTimer) clearTimeout(solveTimer);
  solveTimer = setTimeout(() => void runSolve(), 150);
}

export async function runSolve() {
  if (!client) return;
  const o = get(origin);
  const f = get(facilities);
  if (!o || !f) return;
  const s = get(settings);
  solving.set(true);
  try {
    const res = await client.solve(o, s.speedKmh / 3.6, s.maxMinutes, f);
    isochrone.set(res.isochrone);
    facilityResults.set(res.facilities);
    solveMs.set(res.solveMs);
    statusMessage.set(`求解完成（${res.solveMs} ms），等时圈沿路网计算`);
  } catch (e) {
    statusMessage.set(`求解失败：${e instanceof Error ? e.message : e}`);
  } finally {
    solving.set(false);
  }
}

// ---------- 场景存取（IndexedDB） ----------

export async function saveCurrentScenario(name: string) {
  const r = get(roads);
  const f = get(facilities);
  if (!r || !f) {
    statusMessage.set('没有可保存的数据');
    return;
  }
  const rec: ScenarioRecord = {
    id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || `场景 ${new Date().toLocaleString()}`,
    savedAt: Date.now(),
    roads: r,
    facilities: f,
    context: get(context),
    settings: get(settings),
    originPoint: get(origin)?.point ?? null
  };
  try {
    await saveScenario(rec);
    await refreshScenarios();
    statusMessage.set(`场景「${rec.name}」已保存到 IndexedDB`);
  } catch (e) {
    statusMessage.set(`保存失败：${e instanceof Error ? e.message : e}`);
  }
}

export async function loadScenarioById(id: string) {
  const rec = await loadScenario(id);
  if (!rec) {
    statusMessage.set('场景不存在');
    return;
  }
  settings.set(rec.settings);
  await loadAll(rec.roads, rec.facilities, rec.context, rec.originPoint);
  statusMessage.set(`场景「${rec.name}」已加载`);
}

export async function removeScenario(id: string) {
  await deleteScenario(id);
  await refreshScenarios();
}

// ---------- 文件导入 ----------

export function readGeoJSONFile<T>(file: File): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)) as T);
      } catch {
        reject(new Error('不是有效的 GeoJSON'));
      }
    };
    reader.readAsText(file);
  });
}

export async function importRoads(fc: RoadsFC) {
  const cur = get(facilities);
  await loadAll(fc, cur ?? { type: 'FeatureCollection', features: [] }, null);
}

export async function importFacilities(fc: FacilitiesFC) {
  // 规范化：确保每个设施都有 id / name / category
  const norm: FacilitiesFC = {
    type: 'FeatureCollection',
    features: fc.features.map((f, i) => ({
      ...f,
      properties: {
        ...f.properties,
        id: String(f.properties?.id ?? `fac-${i}`),
        name: String(f.properties?.name ?? `设施 ${i + 1}`),
        category: String(f.properties?.category ?? '未分类')
      }
    }))
  };
  facilities.set(norm);
  scheduleSolve();
}

export async function importWater(fc: FeatureCollection) {
  const c = get(context);
  const next: ContextData = { ...c, water: fc as ContextData['water'] };
  context.set(next);
  const r = get(roads);
  if (r && client) {
    await client.load(r, next); // 屏障变化会影响吸附，重建即可（图结构不变，开销小）
  }
  scheduleSolve();
}

export async function importBoundary(fc: FeatureCollection) {
  const c = get(context);
  const next: ContextData = { ...c, boundary: fc as ContextData['boundary'], boundaryApprox: false };
  context.set(next);
  const r = get(roads);
  if (r && client) await client.load(r, next);
  scheduleSolve();
}
