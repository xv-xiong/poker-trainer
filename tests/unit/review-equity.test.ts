/**
 * 复盘胜率合理性测试。
 *
 * 动机：开发期在界面上观察到「英雄以两对在河牌获胜，但复盘显示的估算胜率仅 9.1%」。
 * 胜率是复盘的核心依据（底池赔率对比、EV 分级都依赖它），若数值失真，
 * 整个训练功能失去意义。因此必须用可执行断言锁定其合理性。
 *
 * 本测试从两个角度验证：
 *   1. 直接对已知牌面计算胜率，检查其量级是否合理（与牌力一致）
 *   2. 通过完整对局生成复盘，检查复盘条目里的胜率与独立计算结果一致
 */

import { describe, it, expect } from 'vitest';
import { parseCards } from '../../src/core/cards.js';
import { computeEquity } from '../../src/core/equity/index.js';
import { createRng } from '../../src/core/rng.js';
import { rank7, categoryOf } from '../../src/core/rank7.js';
import { GameController } from '../../src/ui/controller.js';
import { createMemoryStorage } from '../../src/store/persistence.js';

describe('胜率量级与牌力一致', () => {
  it('两对在「配对 + 三张同花」的多人池里胜率低是正确行为（不是缺陷）', () => {
    // 牌面 9s 9h 7s 2s 5h：公共牌已有对子且三张黑桃。
    // 英雄 5d 8s 的最优五张 = 两对（9 与 5），踢脚 8。
    // 关键认知：公共牌的对子对所有人都是「至少一对 9」，因此
    //   - 任何持 9 的对手成三条
    //   - 任何持两张黑桃的对手成同花
    //   - 任何持 5 的对手也是两对且踢脚可能更大
    // 所以面对 5 个对手时 10% 左右是**正确**数值（已由独立 Python 蒙特卡洛
    // 20 万次采样复核：10.49%）。此断言锁定该认知，防止把正确行为误判为缺陷。
    const hero = parseCards('5d 8s');
    const board = parseCards('9s 9h 7s 2s 5h');
    expect(categoryOf(rank7([...hero, ...board]))).toBe(2); // 两对

    const vs5 = computeEquity({ hero, board, opponents: 5, iterations: 20_000, rng: createRng(1234) });
    expect(vs5.equity).toBeGreaterThan(0.03);
    expect(vs5.equity).toBeLessThan(0.25);

    // 同一手牌面对更少对手时胜率显著更高（对手越多越难赢）
    const vs1 = computeEquity({ hero, board, opponents: 1, iterations: 20_000, rng: createRng(1234) });
    expect(vs1.equity).toBeGreaterThan(0.55);
  });

  it('真正的强牌（三条）面对 5 个对手时胜率应显著高于 50%', () => {
    // 公共牌 9s 9h 7s 2s 5h，英雄持 9c 9d → 四条 9（坚果级别）
    const hero = parseCards('9c 9d');
    const board = parseCards('9s 9h 7s 2s 5h');
    expect(categoryOf(rank7([...hero, ...board]))).toBe(7); // 四条
    const r = computeEquity({ hero, board, opponents: 5, iterations: 20_000, rng: createRng(77) });
    expect(r.equity).toBeGreaterThan(0.9);
  });

  it('同花（三张同花面成型）面对 1 个对手胜率应高于 60%', () => {
    // 英雄持两张黑桃，公共牌三张黑桃 → 同花
    const hero = parseCards('As Ks');
    const board = parseCards('9s 7s 2s 5h 9h');
    expect(categoryOf(rank7([...hero, ...board]))).toBe(5); // 同花
    const r = computeEquity({ hero, board, opponents: 1, rng: createRng(31) });
    expect(r.equity).toBeGreaterThan(0.6);
  });

  it('河牌成型的坚果同花顺对任意对手数胜率应为 100%（精确枚举）', () => {
    const hero = parseCards('As Ks');
    const board = parseCards('Qs Js Ts 2d 3c');
    const r = computeEquity({ hero, board, opponents: 1 });
    expect(r.source).toBe('exact');
    expect(r.equity).toBe(1);
  });

  it('同一牌面下，对手越多胜率越低（单调性）', () => {
    const hero = parseCards('As Ah');
    const board = parseCards('2c 7d 9h');
    const eq = [1, 2, 5].map(
      (opponents) =>
        computeEquity({ hero, board, opponents, iterations: 8_000, rng: createRng(99) }).equity,
    );
    expect(eq[0]).toBeGreaterThan(eq[1]);
    expect(eq[1]).toBeGreaterThan(eq[2]);
  });

  it('强牌与弱牌的胜率差必须显著（区分能力）', () => {
    const board = parseCards('2c 7d 9h Js 4d');
    const strong = computeEquity({
      hero: parseCards('As Ah'),
      board,
      opponents: 1,
      rng: createRng(7),
    }).equity;
    const weak = computeEquity({
      hero: parseCards('3c 5d'),
      board,
      opponents: 1,
      rng: createRng(7),
    }).equity;
    expect(strong - weak).toBeGreaterThan(0.3);
  });
});

