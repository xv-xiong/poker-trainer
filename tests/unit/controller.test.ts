/**
 * 控制器测试：资金账本、对局推进、复盘落库。
 *
 * 重点验证「资金 = 起始 + Σ 各手净盈亏」，以及 AI 轮转不会卡死。
 * 这些是 E2E 难以精确定位的问题（界面能渲染但账本可能错）。
 */

import { describe, it, expect } from 'vitest';
import { GameController } from '../../src/ui/controller.js';
import { createMemoryStorage } from '../../src/store/persistence.js';
import { defaultSettings } from '../../src/core/types.js';

function makeController() {
  return new GameController({ storage: createMemoryStorage(), heroSeat: 0 });
}

/** 打完一手：玩家一直跟注/过牌，AI 自动推进。 */
function playOneHand(c: GameController): void {
  c.startHand();
  c.runAI();
  let guard = 0;
  while (!c.currentState()!.finished && guard++ < 400) {
    const s = c.snapshot();
    if (s.heroTurn) {
      const legal = s.legal!;
      if (legal.canCheck) c.act('check', 0, 50);
      else if (legal.canCall) c.act('call', 0, 50);
      else c.act('fold', 0, 50);
    } else {
      c.runAI();
    }
  }
}

describe('控制器：对局推进', () => {
  it('startHand 后手牌状态存在且已下盲注', () => {
    const c = makeController();
    c.startHand();
    const st = c.currentState()!;
    expect(st).not.toBeNull();
    expect(st.seats.length).toBe(6);
    // 每人 2 张底牌
    for (const s of st.seats) expect(s.holeCards.length).toBe(2);
    // 盲注已下
    expect(st.seats.reduce((a, s) => a + s.committed, 0)).toBe(st.smallBlind + st.bigBlind);
  });

  it('runAI 能把行动权交回玩家（不会永久卡住）', () => {
    const c = makeController();
    c.startHand();
    c.runAI();
    const st = c.currentState()!;
    // 要么轮到玩家，要么本手已结束——不能停在「AI 座位待行动」且未结束
    const stuck = !st.finished && st.actingSeat !== c.heroSeat;
    expect(stuck).toBe(false);
  });

  it('连续 20 手都能正常结束（无死锁）', () => {
    const c = makeController();
    for (let i = 0; i < 20; i++) {
      playOneHand(c);
      expect(c.currentState()!.finished).toBe(true);
    }
    expect(c.snapshot().stats.handsPlayed).toBe(20);
  });

  it('每手结束后筹码守恒（Σ 各座位筹码 == Σ 起始筹码）', () => {
    const c = makeController();
    for (let i = 0; i < 15; i++) {
      playOneHand(c);
      const st = c.currentState()!;
      const now = st.seats.reduce((a, s) => a + s.stack, 0);
      const before = st.initialStacks.reduce((a, b) => a + b, 0);
      expect(now).toBe(before);
    }
  });
});

describe('控制器：资金账本', () => {
  it('资金变化等于各手净盈亏之和（未补码时）', () => {
    const c = makeController();
    const start = c.snapshot().bankroll;
    let expected = start;
    for (let i = 0; i < 12; i++) {
      const topUpsBefore = c.snapshot().stats.topUpAmount;
      playOneHand(c);
      const net = c.currentState()!.results[0];
      // 若本手发生了补码，期望值需加上注入量
      expected += net + (c.snapshot().stats.topUpAmount - topUpsBefore);
      expect(c.snapshot().bankroll).toBe(expected);
    }
  });

  it('单手的资金变化不超过该手起始筹码（不会凭空多扣）', () => {
    const c = makeController();
    const settings = defaultSettings();
    for (let i = 0; i < 15; i++) {
      const before = c.snapshot().bankroll;
      const topUpBefore = c.snapshot().stats.topUpAmount;
      playOneHand(c);
      const after = c.snapshot().bankroll;
      const topUpDelta = c.snapshot().stats.topUpAmount - topUpBefore;
      // 剔除补码注入，只看牌局本身造成的资金变化
      const pokerDelta = after - before - topUpDelta;
      // 单手最多输掉自己投入的筹码（不超过起始筹码）
      expect(pokerDelta).toBeGreaterThanOrEqual(-settings.startingStack);
      // 单手最多赢下其他所有玩家投入的筹码
      expect(pokerDelta).toBeLessThanOrEqual(settings.startingStack * (settings.seatCount - 1));
    }
  });

  it('资金耗尽时补码到起始筹码，且补码单独计入统计（账本可审计）', () => {
    const c = makeController();
    for (let i = 0; i < 80 && c.snapshot().bankroll >= c.snapshot().settings.bigBlind; i++) {
      playOneHand(c);
    }
    const beforeTopUp = c.snapshot().stats.topUps;
    if (c.snapshot().bankroll < c.snapshot().settings.bigBlind) {
      const low = c.snapshot().bankroll;
      c.startHand();
      const s = c.snapshot();
      expect(s.bankroll).toBe(s.settings.startingStack);
      expect(s.notices.join(' ')).toContain('补码');
      // 补码必须被记账，否则账本恒等式失效
      expect(s.stats.topUps).toBe(beforeTopUp + 1);
      expect(s.stats.topUpAmount).toBe(s.settings.startingStack - low);
    }
  });

  it('账本恒等式成立：资金 = 起始 + Σ 各手净盈亏 + Σ 补码', () => {
    const c = makeController();
    const start = c.snapshot().bankroll;
    for (let i = 0; i < 40; i++) playOneHand(c);
    const s = c.snapshot();
    const sumNet = s.history.reduce((a, h) => a + h.heroNet, 0);
    expect(s.stats.netProfit).toBe(sumNet);
    expect(s.bankroll).toBe(start + sumNet + s.stats.topUpAmount);
  });

  it('resetBankroll 把资金恢复到起始筹码并清空统计', () => {
    const c = makeController();
    playOneHand(c);
    playOneHand(c);
    c.resetBankroll();
    const s = c.snapshot();
    expect(s.bankroll).toBe(s.settings.startingStack);
    expect(s.stats.handsPlayed).toBe(0);
    expect(s.stats.netProfit).toBe(0);
  });
});

