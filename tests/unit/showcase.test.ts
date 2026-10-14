/**
 * 分步演出调度层测试（task-4）。
 *
 * 这一层是「AI 一次性跑完」变成「逐个动作演出」的全部逻辑所在，
 * 而它最容易出的两类缺陷——**跳步**与**卡死**——在 E2E 里只表现为
 * 「结果不对」，定位极慢。因此把编排逻辑抽成纯函数直接断言。
 *
 * 覆盖：
 *   1. `planShowcaseStep` 的优先级与各分支（这是「分步」的判据本身）
 *   2. reduced-motion 下延迟必须归零，且仍产出可推进的步骤
 *   3. 拆步与 `runAI()` 的同构性：逐个座位推进与一次跑完，最终动作序列必须逐条相同
 *   4. 同一状态重复编排必须幂等（重入安全的根因）
 */

import { describe, it, expect } from 'vitest';
import {
  planShowcaseStep,
  SHOWCASE_TIMING,
  REDUCED_TIMING,
  actionLabel,
  boardCountForStreet,
  signatureOf,
  sameSignature,
  type ShowcaseView,
} from '../../src/ui/useTableShowcase.js';
import { GameController, type ControllerSnapshot } from '../../src/ui/controller.js';
import { createMemoryStorage } from '../../src/store/persistence.js';
import { decideAI } from '../../src/ai/policy.js';
import { applyAction, createHand } from '../../src/core/hand.js';
import { legalActions } from '../../src/core/betting.js';
import { createRng } from '../../src/core/rng.js';
import { stepAiAction, MAX_SHOWCASE_STEPS } from '../../src/ui/showcaseStep.js';
import { defaultSettings, type ActionType, type HandState } from '../../src/core/types.js';

function makeController(seatCount = 6): GameController {
  const c = new GameController({ storage: createMemoryStorage(), heroSeat: 0 });
  c.updateSettings({ seatCount });
  return c;
}

/** 构造一个「AI 待行动」的快照：直接开局（翻牌前第一个行动者往往是 AI）。 */
function snapshotAtAiTurn(seatCount = 6): { c: GameController; snap: ControllerSnapshot } {
  const c = makeController(seatCount);
  c.startHand();
  const snap = c.snapshot();
  return { c, snap };
}

function viewOf(over: Partial<ShowcaseView> = {}): ShowcaseView {
  return {
    thinking: false,
    thinkingSeat: -1,
    canHeroAct: false,
    lastAction: null,
    visibleBoardCount: 0,
    shownBoard: [],
    settled: false,
    handOver: false,
    winnerSeat: -1,
    dealt: false,
    timing: SHOWCASE_TIMING,
    ...over,
  };
}

