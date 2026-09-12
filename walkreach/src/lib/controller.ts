import { get } from 'svelte/store';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { SolverClient } from './workerClient';
import { makeDemoData } from './demoData';
import { bboxOfLines } from './geo';
import { deleteScenario, listScenarios, loadScenario, saveScenario } from './db';
import type {
  Calendar,
  ContextData,
  FacilitiesFC,
  LngLat,
  RoadsFC,
  ScenarioRecord,
  Settings
} from './types';
import {
  calendar,
  clickMode,
  context,
  facilities,
  facilityResults,
  graphStats,
  isolatedLines,
  isoWaits,
  isochrone,
  isochrone2,
  origin,
  pendingSnap,
  roads,
  scenarios,
  selectedFacilityId,
  settings,
  snapPurpose,
  solveMs,
  solving,
  statusMessage,
  tdEdgeCount,
  tdErrors,
  via,
  viaInfo
} from './stores';

let client: SolverClient | null = null;
let solveTimer: ReturnType<typeof setTimeout> | null = null;
/** 求解序号：只接受最后一次请求的结果，防止旧 Worker 返回混入 */
let solveSeq = 0;

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
  originPoint: LngLat | null = null,
  calendarData: Calendar | null = null,
  viaPoint: LngLat | null = null
) {
  if (!client) return;
  const ctxData = contextData ?? emptyContext();
  if (!ctxData.boundary) {
    ctxData.boundary = approxBoundary(roadsData);
    ctxData.boundaryApprox = true;
  }
  if (calendarData) calendar.set(calendarData);
  roads.set(roadsData);
  facilities.set(facilitiesData);
  context.set(ctxData);
  origin.set(null);
  via.set(null);
  viaInfo.set(null);
  pendingSnap.set(null);
  selectedFacilityId.set(null);
  isochrone.set({ type: 'FeatureCollection', features: [] });
  isochrone2.set({ type: 'FeatureCollection', features: [] });
  isoWaits.set([]);
  facilityResults.set([]);
  statusMessage.set('正在构建路网图…');
  try {
    const res = await client.load(roadsData, ctxData, get(calendar));
    graphStats.set(res.stats);
    isolatedLines.set(res.isolatedLines);
    tdErrors.set(res.tdErrors);
    tdEdgeCount.set(res.tdEdges);
    const s = res.stats;
    statusMessage.set(
      `路网已加载：${s.nodes} 节点 / ${s.edges} 路段 / ${s.components} 个连通分量` +
        (s.stairsEdges ? `，${s.stairsEdges} 段台阶已禁行` : '') +
        (s.isolatedEdges.length ? `，${s.isolatedEdges.length} 段与主网断开` : '') +
        (res.tdEdges ? `，${res.tdEdges} 条限时路段` : '')
    );
    if (res.tdErrors.length > 0) {
      statusMessage.set(`时刻数据未通过 FIFO 校验（${res.tdErrors.length} 项），时刻模式已禁用`);
    }
  } catch (e) {
    statusMessage.set(`路网构建失败：${e instanceof Error ? e.message : e}`);
    return;
  }
  if (originPoint) await requestSnap(originPoint, true, 'origin');
  if (viaPoint) await requestSnap(viaPoint, true, 'via');
}

export async function loadDemo() {
  const d = makeDemoData();
  settings.update((s) => ({ ...s, departureMin: d.defaultDepartureMin }));
  await loadAll(d.roads, d.facilities, d.context, d.defaultOrigin, d.calendar, d.defaultVia);
}

/** 点击地图设点：先吸附并展示候选 */
export async function requestSnap(
  point: LngLat,
  autoPickBest = false,
  purpose: 'origin' | 'via' = 'origin'
) {
  if (!client) return;
  snapPurpose.set(purpose);
  try {
    const { result } = await client.snap(point);
    pendingSnap.set(result);
    if (autoPickBest && result.best) {
      chooseSnap(result.best.edgeId);
    } else if (!result.best) {
      statusMessage.set('附近 100 米内没有可通行道路，请换个位置（该区域可能缺少道路数据）');
    }
  } catch (e) {
    statusMessage.set(`吸附失败：${e instanceof Error ? e.message : e}`);
  }
}

/** 用户确认某个候选边（按当前用途设为起点或接送点） */
export function chooseSnap(edgeId: string) {
  const snap = get(pendingSnap);
  if (!snap) return;
  const c = snap.candidates.find((x) => x.edgeId === edgeId);
  if (!c) return;
  const choice = { point: snap.point, edgeId: c.edgeId, fraction: c.fraction, proj: c.proj };
  if (get(snapPurpose) === 'via') {
    via.set(choice);
  } else {
    origin.set(choice);
  }
  pendingSnap.set(null);
  clickMode.set('inspect');
  scheduleSolve();
}

