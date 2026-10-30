/**
 * 阶段 1-1：筹码继承模式的单测。
 *
 * 覆盖三块：
 *   1. 持久化迁移（v1 → v2 补三个新字段，旧存档不得被判为损坏）
 *   2. 派生量（sessionEndOf / pendingBustsOf）—— 结局与补码队列是算出来的，
 *      不存第二份状态，所以这两个纯函数是整条链路的地基
 *   3. 控制器行为（筹码跨手延续、补码记账、AI 下桌、胜利判定、账本恒等式）
 *
 * 为什么账本恒等式必须在这里测：继承模式把「每手重置」换成了真实流转，
 * 一旦 results 没写回账本，玩家会看到筹码凭空消失或增殖，而界面看起来完全正常。
 *
 * 注意：桌人数只能用 2 / 6 / 9（`validateSettings` 的合法域）。用 3 会被
 * 持久化层判为损坏并整份归档重置，测试会莫名其妙地「全部拿到默认值」。
 */

import { describe, it, expect } from 'vitest';
import { GameController, pendingBustsOf, sessionEndOf } from '../../src/ui/controller.js';
import { createMemoryStorage, saveState } from '../../src/store/persistence.js';
import {
  SCHEMA_VERSION,
  buildRoster,
  initialState,
  migrateState,
  type PersistedState,
  type RosterSeat,
} from '../../src/store/schema.js';
import { defaultSettings, emptyStats, type Settings } from '../../src/core/types.js';
import { buildSessionSummary, handFeedback } from '../../src/review/session.js';

/** 6 人桌设置（合法域内，且能给多个 AI 不同筹码）。 */
const SIX: Settings = { ...defaultSettings(), seatCount: 6 };

/** 造若干 AI 座位，筹码依次取给定值。 */
function rosterOf(stacks: number[], out: boolean[] = []): RosterSeat[] {
  return stacks.map((stack, i) => ({
    id: i + 1,
    name: `AI-${i + 1}`,
    stack,
    out: out[i] ?? false,
  }));
}