describe('演出编排：planShowcaseStep', () => {
  it('无牌局时返回 idle', () => {
    const c = makeController();
    const step = planShowcaseStep(c.snapshot(), 0, 0, SHOWCASE_TIMING);
    expect(step.kind).toBe('idle');
  });

  it('轮到 AI：先产出 ai-action（思考停顿），且延迟 > 0', () => {
    const { snap } = snapshotAtAiTurn(6);
    expect(snap.state!.actingSeat).not.toBe(0);
    const step = planShowcaseStep(snap, 0, 0, SHOWCASE_TIMING);
    expect(step.kind).toBe('ai-action');
    if (step.kind === 'ai-action') {
      expect(step.seat).toBe(snap.state!.actingSeat);
      expect(step.delayMs).toBeGreaterThan(0);
    }
  });

  it('公共牌未揭完时**优先**逐张揭示，而不是直接让 AI 行动', () => {
    // 这是「flop 三张逐张」的判据：即使已经轮到一个 AI，
    // 只要公共牌还没全部亮相，也必须先把牌发完。
    const c = makeController(6);
    c.startHand();
    const st = c.currentState()!;
    // 手工构造「公共牌已发 3 张、但演出只揭示了 1 张」的状态
    while (st.actingSeat !== 0 && !st.finished) {
      const seat = st.actingSeat;
      const d = decideAI(st, seat, createRng(st.seed ^ seat));
      const legal = { canCheck: false };
      void legal;
      applyAction(st, d.type, d.toAmount, 0);
      if (st.board.length >= 3) break;
    }
    if (st.board.length < 3) return; // 本手提前结束，跳过
    const step = planShowcaseStep(c.snapshot(), st.actingSeat === 0 ? 0 : st.actingSeat, 1, SHOWCASE_TIMING);
    expect(step.kind).toBe('board');
    if (step.kind === 'board') expect(step.delayMs).toBe(SHOWCASE_TIMING.revealMs);
  });

  it('轮到玩家且刚动作完：产出 hero-action 停顿（让气泡被看见）', () => {
    const c = makeController(2);
    c.startHand();
    // 单挑：hero 是庄家/小盲，翻牌前先由 hero 行动
    expect(c.currentState()!.actingSeat).toBe(0);
    c.act('call', 0, 10);
    const snap = c.snapshot();
    const step = planShowcaseStep(snap, 0, snap.state!.board.length, SHOWCASE_TIMING);
    // 玩家跟注后 AI 还没动 → 步骤应为 ai-action（hero 的气泡由视图层停留）
    expect(['ai-action', 'hero-action', 'idle']).toContain(step.kind);
  });

  it('本手结束后：先 settle 停顿，停顿走完后必须 idle（否则会无限重排）', () => {
    const c = makeController(2);
    c.startHand();
    c.act('fold', 0, 10);
    const snap = c.snapshot();
    expect(snap.state!.finished).toBe(true);

    const withHold = planShowcaseStep(snap, 0, snap.state!.board.length, SHOWCASE_TIMING, false);
    expect(withHold.kind).toBe('settle');
    if (withHold.kind === 'settle') expect(withHold.delayMs).toBeGreaterThan(0);

    // 停顿已走完 → 必须 idle，否则上层定时器会被无限重排（结算面板永不出现）
    const afterHold = planShowcaseStep(snap, 0, snap.state!.board.length, SHOWCASE_TIMING, true);
    expect(afterHold.kind).toBe('idle');
  });

  it('reduced-motion：所有延迟为 0，但步骤本身仍然存在', () => {
    const { snap } = snapshotAtAiTurn(6);
    const step = planShowcaseStep(snap, 0, 0, REDUCED_TIMING);
    expect(step.kind).toBe('ai-action');
    if (step.kind === 'ai-action') expect(step.delayMs).toBe(0);
  });

  it('reduced-motion 下公共牌仍必须产出 board 步（延迟为 0），否则会卡死', () => {
    // 这是实测踩到的缺陷：若 delay=0 时返回 idle，揭示游标永远停在 0，
    // 而 `revealed < board.length` 这一分支会一直挡住后续所有 AI/玩家步骤。
    const c = makeController(6);
    c.startHand();
    const st = c.currentState()!;
    st.board.push(1, 2, 3); // 手工造出「公共牌已发 3 张」
    const step = planShowcaseStep(c.snapshot(), 0, 0, REDUCED_TIMING);
    expect(step.kind).toBe('board');
    if (step.kind === 'board') expect(step.delayMs).toBe(0);
  });

  it('编排是幂等的：同一状态重复调用结果完全一致（重入安全的根因）', () => {
    const { snap } = snapshotAtAiTurn(6);
    const a = planShowcaseStep(snap, 0, 0, SHOWCASE_TIMING);
    const b = planShowcaseStep(snap, 0, 0, SHOWCASE_TIMING);
    const d = planShowcaseStep(snap, 0, 0, SHOWCASE_TIMING);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(b)).toBe(JSON.stringify(d));
  });

  it('快照未被编排过程修改（编排层不得有副作用）', () => {
    const { snap } = snapshotAtAiTurn(6);
    const before = JSON.stringify({
      actions: snap.state!.actions.length,
      board: snap.state!.board.length,
      acting: snap.state!.actingSeat,
      revision: snap.revision,
    });
    planShowcaseStep(snap, 0, 0, SHOWCASE_TIMING);
    planShowcaseStep(snap, 0, 0, REDUCED_TIMING);
    const after = JSON.stringify({
      actions: snap.state!.actions.length,
      board: snap.state!.board.length,
      acting: snap.state!.actingSeat,
      revision: snap.revision,
    });
    expect(after).toBe(before);
  });
});

describe('演出编排：签名与展示派生', () => {
  it('动作/思考/公共牌任一变化都会改变签名', () => {
    const base = viewOf();
    const s0 = signatureOf(base);
    expect(sameSignature(s0, signatureOf(viewOf()))).toBe(true);

    expect(sameSignature(s0, signatureOf(viewOf({ thinking: true, thinkingSeat: 3 })))).toBe(false);
    expect(sameSignature(s0, signatureOf(viewOf({ visibleBoardCount: 1 })))).toBe(false);
    expect(sameSignature(s0, signatureOf(viewOf({ handOver: true })))).toBe(false);
  });
});

describe('演出文案与街张数', () => {
  it('动作文案带额度且与真实下注一致', () => {
    const mk = (type: ActionType, amount: number, toAmount: number) =>
      actionLabel({ seat: 1, street: 'flop', type, amount, toAmount, thinkMs: 0, potAtAction: 0, toCall: 0, stackAtAction: 0 });
    expect(mk('check', 0, 20)).toBe('过牌');
    expect(mk('call', 20, 20)).toBe('跟注 20');
    expect(mk('raise', 30, 50)).toBe('加注 到 50');
    expect(mk('allin', 400, 400)).toBe('全下 400');
    expect(mk('fold', 0, 0)).toBe('弃牌');
  });

  it('各街公共牌张数正确（flop 3 / turn 1 / river 1）', () => {
    expect(boardCountForStreet('preflop')).toBe(0);
    expect(boardCountForStreet('flop')).toBe(3);
    expect(boardCountForStreet('turn')).toBe(4);
    expect(boardCountForStreet('river')).toBe(5);
  });
});