export function clearVia() {
  via.set(null);
  viaInfo.set(null);
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
  const mySeq = ++solveSeq;
  solving.set(true);
  try {
    if (s.timeMode) {
      // 时刻模式：FIFO 校验未通过时拒绝求解，而不是退回普通最短路
      const errs = get(tdErrors);
      if (errs.length > 0) {
        statusMessage.set(`时刻数据未通过 FIFO 校验（${errs.length} 项），已拒绝求解`);
        return;
      }
      const v = get(via);
      const res = await client.solveTd(
        o,
        v ? { choice: v, dwellMin: s.viaDwellMin } : null,
        s.departureMin,
        s.speedKmh / 3.6,
        s.maxMinutes,
        f
      );
      if (mySeq !== solveSeq) return; // 已有更新的请求，丢弃本次过期结果
      isochrone.set(res.iso1);
      isochrone2.set(res.iso2 ?? { type: 'FeatureCollection', features: [] });
      isoWaits.set(res.isoWaits);
      viaInfo.set(res.viaInfo);
      facilityResults.set(res.facilities);
      solveMs.set(res.solveMs);
      statusMessage.set(`时刻模式求解完成（${res.solveMs} ms），等时圈沿路网计算`);
    } else {
      const res = await client.solve(o, s.speedKmh / 3.6, s.maxMinutes, f);
      if (mySeq !== solveSeq) return;
      isochrone.set(res.isochrone);
      isochrone2.set({ type: 'FeatureCollection', features: [] });
      isoWaits.set([]);
      viaInfo.set(null);
      facilityResults.set(res.facilities);
      solveMs.set(res.solveMs);
      statusMessage.set(`求解完成（${res.solveMs} ms），等时圈沿路网计算`);
    }
  } catch (e) {
    if (mySeq === solveSeq) {
      statusMessage.set(`求解失败：${e instanceof Error ? e.message : e}`);
    }
  } finally {
    if (mySeq === solveSeq) solving.set(false);
  }
}

// ---------- 场景存取（IndexedDB） ----------

const DEFAULT_SETTINGS: Settings = {
  speedKmh: 5,
  maxMinutes: 22,
  timeMode: true,
  departureMin: 450,
  viaDwellMin: 5
};

function currentRecord(name: string): ScenarioRecord | null {
  const r = get(roads);
  const f = get(facilities);
  if (!r || !f) return null;
  return {
    id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || `场景 ${new Date().toLocaleString()}`,
    savedAt: Date.now(),
    roads: r,
    facilities: f,
    context: get(context),
    settings: get(settings),
    originPoint: get(origin)?.point ?? null,
    calendar: get(calendar),
    viaPoint: get(via)?.point ?? null
  };
}

export async function saveCurrentScenario(name: string) {
  const rec = currentRecord(name);
  if (!rec) {
    statusMessage.set('没有可保存的数据');
    return;
  }
  try {
    await saveScenario(rec);
    await refreshScenarios();
    statusMessage.set(`场景「${rec.name}」已保存到 IndexedDB`);
  } catch (e) {
    statusMessage.set(`保存失败：${e instanceof Error ? e.message : e}`);
  }
}

async function applyRecord(rec: ScenarioRecord) {
  // 兼容旧记录：补齐缺失的设置项与日历
  settings.set({ ...DEFAULT_SETTINGS, ...rec.settings });
  await loadAll(
    rec.roads,
    rec.facilities,
    rec.context,
    rec.originPoint,
    rec.calendar ?? { timezone: 'Asia/Shanghai', date: '2026-09-11' },
    rec.viaPoint ?? null
  );
}

export async function loadScenarioById(id: string) {
  const rec = await loadScenario(id);
  if (!rec) {
    statusMessage.set('场景不存在');
    return;
  }
  await applyRecord(rec);
  statusMessage.set(`场景「${rec.name}」已加载`);
}

export async function removeScenario(id: string) {
  await deleteScenario(id);
  await refreshScenarios();
}

// ---------- 离线导出 / 导入（保留时区与开放日历） ----------

export function exportScenarioJson() {
  const rec = currentRecord(`导出 ${new Date().toLocaleString()}`);
  if (!rec) {
    statusMessage.set('没有可导出的数据');
    return;
  }
  const payload = {
    format: 'walkreach-scenario',
    version: 2,
    exportedAt: new Date().toISOString(),
    ...rec
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `walkreach-${rec.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
  statusMessage.set('场景已导出（含时区与开放日历）');
}

export async function importScenarioJson(file: File) {
  try {
    const payload = JSON.parse(await file.text()) as Partial<ScenarioRecord> & { format?: string };
    if (payload.format !== 'walkreach-scenario' || !payload.roads || !payload.facilities) {
      throw new Error('不是有效的 WalkReach 场景文件');
    }
    await applyRecord({
      id: `import-${Date.now()}`,
      name: payload.name ?? file.name,
      savedAt: payload.savedAt ?? Date.now(),
      roads: payload.roads,
      facilities: payload.facilities,
      context: payload.context ?? emptyContext(),
      settings: { ...DEFAULT_SETTINGS, ...payload.settings },
      originPoint: payload.originPoint ?? null,
      calendar: payload.calendar ?? { timezone: 'Asia/Shanghai', date: '2026-09-11' },
      viaPoint: payload.viaPoint ?? null
    });
    statusMessage.set(`场景「${payload.name ?? file.name}」已导入（时区 ${payload.calendar?.timezone ?? '默认'}）`);
  } catch (e) {
    statusMessage.set(`导入失败：${e instanceof Error ? e.message : e}`);
  }
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
  await loadAll(fc, cur ?? { type: 'FeatureCollection', features: [] }, null, get(origin)?.point ?? null);
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
  await reloadNetwork();
}

export async function importBoundary(fc: FeatureCollection) {
  const c = get(context);
  const next: ContextData = { ...c, boundary: fc as ContextData['boundary'], boundaryApprox: false };
  context.set(next);
  await reloadNetwork();
}

async function reloadNetwork() {
  const r = get(roads);
  if (!r || !client) return;
  const res = await client.load(r, get(context), get(calendar));
  graphStats.set(res.stats);
  isolatedLines.set(res.isolatedLines);
  tdErrors.set(res.tdErrors);
  tdEdgeCount.set(res.tdEdges);
  scheduleSolve();
}
