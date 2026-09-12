import type { Calendar, EdgeSchedule, RoadsFC, TimeWindow } from './types';
import type { EdgeRec } from './graphBuild';

/**
 * 出发时刻相关的边通行模型。
 *
 * 限定 FIFO 路段模型：每条边的通行时间为常数，封闭时允许在入口等待到下次开放。
 * 该模型下到达函数 A(t) = t + wait(t) + tt 单调不减（FIFO），
 * 因此标号设定的时变 Dijkstra 正确。任何破坏该前提的数据
 * （wait=false、窗口重叠、通行时间非正、时刻非法）都在加载时检测并拒绝，
 * 而不是继续套普通最短路。
 */

export interface ParsedWindow {
  /** 适用星期（0=周日..6=周六）；null 表示每天 */
  days: number[] | null;
  openM: number;
  closeM: number;
}

export interface ParsedSchedule {
  mode: 'open-only' | 'closed-during';
  windows: ParsedWindow[];
}

/** 等待函数：输入到达边入口的时刻（场景日零点起分钟），输出需等待的分钟数（可 Infinity） */
export type WaitFn = (t: number) => number;

export const WEEK_MIN = 7 * 1440;
/** 搜索时界：等待超过此时界视为在时界内不可达 */
export const HORIZON_MIN = 36 * 60;

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseTime(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 场景日期的星期几（0=周日）。日历日期的星期是天文定义的，与时区无关 */
export function weekdayOfDate(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // 严格校验：Date.UTC 会滚转溢出（如 13 月、40 日）
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.getUTCDay();
}

export function fmtClock(min: number): string {
  if (!isFinite(min)) return '—';
  const t = Math.round(min);
  const d = Math.floor(t / 1440);
  const hh = Math.floor((t % 1440) / 60);
  const mm = t % 60;
  const base = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return d > 0 ? `${base} (+${d}d)` : base;
}

/** 解析并校验一条边的 schedule；返回解析结果或错误说明 */
export function parseSchedule(raw: unknown): { sched?: ParsedSchedule; error?: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'schedule 必须是对象' };
  const r = raw as Record<string, unknown>;
  const mode = r.mode;
  if (mode !== 'open-only' && mode !== 'closed-during') {
    return { error: `未知 schedule.mode：${String(mode)}` };
  }
  if ((r as { wait?: unknown }).wait === false) {
    return { error: 'wait=false（封闭时不可等待）使到达函数非单调，不满足 FIFO 前提' };
  }
  if (!Array.isArray(r.windows) || r.windows.length === 0) {
    return { error: 'schedule.windows 不能为空' };
  }
  const windows: ParsedWindow[] = [];
  for (const w of r.windows as TimeWindow[]) {
    if (typeof w !== 'object' || w === null) return { error: '窗口必须是对象' };
    const openM = parseTime(w.open);
    const closeM = parseTime(w.close);
    if (openM === null || closeM === null) {
      return { error: `窗口时间格式错误（需要 HH:MM）：${String(w.open)}~${String(w.close)}` };
    }
    if (openM === closeM) return { error: '窗口 open 与 close 相同（零长度窗口）' };
    let days: number[] | null = null;
    if (w.days !== undefined) {
      if (!Array.isArray(w.days) || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return { error: '窗口 days 必须是 0..6 的整数数组' };
      }
      days = [...new Set(w.days as number[])].sort();
    }
    windows.push({ days, openM, closeM });
  }
  // 窗口重叠检查：展开到一周的绝对分钟区间后两两比较（跨夜窗口 end 可大于当周）
  const spans = windowSpans(windows);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]![0] < spans[i - 1]![1]) return { error: '同一时间存在重叠的窗口，语义二义' };
  }
  return { sched: { mode, windows } };
}

