/**
 * 胜率计算 Web Worker（浏览器后台线程）。
 *
 * 为什么必须用 Worker：实测 6 人桌蒙特卡洛 20,000 次迭代约 210-243ms，
 * 转牌单挑精确枚举约 80ms。若在渲染线程执行会造成明显卡顿（远超单帧 16ms 预算）。
 * 全部重计算移入本 Worker，主线程保持响应。
 *
 * 单挑翻牌精确枚举（约 1.8 秒）也在本 Worker 内，仅在用户显式开启时调用。
 */

import { computeEquity, type EquityRequest, type EquityResponse } from '../core/equity/index.js';
import { createRng } from '../core/rng.js';

export interface EquityWorkerRequest {
  id: number;
  hero: number[];
  board: number[];
  opponents: number;
  iterations?: number;
  allowFlopExact?: boolean;
  seed?: number;
}

export interface EquityWorkerResponse {
  id: number;
  ok: boolean;
  result?: EquityResponse;
  error?: string;
}

self.onmessage = (ev: MessageEvent<EquityWorkerRequest>): void => {
  const req = ev.data;
  try {
    const equityReq: EquityRequest = {
      hero: req.hero,
      board: req.board,
      opponents: req.opponents,
      iterations: req.iterations,
      allowFlopExact: req.allowFlopExact,
      rng: createRng(req.seed ?? 0x5eed),
    };
    const result = computeEquity(equityReq);
    const msg: EquityWorkerResponse = { id: req.id, ok: true, result };
    (self as unknown as Worker).postMessage(msg);
  } catch (e) {
    const msg: EquityWorkerResponse = {
      id: req.id,
      ok: false,
      error: (e as Error).message,
    };
    (self as unknown as Worker).postMessage(msg);
  }
};
