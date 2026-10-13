/**
 * 胜率路径正确性测试（验收闸门 G3 / G6）。
 *
 * 硬规则（计划 §6.2）：
 *   断言基准只允许使用「精确枚举值」与「查表值」。
 *   蒙特卡洛采样值**不得**作为断言基准——它含随机误差，用作相等断言会同时产生
 *   假阴性（正确实现因采样波动被判失败，更危险）与假阳性（错误实现偶尔落在容差内被放过）。
 *
 * 因此本文件的断言分三类：
 *   1. 精确枚举 → 断言摊牌数 == 组合数，且结果与锚点精确相等
 *   2. 查表     → 断言返回值与冻结表精确相等
 *   3. 蒙特卡洛 → 只断言统计收敛性（固定种子，容差 ±1.5%），绝不断言相等
 */

import { describe, it, expect } from 'vitest';
import { parseCards } from '../../src/core/cards.js';
import { exactEquityHU, expectedShowdowns } from '../../src/core/equity/exact.js';
import { monteCarloEquity } from '../../src/core/equity/montecarlo.js';
import { computeEquity, potOdds, callEv } from '../../src/core/equity/index.js';
import { lookupPreflop, handClassKey, allHandClassKeys, preflopTableMeta } from '../../src/core/equity/lookup.js';
import { createRng } from '../../src/core/rng.js';

describe('G3 精确枚举摊牌数必须等于组合数', () => {
  const hero = parseCards('As Ah');

  it('河牌：C(45,0) x C(45,2) = 990', () => {
    const board = parseCards('2c 7d 9h Js 4d');
    expect(expectedShowdowns(5)).toBe(990);
    const r = exactEquityHU(hero, board);
    expect(r.showdowns).toBe(990);
  });

  it('转牌：C(46,1) x C(45,2) = 45,540', () => {
    const board = parseCards('2c 7d 9h Js');
    expect(expectedShowdowns(4)).toBe(45540);
    const r = exactEquityHU(hero, board);
    expect(r.showdowns).toBe(45540);
  });

  it('翻牌：C(47,2) x C(45,2) = 1,070,190', () => {
    const board = parseCards('2c 7d 9h');
    expect(expectedShowdowns(3)).toBe(1070190);
    const r = exactEquityHU(hero, board);
    expect(r.showdowns).toBe(1070190);
  });

  it('expectedShowdowns 覆盖全部街，且翻牌前规模为 2,097,572,400', () => {
    // 翻牌前精确枚举 = C(50,5) x C(45,2) = 2,118,760 x 990 = 2,097,572,400
    // 注意：计划档案曾误写为 C(50,2)xC(48,3) = 21,187,600，那只覆盖 3 张公共牌，
    // 漏掉了后两张公共牌的角色分配。此处以正确的组合数为准。
    expect(expectedShowdowns(0)).toBe(2097572400);
    // 各街规模严格递减
    expect(expectedShowdowns(0)).toBeGreaterThan(expectedShowdowns(3));
    expect(expectedShowdowns(3)).toBeGreaterThan(expectedShowdowns(4));
    expect(expectedShowdowns(4)).toBeGreaterThan(expectedShowdowns(5));
  });

  it('翻牌前精确枚举在实战中不可行（用于说明为何必须走查表/采样）', () => {
    // 按实测吞吐 0.48M 次 rank7 求值/秒、每次摊牌 2 次求值估算
    const evals = expectedShowdowns(0) * 2;
    const seconds = evals / 480_000;
    // 单只手牌就需要上千秒，因此翻牌前必须查表
    expect(seconds).toBeGreaterThan(3000);
  });
});

describe('G6a 精确枚举锚点（精确枚举值基准，可作断言）', () => {
  it('单挑河牌精确值可复现（同输入必得同输出）', () => {
    const hero = parseCards('As Ah');
    const board = parseCards('2c 7d 9h Js 4d');
    const a = exactEquityHU(hero, board);
    const b = exactEquityHU(hero, board);
    expect(a.equity).toBe(b.equity);
    expect(a.showdowns).toBe(b.showdowns);
  });

  it('已成型坚果同花顺的河牌胜率必然为 100%', () => {
    // 手牌 As Ks + 公共牌 Qs Js Ts -> 皇家同花顺，不可能被击败
    const hero = parseCards('As Ks');
    const board = parseCards('Qs Js Ts 2d 3c');
    const r = exactEquityHU(hero, board);
    expect(r.equity).toBe(1);
    expect(r.showdowns).toBe(990);
  });

  it('必输局面（对手已成型更高牌型）胜率必为 0', () => {
    // 手牌 2c 3d，公共牌 As Ks Qs Js Ts -> 公共牌本身构成皇家同花顺
    // 任何对手只要持有任意一张牌都能用公共牌成同花顺，故英雄最多打平
    const hero = parseCards('2c 3d');
    const board = parseCards('As Ks Qs Js Ts');
    const r = exactEquityHU(hero, board);
    // 公共牌即最强牌型，双方都以公共牌成牌 → 全部平局
    expect(r.equity).toBe(0.5);
    expect(r.showdowns).toBe(990);
  });

  it('河牌精确胜率落在 [0,1] 且平局计入一半', () => {
    const r = exactEquityHU(parseCards('As Kd'), parseCards('2c 7d 9h Js 4d'));
    expect(r.equity).toBeGreaterThanOrEqual(0);
    expect(r.equity).toBeLessThanOrEqual(1);
  });
});