/** 用一份「预置存档」创建控制器，从而精确控制筹码与账本。 */
function seededController(patch: Partial<PersistedState>): GameController {
  const storage = createMemoryStorage();
  saveState(storage, { ...initialState(), ...patch });
  return new GameController({ storage, heroSeat: 0 });
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

describe('阶段 1-1：持久化迁移 v1 → v2', () => {
  it('旧存档补齐 carryOverStacks / roster / heroOut 三个字段', () => {
    const v1 = {
      schemaVersion: 1,
      bankroll: 1200,
      settings: defaultSettings(),
      stats: emptyStats(),
      nextDealerSeat: 2,
      handCounter: 7,
    };
    const migrated = migrateState(v1 as unknown as Record<string, unknown>);
    expect(migrated).not.toBeNull();
    expect(migrated!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated!.bankroll).toBe(1200);
    expect(migrated!.handCounter).toBe(7);
    // 新字段一律取「安全的默认值」：不继承筹码、账本为空、玩家未出局
    expect(migrated!.carryOverStacks).toBe(false);
    expect(migrated!.roster).toEqual([]);
    expect(migrated!.heroOut).toBe(false);
  });

  it('迁移保留已有的新字段值（不是无条件覆盖成默认值）', () => {
    const v1 = {
      schemaVersion: 1,
      bankroll: 500,
      settings: defaultSettings(),
      stats: emptyStats(),
      nextDealerSeat: 0,
      handCounter: 0,
      carryOverStacks: true,
      roster: [{ id: 1, name: 'AI-1', stack: 300, out: true }],
      heroOut: true,
    };
    const migrated = migrateState(v1 as unknown as Record<string, unknown>)!;
    expect(migrated.carryOverStacks).toBe(true);
    expect(migrated.heroOut).toBe(true);
    expect(migrated.roster).toEqual([{ id: 1, name: 'AI-1', stack: 300, out: true }]);
  });

  it('buildRoster 生成 seatCount-1 个座位，筹码均为起始筹码', () => {
    const roster = buildRoster(5, 1000);
    expect(roster).toHaveLength(5);
    expect(roster.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(roster.map((r) => r.name)).toEqual(['AI-1', 'AI-2', 'AI-3', 'AI-4', 'AI-5']);
    expect(roster.every((r) => r.stack === 1000 && !r.out)).toBe(true);
  });
});

describe('阶段 1-1：结局与补码队列（派生量）', () => {
  const base = (): PersistedState => ({
    ...initialState(),
    carryOverStacks: true,
    roster: buildRoster(5, 1000),
  });

  it('单局练习模式下永远没有结局、也没有补码问题', () => {
    const st: PersistedState = { ...base(), carryOverStacks: false, heroOut: true, bankroll: 0 };
    expect(sessionEndOf(st)).toBeNull();
    expect(pendingBustsOf(st)).toEqual([]);
  });

  it('继承模式下的正常状态：无结局、无待补码', () => {
    expect(sessionEndOf(base())).toBeNull();
    expect(pendingBustsOf(base())).toEqual([]);
  });

  it('玩家筹码不足一个大盲时进入补码队列（而不是 <= 0）', () => {
    const st: PersistedState = { ...base(), bankroll: 5, settings: SIX };
    expect(pendingBustsOf(st)).toEqual([{ who: 'hero', name: '你', stack: 5 }]);
    // 刚好等于一个大盲不算输光（还能交盲注）
    expect(pendingBustsOf({ ...st, bankroll: 10 })).toEqual([]);
  });

  it('玩家优先于 AI 出现在补码队列里', () => {
    const st: PersistedState = {
      ...base(),
      bankroll: 3,
      settings: SIX,
      roster: rosterOf([4, 1000, 1000, 1000, 1000]),
    };
    const queue = pendingBustsOf(st);
    expect(queue).toHaveLength(2);
    expect(queue[0].who).toBe('hero');
    expect(queue[1].who).toBe(1);
  });

  it('heroOut 推导为「玩家出局」结局', () => {
    const end = sessionEndOf({ ...base(), heroOut: true, stats: { ...emptyStats(), handsPlayed: 12 } });
    expect(end).toEqual({ kind: 'hero-bust', handsPlayed: 12 });
  });

  it('AI 全部下桌推导为「赢下整桌」结局，且此时不再有补码问题', () => {
    const st: PersistedState = {
      ...base(),
      roster: rosterOf([0, 0, 0, 0, 0], [true, true, true, true, true]),
    };
    expect(sessionEndOf(st)).toEqual({ kind: 'victory', handsPlayed: 0 });
    expect(pendingBustsOf(st)).toEqual([]);
  });

  it('已出局的座位不再进入补码队列', () => {
    const st: PersistedState = {
      ...base(),
      roster: rosterOf([0, 1000, 1000, 1000, 1000], [true]),
    };
    expect(pendingBustsOf(st)).toEqual([]);
  });
});

describe('阶段 1-1：筹码真的跨手延续', () => {
  it('开局时把账本里的筹码原样带进牌桌（而不是起始筹码）', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 700,
      settings: SIX,
      roster: rosterOf([500, 1200, 1000, 1000, 1000]),
    });
    c.startHand();
    const st = c.currentState()!;
    expect(st.seatCount).toBe(6);
    // 用 initialStacks 而不是 seats[i].stack：后者已扣掉刚下的盲注
    expect(st.initialStacks[0]).toBe(700);
    expect(st.initialStacks[1]).toBe(500);
    expect(st.initialStacks[2]).toBe(1200);
  });

  it('已下桌的 AI 不再入座，桌人数随之收缩（派生设置不写回配置）', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 900,
      settings: SIX,
      roster: rosterOf([0, 1200, 1000, 1000, 1000], [true]),
    });
    c.startHand();
    const st = c.currentState()!;
    expect(st.seatCount).toBe(5);
    expect(st.seats[1].name).toBe('AI-2');
    expect(st.initialStacks[1]).toBe(1200);
    // 用户配置里的桌人数不应被「AI 下桌」污染
    expect(c.snapshot().settings.seatCount).toBe(6);
  });

  it('筹码不足大盲的 AI 会先被要求补码，未回答前不能开新手牌', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 900,
      settings: SIX,
      roster: rosterOf([5, 1200, 1000, 1000, 1000]),
    });
    c.startHand();
    expect(c.currentState()).toBeNull();
    expect(c.snapshot().pendingBusts).toEqual([{ who: 1, name: 'AI-1', stack: 5 }]);

    c.resolveBust(1, false);
    expect(c.snapshot().roster[0].out).toBe(true);
    expect(c.snapshot().pendingBusts).toEqual([]);

    c.startHand();
    expect(c.currentState()!.seatCount).toBe(5);
  });

  it('AI 选择补码后筹码回到起始筹码，并继续入座', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 900,
      settings: SIX,
      roster: rosterOf([5, 1200, 1000, 1000, 1000]),
    });
    c.resolveBust(1, true);
    expect(c.snapshot().roster[0]).toMatchObject({ stack: 1000, out: false });
    c.startHand();
    expect(c.currentState()!.seatCount).toBe(6);
  });

  it('一手的输赢会写回账本（而不是每手重置）', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 1000,
      settings: { ...defaultSettings(), seatCount: 2 },
      roster: rosterOf([1000]),
    });
    playOneHand(c);
    const after = c.snapshot();
    const rosterStack = after.roster[0].stack;
    // 单挑零和：玩家资金的变化必须与 AI 筹码的变化等额反向。
    //
    // 这里断言「两者之和为 0」而不是 `heroDelta === -aiDelta`：单挑也可能打平
    // （公共牌成牌、双方分池），此时两边变化都是 0，而 `-(0)` 是 `-0`，
    // `Object.is(0, -0) === false`，用 `toBe` 会偶发假红。
    // 牌局种子取 `Date.now() ^ handCounter * ...`（见 controller.startHand），
    // 每次运行抽到的牌都不同，所以这个假红只在跑到平局手时出现，很难复现。
    const heroDelta = after.bankroll - 1000;
    const aiDelta = rosterStack - 1000;
    expect(heroDelta + aiDelta).toBe(0);
  });
});

