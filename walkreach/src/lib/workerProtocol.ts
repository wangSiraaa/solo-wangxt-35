import type {
  ContextData,
  FacilitiesFC,
  FacilityResult,
  GraphStats,
  LngLat,
  OriginChoice,
  RoadsFC,
  SnapResult
} from './types';
import type { FeatureCollection, LineString } from 'geojson';

export interface LoadReq {
  type: 'load';
  req: number;
  roads: RoadsFC;
  context: ContextData;
}
export interface LoadRes {
  type: 'loaded';
  req: number;
  stats: GraphStats;
  /** 与主连通分量断开的路段几何（前端高亮用） */
  isolatedLines: LngLat[][];
}

export interface SnapReq {
  type: 'snap';
  req: number;
  point: LngLat;
}
export interface SnapRes {
  type: 'snapResult';
  req: number;
  result: SnapResult;
}

export interface SolveReq {
  type: 'solve';
  req: number;
  origin: OriginChoice;
  speedMps: number;
  maxMinutes: number;
  facilities: FacilitiesFC;
}
export interface SolveRes {
  type: 'solved';
  req: number;
  isochrone: FeatureCollection<LineString>;
  facilities: FacilityResult[];
  solveMs: number;
}

export type WorkerReq = LoadReq | SnapReq | SolveReq;
export type WorkerRes = LoadRes | SnapRes | SolveRes | { type: 'error'; req: number; message: string };

export interface SolvePayload {
  isochrone: FeatureCollection<LineString>;
  facilities: FacilityResult[];
  solveMs: number;
}
