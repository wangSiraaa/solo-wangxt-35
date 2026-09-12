import type { Feature, FeatureCollection, LineString, Point, Polygon, MultiPolygon } from 'geojson';

export type LngLat = [number, number];

/** 路网要素属性（导入的 GeoJSON 可带这些字段） */
export interface RoadProps {
  name?: string;
  highway?: string; // 'steps' 表示台阶，禁行
  oneway?: 'yes' | '-1' | 'no';
  bridge?: string;
  /** 时变通行规则（可选）；存在时进入“时刻模式”校验 */
  schedule?: EdgeSchedule;
  [k: string]: unknown;
}

/** 一个开放/封闭时间窗口；open/close 为本地时间 "HH:MM"，close<open 表示跨夜 */
export interface TimeWindow {
  /** 适用星期（0=周日..6=周六）；缺省为每天 */
  days?: number[];
  open: string;
  close: string;
}

/**
 * 边的时间表。FIFO 前提：封闭时允许在边入口等待（wait 缺省 true）。
 * wait=false 的“封路即不可走”边会使到达函数非单调，校验时必须拒绝。
 */
export interface EdgeSchedule {
  mode: 'open-only' | 'closed-during';
  wait?: boolean;
  windows: TimeWindow[];
}

/** 场景日历：时刻表按该时区的本地时间解释 */
export interface Calendar {
  timezone: string; // IANA 时区，如 Asia/Shanghai
  date: string; // YYYY-MM-DD，决定星期几
}

export interface FacilityProps {
  id: string;
  name: string;
  category: string;
  [k: string]: unknown;
}

export type RoadsFC = FeatureCollection<LineString, RoadProps>;
export type FacilitiesFC = FeatureCollection<Point, FacilityProps>;

/** 背景上下文：水体（吸附屏障）与数据范围边界 */
export interface ContextData {
  water: FeatureCollection<Polygon | MultiPolygon> | null;
  /** 数据覆盖范围；范围外的设施只能判定为“数据缺失”，不能判定为不可达 */
  boundary: FeatureCollection<Polygon | MultiPolygon> | null;
  /** 边界是否为路网包围盒近似（导入数据无边界时） */
  boundaryApprox: boolean;
}

export interface Settings {
  speedKmh: number;
  maxMinutes: number;
  /** 时刻模式：启用出发时刻相关的等待/通行函数 */
  timeMode: boolean;
  /** 出发时刻（场景日零点起的分钟数） */
  departureMin: number;
  /** 必经接送点停留分钟数 */
  viaDwellMin: number;
}

export type ReachStatus =
  | 'ok' // 可达
  | 'beyond-time' // 路网可达但超出时间上限
  | 'disconnected' // 路网断开（确定不可达）
  | 'stairs-only' // 仅台阶相连（台阶已禁行）
  | 'data-gap' // 离路网过远，疑似数据缺失，无法判定
  | 'outside-extent' // 在数据范围之外，无法判定
  | 'via-unreachable'; // 必经接送点不可达，第二段无从谈起

export const STATUS_TEXT: Record<ReachStatus, string> = {
  ok: '可达',
  'beyond-time': '超出时间上限',
  disconnected: '路网断开，不可达',
  'stairs-only': '仅台阶相连（台阶禁行）',
  'data-gap': '疑似数据缺失，无法判定',
  'outside-extent': '超出数据范围，无法判定',
  'via-unreachable': '必经接送点不可达'
};

/** 路径上的一次等待（限时边前等待或接送点停留） */
export interface WaitEvent {
  at: LngLat;
  waitMin: number;
  kind: 'wait' | 'dwell';
  /** 人类可读说明，如路段名 */
  label: string;
  /** 等待开始时刻（场景日零点起分钟） */
  clockMin: number;
}

export interface FacilityResult {
  id: string;
  status: ReachStatus;
  /** 实际步行时间（分钟），status 为 ok / beyond-time 时有值 */
  timeMin?: number;
  /** 沿路网步行距离（米） */
  distanceM?: number;
  /** 从起点到设施的路径坐标（含两端吸附短接线） */
  path?: LngLat[];
  /** 设施到路网的吸附距离（米） */
  snapDistM?: number;
  /** 时刻模式：到达时刻（场景日零点起分钟） */
  arrivalMin?: number;
  /** 时刻模式：全程等待合计（含接送点停留，分钟） */
  waitMin?: number;
  /** 时刻模式：路径上的等待事件 */
  waits?: WaitEvent[];
}

export interface SnapCandidate {
  edgeId: string;
  name: string;
  highway: string;
  /** 点击点到投影点的距离（米） */
  distM: number;
  /** 在边上的投影点 */
  proj: LngLat;
  /** 投影点沿边的比例 0..1 */
  fraction: number;
  /** 点击点→投影点的连线是否穿过水体屏障（吸到河对岸的风险） */
  crossesBarrier: boolean;
  /** 该边两个端点节点（候选节点）及到点击点的距离 */
  nodes: { id: string; distM: number }[];
}

export interface SnapResult {
  point: LngLat;
  candidates: SnapCandidate[];
  /** 自动采用的最佳候选（优先不穿屏障） */
  best: SnapCandidate | null;
}

export interface OriginChoice {
  point: LngLat;
  edgeId: string;
  fraction: number;
  proj: LngLat;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  directedEdges: number;
  components: number;
  stairsEdges: number;
  onewayEdges: number;
  /** 非主连通分量的边 id（用于高亮断开路段） */
  isolatedEdges: string[];
}

export interface ScenarioRecord {
  id: string;
  name: string;
  savedAt: number;
  roads: RoadsFC;
  facilities: FacilitiesFC;
  context: ContextData;
  settings: Settings;
  originPoint: LngLat | null;
  /** 场景日历（时区 + 日期），时变窗口按此解释；导出时必须保留 */
  calendar: Calendar;
  /** 必经接送点（吸附点），无则 null */
  viaPoint: LngLat | null;
}

export interface ScenarioMeta {
  id: string;
  name: string;
  savedAt: number;
}
