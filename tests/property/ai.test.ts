/**
 * AI 档位可分辨性测试（验收闸门 G7）。
 *
 * 判据（计划 §5.7 / §9 G7）：固定种子跑 2,000 手，断言
 *   1. 困难档入池率（VPIP）严格低于简单档
 *   2. 面对加注且胜率不达底池赔率要求时，困难档弃牌率严格高于简单档
 *
 * 为什么需要这条闸门：三档 AI 由同一套策略代码 + 不同参数实现，
 * 若参数接线错误（例如困难档误用简单档参数），功能表面正常但难度无差异。
 * 该测试能把「档位实际可分辨」变成可执行断言。
 */

import { describe, it, expect } from 'vitest';
import { createHand, applyAction, heroVoluntarilyEntered } from '../../src/core/hand.js';
import { legalActions } from '../../src/core/betting.js';
import { defaultSettings, type AITier, type Settings } from '../../src/core/types.js';
import { decideAI } from '../../src/ai/policy.js';
import { createRng } from '../../src/core/rng.js';
import { tierParams } from '../../src/ai/tiers.js';
import { preflopStrength, handKey, positionFactor } from '../../src/ai/preflopChart.js';
import { parseCards } from '../../src/core/cards.js';

interface SimResult {
  hands: number;
  vpipHands: number;
  vpip: number;
  /** 面对加注时的弃牌次数与总次数。 */
  foldToRaise: number;
  facedRaise: number;
  foldToRaiseRate: number;
}

/** 用指定档位跑 N 手，统计玩家位（座位 0）的入池率与面对加注弃牌率。 */
function simulate(tier: AITier, hands: number, seed: number): SimResult {
  const rng = createRng(seed);
  const settings = { ...defaultSettings(), seatCount: 6, aiTier: tier };
  let vpipHands = 0;
  let foldToRaise = 0;
  let facedRaise = 0;

  for (let h = 0; h < hands; h++) {
    const handSeed = rng.nextInt(0xffffffff);
    const dealerSeat = rng.nextInt(6);
    const state = createHand({
      handId: `sim-${h}`,
      seed: handSeed,
      settings,
      heroSeat: 0,
      dealerSeat,
    });

    let guard = 0;
    while (!state.finished && guard++ < 500) {
      const seat = state.actingSeat;
      if (seat < 0) break;
      const s = state.seats[seat];
      const legal = legalActions(state, seat);

      // 玩家位（座位 0）也用同一档位策略代打，使统计口径一致
      const decision = decideAI(state, seat, createRng(handSeed ^ (seat * 7919) ^ (guard * 104729)));

      // 统计：玩家本人面对加注时的弃牌
      if (seat === 0 && state.currentBet > state.bigBlind && s.committedThisStreet < state.currentBet) {
        facedRaise++;
        if (decision.type === 'fold') foldToRaise++;
      }

      const r = applyAction(state, decision.type, decision.toAmount, 0);
      if (!r.ok) {
        // 决策与合法集不一致时兜底，避免死循环
        if (legal.canCheck) applyAction(state, 'check', 0);
        else if (legal.canCall) applyAction(state, 'call', 0);
        else applyAction(state, 'fold', 0);
      }
    }

    if (heroVoluntarilyEntered(state, 0)) vpipHands++;
  }

  return {
    hands,
    vpipHands,
    vpip: vpipHands / hands,
    foldToRaise,
    facedRaise,
    foldToRaiseRate: facedRaise > 0 ? foldToRaise / facedRaise : 0,
  };
}

