/**
 * 结算口径审计（G5 扩展）：未跟注退还的等价性、「空有资格层」不变量、退款展示口径。
 *
 * 背景：参考站结算面板把同一笔钱拆成「主池 20 → 练习机器人 1」与
 * 「未跟注退还 10 → 练习机器人 1」两行（场景：小盲投入 10 后弃牌、大盲投入 20）。
 * 我方 buildPots + distributePots 在金额上应得同一结果，但此前的 PotLayer 不区分两类。
 *
 * 本文件回答三个问题：
 *   Q1 金额一致性：A 投入 x 后弃牌、B 投入 y > x 且未弃牌时，我方给 B 的总额
 *      是否恒等于参考站的「主池 + 未跟注退还」。
 *   Q2 「空有资格层」不变量：是否存在某一层无人有资格（会导致筹码既不分出也不退还）。
 *      用大量随机对局在**每个动作前后**主动尝试构造反例，而不是只查终局。
 *   Q3 未跟注退还的展示口径数据是否正确（只加 core 数据，不动 UI）。
 */

import { describe, it, expect } from 'vitest';
import { createHand, applyAction, checkChipConservation } from '../../src/core/hand.js';
import { buildPots, validatePots, distributePots, seatRoles, tieBreakOrder } from '../../src/core/pot.js';
import { settlementBreakdown } from '../../src/core/showdown.js';
import { legalActions } from '../../src/core/betting.js';
import { createRng, type Rng } from '../../src/core/rng.js';
import { defaultSettings, type HandState, type PotLayer } from '../../src/core/types.js';

const baseSettings = { ...defaultSettings() };

/** 由投入额与弃牌情况直接构造分层（不经引擎），用于穷举 (x, y) 组合。 */
function layersOf(committed: number[], folded: boolean[]): PotLayer[] {
  return buildPots({ committed, folded });
}

// ---------------------------------------------------------------------------
// Q1 金额一致性
// ---------------------------------------------------------------------------

