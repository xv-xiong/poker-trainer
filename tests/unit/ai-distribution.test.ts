/**
 * AI 跟注概率门 + 去机械化的接线与统计单测。
 *
 * 背景：改动前 `policy.ts` 在非 strictPotOdds 档里，okToCall 不成立时会**无条件**
 * 落到「宽松跟注」，而 `strength >= preflopThreshold*0.6` 的门槛极易满足，
 * 导致简单/中等档面对下注几乎永不弃牌（实测 easy call 57.5% / fold 0%，
 * medium call 86.9% / fold 0%）。
 *
 * 本文件锁住两件事：
 *   1. 接线正确性：三个新参数（callFrequency / looseCallChance / strengthJitter）
 *      在三档上的相对关系必须符合「简单更松、中等更紧、困难中性」；
 *   2. 统计行为：固定 seed 下中等/简单档的跟注率确实被压下来、困难档的严格
 *      赔率语义没有被概率门改道，且 strengthJitter 真的让同一局面不再恒定。
 *
 * 手数刻意压到 300 手（困难档 100 手），避免拖慢 G7 之外的闸门。
 */

import { describe, it, expect } from 'vitest';
import { createHand, applyAction } from '../../src/core/hand.js';
import { legalActions } from '../../src/core/betting.js';
import { defaultSettings, type AITier, type Settings } from '../../src/core/types.js';
import { decideAI } from '../../src/ai/policy.js';
import { createRng } from '../../src/core/rng.js';
import { tierParams } from '../../src/ai/tiers.js';

interface Distribution {
  decisions: number;
  /** 面对下注（toCall > 0）的决策数。 */
  facing: number;
  /** 面对下注时各动作的次数。 */
  facingCount: Record<string, number>;
  /** 全部决策的 reason 计数。 */
  reasons: Record<string, number>;
}

/** 固定 seed 跑 N 手，统计动作与 reason 分布（口径与 G7 的 simulate 一致）。 */
function distribution(tier: AITier, hands: number, seed: number): Distribution {
  const rng = createRng(seed);
  const settings: Settings = { ...defaultSettings(), seatCount: 6, aiTier: tier };
  const facingCount: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  let decisions = 0;
  let facing = 0;

  for (let h = 0; h < hands; h++) {
    const handSeed = rng.nextInt(0xffffffff);
    const state = createHand({
      handId: `dist-${tier}-${h}`,
      seed: handSeed,
      settings,
      heroSeat: 0,
      dealerSeat: rng.nextInt(6),
    });

    let guard = 0;
    while (!state.finished && guard++ < 500) {
      const seat = state.actingSeat;
      if (seat < 0) break;
      const toCall = Math.max(0, state.currentBet - state.seats[seat].committedThisStreet);
      // 与 G7 / runAI 完全相同的 RNG 派生式
      const d = decideAI(state, seat, createRng(handSeed ^ (seat * 7919) ^ (guard * 104729)));
      decisions++;
      reasons[d.debug.reason] = (reasons[d.debug.reason] ?? 0) + 1;
      if (toCall > 0) {
        facing++;
        facingCount[d.type] = (facingCount[d.type] ?? 0) + 1;
      }

      const r = applyAction(state, d.type, d.toAmount, 0);
      if (!r.ok) {
        const legal = legalActions(state, seat);
        if (legal.canCheck) applyAction(state, 'check', 0);
        else if (legal.canCall) applyAction(state, 'call', 0);
        else applyAction(state, 'fold', 0);
      }
    }
  }

  return { decisions, facing, facingCount, reasons };
}

/** 比率；分母为 0 时返回 0，避免除零。 */
function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

