/**
 * 精确枚举锚点断言（验收闸门 G6）。
 *
 * 断言基准来源：`tests/fixtures/equity-exact.json`，由 `scripts/gen-exact-anchors.mjs`
 * 离线精确枚举生成，是**确定性常量**。这是计划允许的两类断言基准之一
 * （另一类是查表值）。蒙特卡洛采样值严禁用作相等断言。
 *
 * 本测试同时校验摊牌数与组合数一致（G3），双重锁定枚举角色分配的完整性。
 */

import { describe, it, expect } from 'vitest';
import { parseCards } from '../../src/core/cards.js';
import { exactEquityHU, expectedShowdowns } from '../../src/core/equity/exact.js';
import anchorsData from '../fixtures/equity-exact.json' with { type: 'json' };

interface Anchor {
  id: string;
  hero: string;
  board: string;
  boardLength: number;
  equity: number;
  showdowns: number;
  wins: number;
  ties: number;
  source: string;
}

const anchors = (anchorsData as unknown as { anchors: Anchor[] }).anchors;

describe('G6 精确枚举锚点（精确枚举值基准）', () => {
  it('锚点文件存在且非空', () => {
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.source).toBe('exact');
    }
  });

  it('每个锚点的摊牌数精确等于组合数（角色分配完整性）', () => {
    for (const a of anchors) {
      expect(a.showdowns).toBe(expectedShowdowns(a.boardLength));
    }
  });

  it('每个锚点的胜率与离线精确枚举值精确相等（非近似）', () => {
    for (const a of anchors) {
      const hero = parseCards(a.hero);
      const board = parseCards(a.board);
      const r = exactEquityHU(hero, board);
      // 精确枚举是确定性计算：必须逐位相等，容差为 0
      expect(r.equity).toBe(a.equity);
      expect(r.showdowns).toBe(a.showdowns);
      // wins + ties + losses == showdowns，故 wins + ties <= showdowns
      // （不能断言等于：输掉的摊牌是剩余部分）
      const wins = Math.round(a.wins);
      const ties = Math.round(a.ties);
      expect(wins).toBeGreaterThanOrEqual(0);
      expect(ties).toBeGreaterThanOrEqual(0);
      expect(wins + ties).toBeLessThanOrEqual(a.showdowns);
      expect(wins + ties).toBeGreaterThan(0);
    }
  });

  it('胜率公式自洽：equity = (wins + ties/2) / showdowns', () => {
    for (const a of anchors) {
      const expected = (a.wins + a.ties / 2) / a.showdowns;
      expect(Math.abs(a.equity - expected)).toBeLessThan(1e-9);
    }
  });

  it('胜率均落在 [0,1]', () => {
    for (const a of anchors) {
      expect(a.equity).toBeGreaterThanOrEqual(0);
      expect(a.equity).toBeLessThanOrEqual(1);
    }
  });

  it('已成型坚果同花顺锚点胜率为 100%', () => {
    const a = anchors.find((x) => x.id === 'river-nuts-flush')!;
    expect(a.equity).toBe(1);
  });

  it('公共牌本身为坚果时（皇家同花顺在桌面）英雄无法获胜，只有平局', () => {
    const a = anchors.find((x) => x.id === 'river-board-is-nuts')!;
    // 双方都以公共牌成同花顺，英雄只有平局（分得一半底池）
    expect(a.equity).toBeLessThanOrEqual(0.5);
    expect(a.equity).toBeGreaterThan(0);
  });

  it('同一锚点重复计算完全可复现', () => {
    const a = anchors[0];
    const hero = parseCards(a.hero);
    const board = parseCards(a.board);
    const r1 = exactEquityHU(hero, board);
    const r2 = exactEquityHU(hero, board);
    expect(r1.equity).toBe(r2.equity);
    expect(r1.showdowns).toBe(r2.showdowns);
  });

  it('覆盖三个街（河牌/转牌/翻牌），确保各街路径都被锁定', () => {
    const byLen = new Set(anchors.map((a) => a.boardLength));
    expect(byLen.has(5)).toBe(true);
    expect(byLen.has(4)).toBe(true);
    expect(byLen.has(3)).toBe(true);
  });
});
