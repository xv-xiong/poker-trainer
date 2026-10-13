/**
 * 主线程侧 Worker 客户端：带请求 id 匹配与降级路径。
 *
 * 降级：若浏览器不支持 Worker 或创建失败，回退为同步计算（会短暂阻塞，
 * 但保证功能可用而非白屏）。
 */

import type { EquityRequest, EquityResponse } from '../core/equity/index.js';
import { computeEquity } from '../core/equity/index.js';
import { createRng } from '../core/rng.js';
import type { EquityWorkerRequest, EquityWorkerResponse } from '../workers/equity.worker.js';

export interface EquityClient {
  request(req: EquityRequest): Promise<EquityResponse>;
  /** 是否真的在使用 Worker（界面可据此显示提示）。 */
  readonly usingWorker: boolean;
  dispose(): void;
}

export function createEquityClient(): EquityClient {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, { resolve: (r: EquityResponse) => void; reject: (e: Error) => void }>();

  try {
    worker = new Worker(new URL('../workers/equity.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<EquityWorkerResponse>) => {
      const { id, ok, result, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok && result) p.resolve(result);
      else p.reject(new Error(error ?? '未知 Worker 错误'));
    };
    worker.onerror = () => {
      // Worker 运行时错误：让所有等待中的请求走降级
      for (const [, p] of pending) p.reject(new Error('Worker 运行时错误'));
      pending.clear();
    };
  } catch {
    worker = null;
  }

  const usingWorker = worker !== null;

  return {
    usingWorker,
    request(req: EquityRequest): Promise<EquityResponse> {
      if (!worker) {
        // 降级：同步计算
        try {
          return Promise.resolve(computeEquity(req));
        } catch (e) {
          return Promise.reject(e as Error);
        }
      }
      const id = ++seq;
      const payload: EquityWorkerRequest = {
        id,
        hero: [...req.hero],
        board: [...req.board],
        opponents: req.opponents,
        iterations: req.iterations,
        allowFlopExact: req.allowFlopExact,
        seed: req.rng ? req.rng.state : createRng(0x5eed).state,
      };
      return new Promise<EquityResponse>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker!.postMessage(payload);
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      pending.clear();
    },
  };
}
