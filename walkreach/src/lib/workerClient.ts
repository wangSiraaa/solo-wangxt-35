import type {
  Calendar,
  ContextData,
  FacilitiesFC,
  GraphStats,
  LngLat,
  OriginChoice,
  RoadsFC,
  SnapResult
} from './types';
import type { SolvePayload, SolveTdPayload, ViaSpec, WorkerRes } from './workerProtocol';

/** 主线程侧的 Worker 客户端：Promise 化的请求/响应配对 */
export class SolverClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('../worker/solver.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerRes>) => {
      const msg = e.data;
      const p = this.pending.get(msg.req);
      if (!p) return;
      this.pending.delete(msg.req);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg as never);
    };
  }

  private call<T>(payload: Record<string, unknown>): Promise<T> {
    const req = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(req, { resolve: resolve as (v: never) => void, reject });
      this.worker.postMessage({ ...payload, req });
    });
  }

  load(
    roads: RoadsFC,
    context: ContextData,
    calendar: Calendar
  ): Promise<{ stats: GraphStats; isolatedLines: LngLat[][]; tdErrors: string[]; tdEdges: number }> {
    return this.call({ type: 'load', roads, context, calendar });
  }

  snap(point: LngLat): Promise<{ result: SnapResult }> {
    return this.call({ type: 'snap', point });
  }

  solve(
    origin: OriginChoice,
    speedMps: number,
    maxMinutes: number,
    facilities: FacilitiesFC
  ): Promise<SolvePayload> {
    return this.call({ type: 'solve', origin, speedMps, maxMinutes, facilities });
  }

  solveTd(
    origin: OriginChoice,
    via: ViaSpec | null,
    departureMin: number,
    speedMps: number,
    maxMinutes: number,
    facilities: FacilitiesFC
  ): Promise<SolveTdPayload> {
    return this.call({ type: 'solveTd', origin, via, departureMin, speedMps, maxMinutes, facilities });
  }

  terminate() {
    this.worker.terminate();
  }
}