/** 把窗口展开为一周内的绝对分钟区间 [start, end)，按起点排序 */
function windowSpans(windows: ParsedWindow[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const w of windows) {
    const days = w.days ?? [0, 1, 2, 3, 4, 5, 6];
    for (const d of days) {
      const start = d * 1440 + w.openM;
      const end = w.closeM > w.openM ? d * 1440 + w.closeM : (d + 1) * 1440 + w.closeM;
      spans.push([start, end]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
}

/**
 * 构造边的等待函数。t 为场景日零点起的绝对分钟。
 * 返回值可能为 Infinity（一周内没有可用窗口）。
 */
export function makeWaitFn(sched: ParsedSchedule | null, baseWeekday: number): WaitFn {
  if (!sched) return () => 0;
  const spans = windowSpans(sched.windows);
  const toWeek = (t: number) => (((baseWeekday * 1440 + t) % WEEK_MIN) + WEEK_MIN) % WEEK_MIN;
  const containingSpan = (t: number): [number, number] | null => {
    const tw = toWeek(t);
    for (const [s, e] of spans) {
      if (tw >= s && tw < e) return [s, e];
    }
    return null;
  };
  const openAt = (t: number) =>
    sched.mode === 'closed-during' ? containingSpan(t) === null : containingSpan(t) !== null;

  return (t: number) => {
    if (openAt(t)) return 0;
    if (sched.mode === 'closed-during') {
      // 等到当前（可能连续的）封闭区间结束
      let cur = t;
      for (let i = 0; i < 16; i++) {
        const span = containingSpan(cur);
        if (!span) break;
        cur += span[1] - toWeek(cur);
      }
      return cur - t;
    }
    // open-only：找下一个开放窗口的起点
    const tw = toWeek(t);
    let best = Infinity;
    for (const [s] of spans) {
      const delta = s >= tw ? s - tw : s + WEEK_MIN - tw;
      if (delta < best) best = delta;
    }
    return best;
  };
}

/** 等待 + 常数通行时间的到达函数；等待超过时界视为不可达 */
export function arriveOnEdge(waitFn: WaitFn, ttMin: number, t: number): number {
  const w = waitFn(t);
  if (!isFinite(w) || w > HORIZON_MIN) return Infinity;
  return t + w + ttMin;
}

/**
 * FIFO 抽查：在时界内采样，验证到达函数单调不减。
 * 本模型在构造上即满足 FIFO，此处作为数据/模型变更时的防御性检查；
 * 只比较有限值（时界截断产生的 Infinity 不参与单调性判定）。
 */
export function fifoSpotCheck(waitFn: WaitFn, ttMin: number, stepMin = 1): string | null {
  let prev = -Infinity;
  for (let t = 0; t <= HORIZON_MIN; t += stepMin) {
    const a = arriveOnEdge(waitFn, ttMin, t);
    if (isFinite(a)) {
      if (a < prev - 1e-9) {
        return `到达函数在 t=${t.toFixed(0)} 处回退（${prev.toFixed(1)} → ${a.toFixed(1)}），不满足 FIFO`;
      }
      prev = a;
    }
  }
  return null;
}

/**
 * 校验时变数据是否满足 FIFO 前提。返回错误列表（空 = 通过）。
 * 有任何错误时，调用方必须拒绝时刻模式求解，而不是退回普通最短路。
 */
export function validateTdData(
  roads: RoadsFC,
  calendar: Calendar,
  edges: Map<string, EdgeRec>,
  waitFns: Map<string, WaitFn>,
  speedMps: number
): string[] {
  const errors: string[] = [];
  if (!calendar.timezone) {
    errors.push('场景日历缺少时区（timezone）');
  } else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: calendar.timezone });
    } catch {
      errors.push(`无效时区：${calendar.timezone}`);
    }
  }
  if (weekdayOfDate(calendar.date) === null) {
    errors.push(`场景日期无效（需要 YYYY-MM-DD）：${calendar.date}`);
  }
  for (const f of roads.features) {
    const raw = f.properties?.schedule;
    if (raw === undefined) continue;
    const name = String(f.properties?.name ?? '(未命名路段)');
    const { error } = parseSchedule(raw);
    if (error) errors.push(`${name}: ${error}`);
  }
  for (const e of edges.values()) {
    if (e.scheduleRaw === undefined) continue;
    if (e.lengthM <= 0.5) {
      errors.push(`${e.name}: 路段长度为零，通行时间非正，不满足 FIFO 前提`);
      continue;
    }
    const wf = waitFns.get(e.id);
    if (wf) {
      const violation = fifoSpotCheck(wf, e.lengthM / speedMps / 60);
      if (violation) errors.push(`${e.name}: ${violation}`);
    }
  }
  return errors;
}

export type { EdgeSchedule, Calendar };