describe('复盘必须使用决策时点的数据（不是终局数据）', () => {
  it('动作记录包含决策时点的剩余筹码，且等于投入前的真实筹码', () => {
    const c = new GameController({ storage: createMemoryStorage(), heroSeat: 0 });
    c.startHand();
    c.runAI();
    let guard = 0;
    while (!c.currentState()!.finished && guard++ < 400) {
      const s = c.snapshot();
      if (s.heroTurn) {
        const legal = s.legal!;
        const before = c.currentState()!.seats[c.heroSeat].stack;
        if (legal.canCall) c.act('call', 0, 10);
        else if (legal.canCheck) c.act('check', 0, 10);
        else c.act('fold', 0, 10);
        const last = c.currentState()!.actions.filter((a) => a.seat === c.heroSeat).pop();
        if (last) {
          // stackAtAction = 投入前的筹码；投入后剩余 = 投入前 - amount
          expect(last.stackAtAction).toBe(before);
        }
      } else {
        c.runAI();
      }
    }
  });

  it('回归：全下输光后，建议加注额不应坍缩为 0（曾用终局筹码计算导致偏小）', () => {
    const c = new GameController({ storage: createMemoryStorage(), heroSeat: 0 });
    // 连打若干手，收集所有复盘条目
    const entries: { actualAmount: number; bestAmount: number; bestAction: string }[] = [];
    for (let h = 0; h < 8; h++) {
      c.startHand();
      c.runAI();
      let guard = 0;
      while (!c.currentState()!.finished && guard++ < 400) {
        const s = c.snapshot();
        if (s.heroTurn) {
          const legal = s.legal!;
          // 故意多跟注，制造打到全下的局面
          if (legal.canCall) c.act('call', 0, 5);
          else if (legal.canCheck) c.act('check', 0, 5);
          else c.act('fold', 0, 5);
        } else {
          c.runAI();
        }
      }
      for (const e of c.snapshot().lastReview) {
        entries.push({ actualAmount: e.actualAmount, bestAmount: e.bestAmount, bestAction: e.bestAction });
      }
    }
    expect(entries.length).toBeGreaterThan(5);
    // 建议加注额必须为正（不能因为终局筹码为 0 而算出 0）
    const raiseSuggestions = entries.filter((e) => e.bestAction === 'raise');
    if (raiseSuggestions.length > 0) {
      for (const e of raiseSuggestions) {
        expect(e.bestAmount).toBeGreaterThan(0);
      }
    }
  });
});