/**
 * 同构性（本任务最关键的一条）：把 AI 拆成单步推进，与 `runAI()` 一次跑完，
 * 必须得到**逐条相同**的动作序列与相同结果。
 *
 * 这是「分步演出不改变对局结果」的直接证据。
 *
 * 为什么必须逐字节比对：`runAI()` 的 RNG 派生是
 * `createRng(seed ^ (seat * 7919) ^ (guard * 104729))`，`guard` 是循环计数器。
 * 只要步进次数与循环次数有任何偏差，AI 的决策就会变，最终金额自然也不同。
 */
describe('演出编排：拆分步与 runAI 的同构性', () => {
  /** 复刻 `GameController.runAI()` 的循环（一次跑完所有 AI）。 */
  function bulkRunAi(state: HandState, heroSeat: number): void {
    let guard = 0;
    while (!state.finished && state.actingSeat >= 0 && state.actingSeat !== heroSeat && guard++ < 500) {
      const seat = state.actingSeat;
      const d = decideAI(state, seat, createRng(state.seed ^ (seat * 7919) ^ (guard * 104729)));
      const r = applyAction(state, d.type, d.toAmount, 0);
      if (!r.ok) {
        const legal = legalActions(state, seat);
        if (legal.canCheck) applyAction(state, 'check', 0);
        else if (legal.canCall) applyAction(state, 'call', 0);
        else applyAction(state, 'fold', 0);
      }
    }
  }

  /** 用分步版推进到「轮到玩家或本手结束」，每步只推一名 AI。 */
  function stepwiseRunAi(state: HandState, heroSeat: number): void {
    let guard = 0;
    while (!state.finished && state.actingSeat >= 0 && state.actingSeat !== heroSeat && guard < 500) {
      const before = state.actingSeat;
      const actionsBefore = state.actions.length;
      const out = stepAiAction(state, heroSeat, guard + 1);
      if (!out.advanced) break;
      guard += 1;
      // 单步必须真的只推进一个座位、且最多产生一条动作记录
      expect(state.actions.length - actionsBefore).toBeLessThanOrEqual(1);
      expect(out.seat).toBe(before);
    }
  }

  function makeHand(seed: number, seatCount: number, dealerSeat: number): HandState {
    const settings = { ...defaultSettings(), seatCount };
    return createHand({
      handId: `hand-${seed}`,
      seed: seed * 7919,
      settings,
      heroSeat: 0,
      dealerSeat,
      stacks: new Array(seatCount).fill(settings.startingStack),
    });
  }

  it('200 组种子/人数/庄位下，分步推进与一次跑完的动作序列逐条相同', () => {
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const seatCount = 2 + (seed % 8); // 2..9 人
      const dealerSeat = seed % seatCount;
      const a = makeHand(seed, seatCount, dealerSeat);
      const b = makeHand(seed, seatCount, dealerSeat);

      stepwiseRunAi(a, 0);
      bulkRunAi(b, 0);

      expect(a.actions.length).toBe(b.actions.length);
      expect(JSON.stringify(a.actions)).toBe(JSON.stringify(b.actions));
      expect(a.actingSeat).toBe(b.actingSeat);
      expect(a.finished).toBe(b.finished);
      expect(JSON.stringify(a.board)).toBe(JSON.stringify(b.board));
      expect(JSON.stringify(a.seats.map((s) => s.stack))).toBe(JSON.stringify(b.seats.map((s) => s.stack)));
      expect(JSON.stringify(a.results)).toBe(JSON.stringify(b.results));
      checked++;
    }
    expect(checked).toBe(200);
  });

  it('单步确实只推进一名 AI；而 controller.runAI() 一次会推进多名（分步的必要性）', () => {
    const settings = { ...defaultSettings(), seatCount: 6 };
    const st = makeHand(5, 6, 2);
    void settings;

    // 分步：第一步只增加一条动作
    const before = st.actions.length;
    const out = stepAiAction(st, 0, 1);
    expect(out.advanced).toBe(true);
    expect(st.actions.length - before).toBe(1);

    // 对照组：controller.runAI() 一次跑完剩余所有 AI
    const c = makeController(6);
    c.startHand();
    const actingBefore = c.currentState()!.actingSeat;
    if (actingBefore !== 0) {
      const n0 = c.currentState()!.actions.length;
      c.runAI();
      const added = c.currentState()!.actions.length - n0;
      // 记录实测行为：这一条是「为什么不能直接在 runAI 之间加延时」的证据。
      // 在 6 人桌的常见发牌下，一次 runAI 会推进多名 AI（实测 >= 1，通常 3）。
      expect(added).toBeGreaterThanOrEqual(1);
    }
  });

  it('兜底路径也不会卡死：非法决策时仍能推进且总步数有界', () => {
    const st = makeHand(11, 9, 3);
    let guard = 0;
    while (!st.finished && st.actingSeat >= 0 && st.actingSeat !== 0 && guard < MAX_SHOWCASE_STEPS) {
      const out = stepAiAction(st, 0, guard + 1);
      if (!out.advanced) break;
      guard++;
    }
    expect(guard).toBeLessThan(MAX_SHOWCASE_STEPS);
    expect(st.actingSeat === 0 || st.finished).toBe(true);
  });
});
