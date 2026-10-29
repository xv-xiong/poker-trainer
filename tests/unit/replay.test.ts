/**
 * 回放帧生成（阶段三 3.1）单元测试。
 *
 * 这里的策略是「用真实引擎打一手，再把结果当历史记录回放」——
 * 而不是手搓一个假的 HandRecord。理由：回放的价值完全取决于
 * 「记录能否被引擎原样重建」，假记录会把这类问题全部掩盖。
 */

import { describe, expect, it } from 'vitest';
import { legalActions } from '../../src/core/betting.js';
import { applyAction, createHand } from '../../src/core/hand.js';
import { defaultSettings, type HandRecord, type HandState } from '../../src/core/types.js';
import { buildReplayFrames, replayabilityOf, replayStepLabel } from '../../src/ui/replay.js';

const SIX = { ...defaultSettings(), seatCount: 6 };

type Policy = 'passive' | 'allFold' | 'shover';

/** 用确定性的简单策略把一手牌打完。 */
function playHand(opts: {
  seed: number;
  heroSeat?: number;
  dealerSeat?: number;
  policy?: Policy;
}): HandState {
  const state = createHand({
    handId: 'H-1',
    seed: opts.seed,
    settings: SIX,
    heroSeat: opts.heroSeat ?? 0,
    dealerSeat: opts.dealerSeat ?? 0,
  });
  const policy = opts.policy ?? 'passive';
  let guard = 0;
  while (!state.finished && guard++ < 500) {
    const legal = legalActions(state, state.actingSeat);
    let type: 'check' | 'call' | 'fold' | 'allin';
    if (policy === 'shover' && legal.canAllIn) type = 'allin';
    else if (policy === 'allFold' && legal.canCall) type = 'fold';
    else if (legal.canCheck) type = 'check';
    else if (legal.canCall) type = 'call';
    else type = 'fold';
    const applied = applyAction(state, type, 0, 0);
    if (!applied.ok) throw new Error(`applyAction 失败：${applied.error ?? ''}`);
  }
  if (!state.finished) throw new Error('牌局未在 500 步内结束');
  return state;
}

function recordOf(state: HandState, heroSeat = 0): HandRecord {
  return {
    handId: state.handId,
    seed: state.seed,
    timestamp: 1_700_000_000_000,
    seatCount: state.seatCount,
    heroSeat,
    dealerSeat: state.dealerSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    initialStacks: [...state.initialStacks],
    holeCards: state.seats.map((seat) => [...seat.holeCards]),
    board: [...state.board],
    actions: state.actions.map((action) => ({ ...action })),
    pots: state.pots.map((pot) => ({
      ...pot,
      eligible: [...pot.eligible],
      ...(pot.contributors ? { contributors: [...pot.contributors] } : {}),
    })),
    results: [...state.results],
    heroNet: state.results[heroSeat] ?? 0,
    review: [],
    hintsUsed: 0,
  };
}

describe('阶段三 3.1：回放帧生成', () => {
  it('帧数恒为「动作数 + 1」，且第 i 帧恰好含 i 条动作', () => {
    const record = recordOf(playHand({ seed: 20260101 }));
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.frames.length).toBe(record.actions.length + 1);
    built.frames.forEach((frame, i) => {
      expect(frame.index).toBe(i);
      expect(frame.state.actions.length).toBe(i);
    });
  });

  it('帧 0 是开局：无动作、公共牌为空、尚未结束', () => {
    const record = recordOf(playHand({ seed: 777 }));
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const first = built.frames[0];
    expect(first.action).toBeNull();
    expect(first.state.board).toEqual([]);
    expect(first.state.finished).toBe(false);
    expect(first.state.actions).toEqual([]);
    // 开局已下盲注：底池应等于小盲 + 大盲
    const pot = first.state.seats.reduce((sum, seat) => sum + seat.committed, 0);
    expect(pot).toBe(record.smallBlind + record.bigBlind);
  });

  it('末帧已结束，公共牌与结算结果都与记录一致', () => {
    const record = recordOf(playHand({ seed: 424242 }));
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const last = built.frames[built.frames.length - 1];
    expect(last.state.finished).toBe(true);
    expect(last.state.board).toEqual(record.board);
    expect(last.state.results).toEqual(record.results);
  });

  it('不修改传入的记录（回放是只读的）', () => {
    const record = recordOf(playHand({ seed: 5150 }));
    const before = JSON.stringify(record);
    buildReplayFrames(record);
    expect(JSON.stringify(record)).toBe(before);
  });

  it('帧之间互不共享引用（深拷贝，不是同一个对象被反复改写）', () => {
    const record = recordOf(playHand({ seed: 909090 }));
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const [first, second] = built.frames;
    expect(first.state).not.toBe(second.state);
    expect(first.state.seats[0]).not.toBe(second.state.seats[0]);
    // 改第一帧不应影响第二帧
    first.state.seats[0].stack = -12345;
    first.state.board.push(51);
    first.state.actions.push(record.actions[0]);
    expect(second.state.seats[0].stack).not.toBe(-12345);
    expect(second.state.board).not.toContain(51);
    expect(second.state.actions.length).toBe(1);
  });

  it('弃牌结束的一手也能回放（公共牌为空、只有一名赢家）', () => {
    const state = playHand({ seed: 31, policy: 'allFold' });
    expect(state.finishReason).toBe('fold');
    const record = recordOf(state);
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const last = built.frames[built.frames.length - 1];
    expect(last.state.finished).toBe(true);
    expect(last.state.board).toEqual([]);
    expect(last.state.results.filter((v) => v > 0).length).toBe(1);
  });

  it('全下摊牌的一手也能回放（公共牌跑完、多人摊牌）', () => {
    let state: HandState | null = null;
    for (let seed = 1; seed <= 40 && !state; seed++) {
      const candidate = playHand({ seed, policy: 'shover' });
      if (candidate.finishReason === 'showdown' && candidate.board.length === 5) state = candidate;
    }
    expect(state).not.toBeNull();
    const record = recordOf(state as HandState);
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const last = built.frames[built.frames.length - 1];
    expect(last.state.board.length).toBe(5);
    expect(last.state.finished).toBe(true);
  });
});

