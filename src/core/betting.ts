/**
 * 下注轮状态机：合法动作集、最小加注、轮次推进。
 *
 * 规则（无限注德州，无前注、无 straddle、无抽水、盲注不递增）：
 * - 合法动作集 = { 弃牌, 跟注/过牌, 加注（含额度区间）, 全下 }。
 *   非法动作不出现在 UI，也不被状态机接受。
 * - 最小加注增量 = 上一次加注的增量；全下额不足最小加注时不重开加注权。
 * - 轮次结束条件：所有未弃牌且未全下的玩家都已行动，且投入额相等。
 * - 翻牌前行动从大盲左侧开始；翻牌后从庄家左侧第一个未弃牌者开始。
 */

import type { ActionType, HandState, Seat, Street } from './types.js';
import { STREET_ORDER } from './types.js';

/** 一次合法动作的额度约束。 */
export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  /** 最小加注「到」的额度。 */
  minRaiseTo: number;
  /** 最大加注「到」的额度（即全下）。 */
  maxRaiseTo: number;
  canAllIn: boolean;
  allInAmount: number;
}

/** 还需跟注的额度（不会超过自身筹码）。 */
export function amountToCall(state: HandState, seatIndex: number): number {
  const seat = state.seats[seatIndex];
  const need = state.currentBet - seat.committedThisStreet;
  return Math.max(0, Math.min(need, seat.stack));
}

/** 计算某座位的全部合法动作。 */
export function legalActions(state: HandState, seatIndex: number): LegalActions {
  const seat = state.seats[seatIndex];
  if (seat.folded || seat.allIn || seat.stack <= 0) {
    return {
      canFold: false,
      canCheck: false,
      canCall: false,
      callAmount: 0,
      canRaise: false,
      minRaiseTo: 0,
      maxRaiseTo: 0,
      canAllIn: false,
      allInAmount: 0,
    };
  }

  const toCall = amountToCall(state, seatIndex);
  const canCheck = toCall === 0;
  const canCall = toCall > 0;
  const canFold = true;

  // 加注「到」的上限 = 本街投入 + 剩余筹码（即全下）
  const maxRaiseTo = seat.committedThisStreet + seat.stack;

  // 最小加注增量：上一次加注的增量，至少为大盲
  const minIncrement = Math.max(state.lastRaiseSize, state.bigBlind);
  const minRaiseTo = state.currentBet + minIncrement;

  // 若剩余筹码不足以做一次完整最小加注，则只能全下（不能「加注」）
  const canRaise = maxRaiseTo >= minRaiseTo && maxRaiseTo > state.currentBet;
  const canAllIn = seat.stack > 0 && maxRaiseTo > state.currentBet;

  return {
    canFold,
    canCheck,
    canCall,
    callAmount: toCall,
    canRaise,
    minRaiseTo: canRaise ? minRaiseTo : maxRaiseTo,
    maxRaiseTo,
    canAllIn,
    allInAmount: seat.stack,
  };
}

/** 从某座位开始，找下一个仍可行动（未弃牌、未全下、有筹码）的座位；找不到返回 -1。 */
export function nextActionableSeat(state: HandState, from: number): number {
  const n = state.seatCount;
  for (let i = 1; i <= n; i++) {
    const s = (from + i) % n;
    const seat = state.seats[s];
    if (!seat.folded && !seat.allIn && seat.stack > 0) return s;
  }
  return -1;
}

/** 统计仍可行动（未弃牌且未全下）的座位数。 */
export function actionableCount(state: HandState): number {
  return state.seats.filter((s) => !s.folded && !s.allIn).length;
}

/** 统计未弃牌的座位数。 */
export function liveCount(state: HandState): number {
  return state.seats.filter((s) => !s.folded).length;
}

/**
 * 判断本街下注轮是否结束。
 * 条件：所有未弃牌且未全下的玩家都已行动，且投入额相等。
 * 另外：若未弃牌玩家只剩 1 人，或可行动者 <= 1 且投入已平，也结束。
 */
export function isStreetComplete(state: HandState): boolean {
  const live = state.seats.filter((s) => !s.folded);
  if (live.length <= 1) return true;

  const actionable = live.filter((s) => !s.allIn);
  if (actionable.length === 0) return true;

  // 若只剩一个可行动者，且他无需跟注（其余都全下且不高于他），则本街结束
  if (actionable.length === 1) {
    const only = actionable[0];
    // 若该玩家已行动且投入已追平最高额，则结束
    if (only.hasActedThisStreet && only.committedThisStreet >= state.currentBet) return true;
    // 若该玩家的投入已 >= 所有其他未弃牌玩家的投入，也结束
    const maxOther = Math.max(
      ...live.filter((s) => s.index !== only.index).map((s) => s.committedThisStreet),
      0,
    );
    if (only.committedThisStreet >= maxOther) return true;
    return false;
  }

  // 常规条件：每个可行动者都已行动且投入等于 currentBet
  for (const s of actionable) {
    if (!s.hasActedThisStreet) return false;
    if (s.committedThisStreet !== state.currentBet) return false;
  }
  return true;
}

/** 发下一街的公共牌张数。 */
export function cardsForStreet(street: Street): number {
  switch (street) {
    case 'preflop':
      return 0;
    case 'flop':
      return 3;
    case 'turn':
      return 1;
    case 'river':
      return 1;
  }
}

/** 下一街；河牌之后返回 null。 */
export function nextStreet(street: Street): Street | null {
  const i = STREET_ORDER.indexOf(street);
  return i >= 0 && i < STREET_ORDER.length - 1 ? STREET_ORDER[i + 1] : null;
}

/** 重置某街的投入与行动标记（进入新街时调用）。 */
export function resetForNewStreet(seats: Seat[]): void {
  for (const s of seats) {
    s.committedThisStreet = 0;
    s.hasActedThisStreet = false;
  }
}

/** 本街第一个行动座位（翻牌后：庄家左侧第一个未弃牌者）。 */
export function firstToActPostflop(state: HandState): number {
  const n = state.seatCount;
  for (let i = 1; i <= n; i++) {
    const s = (state.dealerSeat + i) % n;
    const seat = state.seats[s];
    if (!seat.folded && !seat.allIn && seat.stack > 0) return s;
  }
  return -1;
}

/** 本街最后行动座位（用于从后往前找起始点）。 */
export function lastToActPreflop(state: HandState, bigBlindSeat: number): number {
  const n = state.seatCount;
  for (let i = 1; i <= n; i++) {
    const s = (bigBlindSeat + i) % n;
    const seat = state.seats[s];
    if (!seat.folded && !seat.allIn && seat.stack > 0) return s;
  }
  return -1;
}

export type { ActionType };