describe('Q1 未跟注退还的金额等价性（我方总额 == 参考站「主池 + 未跟注退还」）', () => {
  it('穷举多组 (x, y)：A 投入 x 弃牌、B 投入 y>x 未弃牌，B 恰得 x+y', () => {
    // 参考站口径：主池 = 被双方争夺的部分（2 × min(x, y)），
    //            未跟注退还 = 最高投入者的超额部分（y - x）。
    // 我方金额必须满足：payout[B] == 主池 + 退还 == x + y。
    const xs = [0, 1, 2, 5, 10, 20, 100, 1000];
    const gaps = [1, 3, 7, 40, 500];
    let cases = 0;
    for (const x of xs) {
      for (const gap of gaps) {
        const y = x + gap;
        const committed = [x, y];
        const folded = [true, false];
        const pots = layersOf(committed, folded);
        expect(validatePots({ committed, folded }, pots)).toEqual([]);

        const payouts = distributePots(pots, () => 1, [0, 1], 2);
        // 弃牌者一分不得
        expect(payouts[0]).toBe(0);
        // B 的总额 == x + y
        expect(payouts[1]).toBe(x + y);
        // 恰好等于参考站的两行之和
        const mainPot = 2 * Math.min(x, y);
        const uncalledRefund = y - x;
        expect(payouts[1]).toBe(mainPot + uncalledRefund);
        // 分层金额也必须是这两段
        expect(pots.map((p) => p.amount)).toEqual([mainPot, uncalledRefund].filter((v) => v > 0));
        expect(payouts.reduce((a, b) => a + b, 0)).toBe(x + y);
        cases++;
      }
    }
    // 断言覆盖度，防止上面的循环被意外写空而变成假绿
    expect(cases).toBe(xs.length * gaps.length);
  });

  it('参考站原始场景 (x=10, y=20)：主池 20 + 未跟注退还 10 = 30，全部归 B', () => {
    const committed = [10, 20];
    const folded = [true, false];
    const pots = layersOf(committed, folded);
    // level 10：2 人 × 10 = 20（被争夺，B 独存故归 B）
    // level 20：1 人 × 10 = 10（未被跟注，退还 B）
    expect(pots.map((p) => p.amount)).toEqual([20, 10]);
    expect(pots[0].kind).toBe('contested');
    expect(pots[1].kind).toBe('uncalled');

    const payouts = distributePots(pots, () => 1, [0, 1], 2);
    expect(payouts).toEqual([0, 30]);
    // 净盈亏：弃牌者 -10，B +10（等于对手投入）
    expect(payouts[0] - committed[0]).toBe(-10);
    expect(payouts[1] - committed[1]).toBe(10);

    const lines = settlementBreakdown(pots, () => 1);
    expect(lines).toEqual([
      { kind: 'contested', amount: 20, recipients: [1], layerIndex: 0 },
      { kind: 'uncalled', amount: 10, recipients: [1], layerIndex: 1 },
    ]);
  });

  it('引擎可达：2 人桌小盲弃牌（盲注 10/20），BB 得 30 = 主池 20 + 退还 10', () => {
    // 这是参考站场景在引擎里的等价复现：小盲（座位 0，2 人桌即庄家）投入 10 后弃牌，
    // 大盲（座位 1）投入 20 未弃牌。
    const st = { ...baseSettings, seatCount: 2, smallBlind: 10, bigBlind: 20, startingStack: 1000 };
    const state = createHand({
      handId: 'hu-sb-fold',
      seed: 20260213,
      settings: st,
      heroSeat: 0,
      dealerSeat: 0,
    });
    expect(state.actingSeat).toBe(0); // 2 人桌翻前由小盲先行动
    const r = applyAction(state, 'fold', 0);
    expect(r.ok).toBe(true);
    expect(state.finished).toBe(true);
    expect(state.finishReason).toBe('fold');
    expect(state.seats.map((s) => s.committed)).toEqual([10, 20]);
    expect(state.pots.map((p) => p.amount)).toEqual([20, 10]);
    expect(state.results).toEqual([-10, 10]);
    expect(checkChipConservation(state)).toEqual([]);

    const lines = settlementBreakdown(state.pots, () => 0);
    expect(lines).toEqual([
      { kind: 'contested', amount: 20, recipients: [1], layerIndex: 0 },
      { kind: 'uncalled', amount: 10, recipients: [1], layerIndex: 1 },
    ]);
    // 主池 + 退还 == 我方给 B 的总额
    expect(lines.reduce((a, l) => a + l.amount, 0)).toBe(30);
  });

  it('引擎可达：2 人桌默认盲注 5/10，小盲弃牌得 15 = 主池 10 + 退还 5', () => {
    const st = { ...baseSettings, seatCount: 2, smallBlind: 5, bigBlind: 10, startingStack: 1000 };
    const state = createHand({ handId: 'hu-sb-fold-default', seed: 7, settings: st, heroSeat: 0, dealerSeat: 0 });
    expect(state.actingSeat).toBe(0);
    expect(applyAction(state, 'fold', 0).ok).toBe(true);
    expect(state.seats.map((s) => s.committed)).toEqual([5, 10]);
    expect(state.pots.map((p) => p.amount)).toEqual([10, 5]);
    expect(state.results).toEqual([-5, 5]);
    expect(checkChipConservation(state)).toEqual([]);
  });

  it('引擎可达：小盲跟注后被大盲加注再弃牌（x=20, y=60），B 得 80', () => {
    const st = { ...baseSettings, seatCount: 2, smallBlind: 10, bigBlind: 20, startingStack: 1000 };
    const state = createHand({ handId: 'hu-sb-call-then-fold', seed: 11, settings: st, heroSeat: 0, dealerSeat: 0 });
    expect(state.actingSeat).toBe(0);
    // 小盲补齐到 20
    expect(applyAction(state, 'call', 0).ok).toBe(true);
    expect(state.seats.map((s) => s.committed)).toEqual([20, 20]);
    expect(state.actingSeat).toBe(1); // 大盲行动
    // 大盲加注到 60
    expect(applyAction(state, 'raise', 60).ok).toBe(true);
    expect(state.actingSeat).toBe(0);
    // 小盲弃牌
    expect(applyAction(state, 'fold', 0).ok).toBe(true);
    expect(state.finished).toBe(true);
    expect(state.seats.map((s) => s.committed)).toEqual([20, 60]);
    // 主池 40 + 未跟注退还 40 = 80
    expect(state.pots.map((p) => p.amount)).toEqual([40, 40]);
    expect(state.results).toEqual([-20, 20]);
    expect(checkChipConservation(state)).toEqual([]);
  });

  it('独立参照实现交叉校验：三人桌 (x,y,z) 全组合，我方分层与总额 == 独立重写公式', () => {
    // 为避免「用同一套实现验证自己」，这里**从零重写**一份分层参照实现（不同写法、不同数据结构），
    // 只依赖「按投入额分层、层额 = 层高差 × 投入者数、单一投入者的层是未被跟注退还」这一定义。
    interface RefLayer {
      amount: number;
      contributorCount: number;
      isRefund: boolean;
    }
    const refLayers = (committed: readonly number[]): RefLayer[] => {
      const sortedLevels = Array.from(new Set(committed.filter((c) => c > 0))).sort((a, b) => a - b);
      const out: RefLayer[] = [];
      let prevLevel = 0;
      for (const level of sortedLevels) {
        const contributorCount = committed.reduce((acc, c) => acc + (c >= level ? 1 : 0), 0);
        const amount = (level - prevLevel) * contributorCount;
        if (amount > 0) out.push({ amount, contributorCount, isRefund: contributorCount === 1 });
        prevLevel = level;
      }
      return out;
    };

    const values = [5, 10, 20, 35, 100];
    let checked = 0;
    let refundCases = 0;
    for (const x of values) {
      for (const y of values) {
        for (const z of values) {
          // 只有座位 2（投入 z）存活，故 z 必须是最高投入
          if (z < Math.max(x, y)) continue;
          const committed = [x, y, z];
          const folded = [true, true, false]; // 座位 0、1 弃牌，座位 2 存活
          const pots = layersOf(committed, folded);
          const ref = refLayers(committed);

          // 我方每层的金额与「是否退还」标注必须与独立实现逐层一致
          expect(pots.map((p) => p.amount)).toEqual(ref.map((r) => r.amount));
          expect(pots.map((p) => p.kind === 'uncalled')).toEqual(ref.map((r) => r.isRefund));
          expect(validatePots({ committed, folded }, pots)).toEqual([]);

          const payouts = distributePots(pots, () => 1, [0, 1, 2], 3);
          const totalCommitted = x + y + z;
          const refContested = ref.filter((r) => !r.isRefund).reduce((a, r) => a + r.amount, 0);
          const refRefund = ref.filter((r) => r.isRefund).reduce((a, r) => a + r.amount, 0);

          // 参照站口径：存活者所得 == 主池（被争夺部分） + 未跟注退还
          expect(payouts[2]).toBe(refContested + refRefund);
          expect(payouts[2]).toBe(totalCommitted);
          // 弃牌者一分不得
          expect(payouts[0] + payouts[1]).toBe(0);
          // 顶点投入者的退还额 == z − 次高投入（无更高投入者时次高即 0）
          expect(refRefund).toBe(z - Math.max(x, y, 0));
          if (refRefund > 0) refundCases++;
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50); // 覆盖度：确实跑了大量组合
    expect(refundCases).toBeGreaterThan(10); // 覆盖度：确实覆盖了「存在未跟注退还」的情形
  });

  it('引擎可达：三人桌两名弃牌者投入不同，B 得全部投入（主池 + 退还）', () => {
    // 座位 0 加注到 20 后弃牌；座位 1（小盲 5）弃牌；座位 2 翻牌下注 20 后独存。
    // 终局投入 [20, 5, 40]，弃牌 [true, true, false]。
    const st = { ...baseSettings, seatCount: 3, smallBlind: 5, bigBlind: 10, startingStack: 1000 };
    const state = createHand({ handId: 'three-way', seed: 99, settings: st, heroSeat: 2, dealerSeat: 0 });
    // 庄家 0 → 小盲 1、大盲 2；翻前首位行动者 = 座位 0
    expect(state.actingSeat).toBe(0);
    expect(applyAction(state, 'raise', 20).ok).toBe(true);
    expect(state.actingSeat).toBe(1);
    expect(applyAction(state, 'fold', 0).ok).toBe(true); // 小盲弃牌
    expect(state.actingSeat).toBe(2);
    expect(applyAction(state, 'call', 0).ok).toBe(true); // 大盲跟注到 20
    expect(state.street).toBe('flop');
    expect(state.actingSeat).toBe(2);
    expect(applyAction(state, 'bet', 20).ok).toBe(true);
    expect(state.actingSeat).toBe(0);
    expect(applyAction(state, 'fold', 0).ok).toBe(true); // 座位 0 弃牌 → 仅剩座位 2

    expect(state.finished).toBe(true);
    expect(state.finishReason).toBe('fold');
    expect(state.seats.map((s) => s.committed)).toEqual([20, 5, 40]);
    // 分层：level 5 → 3×5=15；level 20 → 2×15=30；level 40 → 1×20=20（退还）
    expect(state.pots.map((p) => p.amount)).toEqual([15, 30, 20]);
    expect(state.pots.map((p) => p.kind)).toEqual(['contested', 'contested', 'uncalled']);
    // B（座位 2）拿走全部 65，净 +25 = 20 + 5
    expect(state.results).toEqual([-20, -5, 25]);
    expect(checkChipConservation(state)).toEqual([]);

    const lines = settlementBreakdown(state.pots, () => 0);
    expect(lines.map((l) => l.kind)).toEqual(['contested', 'contested', 'uncalled']);
    expect(lines.reduce((a, l) => a + l.amount, 0)).toBe(65);
    // 未被跟注退还的 20 必然回到唯一投入者（座位 2）手中
    expect(lines[2]).toEqual({ kind: 'uncalled', amount: 20, recipients: [2], layerIndex: 2 });
  });
});

// ---------------------------------------------------------------------------
// Q2 「空有资格层」不变量
// ---------------------------------------------------------------------------

interface SnapshotAudit {
  /** 审计过的快照数（每个动作前后各一次）。 */
  snapshots: number;
  /** 观察到「多人投入的争夺层」次数（覆盖度证据）。 */
  contestedLayers: number;
  /** 观察到「单一投入者的退还层」次数（覆盖度证据）。 */
  uncalledLayers: number;
}

/**
 * 审计单个状态快照：这是我方不变量在**任意时刻**的检查点，而非只查终局。
 *
 * 检查三件事：
 *   1. 每层至少一名有资格者（空层会吞掉筹码）。
 *   2. validatePots 无错误。
 *   3. 结构性引理：max(未弃牌投入) >= max(弃牌投入)。
 *      该引理是检查点 1 的充分条件（证明见 pot.ts 文件头与审计报告）。
 */
function auditSnapshot(state: HandState, label: string, failures: string[], audit: SnapshotAudit): void {
  const committed = state.seats.map((s) => s.committed);
  const folded = state.seats.map((s) => s.folded);
  const pots = buildPots({ committed, folded });
  audit.snapshots++;

  const errs = validatePots({ committed, folded }, pots);
  if (errs.length > 0) {
    failures.push(`${label} validatePots: ${errs.join('; ')}（committed=[${committed}] folded=[${folded}]）`);
  }

  for (const [i, p] of pots.entries()) {
    if (p.amount > 0 && p.eligible.length === 0) {
      failures.push(
        `${label} 第 ${i} 层金额 ${p.amount} 但无有资格者（committed=[${committed}] folded=[${folded}]）`,
      );
    }
    if (p.kind === 'uncalled') audit.uncalledLayers++;
    else if (p.kind === 'contested') audit.contestedLayers++;
  }

  const live = state.seats.filter((s) => !s.folded).map((s) => s.committed);
  const dead = state.seats.filter((s) => s.folded).map((s) => s.committed);
  const maxLive = live.length > 0 ? Math.max(...live) : -1;
  const maxDead = dead.length > 0 ? Math.max(...dead) : -1;
  if (maxDead > maxLive) {
    failures.push(
      `${label} 弃牌者投入 ${maxDead} 超过未弃牌者最高投入 ${maxLive}（committed=[${committed}] folded=[${folded}]）`,
    );
  }
}

/** 随机推进一手牌；policy 决定每次动作的策略（用于不同对抗强度）。 */
function playRandomHand(
  rng: Rng,
  handIndex: number,
  stacks: number[],
  policy: 'g4-like' | 'fold-happy',
  failures: string[],
  audit: SnapshotAudit,
  finalChecks: { finishReason: Record<string, number>; uncalledAtFinish: number },
): void {
  const seatCount = stacks.length;
  const st = { ...baseSettings, seatCount, startingStack: 1000 };
  const dealerSeat = rng.nextInt(seatCount);
  const state = createHand({
    handId: `audit${handIndex}`,
    seed: rng.nextInt(0xffffffff),
    settings: st,
    heroSeat: 0,
    dealerSeat,
    stacks,
  });
  auditSnapshot(state, `第 ${handIndex} 手（盲注后）`, failures, audit);

  let guard = 0;
  while (!state.finished && guard++ < 2000) {
    const seat = state.actingSeat;
    if (seat < 0) break;
    const legal = legalActions(state, seat);
    const roll = rng.nextInt(100);

    if (policy === 'fold-happy') {
      // 对抗策略：极高弃牌率，且**包含 toCall == 0 时的自愿弃牌**
      // （自愿弃牌是「最高投入者弃牌」的唯一可能入口，必须重点打击）。
      if (roll < 70 && legal.canFold) {
        applyAction(state, 'fold', 0);
      } else if (roll < 85 && legal.canRaise) {
        const span = legal.maxRaiseTo - legal.minRaiseTo;
        const to = legal.minRaiseTo + (span > 0 ? rng.nextInt(span + 1) : 0);
        const r = applyAction(state, 'raise', to);
        if (!r.ok) applyAction(state, 'call', 0);
      } else if (legal.canCheck) {
        applyAction(state, 'check', 0);
      } else if (legal.canCall) {
        applyAction(state, 'call', 0);
      } else {
        applyAction(state, 'fold', 0);
      }
    } else {
      if (roll < 12 && legal.canFold) {
        applyAction(state, 'fold', 0);
      } else if (roll < 30 && legal.canRaise) {
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

    auditSnapshot(state, `第 ${handIndex} 手动作 ${guard}`, failures, audit);
  }

  if (!state.finished) {
    failures.push(`第 ${handIndex} 手未在 guard 内结束`);
    return;
  }
  finalChecks.finishReason[state.finishReason] = (finalChecks.finishReason[state.finishReason] ?? 0) + 1;
  finalChecks.uncalledAtFinish += state.pots.filter((p) => p.kind === 'uncalled').length;

  const errs = checkChipConservation(state);
  if (errs.length > 0) failures.push(`第 ${handIndex} 手终局守恒失败: ${errs.join('; ')}`);
  // 终局还要确认：退还层的唯一投入者必然未弃牌。
  for (const [i, p] of state.pots.entries()) {
    if (p.kind === 'uncalled') {
      const owner = p.contributors?.[0];
      if (owner === undefined) failures.push(`第 ${handIndex} 手第 ${i} 层为退还但无投入者`);
      else if (state.seats[owner].folded) failures.push(`第 ${handIndex} 手第 ${i} 层退还归已弃牌座位 ${owner}`);
    }
  }
}

describe('Q2 「空有资格层」不变量（主动构造反例，而非只查终局）', () => {
  it('10,000 手随机对局 × 每个动作快照：无空有资格层，且 max(未弃牌投入) >= max(弃牌投入)', () => {
    const rng = createRng(0x5eed_a11d);
    const failures: string[] = [];
    const audit: SnapshotAudit = { snapshots: 0, contestedLayers: 0, uncalledLayers: 0 };
    const finalChecks = { finishReason: {} as Record<string, number>, uncalledAtFinish: 0 };
    const handCount = 10_000;

    for (let h = 0; h < handCount; h++) {
      const seatCount = [2, 6, 9][rng.nextInt(3)];
      // 等额起始筹码：与产品实际开局一致
      playRandomHand(rng, h, new Array(seatCount).fill(1000), 'g4-like', failures, audit, finalChecks);
      if (failures.length > 8) break;
    }

    expect(failures).toEqual([]);
    expect(audit.snapshots).toBeGreaterThan(100_000); // 覆盖度：确实逐动作审计过
    expect(audit.uncalledLayers).toBeGreaterThan(0); // 覆盖度：确实出现过「未跟注退还」层
    expect(audit.contestedLayers).toBeGreaterThan(0); // 覆盖度：确实出现过争夺层
    expect(finalChecks.finishReason['fold'] ?? 0).toBeGreaterThan(0);
    expect(finalChecks.finishReason['showdown'] ?? 0).toBeGreaterThan(0);
  });

  it('10,000 手「弃牌狂」对抗 + 不等额起始筹码：仍无法构造空有资格层', () => {
    // 更强的证伪尝试：
    //   - 70% 概率弃牌（含 toCall == 0 的自愿弃牌，即「没人下注也弃牌」）；
    //   - 起始筹码不等（含恰好等于大盲的极短筹码），把 createHand 的 API 可达空间也纳入搜索。
    // 若空有资格层可达，这里最可能撞到。
    const rng = createRng(0xC0FFEE);
    const failures: string[] = [];
    const audit: SnapshotAudit = { snapshots: 0, contestedLayers: 0, uncalledLayers: 0 };
    const finalChecks = { finishReason: {} as Record<string, number>, uncalledAtFinish: 0 };
    const handCount = 10_000;
    const stackChoices = [10, 20, 30, 50, 100, 200, 1000];

    for (let h = 0; h < handCount; h++) {
      const seatCount = [2, 3, 6, 9][rng.nextInt(4)];
      const stacks = new Array(seatCount).fill(0).map(() => stackChoices[rng.nextInt(stackChoices.length)]);
      playRandomHand(rng, h, stacks, 'fold-happy', failures, audit, finalChecks);
      if (failures.length > 8) break;
    }

    expect(failures).toEqual([]);
    expect(audit.snapshots).toBeGreaterThan(50_000);
    // 覆盖度证据：不等额筹码确实产生了全下/边池（争夺层与退还层都出现过）
    expect(audit.contestedLayers).toBeGreaterThan(0);
    expect(audit.uncalledLayers).toBeGreaterThan(0);
  });

  it('回归锁定：不可达输入会触发 validatePots 报警，且 distributePots 不再吞掉筹码', () => {
    // 这是问题 2 的「证伪尝试」构造：让**最高投入者**弃牌（folded 最高位为 true），
    // 即可人为制造「空有资格层」。它在引擎中不可达（上方两个属性测试证明），
    // 但 buildPots 是导出的纯函数，必须对任意输入保持筹码守恒而非静默吞钱。
    const committed = [100, 100, 300];
    const folded = [true, false, true]; // 座位 2 投入 300 却已弃牌 → 制造空层
    const pots = buildPots({ committed, folded });
    expect(pots.map((p) => p.amount)).toEqual([300, 200]);
    expect(pots[1].eligible).toEqual([]); // 空有资格层
    // 该输入必须被报警，绝不静默通过
    expect(validatePots({ committed, folded }, pots)).toEqual(['第 1 层金额 200 > 0 但无有资格座位']);

    // 兜底语义：无有资格者的层按「未被跟注的退还」原样退回投入者，
    // 因此 Σ 分得 == Σ 投入 == 500（旧实现此处置为 300，等于凭空销毁 200 筹码）。
    const payouts = distributePots(pots, () => 1, [0, 1, 2], 3);
    expect(payouts.length).toBe(3);
    for (const p of payouts) expect(Number.isNaN(p)).toBe(false);
    expect(payouts[2]).toBe(200);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(500);
  });

  it('穷举可达状态空间（非随机采样）：小筹码 2/3 人桌全动作序列中不存在空有资格层', () => {
    // 为什么还要穷举：随机采样只能说「没撞到」，穷举小规模空间能给出
    // 「在该受限空间内完全不存在」的强证据，且与采样相互独立（不同方法、不同反例来源）。
    // 受限空间：2–3 人、起始筹码 2–6 个大盲、盲注 1/2，深度上限保证覆盖全下与边池。
    const failures: string[] = [];
    const seen = new Set<string>();
    let explored = 0;
    let emptyLayerHits = 0;

    /** 状态指纹：同一状态不重复展开（避免组合爆炸），但每个**唯一**状态都做审计。 */
    const signature = (s: HandState): string =>
      [
        s.street,
        s.actingSeat,
        s.currentBet,
        s.lastRaiseSize,
        s.finished ? 1 : 0,
        s.seats.map((x) => `${x.stack},${x.committed},${x.committedThisStreet},${x.folded ? 1 : 0},${x.allIn ? 1 : 0},${x.hasActedThisStreet ? 1 : 0}`).join('|'),
      ].join(';');

    const auditExhaustive = (state: HandState, label: string): void => {
      const committed = state.seats.map((s) => s.committed);
      const folded = state.seats.map((s) => s.folded);
      const pots = buildPots({ committed, folded });
      explored++;
      for (const [i, p] of pots.entries()) {
        if (p.amount > 0 && p.eligible.length === 0) {
          emptyLayerHits++;
          failures.push(
            `${label} 第 ${i} 层金额 ${p.amount} 无有资格者（committed=[${committed}] folded=[${folded}]）`,
          );
        }
      }
      const errs = validatePots({ committed, folded }, pots);
      if (errs.length > 0) failures.push(`${label} validatePots: ${errs.join('; ')}`);
      const maxLive = Math.max(...state.seats.filter((s) => !s.folded).map((s) => s.committed), -1);
      const maxDead = Math.max(...state.seats.filter((s) => s.folded).map((s) => s.committed), -1);
      if (maxDead > maxLive) failures.push(`${label} 弃牌者投入 ${maxDead} > 未弃牌者 ${maxLive}`);
    };

    const dfs = (state: HandState, depth: number, label: string): void => {
      auditExhaustive(state, label);
      if (state.finished || depth <= 0 || state.actingSeat < 0) return;
      const seat = state.actingSeat;
      const legal = legalActions(state, seat);

      /** 所有可执行动作：弃牌、过牌/跟注、以及若干加注尺度（含全下）。 */
      const moves: Array<{ type: 'fold' | 'check' | 'call' | 'raise' | 'allin'; to: number }> = [];
      if (legal.canFold) moves.push({ type: 'fold', to: 0 });
      if (legal.canCheck) moves.push({ type: 'check', to: 0 });
      if (legal.canCall) moves.push({ type: 'call', to: 0 });
      if (legal.canRaise) {
        const candidates = new Set<number>([legal.minRaiseTo, legal.maxRaiseTo]);
        // 再补几个中间尺度，覆盖「刚好不足最小加注的全下」等边界
        const mid = Math.floor((legal.minRaiseTo + legal.maxRaiseTo) / 2);
        if (mid > legal.minRaiseTo && mid < legal.maxRaiseTo) candidates.add(mid);
        for (const to of candidates) moves.push({ type: 'raise', to });
      }
      if (legal.canAllIn) moves.push({ type: 'allin', to: 0 });

      for (const mv of moves) {
        // 深拷贝后再动：applyAction 是原地修改，必须保证每个分支状态独立
        const next = JSON.parse(JSON.stringify(state)) as HandState;
        const r = applyAction(next, mv.type, mv.to);
        if (!r.ok) continue;
        const sig = signature(next);
        if (seen.has(sig)) continue;
        seen.add(sig);
        dfs(next, depth - 1, `${label}/${mv.type}`);
      }
    };

    let configs = 0;
    for (const seatCount of [2, 3]) {
      for (const smallBlind of [1]) {
        for (const bigBlind of [2]) {
          for (const stack of [2, 3, 4, 6]) {
            const stacks = new Array(seatCount).fill(stack);
            for (let dealerSeat = 0; dealerSeat < seatCount; dealerSeat++) {
              const st = { ...baseSettings, seatCount, smallBlind, bigBlind, startingStack: stack };
              const state = createHand({
                handId: `ex-${seatCount}-${stack}-${dealerSeat}`,
                seed: 12345 + dealerSeat,
                settings: st,
                heroSeat: 0,
                dealerSeat,
                stacks,
              });
              seen.clear();
              dfs(state, 40, `穷举 ${seatCount}人 筹码${stack} 庄${dealerSeat}`);
              configs++;
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
    expect(emptyLayerHits).toBe(0);
    expect(configs).toBe(20); // 2 人 × 4 档筹码 × 2 庄位 = 8，3 人 × 4 档 × 3 庄位 = 12，合计 20
    expect(explored).toBeGreaterThan(5_000); // 覆盖度：确实展开了大量可达状态
  });

  it('验收闸门可见性：checkChipConservation 现在会暴露空有资格层（此前该诊断被丢弃）', () => {
    // 缺陷：settleHand 早已算出 ShowdownResult.errors（含「层金额 > 0 但无有资格座位」），
    // 但 finish() 只取 results / values / pots，errors 被丢弃，任何调用方都读不到——
    // 等于这条不变量从未被验收闸门强制（G4 只调用 checkChipConservation）。
    // 本例用一个「最高投入者弃牌」的不可达状态直接验证闸门现在能看见它。
    const st = { ...baseSettings, seatCount: 3, smallBlind: 5, bigBlind: 10 };
    const state = createHand({ handId: 'gate-visible', seed: 5, settings: st, heroSeat: 0, dealerSeat: 0 });
    // 人为把状态改成「最高投入者（座位 2，投入 300）已弃牌」的不可达形态。
    // committed / folded 与 pots 保持一致，使该状态内部自洽。
    const committed = [100, 100, 300];
    const folded = [true, false, true];
    state.seats.forEach((s, i) => {
      s.committed = committed[i];
      s.folded = folded[i];
    });
    state.finished = true;
    state.pots = buildPots({ committed, folded });
    expect(state.pots.map((p) => p.amount)).toEqual([300, 200]);
    expect(state.pots[1].eligible).toEqual([]);
    const errs = checkChipConservation(state);
    expect(errs.some((e) => e.includes('无有资格座位'))).toBe(true);
  });

  it('可达的摊牌场景：短筹码全下被跟注，超额部分仍是未跟注退还（非仅弃牌获胜才有）', () => {
    // 这是「未跟注退还」概念真正重要的可达场景：两位玩家都未弃牌、进入摊牌，
    // 但一方的全下额低于另一方的投入，超出部分必须原样退还而非当作争夺筹码。
    // committed = [100, 300]，双方都未弃牌：level 100 → 2×100=200（争夺），
    // level 300 → 1×200=200（未被跟注，退还座位 1）。
    const committed = [100, 300];
    const folded = [false, false];
    const pots = layersOf(committed, folded);
    expect(pots.map((p) => p.amount)).toEqual([200, 200]);
    expect(pots.map((p) => p.kind)).toEqual(['contested', 'uncalled']);

    // 短筹码（座位 0）牌型更强：他赢主池 200，但拿不到对方未被跟注的 200
    const shortStackWins = distributePots(pots, (s) => (s === 0 ? 900 : 100), [0, 1], 2);
    expect(shortStackWins).toEqual([200, 200]);
    // 净盈亏：短筹码 +100（赢下对方跟注的 100），对方 -100（其超额 200 已退回）
    expect(shortStackWins[0] - committed[0]).toBe(100);
    expect(shortStackWins[1] - committed[1]).toBe(-100);
    expect(shortStackWins.reduce((a, b) => a + b, 0)).toBe(400);

    const lines = settlementBreakdown(pots, (s) => (s === 0 ? 900 : 100));
    expect(lines).toEqual([
      { kind: 'contested', amount: 200, recipients: [0], layerIndex: 0 },
      { kind: 'uncalled', amount: 200, recipients: [1], layerIndex: 1 },
    ]);
    // 主池 + 退还 == 总投入 400，两行齐全
    expect(lines.reduce((a, l) => a + l.amount, 0)).toBe(400);
  });

  it('姊妹分支兜底：rankOf 全返回 NaN 时该层在有资格者间均分，仍不丢筹码', () => {
    // 与「空有资格层」同类的风险：winners 过滤结果为空（rankOf 全为 NaN 时比较恒 false）。
    // 旧实现直接 continue → 该层金额被静默销毁。现退化为均分，优先保证守恒。
    const committed = [100, 100];
    const folded = [false, false];
    const pots = layersOf(committed, folded);
    const payouts = distributePots(pots, () => Number.NaN, [0, 1], 2);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(200);
    expect(payouts).toEqual([100, 100]);
  });

  it('可达性对照：同一投入额分布若最高投入者未弃牌，则不存在空层（说明空层只由不可达输入产生）', () => {
    const committed = [100, 100, 300];
    const folded = [true, false, false]; // 座位 2 未弃牌 → 正常
    const pots = buildPots({ committed, folded });
    expect(validatePots({ committed, folded }, pots)).toEqual([]);
    expect(pots.map((p) => p.eligible)).toEqual([[1, 2], [2]]);
    const payouts = distributePots(pots, (s) => (s === 2 ? 100 : 50), [0, 1, 2], 3);
    // 座位 2 牌型最强：拿下全部 500（含其自己未被跟注的 200）
    expect(payouts).toEqual([0, 0, 500]);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Q3 未跟注退还的展示口径（只校验 core 数据；UI 渲染留待后续）
// ---------------------------------------------------------------------------

describe('Q3 结算明细（主池 / 未跟注退还）数据口径', () => {
  it('全部未弃牌时没有退还条目：3 人边池全部为争夺层', () => {
    const committed = [100, 300, 300];
    const folded = [false, false, false];
    const pots = layersOf(committed, folded);
    expect(pots.map((p) => p.kind)).toEqual(['contested', 'contested']);
    const lines = settlementBreakdown(pots, (s) => (s === 0 ? 100 : 50));
    expect(lines).toEqual([
      { kind: 'contested', amount: 300, recipients: [0], layerIndex: 0 },
      { kind: 'contested', amount: 400, recipients: [1, 2], layerIndex: 1 },
    ]);
    // 平局层可以有多名受领者
    expect(lines[1].recipients).toEqual([1, 2]);
  });

  it('单一投入者的层标注为退还，且受领者是唯一投入者', () => {
    const committed = [100, 100, 300];
    const folded = [true, true, false];
    const pots = layersOf(committed, folded);
    expect(pots.map((p) => p.kind)).toEqual(['contested', 'uncalled']);
    expect(pots[1].contributors).toEqual([2]);
    const lines = settlementBreakdown(pots, () => 1);
    expect(lines).toEqual([
      { kind: 'contested', amount: 300, recipients: [2], layerIndex: 0 },
      { kind: 'uncalled', amount: 200, recipients: [2], layerIndex: 1 },
    ]);
  });

  it('无投入则不产生任何条目（空手牌不会伪造退还行）', () => {
    const pots = layersOf([0, 0, 0], [false, false, false]);
    expect(pots).toEqual([]);
    expect(settlementBreakdown(pots, () => 1)).toEqual([]);
  });

  it('旧记录兼容：缺少 contributors / kind 字段的层仍能被分类（金额精确，kind 退化为争夺层）', () => {
    // v1 持久化历史里的 pots 只有 amount 与 eligible；读取后不得崩溃。
    // 旧记录无法还原投入者人数，故 kind 一律按「争夺层」归类——这是**有意的降级**：
    // 金额与 recipients 仍精确，只有标注可能不准确。新增字段设计为可选正为避免此破坏。
    const legacy: PotLayer[] = [
      { amount: 20, eligible: [1] },
      { amount: 10, eligible: [1] },
    ];
    const lines = settlementBreakdown(legacy, () => 1);
    expect(lines.reduce((a, l) => a + l.amount, 0)).toBe(30);
    expect(lines.map((l) => l.layerIndex)).toEqual([0, 1]);
    expect(lines.map((l) => l.kind)).toEqual(['contested', 'contested']);
    expect(lines.every((l) => l.recipients.every((r) => Number.isInteger(r)))).toBe(true);
  });

  it('判据必须用「投入者人数」而非「有资格者人数」（否则会把争夺层误标为退还）', () => {
    // 反例：三人各投 100，其中两人弃牌、一人未弃牌。
    // 该层 eligible 只有座位 2（看起来像「唯一有资格者」），但它是三人共同投入的
    // 真实争夺层，绝不能被标成「未跟注退还」。这锁定 settlementBreakdown 的判据选择。
    const committed = [100, 100, 100];
    const folded = [true, true, false];
    const pots = layersOf(committed, folded);
    expect(pots[0].contributors).toEqual([0, 1, 2]);
    expect(pots[0].eligible).toEqual([2]); // 有资格者只有 1 人
    expect(pots[0].kind).toBe('contested'); // 但投入者有 3 人 → 争夺层
    const lines = settlementBreakdown(pots, () => 1);
    expect(lines).toEqual([{ kind: 'contested', amount: 300, recipients: [2], layerIndex: 0 }]);
  });

  it('属性测试：10,000 手随机对局中，明细总额 == 层总额 == 总投入，且退还行归属者未弃牌', () => {
    const rng = createRng(0xa11d_1717);
    const failures: string[] = [];
    let uncalledLines = 0;
    let contestedLines = 0;
    let hands = 0;

    for (let h = 0; h < 10_000; h++) {
      const seatCount = [2, 6, 9][rng.nextInt(3)];
      const st = { ...baseSettings, seatCount, startingStack: 1000 };
      const state = createHand({
        handId: `bd${h}`,
        seed: rng.nextInt(0xffffffff),
        settings: st,
        heroSeat: 0,
        dealerSeat: rng.nextInt(seatCount),
      });
      let guard = 0;
      while (!state.finished && guard++ < 2000) {
        const seat = state.actingSeat;
        if (seat < 0) break;
        const legal = legalActions(state, seat);
        const roll = rng.nextInt(100);
        if (roll < 12 && legal.canFold) applyAction(state, 'fold', 0);
        else if (roll < 30 && legal.canRaise) {
          const span = legal.maxRaiseTo - legal.minRaiseTo;
          const to = legal.minRaiseTo + (span > 0 ? rng.nextInt(span + 1) : 0);
          if (!applyAction(state, 'raise', to).ok) applyAction(state, 'call', 0);
        } else if (roll < 36 && legal.canAllIn) applyAction(state, 'allin', 0);
        else if (legal.canCheck) applyAction(state, 'check', 0);
        else if (legal.canCall) applyAction(state, 'call', 0);
        else applyAction(state, 'fold', 0);
      }
      if (!state.finished) continue;
      hands++;

      const totalCommitted = state.seats.reduce((a, s) => a + s.committed, 0);
      const potTotal = state.pots.reduce((a, p) => a + p.amount, 0);
      const rankOf = (s: number) => state.showdownValues[s] ?? -Infinity;
      const lines = settlementBreakdown(state.pots, rankOf);
      const lineTotal = lines.reduce((a, l) => a + l.amount, 0);

      if (lineTotal !== potTotal || potTotal !== totalCommitted) {
        failures.push(
          `第 ${h} 手：明细 ${lineTotal} / 层总额 ${potTotal} / 总投入 ${totalCommitted} 不相等`,
        );
      }
      for (const l of lines) {
        if (l.kind === 'uncalled') {
          uncalledLines++;
          const owner = l.recipients[0];
          if (owner === undefined) failures.push(`第 ${h} 手：退还行无受领者`);
          else if (state.seats[owner].folded) failures.push(`第 ${h} 手：退还 200 归已弃牌座位 ${owner}`);
        } else {
          contestedLines++;
          for (const r of l.recipients) {
            const layer = state.pots[l.layerIndex];
            if (!layer.eligible.includes(r)) failures.push(`第 ${h} 手：争夺层受领者 ${r} 不在有资格名单`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
    expect(hands).toBe(10_000);
    expect(uncalledLines).toBeGreaterThan(0); // 覆盖度：确实产生过退还行
    expect(contestedLines).toBeGreaterThan(0);
  });

  it('tieBreak 位置序仍参与退还层之外的分配（确保新增字段未影响分配逻辑）', () => {
    // 三人平局、奇数筹码：与既有 G5 断言同口径，防止新增字段改动分配顺序。
    const committed = [10, 10, 10];
    const pots = layersOf(committed, [false, false, false]);
    const order = tieBreakOrder(3, 1);
    expect(order).toEqual([1, 2, 0]);
    const payouts = distributePots(pots, () => 42, order, 3);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(30);
    // 座位角色推导未受影响
    expect(seatRoles(3, 0).smallBlindSeat).toBe(1);
  });
});
