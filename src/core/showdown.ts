/**
 * 摊牌结算、分池。
 */

import { rank7, categoryNameOf } from './rank7.js';
import { buildPots, distributePots, seatRoles, tieBreakOrder, validatePots } from './pot.js';
import type { HandState, PotLayer } from './types.js';

export interface ShowdownResult {
  /** 各座位净盈亏（相对本手开始时的筹码）。 */
  results: number[];
  /** 各座位分得的总金额。 */
  payouts: number[];
  /** 边池分层。 */
  pots: PotLayer[];
  /** 参与摊牌座位的牌型打包值。 */
  values: Record<number, number>;
  /** 获胜座位（可能多人）。 */
  winners: number[];
  /** 守恒校验错误（应为空）。 */
  errors: string[];
}

/**
 * 结算一手牌。
 *
 * 两种情况：
 * 1. 只剩一名未弃牌者 → 直接获得全部底池，不进入摊牌。
 * 2. 多人未弃牌 → 摊牌比较牌型，按边池分层分配。
 *
 * 平局时奇数筹码按位置序（小盲起顺时针）分配（已定案规则）。
 */
export function settleHand(state: HandState): ShowdownResult {
  const committed = state.seats.map((s) => s.committed);
  const folded = state.seats.map((s) => s.folded);
  const pots = buildPots({ committed, folded });
  const potErrors = validatePots({ committed, folded }, pots);

  const live = state.seats.filter((s) => !s.folded);
  const { smallBlindSeat } = seatRoles(state.seatCount, state.dealerSeat);
  const order = tieBreakOrder(state.seatCount, smallBlindSeat);

  const values: Record<number, number> = {};
  let payouts: number[];
  let winners: number[] = [];

  if (live.length <= 1) {
    // 无摊牌：唯一未弃牌者拿下全部底池
    payouts = new Array(state.seatCount).fill(0);
    if (live.length === 1) {
      const w = live[0].index;
      payouts[w] = pots.reduce((a, p) => a + p.amount, 0);
      winners = [w];
    }
  } else {
    // 摊牌：为每位未弃牌者计算牌型
    for (const s of live) {
      const cards = [...s.holeCards, ...state.board];
      values[s.index] = rank7(cards);
    }
    payouts = distributePots(pots, (seat) => values[seat] ?? -Infinity, order, state.seatCount);
    // 找出各层获胜者并集
    const winSet = new Set<number>();
    for (const layer of pots) {
      if (layer.eligible.length === 0) continue;
      let best = -Infinity;
      for (const seat of layer.eligible) best = Math.max(best, values[seat] ?? -Infinity);
      for (const seat of layer.eligible) {
        if ((values[seat] ?? -Infinity) === best) winSet.add(seat);
      }
    }
    winners = [...winSet].sort((a, b) => a - b);
  }

  // 净盈亏 = 分得 - 投入
  const results = state.seats.map((s, i) => payouts[i] - s.committed);

  // 守恒校验：Σ 结果 + Σ 投入 == Σ 分得，且分得总额 == 底池总额
  const errors = [...potErrors];
  const totalPot = pots.reduce((a, p) => a + p.amount, 0);
  const totalPaid = payouts.reduce((a, b) => a + b, 0);
  if (totalPaid !== totalPot) {
    errors.push(`分得总额 ${totalPaid} != 底池总额 ${totalPot}`);
  }
  const netSum = results.reduce((a, b) => a + b, 0);
  if (netSum !== 0) {
    errors.push(`净盈亏合计 ${netSum} != 0（筹码不守恒）`);
  }

  return { results, payouts, pots, values, winners, errors };
}

/** 给某座位的最佳牌型取中文名（界面用）。 */
export function bestCategoryName(cards: readonly number[]): string {
  return categoryNameOf(rank7(cards));
}
