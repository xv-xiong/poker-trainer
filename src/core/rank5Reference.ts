/**
 * 独立参照实现（**仅供测试**，不进生产路径）。
 *
 * 与 `rank7.ts` 的关键差异（这是交叉校验有意义的前提）：
 * 1. 枚举 C(n,5) 全部子集，对每个子集用**独立编写的 5 张分类器**求值，再取最大。
 *    生产实现则是单次遍历计数后直接判定，不做子集枚举。
 * 2. 5 张分类器使用显式的「先顺子后同花」判定顺序与独立的分支结构，
 *    与生产实现的计数分支顺序不同。
 * 3. 返回值为**数字数组** [cat, k1..k5]，与生产实现的打包整数是不同表示。
 *
 * 本实现的语言原型已在 Python 中通过全量枚举 C(52,5) 校验，得到
 * 同花顺 40 / 四条 624 / 葫芦 3744 / 同花 5108 / 顺子 10200 / 三条 54912 /
 * 两对 123552 / 一对 1098240 / 高牌 1302540（合计 2,598,960），
 * 与组合数学真值完全一致，因此可作为交叉校验的基准。
 */

import type { Card } from './cards.js';

/** 5 张牌分类：返回 [cat, k1, k2, k3, k4, k5]，按字典序比较即牌型大小。 */
export function classify5(cards: readonly Card[]): number[] {
  if (cards.length !== 5) throw new Error('classify5 需要恰好 5 张牌');

  const ranks: number[] = [];
  const suits: number[] = [];
  for (let i = 0; i < 5; i++) {
    ranks.push(cards[i] >> 2);
    suits.push(cards[i] & 3);
  }
  let rs = [...ranks].sort((a, b) => b - a);
  const isFlush = suits.every((s) => s === suits[0]);

  let uniq = [...new Set(rs)].sort((a, b) => b - a);
  let isStraight = false;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) {
      isStraight = true;
    } else if (uniq[0] === 12 && uniq[1] === 3 && uniq[2] === 2 && uniq[3] === 1 && uniq[4] === 0) {
      // A-2-3-4-5 轮子顺：最大牌为 5（rank 3）
      isStraight = true;
      rs = [3, 2, 1, 0, -1];
    }
  }

  const counts = new Map<number, number>();
  for (const r of rs) counts.set(r, (counts.get(r) ?? 0) + 1);
  const shape = [...counts.values()].sort((a, b) => b - a);

  const maxRankOf = (r: number): number => rs.find((x) => x === r) ?? 0;

  if (isStraight && isFlush) return [8, Math.max(...rs)];
  if (shape[0] === 4) {
    const q = [...counts.entries()].find(([, n]) => n === 4)![0];
    const k = Math.max(...rs.filter((r) => r !== q));
    return [7, q, k];
  }
  if (shape[0] === 3 && shape[1] === 2) {
    const t = [...counts.entries()].find(([, n]) => n === 3)![0];
    const p = Math.max(...[...counts.entries()].filter(([, n]) => n === 2).map(([r]) => r));
    return [6, t, p];
  }
  if (isFlush) return [5, rs[0], rs[1], rs[2], rs[3], rs[4]];
  if (isStraight) return [4, Math.max(...rs)];
  if (shape[0] === 3) {
    const t = [...counts.entries()].find(([, n]) => n === 3)![0];
    const ks = rs.filter((r) => r !== t).slice(0, 2);
    return [3, t, ks[0], ks[1]];
  }
  if (shape[0] === 2 && shape[1] === 2) {
    const ps = [...counts.entries()]
      .filter(([, n]) => n === 2)
      .map(([r]) => r)
      .sort((a, b) => b - a);
    const k = Math.max(...[...counts.entries()].filter(([, n]) => n === 1).map(([r]) => r));
    return [2, ps[0], ps[1], k];
  }
  if (shape[0] === 2) {
    const p = [...counts.entries()].find(([, n]) => n === 2)![0];
    const ks = rs.filter((r) => r !== p).slice(0, 3);
    return [1, p, ks[0], ks[1], ks[2]];
  }
  void maxRankOf;
  return [0, rs[0], rs[1], rs[2], rs[3], rs[4]];
}

/** 比较两个 classify5 结果。 */
export function compareClassified(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 参照实现：枚举全部 5 张子集取最大，返回 [cat, k1..k5]。 */
export function rank7Reference(cards: readonly Card[]): number[] {
  const n = cards.length;
  if (n < 5 || n > 7) throw new Error(`rank7Reference 仅支持 5..7 张牌，收到 ${n} 张`);
  if (n === 5) return classify5(cards);

  let best: number[] | null = null;
  const pick: Card[] = new Array(5);
  const idx = [0, 1, 2, 3, 4];
  const rec = (start: number, depth: number): void => {
    if (depth === 5) {
      for (let i = 0; i < 5; i++) pick[i] = cards[idx[i]];
      const v = classify5(pick);
      if (best === null || compareClassified(v, best) > 0) best = v;
      return;
    }
    for (let i = start; i < n; i++) {
      idx[depth] = i;
      rec(i + 1, depth + 1);
    }
  };
  rec(0, 0);
  return best!;
}

/** 把参照结果转成与生产实现相同的打包整数，便于直接相等比较。 */
export function packReference(v: readonly number[]): number {
  const [cat, k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0] = v;
  return ((((cat * 16 + k1) * 16 + k2) * 16 + k3) * 16 + k4) * 16 + k5;
}