describe('阶段 1-1：补码与出局', () => {
  it('玩家补码：资金回到起始筹码，补码额单独记账（账本可审计）', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 5,
      settings: SIX,
      roster: rosterOf([1000, 1000, 1000, 1000, 1000]),
    });
    c.resolveBust('hero', true);
    const s = c.snapshot();
    expect(s.bankroll).toBe(1000);
    expect(s.stats.topUps).toBe(1);
    expect(s.stats.topUpAmount).toBe(995);
    expect(s.sessionEnd).toBeNull();
  });

  it('玩家不补码：进入「玩家出局」结局，且不能再开新手牌', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 5,
      settings: SIX,
      roster: rosterOf([1000, 1000, 1000, 1000, 1000]),
    });
    c.resolveBust('hero', false);
    const s = c.snapshot();
    expect(s.sessionEnd).toEqual({ kind: 'hero-bust', handsPlayed: 0 });
    expect(s.pendingBusts).toEqual([]);
    c.startHand();
    expect(c.currentState()).toBeNull();
  });

  it('最后一个 AI 下桌 → 赢下整桌', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 3000,
      settings: SIX,
      roster: rosterOf([5, 0, 0, 0, 0], [false, true, true, true, true]),
    });
    c.resolveBust(1, false);
    const s = c.snapshot();
    expect(s.sessionEnd).toEqual({ kind: 'victory', handsPlayed: 0 });
    expect(s.pendingBusts).toEqual([]);
  });

  it('「重新开始」把资金补回起始筹码，并清空账本与结局', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 0,
      heroOut: true,
      settings: SIX,
      roster: rosterOf([0, 0, 0, 0, 0], [true, true, true, true, true]),
    });
    c.restartSession();
    const s = c.snapshot();
    expect(s.bankroll).toBe(1000);
    expect(s.sessionEnd).toBeNull();
    expect(s.roster).toHaveLength(5);
    expect(s.roster.every((r) => !r.out && r.stack === 1000)).toBe(true);
    // 重开同样要走补码记账，否则账本恒等式会破
    expect(s.stats.topUps).toBe(1);
    expect(c.currentState()).not.toBeNull();
  });

  it('切换模式等价于换新桌：资金与账本都重置，统计也清零', () => {
    const c = seededController({ carryOverStacks: false, settings: SIX });
    c.setCarryOverStacks(true);
    let s = c.snapshot();
    expect(s.carryOverStacks).toBe(true);
    expect(s.roster).toHaveLength(5);
    expect(s.bankroll).toBe(1000);
    expect(s.stats.handsPlayed).toBe(0);
    expect(c.currentState()).not.toBeNull();

    c.setCarryOverStacks(false);
    s = c.snapshot();
    expect(s.carryOverStacks).toBe(false);
    expect(s.roster).toEqual([]);
    expect(s.bankroll).toBe(1000);
  });
});