describe('阶段三 3.1：不可回放的记录要给出原因而不是抛错', () => {
  it('结构完整的记录返回 null', () => {
    expect(replayabilityOf(recordOf(playHand({ seed: 11 })))).toBeNull();
  });

  it('种子不是有限数 → 拒绝', () => {
    const record = { ...recordOf(playHand({ seed: 11 })), seed: Number.NaN };
    expect(replayabilityOf(record)).toContain('种子');
    expect(buildReplayFrames(record).ok).toBe(false);
  });

  it('桌人数越界 → 拒绝', () => {
    const record = { ...recordOf(playHand({ seed: 11 })), seatCount: 12 };
    expect(replayabilityOf(record)).toContain('桌人数');
  });

  it('起始筹码记录不完整 → 拒绝', () => {
    const base = recordOf(playHand({ seed: 11 }));
    const record = { ...base, initialStacks: base.initialStacks.slice(0, 3) };
    expect(replayabilityOf(record)).toContain('起始筹码');
  });

  it('底牌记录不完整 → 拒绝', () => {
    const base = recordOf(playHand({ seed: 11 }));
    const record = { ...base, holeCards: base.holeCards.slice(0, 2) };
    expect(replayabilityOf(record)).toContain('底牌');
  });

  it('座位索引越界 → 拒绝', () => {
    const record = { ...recordOf(playHand({ seed: 11 })), heroSeat: 9 };
    expect(replayabilityOf(record)).toContain('座位索引');
  });

  it('底牌与重放结果不一致 → 拒绝（避免展示「不是当时那手」的假牌局）', () => {
    const base = recordOf(playHand({ seed: 12 }));
    const record = {
      ...base,
      holeCards: base.holeCards.map((cards, i) => (i === 1 ? [0, 1] : cards)),
    };
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toContain('底牌');
  });

  it('公共牌与重放结果不一致 → 拒绝', () => {
    const base = recordOf(playHand({ seed: 13 }));
    const record = { ...base, board: [0, 1, 2, 3, 4] };
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toContain('公共牌');
  });

  it('结算结果与重放结果不一致 → 拒绝', () => {
    const base = recordOf(playHand({ seed: 14 }));
    const record = { ...base, results: base.results.map((v) => v + 1) };
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toContain('结算结果');
  });

  it('动作座位与重放时轮到的座位不一致 → 拒绝', () => {
    const base = recordOf(playHand({ seed: 15 }));
    const first = base.actions[0];
    const record = {
      ...base,
      actions: base.actions.map((action, i) =>
        i === 0 ? { ...action, seat: (first.seat + 1) % base.seatCount } : action,
      ),
    };
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toContain('座位');
  });

  it('动作数比真实牌局多 → 拒绝（不会静默忽略多余动作）', () => {
    const base = recordOf(playHand({ seed: 16 }));
    const record = { ...base, actions: [...base.actions, base.actions[base.actions.length - 1]] };
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(false);
  });
});

describe('阶段三 3.1：步骤描述文案', () => {
  it('开局帧没有动作，描述为「开局（盲注已下）」', () => {
    const record = recordOf(playHand({ seed: 21 }));
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(replayStepLabel(record, built.frames[0])).toBe('开局（盲注已下）');
  });

  it('玩家动作写成「你」，AI 动作写成「座位 N」，并带街与额度', () => {
    const record = recordOf(playHand({ seed: 22 }));
    const built = buildReplayFrames(record);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const heroFrame = built.frames.find((f) => f.action?.seat === record.heroSeat);
    expect(heroFrame).toBeDefined();
    if (heroFrame) expect(replayStepLabel(record, heroFrame)).toContain('你');

    const aiFrame = built.frames.find((f) => f.action && f.action.seat !== record.heroSeat);
    expect(aiFrame).toBeDefined();
    if (aiFrame) {
      const label = replayStepLabel(record, aiFrame);
      expect(label).toContain(`座位 ${(aiFrame.action as { seat: number }).seat + 1}`);
      expect(label).toContain('·');
    }
  });
});
