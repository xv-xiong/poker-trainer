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

/** 结算面板的一行分配条目（与金额无关，纯展示口径）。 */
export interface SettlementLine {
  /** 条目类型：主池 / 边池（被争夺）或未被跟注的退还。 */
  readonly kind: 'contested' | 'uncalled';
  /** 该条目金额。 */
  readonly amount: number;
  /** 该条目的归属座位（退还条目恒为唯一投入者；争夺条目为牌型最强者，可能多人平分）。 */
  readonly recipients: number[];
  /** 层序号（0 为主池，逐层升高），便于界面按层显示。 */
  readonly layerIndex: number;
}

/**
 * 把结算结果整理成「参考站口径」的分行明细：主池 / 边池 与 未被跟注退还 分开列。
 *
 * 为什么放在 core 而不是 UI：这是**结算语义**而非渲染细节——「这 10 是赢来的还是退回来的」
 * 取决于该层的投入者人数，属于规则层可判定的事实。UI 只需原样渲染。
 *
 * 金额恒等式：Σ 各行 amount == Σ pots.amount == 总投入。本函数只做分类，不改动任何金额，
 * 且对争夺层的归属判定与 distributePots 完全同源（同样取 eligible 中 rankOf 最大者），
 * 因此不会与真实分配结果产生分歧。
 *
 * @param rankOf 座位 -> 牌型强度（越大越强）。无摊牌（仅一名未弃牌者）时传常量即可。
 */
export function settlementBreakdown(
  pots: readonly PotLayer[],
  rankOf: (seat: number) => number,
): SettlementLine[] {
  const lines: SettlementLine[] = [];
  for (const [layerIndex, layer] of pots.entries()) {
    if (layer.amount <= 0) continue;
    // 未被跟注的退还：只有一名投入者，该笔钱必然原样回到他手中（与他是否弃牌无关）。
    //
    // 判据是 contributors.length <= 1，而非 eligible.length <= 1：
    // 「只有一名有资格者」的层未必是退还层（其余投入者可能只是弃牌了），
    // 例如 committed=[100,100,300]、folded=[true,true,false] 的第 0 层是三人投入的 300，
    // 但 eligible 只有座位 2。故必须用「投入者人数」而非「有资格者人数」判定。
    if (layer.kind === 'uncalled' || (layer.contributors !== undefined && layer.contributors.length <= 1)) {
      const owner = layer.contributors?.[0] ?? layer.eligible[0];
      if (owner !== undefined) {
        lines.push({ kind: 'uncalled', amount: layer.amount, recipients: [owner], layerIndex });
        continue;
      }
      // 无归属信息（旧记录 + 空 eligible）：落回争夺层分支，由 rankOf 决定归属
    }
    // 被争夺的层：归属与 distributePots 同源（eligible 中 rankOf 最大者，可多人平分）。
    //
    // 注意：v1 旧持久化记录既无 kind 也无 contributors，无法还原投入者人数，
    // 因此旧记录一律按「争夺层」归类（kind 字段可选即为兼容此情形）。
    // 这对金额无影响：amount 与 recipients 仍然精确，仅 kind 标注可能不准确。
    let best = -Infinity;
    for (const seat of layer.eligible) {
      const v = rankOf(seat);
      if (v > best) best = v;
    }
    const recipients = layer.eligible.filter((s) => rankOf(s) === best);
    lines.push({ kind: 'contested', amount: layer.amount, recipients, layerIndex });
  }
  return lines;
}
