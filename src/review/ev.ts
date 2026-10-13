/**
 * 决策复盘 EV 计算与偏离分级。
 *
 * 判定基准（Q14 定案）：启发式 EV 阈值，不引 GTO 求解器。
 * 对每个决策点计算「实际动作 EV − 最优动作 EV」：
 *   EV(弃牌) = 0（以当前时点为基准）
 *   EV(跟注) = 胜率 x (底池 + 跟注额) − (1 − 胜率) x 跟注额
 *   EV(加注) 按加注额与被跟注概率估算
 *
 * 分级阈值：|EV 损失| > 0.5BB 标记「值得复盘」；> 2BB 标记「明显偏离」。
 *
 * 强制要求：每个标记必须同时展示原始数据（底池赔率、估算胜率、底池额、
 * 筹码额、思考耗时），否则无法学习。
 */

import type { ActionType, HandState, ReviewEntry, Street } from '../core/types.js';
import { potOdds } from '../core/equity/index.js';

export interface EvThresholds {
  /** 值得复盘的 EV 损失阈值（以 BB 为单位）。 */
  review: number;
  /** 明显偏离的 EV 损失阈值（以 BB 为单位）。 */
  major: number;
}

export const DEFAULT_THRESHOLDS: EvThresholds = { review: 0.5, major: 2.0 };

export interface DecisionInput {
  equity: number;
  pot: number;
  toCall: number;
  /** 加注「到」的额度（用于估算加注 EV）。 */
  raiseTo: number;
  /** 该座位剩余筹码。 */
  stack: number;
  bigBlind: number;
}

export interface EvBreakdown {
  fold: number;
  call: number;
  raise: number;
}

/**
 * 估算三种动作的 EV。
 *
 * 加注 EV 采用简化模型：假设加注后被跟注的概率随加注相对底池的大小递减，
 * 并假设被跟注时胜率不变。这是启发式近似，用于**相对比较**而非绝对收益预测。
 */
export function estimateEvs(input: DecisionInput): EvBreakdown {
  const { equity, pot, toCall, raiseTo, stack, bigBlind } = input;

  const fold = 0;
  // 跟注 EV：e·pot - (1-e)·toCall（与 equity/callEv 同口径，盈亏平衡点为 potOdds）
  const call = toCall <= 0 ? equity * pot : equity * pot - (1 - equity) * toCall;

  // 加注：投入额为 raiseTo（本街已投入不计入增量，简化按 raiseTo 计）
  const invest = Math.min(raiseTo, stack);
  const potAfter = pot + invest;
  // 被跟注概率：加注额相对底池越大，被跟注概率越低（0.25..0.75 区间）
  const sizeRatio = invest / Math.max(bigBlind, pot);
  const calledProb = Math.max(0.25, Math.min(0.75, 0.75 - 0.12 * sizeRatio));
  // 被跟注时：赢下 potAfter，输掉 invest；未被跟注时：直接赢下 pot
  const evWhenCalled = equity * potAfter - (1 - equity) * invest;
  const evWhenFold = pot;
  const raise = calledProb * evWhenCalled + (1 - calledProb) * evWhenFold;

  return { fold, call, raise };
}

/** 从 EV 拆解中选出最优动作。 */
export function bestActionOf(evs: EvBreakdown): { action: ActionType; ev: number } {
  let best: { action: ActionType; ev: number } = { action: 'fold', ev: evs.fold };
  if (evs.call > best.ev) best = { action: 'call', ev: evs.call };
  if (evs.raise > best.ev) best = { action: 'raise', ev: evs.raise };
  return best;
}

/** 按 EV 损失分级。 */
export function gradeEvLoss(evLoss: number, bigBlind: number, th = DEFAULT_THRESHOLDS): 'ok' | 'review' | 'major' {
  const inBB = evLoss / bigBlind;
  if (inBB > th.major) return 'major';
  if (inBB > th.review) return 'review';
  return 'ok';
}

/** 把动作归一化为 EV 拆解中的三类之一。 */
export function normalizeAction(type: ActionType): 'fold' | 'call' | 'raise' {
  switch (type) {
    case 'fold':
      return 'fold';
    case 'check':
    case 'call':
      return 'call';
    case 'bet':
    case 'raise':
    case 'allin':
      return 'raise';
  }
}

export interface ReviewContext {
  /** 每个决策点的胜率（由调用方用 equity 模块算好并传入，便于缓存）。 */
  equityAt: (actionIndex: number, seat: number, street: Street) => number;
  thresholds?: EvThresholds;
}

/**
 * 为一手牌生成复盘条目（仅针对玩家本人）。
 *
 * 为什么只复盘玩家本人：AI 的决策不构成「练习」对象；同时避免无谓计算。
 */
export function buildReview(
  state: HandState,
  heroSeat: number,
  ctx: ReviewContext,
): ReviewEntry[] {
  const out: ReviewEntry[] = [];
  const th = ctx.thresholds ?? DEFAULT_THRESHOLDS;

  for (const [i, a] of state.actions.entries()) {
    if (a.seat !== heroSeat) continue;

    const pot = a.potAtAction;
    const toCall = a.toCall;
    const equity = ctx.equityAt(i, a.seat, a.street);

    // 该决策点的可加注额度：以「本街投入 + 剩余筹码」为上界，取一个半池加注作为候选
    const seat = state.seats[heroSeat];
    const raiseTo = Math.min(
      a.toAmount + Math.max(state.bigBlind, Math.round((pot + toCall) * 0.5)),
      a.toAmount + seat.stack + (a.amount > 0 ? 0 : 0),
    );

    const evs = estimateEvs({
      equity,
      pot,
      toCall,
      raiseTo,
      stack: seat.stack,
      bigBlind: state.bigBlind,
    });

    const actualKey = normalizeAction(a.type);
    const actualEv = evs[actualKey];
    const best = bestActionOf(evs);
    const evLoss = Math.max(0, best.ev - actualEv);

    out.push({
      seat: a.seat,
      street: a.street,
      actionIndex: i,
      actual: a.type,
      actualAmount: a.amount,
      bestAction: best.action,
      bestAmount: best.action === 'raise' ? raiseTo : best.action === 'call' ? toCall : 0,
      actualEv,
      bestEv: best.ev,
      evLoss,
      grade: gradeEvLoss(evLoss, state.bigBlind, th),
      pot,
      toCall,
      potOdds: potOdds(toCall, pot),
      equity,
      thinkMs: a.thinkMs,
    });
  }

  return out;
}

/** 汇总复盘结果的分级计数。 */
export function countGrades(entries: readonly ReviewEntry[]): { ok: number; review: number; major: number } {
  const c = { ok: 0, review: 0, major: 0 };
  for (const e of entries) c[e.grade]++;
  return c;
}