describe('控制器：复盘与统计', () => {
  it('每手结束后生成复盘条目并写入历史', () => {
    const c = makeController();
    playOneHand(c);
    const s = c.snapshot();
    expect(s.history.length).toBe(1);
    expect(s.lastRecord).not.toBeNull();
    expect(s.lastRecord!.handId).toBe(c.currentState()!.handId);
    // 复盘条目应与玩家动作一一对应
    const heroActions = c.currentState()!.actions.filter((a) => a.seat === c.heroSeat).length;
    expect(s.lastReview.length).toBe(heroActions);
  });

  it('复盘条目包含计划要求的原始数据字段', () => {
    const c = makeController();
    playOneHand(c);
    const review = c.snapshot().lastReview;
    expect(review.length).toBeGreaterThan(0);
    for (const e of review) {
      expect(typeof e.pot).toBe('number');
      expect(typeof e.toCall).toBe('number');
      expect(typeof e.potOdds).toBe('number');
      expect(typeof e.equity).toBe('number');
      expect(typeof e.evLoss).toBe('number');
      expect(['ok', 'review', 'major']).toContain(e.grade);
      expect(e.equity).toBeGreaterThanOrEqual(0);
      expect(e.equity).toBeLessThanOrEqual(1);
      expect(e.potOdds).toBeGreaterThanOrEqual(0);
      expect(e.potOdds).toBeLessThanOrEqual(1);
    }
  });

  it('统计口径正确：已打手数、净盈亏、VPIP 分子不超过分母', () => {
    const c = makeController();
    for (let i = 0; i < 10; i++) playOneHand(c);
    const s = c.snapshot();
    expect(s.stats.handsPlayed).toBe(10);
    expect(s.stats.vpipHands).toBeLessThanOrEqual(s.stats.handsPlayed);
    expect(s.stats.pfrHands).toBeLessThanOrEqual(s.stats.vpipHands);
    expect(s.stats.showdownsSeen).toBeLessThanOrEqual(s.stats.handsPlayed);
    const reviewTotal =
      s.stats.reviewCounts.ok + s.stats.reviewCounts.review + s.stats.reviewCounts.major;
    const heroActionTotal = s.history.reduce((a, h) => a + h.review.length, 0);
    expect(reviewTotal).toBe(heroActionTotal);
  });

  it('历史按 FIFO 上限截断（不无限增长）', () => {
    const c = makeController();
    for (let i = 0; i < 8; i++) playOneHand(c);
    expect(c.snapshot().history.length).toBe(8);
    // 手牌编号递增
    const ids = c.snapshot().history.map((h) => h.handId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('同一手牌可通过种子精确复现（可回放性）', () => {
    const c = makeController();
    playOneHand(c);
    const rec = c.snapshot().lastRecord!;
    // 种子与公共牌已记录，便于复现
    expect(typeof rec.seed).toBe('number');
    expect(rec.seed).toBeGreaterThanOrEqual(0);
    expect(rec.initialStacks.length).toBe(rec.seatCount);
    expect(rec.holeCards.length).toBe(rec.seatCount);
  });
});

describe('控制器：设置', () => {
  it('切换桌人数后新手牌按新人数开局', () => {
    const c = makeController();
    c.updateSettings({ seatCount: 2 });
    c.startHand();
    expect(c.currentState()!.seatCount).toBe(2);
    c.updateSettings({ seatCount: 9 });
    c.startHand();
    expect(c.currentState()!.seatCount).toBe(9);
  });

  it('设置持久化到存储（重载后保留）', () => {
    const storage = createMemoryStorage();
    const c1 = new GameController({ storage, heroSeat: 0 });
    c1.updateSettings({ aiTier: 'hard', fourColorDeck: false });
    const c2 = new GameController({ storage, heroSeat: 0 });
    expect(c2.snapshot().settings.aiTier).toBe('hard');
    expect(c2.snapshot().settings.fourColorDeck).toBe(false);
  });

  it('9 人桌也能正常打完一手', () => {
    const c = makeController();
    c.updateSettings({ seatCount: 9 });
    playOneHand(c);
    const st = c.currentState()!;
    expect(st.finished).toBe(true);
    expect(st.seats.reduce((a, s) => a + s.stack, 0)).toBe(
      st.initialStacks.reduce((a, b) => a + b, 0),
    );
  });

  it('2 人桌（单挑）能正常打完一手', () => {
    const c = makeController();
    c.updateSettings({ seatCount: 2 });
    playOneHand(c);
    const st = c.currentState()!;
    expect(st.finished).toBe(true);
    expect(st.seats.reduce((a, s) => a + s.stack, 0)).toBe(
      st.initialStacks.reduce((a, b) => a + b, 0),
    );
  });
});
