/**
 * 分步演出：单个 AI 动作（表现层）。
 *
 * ── 为什么必须有这个文件 ──────────────────────────────────────
 * `GameController.runAI()` 内部是一个 `while` 循环，**一次调用会把所有 AI 动作
 * 全部跑完**直到轮到玩家或本手结束（实测：6 人桌一次调用推进 3 名 AI）。
 * 因此「在两次调用之间加延时」根本做不到分步——一次调用就已经是全部了。
 *
 * 本模块把那次循环**逐次复刻**成一个「只推进一名 AI」的单步：
 * 决策源、RNG 派生公式、兜底路径与 `runAI()` 逐字一致，
 * 只是把 `while` 换成「调用一次就返回」。
 *
 * ── 为什么这不是「改规则」（本任务的硬约束）──────────────
 *   - 本模块**不修改 `src/core/` 或 `src/ui/controller.ts`**；
 *   - 它调用的是 `core` 自己导出的 `applyAction`，参数与 `runAI()` 完全相同
 *     （`decision.type`、`decision.toAmount`、`thinkMs = 0`）；
 *   - 它不改任何金额、结算或合法动作判定；
 *   - 它与 `runAI()` 的**唯一**差别是「一次循环 vs 一次调用」，
 *     即纯粹的调用时机编排。
 *
 * 等价性由 `tests/unit/showcase.test.ts` 的「同构性」用 200 组种子逐条比对
 * 动作序列来强制（逐步推进 vs 一次跑完，`actions` 必须逐字节相同）。
 */

import { decideAI } from '../ai/policy.js';
import { applyAction } from '../core/hand.js';
import { legalActions } from '../core/betting.js';
import { createRng } from '../core/rng.js';
import type { HandState } from '../core/types.js';

/** 单步尝试的总次数上限（防止任何意外情况演变成死循环）。 */
export const MAX_SHOWCASE_STEPS = 500;

export interface StepOutcome {
  /** 本步是否推进了一名 AI。 */
  advanced: boolean;
  /** 被执行动作的座位；未推进时为 -1。 */
  seat: number;
  /** 走的是否是 `runAI()` 的兜底路径（决策被拒绝）。 */
  fallback: boolean;
}

const NOTHING: StepOutcome = { advanced: false, seat: -1, fallback: false };

/**
 * 推进一名 AI（等价于 `runAI()` 循环的一次迭代）。
 *
 * `guard` 必须由调用方**按本手累计**传入，且语义与 `runAI()` 的循环计数器完全一致：
 * 它参与 RNG 派生（`guard * 104729`），若计数口径不同，AI 的决策就会与原来不同
 * ——这正是「演出不得改变对局结果」最容易踩的坑，故此处显式暴露为参数。
 *
 * @param state     牌局状态（原地修改，与 `applyAction` 的既有语义一致）
 * @param heroSeat  玩家座位
 * @param guard     本手已执行的 AI 步序号（从 1 开始）
 */
export function stepAiAction(state: HandState, heroSeat: number, guard: number): StepOutcome {
  if (state.finished) return NOTHING;
  const seat = state.actingSeat;
  if (seat < 0 || seat === heroSeat) return NOTHING;

  const decision = decideAI(state, seat, createRng(state.seed ^ (seat * 7919) ^ (guard * 104729)));
  const r = applyAction(state, decision.type, decision.toAmount, 0);
  if (r.ok) return { advanced: true, seat, fallback: false };

  // ── 兜底：与 `runAI()` 的兜底分支完全一致（避免卡死）──
  const legal = legalActions(state, seat);
  if (legal.canCheck) applyAction(state, 'check', 0);
  else if (legal.canCall) applyAction(state, 'call', 0);
  else applyAction(state, 'fold', 0);
  return { advanced: true, seat, fallback: true };
}
