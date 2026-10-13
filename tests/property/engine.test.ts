/**
 * 引擎守恒与边池测试（验收闸门 G4 / G5）。
 */

import { describe, it, expect } from 'vitest';
import { createHand, applyAction, checkChipConservation, totalPot } from '../../src/core/hand.js';
import { buildPots, validatePots, distributePots, seatRoles, tieBreakOrder } from '../../src/core/pot.js';
import { defaultSettings } from '../../src/core/types.js';
import { legalActions } from '../../src/core/betting.js';
import { createRng } from '../../src/core/rng.js';

const settings = { ...defaultSettings() };

describe('G4 筹码守恒（属性测试：10,000 手随机对局）', () => {
  it('每手结束后各座位筹码之和等于起始总额，且净盈亏合计为 0', () => {
    const rng = createRng(987654321);
    let handsRun = 0;
    let allInHands = 0;
    const failures: string[] = [];

    for (let h = 0; h < 10_000; h++) {
      const seed = rng.nextInt(0xffffffff);
      const seatCount = [2, 6, 9][rng.nextInt(3)];
      const st = { ...settings, seatCount, startingStack: 1000 };
      const dealerSeat = rng.nextInt(seatCount);
      const state = createHand({
        handId: `h${h}`,
        seed,
        settings: st,
        heroSeat: 0,
        dealerSeat,
      });

      // 随机行动直到结束
      let guard = 0;
      while (!state.finished && guard++ < 2000) {
        const seat = state.actingSeat;
        if (seat < 0) break;
        const legal = legalActions(state, seat);
        const roll = rng.nextInt(100);

        if (roll < 12 && legal.canFold) {
          applyAction(state, 'fold', 0);
        } else if (roll < 30 && legal.canRaise) {
          // 随机加注：在 [minRaiseTo, maxRaiseTo] 内取值
          const span = legal.maxRaiseTo - legal.minRaiseTo;
          const to = legal.minRaiseTo + (span > 0 ? rng.nextInt(span + 1) : 0);
          const r = applyAction(state, 'raise', to);
          if (!r.ok) applyAction(state, 'call', 0);
        } else if (roll < 36 && legal.canAllIn) {
          applyAction(state, 'allin', 0);
        } else if (legal.canCheck) {
          applyAction(state, 'check', 0);
        } else if (legal.canCall) {
          applyAction(state, 'call', 0);
        } else {
          applyAction(state, 'fold', 0);
        }
      }

      if (!state.finished) {
        failures.push(`第 ${h} 手未在 guard 内结束`);
        continue;
      }
      handsRun++;
      const anyAllIn = state.seats.some((s) => s.allIn);
      if (anyAllIn) allInHands++;

      const errs = checkChipConservation(state);
      if (errs.length > 0 && failures.length < 5) {
        failures.push(`第 ${h} 手（seed=${seed}, seats=${seatCount}）: ${errs.join('; ')}`);
      }
      // 逐手立即断言，避免累积到 10,000 手才失败
      expect(errs).toEqual([]);
    }

    expect(failures).toEqual([]);
    expect(handsRun).toBe(10_000);
    // 确认确实覆盖了全下（边池）情形，否则该测试是假阴性
    expect(allInHands).toBeGreaterThan(500);
  });
});