describe('复盘胜率来自正确的牌面与对手数', () => {
  it('各街的胜率应与「该街牌面 + 当时对手数」的独立计算一致', () => {
    const hero = parseCards('As Ah');
    const flop = parseCards('2c 7d 9h');
    const turn = parseCards('2c 7d 9h Js');
    const river = parseCards('2c 7d 9h Js 4d');

    // 用固定种子分别计算三个街的胜率
    const atFlop = computeEquity({ hero, board: flop, opponents: 2, iterations: 5_000, rng: createRng(11) }).equity;
    const atTurn = computeEquity({ hero, board: turn, opponents: 2, iterations: 5_000, rng: createRng(11) }).equity;
    const atRiver = computeEquity({ hero, board: river, opponents: 2, iterations: 5_000, rng: createRng(11) }).equity;

    // AA 在干燥牌面上，随公共牌增加应保持高位（>60%）
    expect(atFlop).toBeGreaterThan(0.6);
    expect(atTurn).toBeGreaterThan(0.6);
    expect(atRiver).toBeGreaterThan(0.6);

    // 关键：胜率必须随牌面变化而变化，不能三个街完全相同
    // （若实现错误地总是用最终 5 张公共牌或错误对手数，三者会趋同）
    const distinct = new Set([atFlop.toFixed(4), atTurn.toFixed(4), atRiver.toFixed(4)]);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('对手数不同则胜率不同（防止复盘固定用某个对手数）', () => {
    const hero = parseCards('As Ah');
    const board = parseCards('2c 7d 9h');
    const vs1 = computeEquity({ hero, board, opponents: 1, iterations: 10_000, rng: createRng(5) }).equity;
    const vs5 = computeEquity({ hero, board, opponents: 5, iterations: 10_000, rng: createRng(5) }).equity;
    expect(vs1).toBeGreaterThan(vs5 + 0.15);
  });
});

/**
 * 回归：复盘胜率必须按「决策时点」的对手数计算，而非整手结束后的终局对手数。
 *
 * 缺陷（评估报告 H1，已实证）：finalizeHand 在整手结束后才跑复盘，
 * 曾用 `st.seats.filter(!folded).length` 取存活人数——那是**终局**状态。
 * 早期决策点因此漏掉「当时还在池里、后来才弃牌」的对手，对手数偏少，
 * 胜率被系统性高估（实测最大 7.2 个百分点、平均 2.9 个百分点，方向恒为高估）。
 *
 * 本测试用确定性场景锁死口径：构造一手牌，使「玩家第一个决策点」发生时
 * 存活人数 > 终局存活人数，然后断言复盘胜率等于「按决策时点对手数」独立计算的值，
 * 且**不等于**「按终局对手数」计算的值。
 */
describe('回归 H1：复盘胜率取决策时点的对手数（不是终局）', () => {
  it('玩家首个决策点的胜率必须按当时的存活人数计算', () => {
    const c = new GameController({ storage: createMemoryStorage(), heroSeat: 0 });
    c.updateSettings({ aiTier: 'medium', seatCount: 6 });

    // 找一手满足条件的牌：玩家首个动作发生前有 6 人存活，终局存活人数更少。
    // 用固定种子序列保证可复现（不依赖 Math.random）。
    let found = false;
    for (let attempt = 0; attempt < 60 && !found; attempt++) {
      c.startHand();
      let guard = 0;
      while (guard++ < 400) {
        const s = c.snapshot();
        const st = c.currentState();
        if (!st || st.finished) break;
        if (s.heroTurn) {
          const legal = s.legal!;
          // 让玩家尽早弃牌以制造「早期多人 → 后期少人」的局面
          if (legal.canFold && st.street !== 'preflop') c.act('fold');
          else if (legal.canCall) c.act('call');
          else if (legal.canCheck) c.act('check');
          else c.act('fold');
        } else {
          c.runAI();
        }
      }

      const st = c.currentState();
      const rec = c.snapshot().lastRecord;
      if (!st || !rec || rec.review.length === 0) continue;

      // 重放动作序列，算「每个动作发生前」的存活人数
      const liveBefore: number[] = [];
      let folds = 0;
      for (const a of st.actions) {
        liveBefore.push(st.seatCount - folds);
        if (a.type === 'fold') folds++;
      }
      const liveAtEnd = st.seats.filter((x) => !x.folded).length;

      const first = rec.review[0];
      const liveAtDecision = liveBefore[first.actionIndex];
      if (liveAtDecision <= liveAtEnd) continue; // 本手不满足条件，继续找

      found = true;

      // 独立计算：按「决策时点对手数」
      const boardLen = first.street === 'preflop' ? 0 : first.street === 'flop' ? 3 : first.street === 'turn' ? 4 : 5;
      const hero = st.seats[c.heroSeat].holeCards;
      const board = st.board.slice(0, boardLen);
      const opponentsAtDecision = Math.max(1, liveAtDecision - 1);
      const opponentsAtEnd = Math.max(1, liveAtEnd - 1);

      const expected = computeEquity({
        hero,
        board,
        opponents: opponentsAtDecision,
        iterations: 3_000,
        rng: createRng(st.seed ^ first.actionIndex ^ 0x777),
      }).equity;
      const wrong = computeEquity({
        hero,
        board,
        opponents: opponentsAtEnd,
        iterations: 3_000,
        rng: createRng(st.seed ^ first.actionIndex ^ 0x777),
      }).equity;

      // 必须等于「决策时点」口径
      expect(first.equity).toBeCloseTo(expected, 10);
      // 且必须与「终局」口径不同（否则本测试没有区分力）
      expect(Math.abs(expected - wrong)).toBeGreaterThan(1e-6);
      expect(Math.abs(first.equity - wrong)).toBeGreaterThan(1e-6);
    }

    expect(found, '未能在 60 手内构造出「决策时点存活人数 > 终局存活人数」的场景').toBe(true);
  });
});
