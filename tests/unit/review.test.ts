/**
 * 复盘 EV 计算与分级测试。
 */

import { describe, it, expect } from 'vitest';
import {
  estimateEvs,
  bestActionOf,
  gradeEvLoss,
  normalizeAction,
  DEFAULT_THRESHOLDS,
} from '../../src/review/ev.js';

describe('EV 估算', () => {
  it('弃牌 EV 恒为 0（当前时点基准）', () => {
    const evs = estimateEvs({ equity: 0.5, pot: 100, toCall: 50, raiseTo: 100, stack: 500, bigBlind: 10 });
    expect(evs.fold).toBe(0);
  });

  it('跟注 EV 与 callEv 公式一致（e·pot - (1-e)·toCall）', () => {
    const equity = 0.4;
    const pot = 100;
    const toCall = 50;
    const evs = estimateEvs({ equity, pot, toCall, raiseTo: 200, stack: 500, bigBlind: 10 });
    // 跟注额被收回，净得底池；输则损失跟注额
    expect(evs.call).toBeCloseTo(0.4 * 100 - 0.6 * 50, 10);
  });

  it('跟注 EV 的盈亏平衡点与底池赔率一致', () => {
    const pot = 100;
    const toCall = 50;
    const po = toCall / (pot + toCall); // = 1/3
    const evs = estimateEvs({ equity: po, pot, toCall, raiseTo: 200, stack: 500, bigBlind: 10 });
    expect(evs.call).toBeCloseTo(0, 10);
  });

  it('无需跟注时跟注 EV 等于底池（即过牌的赢池期望）', () => {
    const evs = estimateEvs({ equity: 0.7, pot: 80, toCall: 0, raiseTo: 40, stack: 500, bigBlind: 10 });
    expect(evs.call).toBeCloseTo(0.7 * 80, 10);
  });

  it('胜率越高，跟注 EV 越高（单调性）', () => {
    const lo = estimateEvs({ equity: 0.2, pot: 100, toCall: 50, raiseTo: 200, stack: 500, bigBlind: 10 });
    const hi = estimateEvs({ equity: 0.8, pot: 100, toCall: 50, raiseTo: 200, stack: 500, bigBlind: 10 });
    expect(hi.call).toBeGreaterThan(lo.call);
  });

  it('最优动作选择正确：胜率极高时加注优于跟注', () => {
    const evs = estimateEvs({ equity: 0.95, pot: 100, toCall: 20, raiseTo: 120, stack: 900, bigBlind: 10 });
    const best = bestActionOf(evs);
    expect(['raise', 'call']).toContain(best.action);
    expect(best.ev).toBeGreaterThanOrEqual(evs.fold);
  });

  it('最优动作：必输且需跟注时应弃牌', () => {
    const evs = estimateEvs({ equity: 0.01, pot: 100, toCall: 200, raiseTo: 400, stack: 500, bigBlind: 10 });
    const best = bestActionOf(evs);
    expect(best.action).toBe('fold');
  });
});

describe('EV 损失分级', () => {
  it('阈值边界正确（0.5BB / 2BB）', () => {
    const bb = 10;
    expect(gradeEvLoss(0, bb)).toBe('ok');
    expect(gradeEvLoss(4.9, bb)).toBe('ok');
    expect(gradeEvLoss(5.1, bb)).toBe('review');
    expect(gradeEvLoss(19.9, bb)).toBe('review');
    expect(gradeEvLoss(20.1, bb)).toBe('major');
  });

  it('阈值定义与计划一致', () => {
    expect(DEFAULT_THRESHOLDS.review).toBe(0.5);
    expect(DEFAULT_THRESHOLDS.major).toBe(2.0);
  });

  it('分级随 BB 大小缩放（同一 EV 损失在不同盲注下分级不同）', () => {
    // 10 筹码损失：盲注 10 时为 1BB（review）；盲注 100 时为 0.1BB（ok）
    expect(gradeEvLoss(10, 10)).toBe('review');
    expect(gradeEvLoss(10, 100)).toBe('ok');
  });
});

describe('动作归一化', () => {
  it('过牌与跟注归为 call；下注/加注/全下归为 raise', () => {
    expect(normalizeAction('fold')).toBe('fold');
    expect(normalizeAction('check')).toBe('call');
    expect(normalizeAction('call')).toBe('call');
    expect(normalizeAction('bet')).toBe('raise');
    expect(normalizeAction('raise')).toBe('raise');
    expect(normalizeAction('allin')).toBe('raise');
  });
});