describe('G5 边池构建', () => {
  it('两层边池：A 全下 100、B/C 各投 300', () => {
    const committed = [100, 300, 300];
    const folded = [false, false, false];
    const pots = buildPots({ committed, folded });
    // 层边界 100 与 300：第 0 层 = 100x3 = 300；第 1 层 = 200x2 = 400
    expect(pots.length).toBe(2);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligible).toEqual([0, 1, 2]);
    expect(pots[1].amount).toBe(400);
    expect(pots[1].eligible).toEqual([1, 2]);
    expect(validatePots({ committed, folded }, pots)).toEqual([]);
  });

  it('三层边池：50 / 200 / 500', () => {
    const committed = [50, 200, 500];
    const folded = [false, false, false];
    const pots = buildPots({ committed, folded });
    expect(pots.map((p) => p.amount)).toEqual([150, 300, 300]);
    expect(pots[0].eligible).toEqual([0, 1, 2]);
    expect(pots[1].eligible).toEqual([1, 2]);
    expect(pots[2].eligible).toEqual([2]);
    expect(validatePots({ committed, folded }, pots)).toEqual([]);
  });

  it('弃牌者的投入进池但无资格分得', () => {
    const committed = [100, 100, 500];
    const folded = [true, false, false];
    const pots = buildPots({ committed, folded });
    expect(validatePots({ committed, folded }, pots)).toEqual([]);
    // 第 0 层由三人的 100 组成，但只有座位 1、2 有资格
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligible).toEqual([1, 2]);
    expect(pots[1].amount).toBe(400);
    expect(pots[1].eligible).toEqual([2]);
  });

  it('全下额不足最小加注时仍正确建池', () => {
    const committed = [5, 10, 15];
    const folded = [false, false, false];
    const pots = buildPots({ committed, folded });
    expect(pots.reduce((a, p) => a + p.amount, 0)).toBe(30);
    expect(validatePots({ committed, folded }, pots)).toEqual([]);
  });

  it('分配：全下者只能赢得其覆盖的层', () => {
    const committed = [100, 300, 300];
    const folded = [false, false, false];
    const pots = buildPots({ committed, folded });
    // 座位 0 牌型最强
    const rankOf = (s: number) => (s === 0 ? 100 : 50);
    const payouts = distributePots(pots, rankOf, [0, 1, 2], 3);
    // 座位 0 赢第 0 层 300；座位 1/2 中较强者赢第 1 层 400
    expect(payouts[0]).toBe(300);
    expect(payouts[1] + payouts[2]).toBe(400);
  });

  it('平局：奇数筹码按位置序（小盲起顺时针）分配', () => {
    // 三人各投 10，底池 30，三人牌型相同，每人 10
    const committed = [10, 10, 10];
    const folded = [false, false, false];
    const pots = buildPots({ committed, folded });
    const rankOf = () => 42;
    const order = tieBreakOrder(3, 1); // 小盲为座位 1
    expect(order).toEqual([1, 2, 0]);
    const payouts = distributePots(pots, rankOf, order, 3);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('奇数筹码确实按位置序分配', () => {
    const committed = [4, 3, 3];
    const folded = [false, false, false];
    const pots = buildPots({ committed, folded });
    expect(pots.reduce((a, p) => a + p.amount, 0)).toBe(10);
    const rankOf = () => 7;
    const order = tieBreakOrder(3, 1);
    const payouts = distributePots(pots, rankOf, order, 3);
    // 第 0 层 3x3=9 各 3；第 1 层 1x1=1 归座位 0（唯一投入 4 者）
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('弃牌的高位座位不会产生 NaN（回归：曾因 payout 数组长度按 eligible 推导而越界）', () => {
    // 触发条件：座位 2 已弃牌且索引高于所有有资格座位（eligible 最大索引为 1）。
    // 旧实现把 payout 数组长度取为 eligible 最大索引 + 1 = 2，
    // 于是结算时 payouts[2] 为 undefined，减法产生 NaN，导致「筹码总额 NaN」。
    const committed = [100, 100, 300];
    const folded = [true, false, true];
    const pots = buildPots({ committed, folded });
    const payouts = distributePots(pots, () => 1, [0, 1, 2], 3);
    // 长度必须等于座位总数，而非 eligible 最大索引 + 1
    expect(payouts.length).toBe(3);
    for (const p of payouts) expect(Number.isNaN(p)).toBe(false);
    // 第 0 层：三人各 100，共 300，唯一有资格者座位 1 独得；
    // 第 1 层：仅座位 2 投入的 200，但座位 2 已弃牌故无有资格者，该层不分配。
    expect(pots.map((p) => p.amount)).toEqual([300, 200]);
    expect(pots[1].eligible).toEqual([]);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(300);
  });

  it('未被跟注的超额投入情形：唯一未弃牌者拿回全部投入（净收益为对手投入）', () => {
    // 可达情形：座位 2 加注到 300，座位 0、1 各投入 100 后弃牌。
    // 座位 2 的 300 中未被跟注的部分随其获胜一并返还，净收益 = 200。
    const committed = [100, 100, 300];
    const folded = [true, true, false];
    const pots = buildPots({ committed, folded });
    const payouts = distributePots(pots, () => 1, [0, 1, 2], 3);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(500);
    expect(payouts[2]).toBe(500);
    expect(payouts[2] - committed[2]).toBe(200);
  });
});

describe('座位角色推导', () => {
  it('6 人桌：庄家为 0 时小盲 1、大盲 2', () => {
    expect(seatRoles(6, 0)).toEqual({
      smallBlindSeat: 1,
      bigBlindSeat: 2,
      order: [3, 4, 5, 0, 1, 2],
    });
  });

  it('2 人桌：庄家就是小盲', () => {
    const r = seatRoles(2, 0);
    expect(r.smallBlindSeat).toBe(0);
    expect(r.bigBlindSeat).toBe(1);
  });
});

describe('下注合法性与最小加注', () => {
  it('翻牌前首个行动者（大盲左侧）需跟注满额大盲', () => {
    const st = { ...settings, seatCount: 6 };
    const state = createHand({
      handId: 't1',
      seed: 12345,
      settings: st,
      heroSeat: 0,
      dealerSeat: 0,
    });
    // 庄家 0，小盲 1、大盲 2，首个行动者为座位 3（UTG）
    expect(state.actingSeat).toBe(3);
    const legal = legalActions(state, state.actingSeat);
    expect(legal.canCall).toBe(true);
    // UTG 未投入任何筹码，需跟注完整大盲 10
    expect(legal.callAmount).toBe(state.bigBlind);
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(state.bigBlind * 2);
  });

  it('小盲跟注额为 大盲 - 小盲', () => {
    const st = { ...settings, seatCount: 2 };
    // 2 人桌：庄家即小盲。庄家 0，小盲 0、大盲 1，翻牌前先行动的是小盲（座位 0）
    const state = createHand({
      handId: 't1b',
      seed: 12345,
      settings: st,
      heroSeat: 0,
      dealerSeat: 0,
    });
    expect(state.actingSeat).toBe(0);
    const legal = legalActions(state, state.actingSeat);
    expect(legal.callAmount).toBe(state.bigBlind - state.smallBlind);
  });

  it('加注额超出范围会被拒绝', () => {
    const st = { ...settings, seatCount: 6 };
    const state = createHand({
      handId: 't2',
      seed: 999,
      settings: st,
      heroSeat: 0,
      dealerSeat: 0,
    });
    const legal = legalActions(state, state.actingSeat);
    const bad = applyAction(state, 'raise', legal.maxRaiseTo + 100);
    expect(bad.ok).toBe(false);
    const tooSmall = applyAction(state, 'raise', legal.minRaiseTo - 1);
    expect(tooSmall.ok).toBe(false);
  });

  it('非法过牌被拒绝', () => {
    const st = { ...settings, seatCount: 6 };
    const state = createHand({
      handId: 't3',
      seed: 4242,
      settings: st,
      heroSeat: 0,
      dealerSeat: 0,
    });
    expect(legalActions(state, state.actingSeat).canCheck).toBe(false);
    const r = applyAction(state, 'check', 0);
    expect(r.ok).toBe(false);
  });
});

describe('对局能正常结束', () => {
  it('全员弃牌只剩一人时立即结束且不摊牌', () => {
    const st = { ...settings, seatCount: 3 };
    const state = createHand({
      handId: 't4',
      seed: 777,
      settings: st,
      heroSeat: 0,
      dealerSeat: 0,
    });
    let guard = 0;
    while (!state.finished && guard++ < 50) {
      const seat = state.actingSeat;
      if (seat < 0) break;
      const legal = legalActions(state, seat);
      if (legal.canFold) applyAction(state, 'fold', 0);
      else if (legal.canCheck) applyAction(state, 'check', 0);
      else applyAction(state, 'call', 0);
    }
    expect(state.finished).toBe(true);
    expect(state.finishReason).toBe('fold');
    expect(checkChipConservation(state)).toEqual([]);
    expect(state.seats.filter((s) => !s.folded).length).toBe(1);
  });

  it('河牌打满后进入摊牌', () => {
    const st = { ...settings, seatCount: 3 };
    const state = createHand({
      handId: 't5',
      seed: 31337,
      settings: st,
      heroSeat: 0,
      dealerSeat: 0,
    });
    let guard = 0;
    while (!state.finished && guard++ < 200) {
      const seat = state.actingSeat;
      if (seat < 0) break;
      const legal = legalActions(state, seat);
      if (legal.canCheck) applyAction(state, 'check', 0);
      else if (legal.canCall) applyAction(state, 'call', 0);
      else applyAction(state, 'fold', 0);
    }
    expect(state.finished).toBe(true);
    expect(state.finishReason).toBe('showdown');
    expect(state.board.length).toBe(5);
    expect(checkChipConservation(state)).toEqual([]);
    expect(totalPot(state)).toBeGreaterThan(0);
  });
});
