import type {
  Calendar,
  ContextData,
  FacilitiesFC,
  FacilityResult,
  GraphStats,
  LngLat,
  OriginChoice,
  RoadsFC,
  SnapResult,
  WaitEvent
} from './types';
import type { FeatureCollection, LineString } from 'geojson';

export interface LoadReq {
  type: 'load';
  req: number;
  roads: RoadsFC;
  context: ContextData;
  calendar: Calendar;
}
export interface LoadRes {
  type: 'loaded';
  req: number;
  stats: GraphStats;
  /** 与主连通分量断开的路段几何（前端高亮用） */
  isolatedLines: LngLat[][];
  /** 时变数据 FIFO 校验错误（非空时禁止时刻模式求解） */
  tdErrors: string[];
  /** 带时间表的边数 */
  tdEdges: number;
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

export interface ViaSpec {
  choice: OriginChoice;
  dwellMin: number;
}

export interface SolveTdReq {
  type: 'solveTd';
  req: number;
  origin: OriginChoice;
  via: ViaSpec | null;
  departureMin: number;
  speedMps: number;
  maxMinutes: number;
  facilities: FacilitiesFC;
}
export interface SolveTdRes {
  type: 'solvedTd';
  req: number;
  /** 第一段等时圈（有接送点时覆盖到实际到达接送点为止） */
  iso1: FeatureCollection<LineString>;
  /** 第二段等时圈（从 到达+停留 时刻起算）；无接送点时为 null */
  iso2: FeatureCollection<LineString> | null;
  /** 网络上发生等待的位置 */
  isoWaits: { at: LngLat; waitMin: number; label: string; clockMin: number }[];
  facilities: FacilityResult[];
  viaInfo: { arrivalMin: number; departMin: number } | null;
  solveMs: number;
}

export type WorkerReq = LoadReq | SnapReq | SolveReq | SolveTdReq;
export type WorkerRes = LoadRes | SnapRes | SolveRes | SolveTdRes | { type: 'error'; req: number; message: string };

export interface SolvePayload {
  isochrone: FeatureCollection<LineString>;
  facilities: FacilityResult[];
  solveMs: number;
}

export interface SolveTdPayload {
  iso1: FeatureCollection<LineString>;
  iso2: FeatureCollection<LineString> | null;
  isoWaits: { at: LngLat; waitMin: number; label: string; clockMin: number }[];
  facilities: FacilityResult[];
  viaInfo: { arrivalMin: number; departMin: number } | null;
  solveMs: number;
}

export type { WaitEvent };