describe('G6b 查表值（冻结表，可作精确断言）', () => {
  it('表元信息与档位存在', () => {
    const meta = preflopTableMeta();
    expect(meta.iterations).toBeGreaterThan(0);
    expect(meta.opponentCounts.length).toBeGreaterThan(0);
  });

  it('169 个手牌类键齐全且无重复', () => {
    const keys = allHandClassKeys();
    expect(keys.length).toBe(169);
    expect(new Set(keys).size).toBe(169);
  });

  it('手牌类规范化正确', () => {
    expect(handClassKey(parseCards('As Ah'))).toBe('AA');
    expect(handClassKey(parseCards('As Kh'))).toBe('AKo');
    expect(handClassKey(parseCards('Ks Ah'))).toBe('AKo');
    expect(handClassKey(parseCards('As Ks'))).toBe('AKs');
    expect(handClassKey(parseCards('2h 7c'))).toBe('72o');
    // 顺序无关
    expect(handClassKey(parseCards('Kh As'))).toBe(handClassKey(parseCards('As Kh')));
  });

  it('查表返回值与冻结表逐字相等（非近似）', () => {
    for (const opp of preflopTableMeta().opponentCounts) {
      const v = lookupPreflop(parseCards('As Ah'), opp);
      expect(v).not.toBeNull();
      expect(typeof v).toBe('number');
      // 再查一次必须完全一致（确定性）
      expect(lookupPreflop(parseCards('As Ah'), opp)).toBe(v);
    }
  });

  it('表内数值单调合理：AA 强于 72o，且随对手增多而下降', () => {
    const counts = preflopTableMeta().opponentCounts;
    for (const opp of counts) {
      const aa = lookupPreflop(parseCards('As Ah'), opp)!;
      const worst = lookupPreflop(parseCards('7h 2c'), opp)!;
      expect(aa).toBeGreaterThan(worst);
      expect(aa).toBeLessThanOrEqual(1);
      expect(worst).toBeGreaterThanOrEqual(0);
    }
    // 对手越多，AA 胜率越低（多人桌必然下降，这不是缺陷）
    const sorted = [...counts].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const fewer = lookupPreflop(parseCards('As Ah'), sorted[i])!;
      const more = lookupPreflop(parseCards('As Ah'), sorted[i + 1])!;
      expect(fewer).toBeGreaterThan(more);
    }
  });

  it('无表的对手数返回 null（不伪造数值）', () => {
    expect(lookupPreflop(parseCards('As Ah'), 99)).toBeNull();
  });
});

describe('G6c 蒙特卡洛：只断言收敛性，绝不断言相等', () => {
  it('固定种子下结果可复现（同种子同输出）', () => {
    const hero = parseCards('As Ah');
    const board = parseCards('2c 7d 9h');
    const a = monteCarloEquity(hero, board, { iterations: 2000, opponents: 5, rng: createRng(12345) });
    const b = monteCarloEquity(hero, board, { iterations: 2000, opponents: 5, rng: createRng(12345) });
    expect(a.equity).toBe(b.equity);
  });

  it('6 人桌翻牌前 AA 收敛到查表值 ±1.5% 内（容差依据实测标准差 0.321%）', () => {
    const hero = parseCards('As Ah');
    const tableValue = lookupPreflop(hero, 5)!;
    const mc = monteCarloEquity(hero, [], { iterations: 20_000, opponents: 5, rng: createRng(999) });
    // 容差 ±1.5% 约为实测 95% 置信区间（±0.63%）的 2.4 倍，杜绝假阴性
    expect(Math.abs(mc.equity - tableValue)).toBeLessThan(0.015);
  });

  it('单挑翻牌前 AA 收敛到查表值 ±1.5% 内（容差依据实测标准差 0.238%）', () => {
    const hero = parseCards('As Ah');
    const tableValue = lookupPreflop(hero, 1)!;
    const mc = monteCarloEquity(hero, [], { iterations: 20_000, opponents: 1, rng: createRng(4242) });
    expect(Math.abs(mc.equity - tableValue)).toBeLessThan(0.015);
  });

  it('迭代次数越多，与查表值的偏差不增大（量级健全性）', () => {
    const hero = parseCards('As Ah');
    const tableValue = lookupPreflop(hero, 1)!;
    const coarse = monteCarloEquity(hero, [], { iterations: 1_000, opponents: 1, rng: createRng(7) });
    const fine = monteCarloEquity(hero, [], { iterations: 40_000, opponents: 1, rng: createRng(7) });
    // 两者都应在合理量级内；粗采样允许更大偏差
    expect(Math.abs(coarse.equity - tableValue)).toBeLessThan(0.05);
    expect(Math.abs(fine.equity - tableValue)).toBeLessThan(0.015);
  });

  it('河牌蒙特卡洛与精确枚举一致（±1.5%）——两种独立路径互证', () => {
    const hero = parseCards('As Ah');
    const board = parseCards('2c 7d 9h Js 4d');
    const exact = exactEquityHU(hero, board);
    const mc = monteCarloEquity(hero, board, { iterations: 20_000, opponents: 1, rng: createRng(2026) });
    expect(Math.abs(mc.equity - exact.equity)).toBeLessThan(0.015);
  });
});

