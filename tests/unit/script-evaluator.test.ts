/**
 * 构建期脚本求值器与生产求值器的交叉校验（回归闸门）。
 *
 * 为什么必须有这条测试：
 *   `scripts/lib/rank7.mjs` 是 `src/core/rank7.ts` 的 JS 等价副本（脚本无法直接
 *   import TS 源码）。「等价」不能靠假设——本测试在 10 万手随机牌上逐手比对两者，
 *   错 0 手才算通过。
 *
 * 该闸门的必要性已被证明：脚本求值器曾把同花检查写成
 *   `rs.filter((r, i) => su[i] === fs)`
 * 即用「降序排序后的点数」配「原始发牌顺序的花色」，索引不对齐，导致
 *   1. 同花顺被漏判为同花（公共牌 A♠K♠Q♠J♠T♠ 被算成同花）
 *   2. 翻牌前查表与精确锚点双双失真
 * 该缺陷由 tests/unit/anchors.test.ts 与 tests/unit/equity.test.ts 捕获。
 * 本测试把「两份实现必须一致」变成可执行断言，杜绝同类缺陷再次进入构建产物。
 */

import { describe, it, expect } from 'vitest';
import { rank7 as rank7Prod } from '../../src/core/rank7.js';
import { parseCards, fullDeck, cardToString } from '../../src/core/cards.js';
import { createRng } from '../../src/core/rng.js';
// @ts-expect-error 脚本为纯 JS（.mjs），无类型声明；此处仅测试用
import { rank7 as rank7Script } from '../../scripts/lib/rank7.mjs';

function shuffleWith(deck: number[], rnd: () => number): number[] {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

describe('脚本求值器与生产求值器交叉校验', () => {
  it('10 万手随机 7 张牌：两份实现逐手一致，错 0 手', () => {
    const rng = createRng(13572468);
    const deck = fullDeck();
    const mismatches: string[] = [];
    const hand: number[] = new Array(7);

    for (let n = 0; n < 100_000; n++) {
      const d = shuffleWith(deck, () => rng.next());
      for (let i = 0; i < 7; i++) hand[i] = d[i];
      const p = rank7Prod(hand);
      const s = rank7Script(hand);
      if (p !== s) {
        if (mismatches.length < 5) {
          mismatches.push(`${hand.map(cardToString).join(' ')}: 生产 ${p} vs 脚本 ${s}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('5 张与 6 张牌同样一致', () => {
    const rng = createRng(24681357);
    const deck = fullDeck();
    for (const size of [5, 6]) {
      let bad = 0;
      for (let n = 0; n < 20_000; n++) {
        const d = shuffleWith(deck, () => rng.next());
        const hand = d.slice(0, size);
        if (rank7Prod(hand) !== rank7Script(hand)) bad++;
      }
      expect(bad).toBe(0);
    }
  });

  it('回归：公共牌为皇家同花顺时，英雄牌型必须是同花顺（类别 8）而非同花（类别 5）', () => {
    // 这是脚本求值器曾出错的原始用例
    const cards = parseCards('2c 3d As Ks Qs Js Ts');
    const prod = rank7Prod(cards);
    const script = rank7Script(cards);
    expect(Math.floor(prod / 1048576)).toBe(8);
    expect(script).toBe(prod);
  });

  it('回归：同花顺与同花的边界用例两份实现一致', () => {
    const cases = [
      'As Ks Qs Js Ts 2c 3d', // 皇家同花顺
      'As 2s 3s 4s 5s Kd Qc', // 轮子同花顺
      'As Ks Qs Js 9s 2c 3d', // 同花（非顺）
      '9s 8s 7s 6s 5s 2c 3d', // 同花顺（9 高）
      'As Ah Ad Ac Ks Qs Js', // 四条 + 同花干扰
      'As Ks Qs Js Ts 9s 8s', // 7 张同花，取最优同花顺
    ];
    for (const c of cases) {
      const cards = parseCards(c);
      expect(rank7Script(cards)).toBe(rank7Prod(cards));
    }
  });

  it('回归：带同花干扰时取最优牌型（葫芦优先于同花）', () => {
    const cards = parseCards('As Ah Ad Ks Kd 2s 3s');
    const prod = rank7Prod(cards);
    expect(Math.floor(prod / 1048576)).toBe(6); // 葫芦
    expect(rank7Script(cards)).toBe(prod);
  });
});
