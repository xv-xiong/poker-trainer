/**
 * 决策复盘 EV 计算与偏离分级。
 *
 * 判定基准（Q14 定案）：启发式 EV 阈值，不引 GTO 求解器。
 * 对每个决策点计算「实际动作 EV − 推荐动作 EV」：
 *   EV(弃牌) = 0（以当前时点为基准，已投入的筹码是沉没成本）
 *   EV(跟注) = 胜率 x 底池 − (1 − 胜率) x 跟注额
 *   EV(加注) = 弃牌概率 x 底池 + (1 − 弃牌概率) x 被跟注时的 EV
 *
 * ## 为什么加注分支要重写（v1.2 修复）
 *
 * 旧实现有三处叠加的错误，导致「建议动作」几乎恒为加注、分级变成底池大小的函数：
 *
 *   1. `calledProb = 0.75 − 0.12·sizeRatio`，下限硬编码 0.25 —— 被跟注概率
 *      **与牌力无关**。任何下注都白得至少 25% 的弃牌收益，哪怕手里是 7 高。
 *   2. 被跟注时胜率仍等于摊牌胜率 —— 现实中跟注范围比随机手牌强，
 *      下注越大被跟注时的实际胜率越低，模型没有这个衰减。
 *   3. 基线不统一：弃牌分支是 0、加注未跟注分支直接给 `pot`，
 *      而跟注分支是 `e·pot − (1−e)·toCall`。同一个「赢下底池」在三处口径不同，
 *      EV 差值失去经济含义（实测：胜率 25% 时过牌被判「明显偏离 2.4BB」）。
 *
 * 现在的模型：
 *   - 三个动作统一用「净筹码变化」为基准，加注在 `invest = toCall` 时
 *     退化为跟注公式（可证：e·(pot+invest−toCall) − (1−e)·invest = e·pot − (1−e)·toCall）。
 *   - 弃牌概率随**胜率**与**下注尺度**同时下降：牌越强对手越难弃牌，
 *     下注越大对手越难跟注。范围夹在 [0.05, 0.60]，不做「保底送收益」。
 *   - 被跟注时胜率按尺度衰减 `e' = e·(1 − 0.3·sizeRatio)`（下注越大，
 *     跟注范围越强），并夹在 [0, e]。
 *
 * 分级阈值：EV 损失 > 0.5BB 标记「值得复盘」；> 2BB 标记「明显偏离」。
 * 另有 0.2BB 的「可接受容差」：与最优相差不足 0.2BB 时不推荐边际加注
 * （见 `recommendAction`），避免把噪声当结论教给用户。
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

/**
 * 「可接受容差」（BB）：两个动作的 EV 差在这个范围内视为等价，
 * 不据此判偏离、也不把边际动作当成「标准答案」。
 */
export const ACCEPT_TOLERANCE_BB = 0.2;