describe('G7 AI 档位可分辨', () => {
  /**
   * G7 的超时预算。
   *
   * 为什么需要显式且宽松的超时：`hard` 档每个决策跑 3000 次蒙特卡洛
   * （`TIER_PARAMS.hard.equityIterations`），而这几条断言要跑 2000 手 ≈ 3 万个决策。
   * 实测（本机，24 逻辑核）：
   *   - 单次 `decideAI`（hard，翻牌后）≈ 10ms
   *   - `easy` 2000 手 ≈ 0.1s（不做采样，只用强度近似）
   *   - `hard` 2000 手 ≈ 302s，其中 `decideAI` 占 302.4s
   *
   * 原超时为 300s，即**余量为 0**：本机任何负载波动都会让测试失败
   * （实测出现过 4540s 才超时的情形）。GitHub 的 CI runner 更快（整条 CI 约 12 分钟），
   * 所以线上没暴露，但这是真实的测试脆弱性。
   *
   * 为什么不缩小样本：已实测过 N=600 时的统计余量——
   *   - VPIP 差距：easy≈1.000 vs hard≈0.29，差距 ≈0.69，阈值 0.02 → 余量充足；
   *   - 但**单调性**断言在 N=600 时 easy=1.000 / medium=0.998，差距仅 0.002，
   *     与采样噪声同量级，会变成假失败。
   * 即：缩样本会把「超时脆弱」换成「统计脆弱」，是更差的取舍。
   * 因此保持样本量、把超时提到远高于实测成本（302s → 900s，约 3 倍余量）。
   */
  const G7_TIMEOUT_MS = 900_000;

  it('三档参数确实不同（接线正确性）', () => {
    const e = tierParams('easy');
    const m = tierParams('medium');
    const h = tierParams('hard');
    expect(e.preflopThreshold).toBeLessThan(m.preflopThreshold);
    expect(m.preflopThreshold).toBeLessThan(h.preflopThreshold);
    expect(e.foldToRaiseThreshold).toBeGreaterThan(m.foldToRaiseThreshold);
    expect(m.foldToRaiseThreshold).toBeGreaterThan(h.foldToRaiseThreshold);
    expect(e.useEquity).toBe(false);
    expect(h.useEquity).toBe(true);
    expect(h.strictPotOdds).toBe(true);
    expect(e.strictPotOdds).toBe(false);
  });

  it('困难档入池率（VPIP）严格低于简单档', () => {
    const easy = simulate('easy', 2000, 11111);
    const hard = simulate('hard', 2000, 22222);
    // 断言严格不等，避免「参数未接线但恰好相等」被放过
    expect(hard.vpip).toBeLessThan(easy.vpip);
    // 同时要求差异有实际意义（不是浮点噪声）
    expect(easy.vpip - hard.vpip).toBeGreaterThan(0.02);
  }, G7_TIMEOUT_MS);

  it('面对加注时困难档弃牌率严格高于简单档', () => {
    const easy = simulate('easy', 2000, 33333);
    const hard = simulate('hard', 2000, 44444);
    // 两个样本都必须真的遇到过加注，否则该断言是假阴性
    expect(easy.facedRaise).toBeGreaterThan(20);
    expect(hard.facedRaise).toBeGreaterThan(20);
    expect(hard.foldToRaiseRate).toBeGreaterThan(easy.foldToRaiseRate);
  }, G7_TIMEOUT_MS);

  it('中等档入池率介于简单与困难之间（单调性）', () => {
    const easy = simulate('easy', 1200, 555);
    const medium = simulate('medium', 1200, 666);
    const hard = simulate('hard', 1200, 777);
    expect(medium.vpip).toBeLessThan(easy.vpip);
    expect(hard.vpip).toBeLessThan(medium.vpip);
  }, G7_TIMEOUT_MS);

  it('AI 决策始终返回合法动作（不会产生非法动作导致卡死）', () => {
    const rng = createRng(31337);
    const settings: Settings = { ...defaultSettings(), seatCount: 6, aiTier: 'hard' };
    let decisions = 0;
    for (let h = 0; h < 300; h++) {
      const state = createHand({
        handId: `legal-${h}`,
        seed: rng.nextInt(0xffffffff),
        settings,
        heroSeat: 0,
        dealerSeat: rng.nextInt(6),
      });
      let guard = 0;
      while (!state.finished && guard++ < 500) {
        const seat = state.actingSeat;
        if (seat < 0) break;
        const d = decideAI(state, seat, createRng(h * 1000 + guard));
        const r = applyAction(state, d.type, d.toAmount, 0);
        if (r.ok) decisions++;
        else if (legalActions(state, seat).canCheck) applyAction(state, 'check', 0);
        else if (legalActions(state, seat).canCall) applyAction(state, 'call', 0);
        else applyAction(state, 'fold', 0);
      }
    }
    // 绝大多数决策都应直接合法
    expect(decisions).toBeGreaterThan(1000);
  }, 120_000);
});

describe('起手牌强度表', () => {
  it('手牌键规范化正确', () => {
    expect(handKey(parseCards('As Ah'))).toBe('AA');
    expect(handKey(parseCards('As Kh'))).toBe('AKo');
    expect(handKey(parseCards('As Ks'))).toBe('AKs');
    expect(handKey(parseCards('7h 2c'))).toBe('72o');
  });

  it('强度排序合理：AA 最高，72o 接近最低', () => {
    expect(preflopStrength(parseCards('As Ah'))).toBe(1);
    expect(preflopStrength(parseCards('As Ah'))).toBeGreaterThan(preflopStrength(parseCards('As Kh')));
    expect(preflopStrength(parseCards('As Kh'))).toBeGreaterThan(preflopStrength(parseCards('7h 2c')));
    expect(preflopStrength(parseCards('7h 2c'))).toBeLessThan(0.3);
  });

  it('同花强于非同花（同点数对比）', () => {
    expect(preflopStrength(parseCards('As Ks'))).toBeGreaterThan(preflopStrength(parseCards('Ah Kc')));
  });

  it('位置修正：后位系数大于前位', () => {
    // seatFromDealer 小 = 靠近庄家（后位），应更宽松
    const late = positionFactor(1, 6);
    const early = positionFactor(5, 6);
    expect(late).toBeGreaterThan(early);
  });
});
