/**
 * AI 决策策略。
 *
 * 输入当前牌局状态，输出一个合法动作。所有档位共用本逻辑，差异来自 tiers.ts 的参数。
 * 决策是确定性的（给定 rng 状态与状态机，输出确定），便于单测与回放。
 */

import { legalActions, amountToCall, liveCount } from '../core/betting.js';
import { computeEquity, AI_ITERATIONS, potOdds } from '../core/equity/index.js';
import { totalPot } from '../core/hand.js';
import { createRng, type Rng } from '../core/rng.js';
import { rank7 } from '../core/rank7.js';
import type { ActionType, HandState } from '../core/types.js';
import { preflopStrength, positionFactor } from './preflopChart.js';
import { tierParams } from './tiers.js';

export interface AIDecision {
  type: ActionType;
  toAmount: number;
  /** 决策依据（用于调试与测试断言）。 */
  debug: {
    tier: string;
    strength: number;
    equity: number;
    potOdds: number;
    reason: string;
  };
}

/** 后翻牌的手牌强度启发式（0..1），仅在非困难档使用。 */
function heuristicStrength(state: HandState, seatIndex: number): number {
  const hole = state.seats[seatIndex].holeCards;
  const board = state.board;
  const all = [...hole, ...board];
  const value = rank7(all);
  const cat = Math.floor(value / 1048576);

  // 牌型类别映射到基础强度
  const byCat = [0.12, 0.32, 0.52, 0.66, 0.74, 0.82, 0.92, 0.97, 1.0];
  let s = byCat[cat] ?? 0.2;

  // 高牌与一对时，用最大牌点数做微调（A 高比 9 高好）
  if (cat <= 1) {
    const topRank = Math.max(...hole.map((c) => c >> 2));
    s += (topRank / 12) * 0.12;
  }
  return Math.max(0, Math.min(1, s));
}

/** 决策耗时预算：困难档需要蒙特卡洛，限制迭代数。 */
export function decideAI(
  state: HandState,
  seatIndex: number,
  rng: Rng = createRng(state.seed ^ (seatIndex * 2654435761)),
): AIDecision {
  const seat = state.seats[seatIndex];
  const params = tierParams(seat.tier);
  const legal = legalActions(state, seatIndex);
  const pot = totalPot(state);
  const toCall = amountToCall(state, seatIndex);

  const opponents = Math.max(1, liveCount(state) - 1);
  const isPreflop = state.street === 'preflop';

  // 强度评估
  let strength: number;
  if (isPreflop) {
    const seatFromDealer = (seatIndex - state.dealerSeat + state.seatCount) % state.seatCount;
    strength = preflopStrength(seat.holeCards) * positionFactor(seatFromDealer, state.seatCount);
  } else {
    strength = heuristicStrength(state, seatIndex);
  }

  // 胜率：困难档用蒙特卡洛；其余档用强度近似（不做采样，保证速度）
  let equity = strength;
  if (params.useEquity && state.board.length > 0) {
    const r = computeEquity({
      hero: seat.holeCards,
      board: state.board,
      opponents,
      iterations: params.equityIterations || AI_ITERATIONS,
      rng,
    });
    equity = r.equity;
  } else if (params.useEquity && state.board.length === 0) {
    // 翻牌前困难档也查表（零延迟）
    const r = computeEquity({ hero: seat.holeCards, board: [], opponents, rng });
    equity = r.equity;
  }

  const po = toCall > 0 ? potOdds(toCall, pot) : 0;
  const requiredEquity = po * params.potOddsMargin;

  // ---- 决策规则 ----

  // 1. 无人下注：可用强度决定是否下注（或过牌）
  if (toCall === 0) {
    if (strength >= params.preflopThreshold + 0.25 && legal.canRaise) {
      const target = Math.round(pot * params.raiseSizeFactor) + state.bigBlind;
      const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, target));
      return mk('bet', to, seat.tier, strength, equity, po, '强牌主动下注');
    }
    // 诈唬
    if (rng.next() < params.bluffFrequency && legal.canRaise) {
      const target = Math.round(pot * params.raiseSizeFactor);
      const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, target));
      return mk('bet', to, seat.tier, strength, equity, po, '诈唬下注');
    }
    if (legal.canCheck) return mk('check', 0, seat.tier, strength, equity, po, '无下注，过牌');
  }

  // 2. 面对下注：严格执行赔率（困难档）或按阈值弃牌
  if (toCall > 0) {
    const potCommitted = seat.committedThisStreet > 0;
    const facingRaise = state.currentBet > state.bigBlind && !isPreflop;

    if (params.strictPotOdds && equity < requiredEquity) {
      // 胜率不足赔率要求 → 弃牌
      if (legal.canFold) return mk('fold', 0, seat.tier, strength, equity, po, '胜率低于底池赔率要求');
    }

    if (facingRaise && strength < params.foldToRaiseThreshold && params.strictPotOdds) {
      if (legal.canFold) return mk('fold', 0, seat.tier, strength, equity, po, '面对加注且牌力不足');
    }

    // 强牌加注
    if (strength >= params.preflopThreshold + 0.3 && legal.canRaise) {
      const target = seat.committedThisStreet + Math.round((pot + toCall) * params.raiseSizeFactor);
      const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, target));
      return mk('raise', to, seat.tier, strength, equity, po, '强牌加注');
    }

    // 诈唬加注
    if (rng.next() < params.bluffFrequency * 0.5 && legal.canRaise) {
      const target = seat.committedThisStreet + Math.round((pot + toCall) * params.raiseSizeFactor);
      const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, target));
      return mk('raise', to, seat.tier, strength, equity, po, '诈唬加注');
    }

    // 跟注：困难档要求满足赔率；其他档按宽容系数
    if (legal.canCall) {
      const okToCall = params.strictPotOdds
        ? equity >= requiredEquity
        : equity >= po * params.potOddsMargin || strength >= params.preflopThreshold * 0.6;
      if (okToCall) return mk('call', 0, seat.tier, strength, equity, po, '跟注');
      if (params.strictPotOdds && legal.canFold) {
        return mk('fold', 0, seat.tier, strength, equity, po, '赔率不支持跟注');
      }
      // 简单/中等档即使赔率不佳也可能跟注（体现「松」）
      if (!params.strictPotOdds) {
        return mk('call', 0, seat.tier, strength, equity, po, '宽松跟注');
      }
    }
    void potCommitted;
  }

  // 3. 兜底：能过牌则过牌，否则弃牌
  if (legal.canCheck) return mk('check', 0, seat.tier, strength, equity, po, '兜底过牌');
  if (legal.canFold) return mk('fold', 0, seat.tier, strength, equity, po, '兜底弃牌');
  return mk('check', 0, seat.tier, strength, equity, po, '无合法动作，默认过牌');
}

function mk(
  type: ActionType,
  toAmount: number,
  tier: string,
  strength: number,
  equity: number,
  po: number,
  reason: string,
): AIDecision {
  return { type, toAmount, debug: { tier, strength, equity, potOdds: po, reason } };
}