export interface DecisionInput {
  equity: number;
  pot: number;
  toCall: number;
  /**
   * 加注需要**额外投入**的筹码（增量，不是「加注到」的总额）。
   *
   * 口径变更（v1.2）：旧实现把它当成总额、再 `min(raiseTo, stack)`，
   * 会把本街已投入的筹码重复计入，导致加注 EV 系统性偏乐观。
   */
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

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 估算三种动作的 EV（单位：筹码，以当前时点为基准的净变化）。
 *
 * 这是启发式近似，用于**相对比较**而非绝对收益预测；参数来自
 * 「让 200 手固定种子样本的非正常决策占比回到 20–30%」这一标定目标
 * （见 tests/unit/review-distribution.test.ts）。
 */
export function estimateEvs(input: DecisionInput): EvBreakdown {
  const { equity, pot, toCall, raiseTo, stack, bigBlind } = input;
  const e = clamp(equity, 0, 1);

  const fold = 0;
  // 跟注 EV：e·pot − (1−e)·toCall（与 equity/callEv 同口径，盈亏平衡点为 potOdds）
  const call = toCall <= 0 ? e * pot : e * pot - (1 - e) * toCall;

  // 加注：invest 是本次要**再投入**的筹码（夹在 [0, 剩余筹码]）
  const invest = clamp(raiseTo, 0, Math.max(0, stack));
  // 下注尺度：相对「底池」与「一个大盲」的较大者；夹在 [0, 3] 避免全下时爆表
  const sizeRatio = clamp(invest / Math.max(bigBlind, pot), 0, 3);

  // 弃牌概率：牌越强（对手更可能跟）越低，下注越大（对手更可能弃）越低。
  // 不设「保底弃牌收益」——那正是旧模型「任何牌都该加注」的根源。
  const pFoldBet = clamp(0.55 - 0.5 * e - 0.35 * sizeRatio, 0.05, 0.6);
  // 面对下注时的「加注」与无人下注时的「主动下注」必须区分：
  // 对手已经下注 = 已表现出强度，一次加注能让他弃牌的比例远低于主动下注。
  // 不做这个区分，模型会认为「5% 胜率也可以加注诈唬」——因为把 35% 的
  // 主动下注弃牌率直接套到了加注上（实测该情形加注 EV +29 > 弃牌 0）。
  const pFold = toCall > 0 ? pFoldBet * 0.55 : pFoldBet;
  // 被跟注时胜率衰减：跟注范围比随机手牌强，下注越大衰减越明显
  const eqWhenCalled = clamp(e * (1 - 0.3 * sizeRatio), 0, e);

  // 被跟注时的净 EV：赢 → 净得 (pot + invest − toCall)；输 → 损失 invest
  //   （对手跟注 invest − toCall，故最终底池 = pot + 2·invest − toCall，
  //     减去自己投入 invest，净得 pot + invest − toCall）
  const evWhenCalled = eqWhenCalled * (pot + invest - toCall) - (1 - eqWhenCalled) * invest;
  // 未被跟注：直接赢下当前底池（相对弃牌基准 0 的净收益）
  const evWhenFold = pot;
  const raise = pFold * evWhenFold + (1 - pFold) * evWhenCalled;

  return { fold, call, raise };
}

/** 从 EV 拆解中选出数值最优的动作。 */
export function bestActionOf(evs: EvBreakdown): { action: ActionType; ev: number } {
  let best: { action: ActionType; ev: number } = { action: 'fold', ev: evs.fold };
  if (evs.call > best.ev) best = { action: 'call', ev: evs.call };
  if (evs.raise > best.ev) best = { action: 'raise', ev: evs.raise };
  return best;
}

/**
 * 推荐动作：在 `bestActionOf` 之上加「容差内优先稳健动作」的规则。
 *
 * 为什么需要：旧模型下 10% 胜率的过牌只比加注差 0.12BB，却会被写成
 * 「建议动作：加注」——把模型噪声当成标准答案教给用户，比不推荐更糟。
 * 现在当加注只比跟注/过牌高出不到 `toleranceChips` 时，推荐跟注/过牌。
 */
export function recommendAction(
  evs: EvBreakdown,
  toleranceChips: number,
): { action: ActionType; ev: number } {
  const best = bestActionOf(evs);
  const tol = Math.max(0, toleranceChips);
  if (best.action === 'raise' && evs.call >= best.ev - tol) {
    return { action: 'call', ev: evs.call };
  }
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

    // 关键：必须用**决策时点**的剩余筹码（a.stackAtAction），
    // 不能用 state.seats[heroSeat].stack —— 复盘在整手结束后才计算，
    // 那时的 stack 已是终局值（全下后为 0），会得出偏小甚至为 0 的建议加注额。
    const stackAtDecision = a.stackAtAction;

    // 候选加注尺度：半个底池（至少一个大盲），且不超过决策时点剩余筹码。
    // 注意这里算的是「额外投入」，展示给用户的「加注到」= 本街已投入 + 增量。
    const halfPot = Math.max(state.bigBlind, Math.round((pot + toCall) * 0.5));
    const invest = Math.max(0, Math.min(halfPot, stackAtDecision));
    const raiseTotal = a.toAmount + invest;

    const evs = estimateEvs({
      equity,
      pot,
      toCall,
      raiseTo: invest,
      stack: stackAtDecision,
      bigBlind: state.bigBlind,
    });

    const actualKey = normalizeAction(a.type);
    const actualEv = evs[actualKey];
    // 推荐动作带 0.2BB 容差：边际加注不会被写成「标准答案」
    const best = recommendAction(evs, state.bigBlind * ACCEPT_TOLERANCE_BB);
    const evLoss = Math.max(0, best.ev - actualEv);

    out.push({
      seat: a.seat,
      street: a.street,
      actionIndex: i,
      actual: a.type,
      actualAmount: a.amount,
      bestAction: best.action,
      bestAmount: best.action === 'raise' ? raiseTotal : best.action === 'call' ? toCall : 0,
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
