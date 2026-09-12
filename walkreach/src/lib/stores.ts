import { derived, writable } from 'svelte/store';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type {
  ContextData,
  FacilitiesFC,
  FacilityResult,
  GraphStats,
  LngLat,
  OriginChoice,
  RoadsFC,
  ScenarioMeta,
  Settings,
  SnapResult
} from './types';

export const roads = writable<RoadsFC | null>(null);
export const facilities = writable<FacilitiesFC | null>(null);
export const context = writable<ContextData>({ water: null, boundary: null, boundaryApprox: false });
export const settings = writable<Settings>({ speedKmh: 5, maxMinutes: 15 });

export const graphStats = writable<GraphStats | null>(null);
export const isolatedLines = writable<LngLat[][]>([]);

export const origin = writable<OriginChoice | null>(null);
/** 点击地图后待确认的吸附候选 */
export const pendingSnap = writable<SnapResult | null>(null);
export const clickMode = writable<'origin' | 'inspect'>('inspect');

export const isochrone = writable<FeatureCollection<LineString>>({
  type: 'FeatureCollection',
  features: []
});
export const facilityResults = writable<FacilityResult[]>([]);
export const solveMs = writable<number>(0);
export const solving = writable(false);

export const selectedFacilityId = writable<string | null>(null);
export const scenarios = writable<ScenarioMeta[]>([]);
export const statusMessage = writable<string>('尚未加载数据');

/** 设施 + 求解状态合并，供地图着色与列表展示 */
export interface FacilityView {
  id: string;
  name: string;
  category: string;
  coord: LngLat;
  result: FacilityResult | null;
}
export const facilitiesView = derived([facilities, facilityResults], ([$fac, $results]) => {
  const byId = new Map($results.map((r) => [r.id, r]));
  const out: FacilityView[] = [];
  if ($fac) {
    for (const f of $fac.features) {
      const p = f.properties;
      out.push({
        id: p.id,
        name: p.name,
        category: p.category,
        coord: f.geometry.coordinates as LngLat,
        result: byId.get(p.id) ?? null
      });
    }
  }
  return out;
});

export const facilitiesFC = derived(facilitiesView, ($views) => {
  const features: Feature<Point>[] = $views.map((v) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: v.coord },
    properties: { id: v.id, name: v.name, category: v.category, status: v.result?.status ?? 'none' }
  }));
  return { type: 'FeatureCollection', features } as FeatureCollection<Point>;
});

/** 当前选中设施的路径 */
export const selectedPath = derived(
  [facilitiesView, selectedFacilityId],
  ([$views, $sel]): FeatureCollection<LineString> => {
    const v = $views.find((x) => x.id === $sel);
    if (!v?.result?.path) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: v.result.path },
          properties: { id: v.id }
        }
      ]
    };
  }
);

export const selectedFacility = derived([facilitiesView, selectedFacilityId], ([$views, $sel]) =>
  $views.find((x) => x.id === $sel)
);
