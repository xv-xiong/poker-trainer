/**
 * 边池（side pot）构建与筹码分配。
 *
 * 算法：按各座位**本手总投入额**分层。
 *   1. 取所有「投入额 > 0」的座位，其投入额去重升序排列，得到层级边界。
 *   2. 对每个层级边界 L（上一层边界为 P），该层金额 = (L - P) × 参与该层的座位数，
 *      其中「参与该层」= 投入额 >= L 的座位（含已弃牌者——他们的钱进池但无资格分）。
 *   3. 该层的有资格座位 = 参与该层 且 未弃牌 的座位。
 *
 * 关键不变量（由 G4 属性测试强制）：
 *   Σ 各层金额 == 所有玩家投入总额
 *   且每层金额 >= 0
 *
 * 为什么必须实现边池：全下且筹码不等时若不建边池，结算会算错，
 * 表现为「筹码账本不守恒」，这是最容易被忽略但会导致资金错乱的缺陷。
 */

import type { PotLayer } from './types.js';

export interface PotInput {
  /** 每个座位的本手总投入额（含盲注）。 */
  readonly committed: readonly number[];
  /** 每个座位是否已弃牌。 */
  readonly folded: readonly boolean[];
}

/**
 * 构建主池与边池分层。
 * 返回的层按「层级从低到高」排列，即第 0 层是主池。
 */
export function buildPots(input: PotInput): PotLayer[] {
  const { committed, folded } = input;
  const n = committed.length;

  const levels = [...new Set(committed.filter((c) => c > 0))].sort((a, b) => a - b);
  const layers: PotLayer[] = [];
  let prev = 0;

  for (const level of levels) {
    const contributors: number[] = [];
    const eligible: number[] = [];
    for (let i = 0; i < n; i++) {
      if (committed[i] >= level) {
        contributors.push(i);
        if (!folded[i]) eligible.push(i);
      }
    }
    const amount = (level - prev) * contributors.length;
    // 金额为 0 的层（例如某座位投入 0）不应出现
    if (amount > 0) {
      // contributors 按座位索引升序天然有序（上面的循环 i 递增）。
      // 结算口径：单一投入者的层 = 未被跟注的退还（uncalled bet），
      // 多人投入 = 真正被争夺的层。此处只做标注，不改变金额与分配逻辑。
      layers.push({
        amount,
        eligible,
        contributors,
        kind: contributors.length <= 1 ? 'uncalled' : 'contested',
      });
    }
    prev = level;
  }

  return layers;
}

/** 校验边池构建的守恒不变量；返回错误信息数组（空数组表示通过）。 */
export function validatePots(input: PotInput, pots: readonly PotLayer[]): string[] {
  const errors: string[] = [];
  const totalCommitted = input.committed.reduce((a, b) => a + b, 0);
  const totalPots = pots.reduce((a, b) => a + b.amount, 0);
  if (totalPots !== totalCommitted) {
    errors.push(`边池总额 ${totalPots} != 总投入 ${totalCommitted}`);
  }
  for (const [i, p] of pots.entries()) {
    if (p.amount < 0) errors.push(`第 ${i} 层金额为负: ${p.amount}`);
    if (p.amount > 0 && p.eligible.length === 0) {
      errors.push(`第 ${i} 层金额 ${p.amount} > 0 但无有资格座位`);
    }
  }
  return errors;
}

/**
 * 按给定排名分配各层底池。
 *
 * @param pots 分层底池
 * @param rankOf 座位 -> 牌型强度（越大越强）。仅对有资格的座位调用。
 * @param tieBreakOrder 平局时奇数筹码的分配顺序（座位索引序列，靠前者优先）。
 * @param seatCount 座位总数（必须显式传入：不能从 eligible 推导，
 *        否则「全部弃牌的高位座位」会越界并产生 undefined -> NaN）。
 * @returns 每个座位从各层分得的总额，长度为 seatCount
 */