describe('阶段 1-1：账本恒等式在继承模式下依然成立', () => {
  it('资金 + 各 AI 筹码 = 起始总额 + Σ 补码（连打多手不漂移）', () => {
    const c = seededController({
      carryOverStacks: true,
      bankroll: 1000,
      settings: { ...defaultSettings(), seatCount: 2 },
      roster: rosterOf([1000]),
    });
    const START_TOTAL = 2000;

    for (let i = 0; i < 12; i++) {
      // 有补码问题就先补码（让对局能继续），有结局就停
      const pending = c.snapshot().pendingBusts[0];
      if (pending) c.resolveBust(pending.who, true);
      if (c.snapshot().sessionEnd) break;
      playOneHand(c);
    }

    const s = c.snapshot();
    const held = s.bankroll + s.roster.reduce((a, r) => a + r.stack, 0);
    expect(held).toBe(START_TOTAL + s.stats.topUpAmount);
  });
});

describe('阶段 1-1：总结与单手点评', () => {
  it('赢下整桌时给出鼓励性的收尾，并把最亏决策列出来', () => {
    const summary = buildSessionSummary({
      stats: {
        ...emptyStats(),
        handsPlayed: 20,
        netProfit: 800,
        vpipHands: 5,
        pfrHands: 3,
        reviewCounts: { ok: 18, review: 1, major: 1 },
      },
      history: [],
      bigBlind: 10,
      kind: 'victory',
    });
    expect(summary.headline).toContain('赢下了整桌');
    expect(summary.netBB).toBe(80);
    expect(summary.advice.length).toBeGreaterThan(0);
    expect(summary.advice.length).toBeLessThanOrEqual(4);
    // 赢下整桌不应该说「输光不等于打错」
    expect(summary.closing).not.toContain('输光');
  });

  it('玩家出局时给出可量化的改进方向（每条建议都带数字）', () => {
    const summary = buildSessionSummary({
      stats: {
        ...emptyStats(),
        handsPlayed: 30,
        netProfit: -1000,
        vpipHands: 18, // 60% —— 明显偏宽
        pfrHands: 2,
        reviewCounts: { ok: 20, review: 4, major: 6 },
      },
      history: [],
      bigBlind: 10,
      kind: 'hero-bust',
    });
    expect(summary.headline).toContain('输光');
    expect(summary.vpip).toBeCloseTo(0.6, 6);
    expect(summary.advice.some((a) => a.includes('入池偏宽'))).toBe(true);
    expect(summary.advice.some((a) => a.includes('翻前过于被动'))).toBe(true);
  });

  it('样本太小时不建议「改打法」，只提示样本不足', () => {
    const summary = buildSessionSummary({
      stats: { ...emptyStats(), handsPlayed: 3, netProfit: -1000 },
      history: [],
      bigBlind: 10,
      kind: 'hero-bust',
    });
    expect(summary.advice).toHaveLength(1);
    expect(summary.advice[0]).toContain('样本');
  });

  it('单手点评：没有可复盘的决策时给正向确认', () => {
    const fb = handFeedback([], 10);
    expect(fb.worst).toBeNull();
    expect(fb.verdict).toContain('没有需要决策');
  });

  it('单手点评：挑 EV 损失最大的那个决策，并给出替代动作', () => {
    const mk = (evLoss: number, actual: 'call' | 'fold', grade: 'review' | 'major') =>
      ({
        seat: 0,
        street: 'flop',
        actionIndex: 1,
        actual,
        actualAmount: 100,
        bestAction: 'raise',
        bestAmount: 300,
        actualEv: 0,
        bestEv: evLoss,
        evLoss,
        grade,
        pot: 400,
        toCall: 100,
        potOdds: 0.2,
        equity: 0.3,
        thinkMs: 1200,
      }) as const;

    // evLoss 单位是筹码：45 筹码 / 大盲 10 = 4.5 BB
    const fb = handFeedback([mk(12, 'call', 'review'), mk(45, 'fold', 'major')], 10);
    expect(fb.worst).not.toBeNull();
    expect(fb.worst!.actualLabel).toBe('弃牌');
    expect(fb.worst!.bestLabel).toBe('加注');
    expect(fb.verdict).toContain('4.5 BB');
  });
});