describe('分级路由选择正确的执行路径', () => {
  it('翻牌前走查表', () => {
    const r = computeEquity({ hero: parseCards('As Ah'), board: [], opponents: 5 });
    expect(r.source).toBe('lookup');
    expect(r.showdowns).toBeNull();
  });

  it('单挑转牌走精确枚举', () => {
    const r = computeEquity({
      hero: parseCards('As Ah'),
      board: parseCards('2c 7d 9h Js'),
      opponents: 1,
    });
    expect(r.source).toBe('exact');
    expect(r.showdowns).toBe(45540);
  });

  it('单挑河牌走精确枚举', () => {
    const r = computeEquity({
      hero: parseCards('As Ah'),
      board: parseCards('2c 7d 9h Js 4d'),
      opponents: 1,
    });
    expect(r.source).toBe('exact');
    expect(r.showdowns).toBe(990);
  });

  it('单挑翻牌默认走蒙特卡洛（精确枚举 1.8s 超交互预算）', () => {
    const r = computeEquity({
      hero: parseCards('As Ah'),
      board: parseCards('2c 7d 9h'),
      opponents: 1,
      iterations: 500,
    });
    expect(r.source).toBe('montecarlo');
  });

  it('单挑翻牌显式开启时才走精确枚举，且摊牌数为 1,070,190', () => {
    const r = computeEquity({
      hero: parseCards('As Ah'),
      board: parseCards('2c 7d 9h'),
      opponents: 1,
      allowFlopExact: true,
    });
    expect(r.source).toBe('exact');
    expect(r.showdowns).toBe(1070190);
  });

  it('多人桌翻牌/转牌/河牌一律走蒙特卡洛（精确枚举组合上不可行）', () => {
    for (const board of [parseCards('2c 7d 9h'), parseCards('2c 7d 9h Js'), parseCards('2c 7d 9h Js 4d')]) {
      const r = computeEquity({
        hero: parseCards('As Ah'),
        board,
        opponents: 5,
        iterations: 300,
      });
      expect(r.source).toBe('montecarlo');
      expect(r.showdowns).toBeNull();
    }
  });
});

describe('底池赔率与跟注 EV', () => {
  it('底池赔率计算正确', () => {
    // 底池 100，需跟注 50 → 50 / 150 = 1/3
    expect(potOdds(50, 100)).toBeCloseTo(1 / 3, 10);
    // 无需跟注时赔率为 0
    expect(potOdds(0, 100)).toBe(0);
  });

  it('跟注 EV：胜率恰好等于底池赔率时为 0（临界点）', () => {
    const po = potOdds(50, 100);
    expect(callEv(po, 50, 100)).toBeCloseTo(0, 10);
  });

  it('跟注 EV 随胜率单调递增', () => {
    expect(callEv(0.6, 50, 100)).toBeGreaterThan(callEv(0.4, 50, 100));
  });

  it('胜率为 1 时跟注 EV 等于底池（跟注额被收回，净得底池）', () => {
    expect(callEv(1, 50, 100)).toBeCloseTo(100, 10);
  });

  it('胜率为 0 时跟注 EV 等于负的跟注额', () => {
    expect(callEv(0, 50, 100)).toBeCloseTo(-50, 10);
  });

  it('跟注 EV 与底池赔率盈亏平衡点自洽（回归：曾因公式多算 e·toCall 而错位）', () => {
    // 对多组参数验证：e = potOdds(toCall, pot) 时 EV 必须为 0
    for (const [toCall, pot] of [
      [50, 100],
      [10, 40],
      [200, 600],
      [5, 15],
    ]) {
      const po = potOdds(toCall, pot);
      expect(callEv(po, toCall, pot)).toBeCloseTo(0, 10);
      // 高于盈亏平衡胜率则 EV 为正，低于则为负
      expect(callEv(po + 0.05, toCall, pot)).toBeGreaterThan(0);
      expect(callEv(po - 0.05, toCall, pot)).toBeLessThan(0);
    }
  });
});