export function distributePots(
  pots: readonly PotLayer[],
  rankOf: (seat: number) => number,
  tieBreakOrder: readonly number[],
  seatCount: number,
): number[] {
  if (!Number.isInteger(seatCount) || seatCount <= 0) {
    throw new Error(`distributePots 需要正整数 seatCount，收到 ${seatCount}`);
  }
  const payout = new Array<number>(seatCount).fill(0);

  for (const layer of pots) {
    if (layer.eligible.length === 0) {
      // 兜底：本层无人有资格分配。
      //
      // 按规则这**不应发生**（不变量：按投入额分层后每层至少有一名未弃牌的有资格玩家；
      // 论证见文件头，实证见 tests/property/pot-audit.test.ts 的 10,000 手属性测试）。
      // 但 `buildPots` 是导出的纯函数，可被任意输入调用（现有 G5 用例即构造了不可达输入），
      // 因此此处绝不能把筹码吞掉——既不分配也不退还就是静默的资金错乱。
      // 兜底语义：原样退还给该层的投入者（amount 恒等于 (层高差 × 投入者数)，可整除）。
      // 旧记录（v1 持久化）没有 contributors 字段、且此处 eligible 为空，已无归属信息，
      // 此时退化为「按座位均摊」——牺牲归属准确性，但保证筹码守恒（绝不静默销毁）。
      const owners =
        layer.contributors && layer.contributors.length > 0
          ? layer.contributors.filter((s) => Number.isInteger(s) && s >= 0 && s < seatCount)
          : new Array(seatCount).fill(0).map((_, i) => i);
      if (owners.length === 0) continue;
      const refund = Math.floor(layer.amount / owners.length);
      let left = layer.amount - refund * owners.length;
      for (const o of owners) payout[o] += refund;
      for (const o of owners) {
        if (left <= 0) break;
        payout[o] += 1;
        left--;
      }
      continue;
    }
    let best = -Infinity;
    for (const seat of layer.eligible) {
      const v = rankOf(seat);
      if (v > best) best = v;
    }
    const winners = layer.eligible.filter((s) => rankOf(s) === best);
    // 兜底：与上面「空有资格层」同一类风险的姊妹分支。
    // 只有当 rankOf 对所有有资格者都返回 NaN（比较恒为 false）时才会走到这里——
    // 正常牌型值不会出现 NaN，但绝不能因此把该层筹码静默丢弃：退化为在有资格者间均分，
    // 保证 Σ 分得 == Σ 投入 这一硬不变量优先于归属准确性。
    if (winners.length === 0) {
      const share0 = Math.floor(layer.amount / layer.eligible.length);
      let left0 = layer.amount - share0 * layer.eligible.length;
      for (const s of layer.eligible) payout[s] += share0;
      for (const s of layer.eligible) {
        if (left0 <= 0) break;
        payout[s] += 1;
        left0--;
      }
      continue;
    }

    const share = Math.floor(layer.amount / winners.length);
    let remainder = layer.amount - share * winners.length;

    for (const w of winners) payout[w] += share;

    // 奇数筹码按 tieBreakOrder 的先后顺序分配（小盲起顺时针）
    if (remainder > 0) {
      const ordered = [...winners].sort((a, b) => {
        const ia = tieBreakOrder.indexOf(a);
        const ib = tieBreakOrder.indexOf(b);
        return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
      });
      for (const w of ordered) {
        if (remainder <= 0) break;
        payout[w] += 1;
        remainder--;
      }
    }
  }

  return payout;
}

/** 从庄家位推导各座位角色。 */
export function seatRoles(
  seatCount: number,
  dealerSeat: number,
): { smallBlindSeat: number; bigBlindSeat: number; order: number[] } {
  // 2 人桌特殊：庄家是小盲
  const sb = seatCount === 2 ? dealerSeat : (dealerSeat + 1) % seatCount;
  const bb = (sb + 1) % seatCount;
  // 行动顺序：大盲之后顺时针
  const order: number[] = [];
  for (let i = 1; i <= seatCount; i++) order.push((bb + i) % seatCount);
  return { smallBlindSeat: sb, bigBlindSeat: bb, order };
}

/**
 * 平局奇数筹码的分配顺序：从小盲起顺时针。
 * 已定案规则，写入规则页。
 */
export function tieBreakOrder(seatCount: number, smallBlindSeat: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < seatCount; i++) order.push((smallBlindSeat + i) % seatCount);
  return order;
}