/**
 * 阶段 2-1：首屏可以直接改建桌参数，于是「改了之后到底生不生效」变成了
 * 用户会当场验证的事。
 *
 * 非继承模式下它下一手自然生效（`startHand` 用
 * `new Array(seatCount).fill(startingStack)` 现取现用）。但**继承模式**下开局
 * 筹码来自账本 `[bankroll, ...roster.map(r => r.stack)]`，根本不读
 * `settings.startingStack` —— 只 merge 设置不重建账本，用户会看到「把起始筹码
 * 从 1000 改成 2000，牌桌上还是 1000」，改完像没改。
 *
 * 因此继承模式下改这两个字段按「换一张新桌子」处理。这组测试钉住该行为，
 * 也钉住「不许顺手把非继承模式也重置掉」——那会让单局练习的累计战绩凭空消失。
 */
describe('阶段 2-1：继承模式下改建桌参数会重开一局', () => {
  it('继承模式下改起始筹码：资金、AI 筹码、统计都按新值重建', () => {
    const c = seededController({
      settings: SIX,
      carryOverStacks: true,
      bankroll: 1750,
      roster: rosterOf([900, 1100, 1300, 700, 1500]),
      stats: { ...emptyStats(), handsPlayed: 23, netProfit: 750 },
    });
    expect(c.snapshot().bankroll).toBe(1750);

    c.updateSettings({ startingStack: 2000 });

    const s = c.snapshot();
    expect(s.settings.startingStack).toBe(2000);
    expect(s.bankroll).toBe(2000); // 账本重建：不是 1750
    expect(s.stats.handsPlayed).toBe(0); // 新桌子，战绩清零
    expect(s.stats.netProfit).toBe(0);
    // AI 筹码也按新起始筹码重建
    const roster = s.roster ?? [];
    expect(roster).toHaveLength(5);
    for (const r of roster) expect(r.stack).toBe(2000);
  });

  it('继承模式下改桌人数：AI 座位数跟着变，且不带上一桌的筹码', () => {
    const c = seededController({
      settings: SIX,
      carryOverStacks: true,
      bankroll: 1500,
      roster: rosterOf([800, 800, 800, 800, 800]),
      stats: { ...emptyStats(), handsPlayed: 11 },
    });

    c.updateSettings({ seatCount: 2 });

    const s = c.snapshot();
    expect(s.settings.seatCount).toBe(2);
    expect(s.roster).toHaveLength(1); // 2 人桌 = 1 个 AI
    expect(s.roster![0].stack).toBe(s.settings.startingStack);
    expect(s.bankroll).toBe(s.settings.startingStack);
    expect(s.stats.handsPlayed).toBe(0);
  });

  it('改非建桌参数（AI 难度）不重建账本', () => {
    const c = seededController({
      settings: SIX,
      carryOverStacks: true,
      bankroll: 1750,
      roster: rosterOf([900, 1100, 1300, 700, 1500]),
      stats: { ...emptyStats(), handsPlayed: 23, netProfit: 750 },
    });

    c.updateSettings({ aiTier: 'hard' });

    const s = c.snapshot();
    expect(s.settings.aiTier).toBe('hard');
    expect(s.bankroll).toBe(1750); // 账本没动
    expect(s.stats.handsPlayed).toBe(23);
  });

  it('非继承模式下改起始筹码不重置战绩（下一手自然生效）', () => {
    const c = seededController({
      settings: SIX,
      carryOverStacks: false,
      bankroll: 1750,
      roster: [],
      stats: { ...emptyStats(), handsPlayed: 23, netProfit: 750 },
    });

    c.updateSettings({ startingStack: 2000, seatCount: 9 });

    const s = c.snapshot();
    expect(s.settings.startingStack).toBe(2000);
    expect(s.settings.seatCount).toBe(9);
    // 单局练习模式的累计战绩属于用户，不该因为改建桌参数而消失
    expect(s.stats.handsPlayed).toBe(23);
    expect(s.stats.netProfit).toBe(750);
    // 资金按差额平移：1750 + (2000 - 1000) = 2750。
    // 不平移的话顶部显示 1750 而牌桌座位已是 2000，同一屏两个数对不上。
    expect(s.bankroll).toBe(2750);
    // 平移不改变「资金 - 起始筹码 = 累计净盈亏」这个关系
    expect(s.bankroll - s.settings.startingStack).toBe(s.stats.netProfit);
  });
});