describe('AI 概率门参数接线', () => {
  it('三档按「简单更松、中等更紧、困难中性」接线', () => {
    const e = tierParams('easy');
    const m = tierParams('medium');
    const h = tierParams('hard');

    // 简单档比中等档更常跟注 / 更常宽松跟注
    expect(e.callFrequency).toBeGreaterThan(m.callFrequency);
    expect(e.looseCallChance).toBeGreaterThan(m.looseCallChance);

    // 困难档走 strictPotOdds 分支，两个概率门必须是中性值，
    // 否则会篡改「胜率不足赔率要求即弃牌」的严格语义。
    expect(h.strictPotOdds).toBe(true);
    expect(h.callFrequency).toBe(1);
    expect(h.looseCallChance).toBe(0);

    // 抖动：三档都启用，且越弱越随机（简单 > 中等 > 困难）
    for (const p of [e, m, h]) {
      expect(p.strengthJitter).toBeGreaterThanOrEqual(0);
      expect(p.strengthJitter).toBeLessThanOrEqual(1);
    }
    expect(e.strengthJitter).toBeGreaterThan(m.strengthJitter);
    expect(m.strengthJitter).toBeGreaterThan(h.strengthJitter);

    // 概率门值域必须落在 [0,1]
    for (const p of [e, m]) {
      expect(p.callFrequency).toBeGreaterThan(0);
      expect(p.callFrequency).toBeLessThanOrEqual(1);
      expect(p.looseCallChance).toBeGreaterThanOrEqual(0);
      expect(p.looseCallChance).toBeLessThanOrEqual(1);
    }
  });
});

describe('AI 跟注率下调（固定 seed 统计区间）', () => {
  it('中等档面对下注：跟注率明显下降，并开始弃牌', () => {
    const d = distribution('medium', 300, 20260101);
    const call = rate(d.facingCount.call ?? 0, d.facing);
    const fold = rate(d.facingCount.fold ?? 0, d.facing);

    expect(d.facing).toBeGreaterThan(500);
    // 改动前 800 手实测 call≈86.9% / fold≈0%；本次目标 55%–65% / 10%–25%。
    // 区间留出统计余量，但任何「回到无条件跟注」的回归都会失败。
    expect(call).toBeGreaterThan(0.45);
    expect(call).toBeLessThan(0.75);
    expect(fold).toBeGreaterThan(0.08);
    expect(fold).toBeLessThan(0.4);
    // 弃牌必须来自「跟注频率门」，而不是兜底路径
    expect(d.reasons['跟注频率门弃牌'] ?? 0).toBeGreaterThan(0);
  });

  it('简单档面对下注：跟注率下降但仍是三档中最松的', () => {
    const d = distribution('easy', 300, 20260101);
    const call = rate(d.facingCount.call ?? 0, d.facing);
    const fold = rate(d.facingCount.fold ?? 0, d.facing);

    expect(d.facing).toBeGreaterThan(500);
    // 改动前 call≈57.5% / fold≈0%；目标 call 45%–55%。
    expect(call).toBeGreaterThan(0.35);
    expect(call).toBeLessThan(0.65);
    expect(fold).toBeGreaterThan(0.01);
    expect(fold).toBeLessThan(0.2);
  });

  it('困难档严格赔率语义保留：面对下注仍以弃牌为主，跟注率未上升', () => {
    const d = distribution('hard', 100, 20260101);
    const call = rate(d.facingCount.call ?? 0, d.facing);
    const fold = rate(d.facingCount.fold ?? 0, d.facing);

    expect(d.facing).toBeGreaterThan(100);
    expect(fold).toBeGreaterThan(0.3);
    expect(call).toBeLessThan(0.5);
    // 「胜率低于底池赔率要求」这条严格弃牌 reason 必须仍然存在，
    // 证明困难档没有被概率门改道。
    expect(d.reasons['胜率低于底池赔率要求'] ?? 0).toBeGreaterThan(0);
  });
});

describe('去机械化：strengthJitter 生效', () => {
  it('同一局面在不同 rng 下强度不再恒定，且始终在 [0,1]', () => {
    const settings: Settings = { ...defaultSettings(), seatCount: 6, aiTier: 'medium' };
    const state = createHand({
      handId: 'jitter',
      seed: 20260101,
      settings,
      heroSeat: 0,
      dealerSeat: 2,
    });

    // 同一局面、同一座位，仅改变 rng：强度应随抖动而分散。
    const seat = 1;
    const strengths = new Set<number>();
    for (let k = 0; k < 24; k++) {
      const d = decideAI(state, seat, createRng(k * 7919 + 13));
      expect(d.debug.strength).toBeGreaterThanOrEqual(0);
      expect(d.debug.strength).toBeLessThanOrEqual(1);
      strengths.add(d.debug.strength);
    }
    // 若 strengthJitter 未接线，24 次会得到同一个强度（Set.size === 1）。
    expect(strengths.size).toBeGreaterThan(5);
  });
});
