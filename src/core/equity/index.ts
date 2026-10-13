/**
 * 分级胜率调度器（equity router）。
 *
 * 路由规则为「对阵规模 x 街」二维分级（原计划只按街分级，实测发现多人数桌
 * 精确枚举组合上不可行，故按实测修正）：
 *
 *   街      单挑（1 对手）                        多人桌（>=2 对手）
 *   翻牌前  查表（169 手，确定性）                查表（169 手，确定性）
 *   翻牌    精确枚举 1,070,190 摊牌（约 1.8s，   蒙特卡洛
 *           默认关闭，仅「设置-高级」可开）
 *   转牌    精确枚举 45,540 摊牌（约 80ms）       蒙特卡洛
 *   河牌    精确枚举 990 摊牌（约 1.7ms，可同步） 蒙特卡洛
 *
 * 实测耗时（Node 24.21.0 / Windows，预热后中位数）：
 *   河牌单挑 1.7ms｜转牌单挑 80.6ms｜翻牌单挑 1823.9ms
 *   6 人桌蒙特卡洛 20,000 次：翻牌前 243.2ms｜翻牌 234.7ms｜转牌 224.5ms｜河牌 210.9ms
 *   吞吐：6 人桌 79,365 次迭代/秒（0.48M 次 rank7 求值/秒）
 */

import type { Card } from '../cards.js';
import type { Rng } from '../rng.js';
import { createRng } from '../rng.js';
import { exactEquityHU } from './exact.js';
import { monteCarloEquity } from './montecarlo.js';
import { lookupPreflop } from './lookup.js';

export type EquitySource = 'lookup' | 'exact' | 'montecarlo';

export interface EquityRequest {
  hero: readonly Card[];
  board: readonly Card[];
  /** 对手数量（1 = 单挑）。 */
  opponents: number;
  /** 蒙特卡洛迭代次数；默认 20,000。 */
  iterations?: number;
  /** 是否允许翻牌单挑精确枚举（约 1.8 秒）。默认 false。 */
  allowFlopExact?: boolean;
  /** 随机源；未提供时用固定种子创建（保证同输入同输出）。 */
  rng?: Rng;
}

export interface EquityResponse {
  equity: number;
  source: EquitySource;
  /** 精确枚举时的实际摊牌数（用于 G3 断言）；其他来源为 null。 */
  showdowns: number | null;
  /** 蒙特卡洛迭代次数；其他来源为 null。 */
  iterations: number | null;
  /** 估算耗时（毫秒）。 */
  elapsedMs: number;
}

export const DEFAULT_ITERATIONS = 20_000;
/** AI 决策用较低预算以控制延迟（实测约 38ms）。 */
export const AI_ITERATIONS = 3_000;

/** 按分级规则选择路径并计算胜率。 */
export function computeEquity(req: EquityRequest): EquityResponse {
  const { hero, board, opponents } = req;
  const iterations = req.iterations ?? DEFAULT_ITERATIONS;
  const t0 = Date.now();

  // 翻牌前：一律查表（确定性、零延迟）
  if (board.length === 0) {
    const hit = lookupPreflop(hero, opponents);
    if (hit !== null) {
      return {
        equity: hit,
        source: 'lookup',
        showdowns: null,
        iterations: null,
        elapsedMs: Date.now() - t0,
      };
    }
    // 查表未命中（例如对局中途人数变化）：退化为蒙特卡洛
    const rng = req.rng ?? createRng(0x5eed);
    const mc = monteCarloEquity(hero, board, { iterations, opponents, rng });
    return {
      equity: mc.equity,
      source: 'montecarlo',
      showdowns: null,
      iterations: mc.iterations,
      elapsedMs: Date.now() - t0,
    };
  }

  // 单挑：转牌与河牌走精确枚举；翻牌默认蒙特卡洛（1.8s 超交互预算）
  if (opponents === 1) {
    if (board.length === 5 || board.length === 4) {
      const ex = exactEquityHU(hero, board);
      return {
        equity: ex.equity,
        source: 'exact',
        showdowns: ex.showdowns,
        iterations: null,
        elapsedMs: Date.now() - t0,
      };
    }
    if (board.length === 3 && req.allowFlopExact) {
      const ex = exactEquityHU(hero, board);
      return {
        equity: ex.equity,
        source: 'exact',
        showdowns: ex.showdowns,
        iterations: null,
        elapsedMs: Date.now() - t0,
      };
    }
  }

  // 其余情形：蒙特卡洛
  const rng = req.rng ?? createRng(0x5eed);
  const mc = monteCarloEquity(hero, board, { iterations, opponents, rng });
  return {
    equity: mc.equity,
    source: 'montecarlo',
    showdowns: null,
    iterations: mc.iterations,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * 底池赔率：需要跟注额 / (当前底池 + 跟注额)。
 * 返回「至少需要多少胜率才值得跟注」，即跟注的盈亏平衡胜率。
 *
 * 推导：设跟注前底池为 P、需跟注 C。跟注后底池为 P + C。
 *   赢：净得 (P + C) - C = P
 *   输：净失 C
 *   EV = e·P - (1-e)·C，令 EV = 0 得 e = C / (P + C)
 */
export function potOdds(toCall: number, pot: number): number {
  if (toCall <= 0) return 0;
  return toCall / (pot + toCall);
}

/**
 * 跟注的期望值（以当前时点为基准，弃牌 EV 记为 0）。
 *
 * @param equity 估算胜率
 * @param toCall 需跟注额
 * @param pot 跟注**前**的底池额（含对手已下注的筹码，不含本次跟注）
 *
 * 公式：EV = equity·pot - (1 - equity)·toCall
 * 注意：不能写成 equity·(pot + toCall) - ...，那会把「跟注额被收回」
 * 重复计入收益（多算 equity·toCall），导致盈亏平衡点与 potOdds 不一致。
 * 该错误由单测「胜率为 1 时跟注 EV 等于底池」捕获。
 */
export function callEv(equity: number, toCall: number, pot: number): number {
  if (toCall <= 0) return equity * pot;
  return equity * pot - (1 - equity) * toCall;
}
