/**
 * 求值器交叉校验与边界用例（验收闸门 G2）。
 *
 * 生产实现 `rank7.ts` 与独立参照实现 `rank5Reference.ts` 在 20 万手随机 7 张牌上
 * 必须逐手完全一致（错 0 手）。该闸门的必要性已被证明：开发期一个打包求值器原型
 * 在同样规模下错 6,423 手（角色分配处理有误），本闸门能真实捕获该类缺陷。
 */

import { describe, it, expect } from 'vitest';
import { fullDeck, makeCard, parseCard, parseCards, cardToString } from '../../src/core/cards.js';
import { rank7, categoryOf, valuesOf, bestFive } from '../../src/core/rank7.js';
import { rank7Reference, packReference } from '../../src/core/rank5Reference.js';

function shuffleWith(deck: number[], rnd: () => number): number[] {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** 确定性 LCG，保证测试可复现。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('G2 求值器交叉校验', () => {
  it('20 万手随机 7 张牌：生产实现与参照实现逐手一致，错 0 手', () => {
    const rnd = makeRng(20261012);
    const base = fullDeck();
    let mismatches = 0;
    let checked = 0;
    const firstMismatches: string[] = [];
    const hand: number[] = new Array(7);

    for (let n = 0; n < 200_000; n++) {
      const d = shuffleWith(base, rnd);
      for (let i = 0; i < 7; i++) hand[i] = d[i];
      const prod = rank7(hand);
      const ref = packReference(rank7Reference(hand));
      checked++;
      if (prod !== ref) {
        mismatches++;
        if (firstMismatches.length < 5) {
          firstMismatches.push(
            `手牌 ${hand.map(cardToString).join(' ')}: 生产 ${prod} vs 参照 ${ref}`,
          );
        }
      }
    }

    expect(checked).toBe(200_000);
    expect(firstMismatches).toEqual([]);
    expect(mismatches).toBe(0);
  });

  it('5 张与 6 张牌同样一致（覆盖 rank7 的非 7 张路径）', () => {
    const rnd = makeRng(777);
    const base = fullDeck();
    for (const size of [5, 6]) {
      let mismatches = 0;
      for (let n = 0; n < 30_000; n++) {
        const d = shuffleWith(base, rnd);
        const hand = d.slice(0, size);
        if (rank7(hand) !== packReference(rank7Reference(hand))) mismatches++;
      }
      expect(mismatches).toBe(0);
    }
  });
});

describe('牌型判定边界用例', () => {
  const r = (s: string) => rank7(parseCards(s));

  it('识别全部 9 种类别', () => {
    expect(categoryOf(r('As Ks Qs Js Ts'))).toBe(8); // 同花顺
    expect(categoryOf(r('As Ah Ad Ac Kd'))).toBe(7); // 四条
    expect(categoryOf(r('As Ah Ad Kc Kd'))).toBe(6); // 葫芦
    expect(categoryOf(r('As Ks Qs Js 9s'))).toBe(5); // 同花
    expect(categoryOf(r('As Kh Qd Jc Ts'))).toBe(4); // 顺子
    expect(categoryOf(r('As Ah Ad Kc Qd'))).toBe(3); // 三条
    expect(categoryOf(r('As Ah Kd Kc Qd'))).toBe(2); // 两对
    expect(categoryOf(r('As Ah Kd Qc Jd'))).toBe(1); // 一对
    expect(categoryOf(r('As Kh Qd Jc 9d'))).toBe(0); // 高牌
  });

  it('A-2-3-4-5 轮子顺：最大牌是 5，且小于 6 高顺子', () => {
    const wheel = r('As 2h 3d 4c 5s');
    expect(categoryOf(wheel)).toBe(4);
    expect(valuesOf(wheel)[0]).toBe(3); // rank 3 === '5'
    const sixHigh = r('2s 3h 4d 5c 6s');
    expect(categoryOf(sixHigh)).toBe(4);
    expect(sixHigh).toBeGreaterThan(wheel);
  });

  it('轮子同花顺被识别为同花顺，且是最大同花顺中最小的', () => {
    const steelWheel = r('As 2s 3s 4s 5s');
    expect(categoryOf(steelWheel)).toBe(8);
    const royal = r('As Ks Qs Js Ts');
    expect(royal).toBeGreaterThan(steelWheel);
  });

  it('同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌', () => {
    const order = [
      r('As Ks Qs Js Ts'), // 同花顺
      r('As Ah Ad Ac Kd'), // 四条
      r('As Ah Ad Kc Kd'), // 葫芦
      r('As Ks Qs Js 9s'), // 同花
      r('As Kh Qd Jc Ts'), // 顺子
      r('As Ah Ad Kc Qd'), // 三条
      r('As Ah Kd Kc Qd'), // 两对
      r('As Ah Kd Qc Jd'), // 一对
      r('As Kh Qd Jc 9d'), // 高牌
    ];
    for (let i = 0; i < order.length - 1; i++) {
      expect(order[i]).toBeGreaterThan(order[i + 1]);
    }
  });

  it('踢脚逐级比较：一对比较踢脚，两对比较大小对与踢脚', () => {
    expect(r('As Ah Kd Qc Jd')).toBeGreaterThan(r('As Ah Kd Qc Td')); // 一对踢脚 K>Q? 实为第三踢脚
    expect(r('As Ah Kd Qc Jd')).toBeGreaterThan(r('As Ah Qd Jc Td'));
    // 两对：大对优先
    expect(r('Ks Kh Qd Qc 2d')).toBeGreaterThan(r('Qs Qh Jd Jc Ad'));
    // 两对：大对相同则比小对
    expect(r('Ks Kh Qd Qc 2d')).toBeGreaterThan(r('Ks Kh Jd Jc Ad'));
    // 两对：对子相同则比踢脚
    expect(r('Ks Kh Qd Qc 3d')).toBeGreaterThan(r('Ks Kh Qd Qc 2d'));
  });

  it('7 张取最优：能从 7 张中选出同花而非两对', () => {
    const v = r('As Ks 9s 5s 2s Kh Kd');
    expect(categoryOf(v)).toBe(5); // 同花
  });

  it('7 张中同时存在葫芦与同花时取葫芦（更强）', () => {
    const v = r('As Ah Ad Ks Kd 2s 3s');
    expect(categoryOf(v)).toBe(6); // 葫芦
  });

  it('三条 + 三条（7 张）应识别为葫芦', () => {
    const v = r('As Ah Ad Ks Kh Kd 2c');
    expect(categoryOf(v)).toBe(6);
  });

  it('bestFive 返回的 5 张牌确实构成该最优牌型', () => {
    const cards = parseCards('As Ks 9s 5s 2s Kh Kd');
    const five = bestFive(cards);
    expect(five.length).toBe(5);
    expect(rank7(five)).toBe(rank7(cards));
    expect(categoryOf(rank7(five))).toBe(5);
  });
});

describe('牌的编码', () => {
  it('编码可逆且覆盖 52 张', () => {
    const deck = fullDeck();
    expect(deck.length).toBe(52);
    expect(new Set(deck).size).toBe(52);
    for (const c of deck) {
      expect(parseCard(cardToString(c))).toBe(c);
    }
  });

  it('rank 与 suit 提取正确', () => {
    const as = parseCard('As');
    expect(as >> 2).toBe(12);
    expect(as & 3).toBe(0);
    expect(makeCard(12, 0)).toBe(as);
    expect(parseCard('2c') >> 2).toBe(0);
    expect(parseCard('2c') & 3).toBe(3);
  });
});
