/**
 * 冻结数据产物的健全性检查（防止「生成脚本有缺陷导致产物失真」再次发生）。
 *
 * 背景：本项目开发期两次生成出失真的产物——
 *   1. 查表全为 0（生成器用数组式比较处理打包整数，循环不执行、恒返回 0）
 *   2. 精确锚点胜率恒为 50%（同一原因）
 *   3. 脚本求值器同花索引错位，使同花顺被漏判为同花
 * 这些缺陷都能被「产物健全性检查」在秒级内发现，因此固化为测试。
 *
 * 本测试只检查**结构性健全**（单调性、范围、覆盖度），
 * 具体的精确值断言在 equity.test.ts / anchors.test.ts 中。
 */

import { describe, it, expect } from 'vitest';
import { rawPreflopTable, allHandClassKeys, preflopTableMeta } from '../../src/core/equity/lookup.js';
import anchorsData from '../fixtures/equity-exact.json' with { type: 'json' };

interface Anchor {
  id: string;
  equity: number;
  showdowns: number;
  boardLength: number;
  wins: number;
  ties: number;
}

const anchors = (anchorsData as unknown as { anchors: Anchor[] }).anchors;

describe('冻结产物健全性：翻牌前查表', () => {
  it('所有档位、所有 169 个手牌类的取值都在 (0, 1) 开区间内', () => {
    const meta = preflopTableMeta();
    expect(meta.opponentCounts.length).toBeGreaterThan(0);
    for (const opp of meta.opponentCounts) {
      const bucket = rawPreflopTable.tables[String(opp)];
      expect(bucket).toBeDefined();
      for (const key of allHandClassKeys()) {
        const v = bucket[key];
        expect(typeof v).toBe('number');
        // 必须严格在开区间：0 或 1 说明生成器出错（例如恒等比较产生 0）
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('取值不是常量（防止「恒为 0」或「恒为 0.5」这类生成器缺陷）', () => {
    for (const opp of preflopTableMeta().opponentCounts) {
      const bucket = rawPreflopTable.tables[String(opp)];
      const values = allHandClassKeys().map((k) => bucket[k]);
      const min = Math.min(...values);
      const max = Math.max(...values);
      // 真实查表的极差应显著大于 0.2（AA 约 0.85，72o 约 0.34）
      expect(max - min).toBeGreaterThan(0.2);
      // 不能所有值都相同
      expect(new Set(values).size).toBeGreaterThan(50);
    }
  });

  it('强度排序合理：对子随点数递减，AA 最高', () => {
    const bucket = rawPreflopTable.tables['1'];
    const pairs = ['AA', 'KK', 'QQ', 'JJ', 'TT', '99', '88', '77', '66', '55', '44', '33', '22'];
    for (let i = 0; i < pairs.length - 1; i++) {
      expect(bucket[pairs[i]]).toBeGreaterThan(bucket[pairs[i + 1]]);
    }
  });

  it('同花强于非同花（同点数对比）', () => {
    const bucket = rawPreflopTable.tables['1'];
    for (const [s, o] of [
      ['AKs', 'AKo'],
      ['QJs', 'QJo'],
      ['T9s', 'T9o'],
      ['54s', '54o'],
    ]) {
      expect(bucket[s]).toBeGreaterThan(bucket[o]);
    }
  });

  it('对手越多，同一手牌胜率越低（单调递减）', () => {
    const counts = [...preflopTableMeta().opponentCounts].sort((a, b) => a - b);
    expect(counts.length).toBeGreaterThan(1);
    for (const key of ['AA', 'KK', 'AKs', '72o']) {
      for (let i = 0; i < counts.length - 1; i++) {
        const fewer = rawPreflopTable.tables[String(counts[i])][key];
        const more = rawPreflopTable.tables[String(counts[i + 1])][key];
        expect(fewer).toBeGreaterThan(more);
      }
    }
  });

  it('单挑 AA 胜率落在合理区间（约 0.80-0.90，与独立蒙特卡洛实测 85.36% 一致）', () => {
    const aa = rawPreflopTable.tables['1'].AA;
    expect(aa).toBeGreaterThan(0.8);
    expect(aa).toBeLessThan(0.9);
  });

  it('单挑 72o 胜率落在合理区间（约 0.30-0.38，与独立实测 34.57% 一致）', () => {
    const worst = rawPreflopTable.tables['1']['72o'];
    expect(worst).toBeGreaterThan(0.3);
    expect(worst).toBeLessThan(0.38);
  });
});

describe('冻结产物健全性：精确枚举锚点', () => {
  it('锚点数量与结构完整', () => {
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.equity).toBe('number');
      expect(typeof a.showdowns).toBe('number');
    }
  });

  it('胜率不是常量（防止「恒为 0.5」这类比较缺陷）', () => {
    const values = anchors.map((a) => a.equity);
    expect(new Set(values).size).toBeGreaterThan(3);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.2);
  });

  it('胜率在 [0,1] 内且摊牌数等于组合数', () => {
    const expected = (boardLen: number): number => {
      const unknown = 52 - 2 - boardLen;
      const toCome = 5 - boardLen;
      const c = (n: number, k: number): number => {
        if (k < 0 || k > n) return 0;
        let r = 1;
        for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
        return Math.round(r);
      };
      return c(unknown, toCome) * c(unknown - toCome, 2);
    };
    for (const a of anchors) {
      expect(a.equity).toBeGreaterThanOrEqual(0);
      expect(a.equity).toBeLessThanOrEqual(1);
      expect(a.showdowns).toBe(expected(a.boardLength));
    }
  });

  it('胜/平计数自洽：wins + ties <= showdowns 且胜率公式成立', () => {
    for (const a of anchors) {
      expect(a.wins + a.ties).toBeLessThanOrEqual(a.showdowns);
      const computed = (a.wins + a.ties / 2) / a.showdowns;
      expect(Math.abs(computed - a.equity)).toBeLessThan(1e-9);
    }
  });

  it('存在确定性极值锚点：坚果同花顺胜率 100%，公共牌为坚果时胜率 50%', () => {
    const nuts = anchors.find((a) => a.id === 'river-nuts-flush');
    expect(nuts?.equity).toBe(1);
    const boardNuts = anchors.find((a) => a.id === 'river-board-is-nuts');
    // 双方都以公共牌成同花顺 → 必然平局，胜率恰为 0.5
    expect(boardNuts?.equity).toBe(0.5);
  });
});
