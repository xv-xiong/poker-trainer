/**
 * 分步演出调度 hook（表现层）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * `GameController.runAI()` 内部是 `while` 循环，**一次性**把 AI 所有动作跑完
 * 直到轮到玩家或本手结束。玩家看到的是「结果瞬间出现」，看不到谁做了什么、
 * 更看不到公共牌是一张张发出来的。
 *
 * 本 hook 把那一次 `runAI()` 拆成「一次只推进一名 AI」的多次调用，
 * 并在两次调用之间插入停顿，让每个动作都能被看见。
 *
 * ── 三层职责分离（刻意设计，便于验收）────────────────────────
 *   1. 决策层（纯逻辑）：`GameController` + `src/core/*`
 *   2. 编排层（纯函数，可单测）：`src/ui/showcasePlan.ts`
 *      —— 公开类型、`planShowcaseStep()`、节奏常量、游标数学、视图派生、调度键
 *   3. 调度层（本文件，约 350 行）：只负责「什么时候重算 / 什么时候推进」
 *
 * 阶段四把这一个 760 行的文件拆成四个：纯函数层 `showcasePlan.ts`、
 * 揭示游标 `useBoardReveal.ts`、结束停顿 `useSettleHold.ts`，本文件只剩 React 编排。
 * **对外 API 一字未变**（下方 `export *` 把纯函数层原样再导出），
 * 组件与测试的 import 路径不需要改。
 *
 * ── 硬约束 ────────────────────────────────────────────────────
 *   - **只改变「什么时候调用」，不改变「调用什么」**：
 *     `ai-action` 步调用 `src/ui/showcaseStep.ts` 的 `stepAiAction()`，
 *     它逐字复刻 `GameController.runAI()` 循环体的一次迭代（同一 RNG 派生、
 *     同一兜底逻辑），因此两条路径对同一状态产出相同动作
 *     （见 `tests/unit/showcase.test.ts` 的同构性断言）。
 *     玩家动作仍由 `<ActionBar>` → `App.handleAct` → `controller.act()` 发起。
 *     本文件不产生任何新的 `applyAction` 调用，也不传任何新参数。
 *   - **重入安全**：本 hook 只在 React 副作用里推进，无飞行中的定时器/微任务。
 *   - **可打断**：`handId` 变化（下一手 / 重新发牌）会重置全部演出状态，
 *     上一手的中间态不会污染新一手。
 *   - **reduced-motion**：`prefers-reduced-motion: reduce` 时所有等待压到 0。
 *
 * ── 本 hook 不碰任何规则 ──────────────────────────────────────
 *   不 import `src/core/*` 的**规则函数或状态构造**（如 `applyAction`、`createHand`），
 *   只读 `HandState` 的字段做展示判断（唯一从 core 引入的值 `ACTION_LABELS`
 *   是纯展示标签，已随纯函数层搬到 `showcasePlan.ts`）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionType } from '../core/types.js';
import { MAX_SHOWCASE_STEPS } from './showcaseStep.js';
import { aiThinkDelayMs } from './thinkTiming.js';
import {
  REDUCED_TIMING,
  SHOWCASE_TIMING,
  deriveShowcaseView,
  planShowcaseStep,
  showcaseStepKey,
  type ShowcaseStep,
  type ShowcaseTiming,
  type ShowcaseView,
  type TableShowcase,
  type UseTableShowcaseOptions,
} from './showcasePlan.js';
import { prefersReducedMotion, useStableCallback } from './reactSupport.js';
import { useBoardReveal } from './useBoardReveal.js';
import { useSettleHold } from './useSettleHold.js';

// 纯函数层原样再导出：组件、单测、E2E 一直从本文件取这些符号，
// 拆分内部文件不应该逼调用方改 import 路径。
export * from './showcasePlan.js';
export type { ActionType };

/**
 * 分步演出调度 hook。
 *
 * 设计要点（针对「双重推进导致跳步 / 卡死」这一最容易出 bug 的地方）：
 *   - 所有推进都发生在 effect 内，**不在渲染期做副作用**；
 *   - 每一步的完成条件都是「`snap.revision` 真的变化了」，而不是「定时器到点了」；
 *   - 揭示公共牌的游标是 `{ handId, n }` 作用域化的**派生量**：换手或牌数变短时
 *     派生值立刻归零 / clamp，不依赖任何「重置 effect」，天然幂等；
 *   - 结束停顿由 `settleHold` 一次性标记，不会反复触发。
 */
export function useTableShowcase(opts: UseTableShowcaseOptions): TableShowcase {
  const { snap, heroSeat } = opts;
  // 回调固定身份，避免上层定时器被反复取消（见 useStableCallback 注释）
  const runAiStep = useStableCallback(opts.runAiStep);

  // 节奏：跟随系统「减少动态效果」偏好
  const [reduced, setReduced] = useState<boolean>(() => prefersReducedMotion());
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);

  const timing = useMemo<ShowcaseTiming>(
    () => (reduced ? REDUCED_TIMING : { ...SHOWCASE_TIMING, ...(opts.timing ?? {}) }),
    [reduced, opts.timing],
  );

  const st = snap.state;
  // 当前手牌 id：游标是 `{ handId, n }` 作用域化的，渲染期就要用它派生可见张数。
  const handId = st?.handId ?? null;

  // 演出代数：新一手自增
  const [epoch, setEpoch] = useState(0);

  // 揭示游标（内部 hook）：换手后派生值立刻为 0，不依赖「换手重置」effect。
  const boardLen = st?.board.length ?? 0;
  const reveal = useBoardReveal(handId, boardLen, st);
  const visibleBoardCount = reveal.visibleBoardCount;

  // 结束停顿（内部 hook）：必须等公共牌全部揭示完才开始计时。
  const settle = useSettleHold({
    finished: Boolean(st?.finished),
    showdown: Boolean(st?.finished && st.finishReason === 'showdown'),
    visibleBoardCount,
    boardLen,
    settleMs: timing.settleMs,
    epoch,
    signature: st,
  });
  const settleHold = settle.settleHold;
  const setSettleHold = settle.setSettleHold;

  /**
   * 本手的 AI 步计数器。
   *
   * 为什么必须是 ref 而不是 state：它参与 RNG 派生（`guard * 104729`），
   * 口径必须与 `GameController.runAI()` 里的 `while` 计数器**逐一对应**
   * （该循环每迭代一次 `guard++` 一次）。若用 state，React 批处理会让它在
   * 同一帧内读到旧值，导致两次 AI 决策共用同一个 guard → 决策序列与原来不同
   * → **对局结果被演出改变**（本任务明令禁止）。
   */
  const aiGuardRef = useRef(0);

  // ── 新一手：重置演出状态 ──
  // 依赖里必须用 `handId` 这样的原始值：`snap.state` 是原地修改的对象，
  // 引用不会变，用对象做依赖会漏掉「同一对象换了一手」的情况；
  // 也不能用 `revision`，否则每次动作都会重置（公共牌会被反复重发）。
  //
  // **揭示游标刻意不在这里重置**：它是 `{handId, n}` 作用域化的派生量，
  // 换手后 `visibleBoardCountOf` 在渲染期直接返回 0，无需 setState。
  // 这样就不存在「重置排队、同帧断言读到旧值」的窗口——那正是 dev 模式
  // 点「下一手」整页白屏的根因。
  const handIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (handId === handIdRef.current) return;
    handIdRef.current = handId;
    aiGuardRef.current = 0;
    setSettleHold(false);
    setEpoch((e) => e + 1);
  }, [handId, setSettleHold]);

  // 4.5 之后 `snap.state` 是 controller 每次 emit 重新克隆的对象，
  // 身份变化即代表状态变化，因此依赖 `st` 本身就够（不再需要七段字符串键）。
  const view = useMemo<ShowcaseView>(
    () => deriveShowcaseView({ state: st, heroSeat, visibleBoardCount, settleHold, timing }),
    [st, visibleBoardCount, settleHold, heroSeat, timing],
  );

  const step = useMemo(
    () => planShowcaseStep(snap, heroSeat, view.visibleBoardCount, timing, settleHold),
    [snap, heroSeat, view.visibleBoardCount, timing, settleHold],
  );

  const stepKey = showcaseStepKey(snap.revision, step, view.visibleBoardCount, settleHold);
  const stepRef = useRef(step);
  stepRef.current = step;

  /**
   * 本步的实际等待时长（AI 思考时长模拟真人）。
   *
   * 为什么放在这一层、而不是直接改 `planShowcaseStep` 的 `delayMs`：
   *   - `planShowcaseStep` 是**纯函数**，单测断言它「同状态重复调用结果完全相同」；
   *     在纯函数里抽随机数会直接破坏这条不变量。
   *   - 抽样必须「一步只抽一次」。用 (seed, revision, seat) 做哈希键，同一步在
   *     任意次重渲染 / StrictMode 双调用下都得到同一个值，因此定时器不会被
   *     自己的清理函数反复取消（那会表现为画面停在「思考中」不动）。
   *
   * 只有 `ai-action` 步被覆盖；`board` / `settle` / `hero-action` 仍用
   * `planShowcaseStep` 给出的确定值（它们不是「AI 思考」，不该随机化）。
   */
  const aiThinkDelay = useMemo(
    () =>
      aiThinkDelayMs({
        kind: step.kind,
        seat: 'seat' in step ? step.seat : -1,
        baseMs: timing.thinkMs,
        // 档位只决定「用哪个区间」，不参与决策；换档位后同一步会换一个时长，
        // 因此必须进依赖数组（否则切到「瞬时」后当前这步仍按旧档等完）。
        pace: snap.pace,
        seed: st?.seed ?? 0,
        revision: snap.revision,
      }),
    // stepKey 已涵盖 kind / seat / revision / 揭示游标 / settleHold，用它做依赖即可；
    // st 是原地修改的对象，引用不变，不能进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stepKey, timing.thinkMs, st?.seed, snap.pace],
  );

  // step 的身份只随调度键变化；delayMs 每次读取最新值，不参与身份计算。
  const stableStep = useMemo<ShowcaseStep>(() => {
    const s = stepRef.current;
    return s.kind === 'ai-action' ? { ...s, delayMs: aiThinkDelay } : s;
  }, [stepKey, aiThinkDelay]);

  // 调试观测点（仅非生产）：把演出调度轨迹暴露到 window，便于 E2E 采样取证。
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const w = globalThis as unknown as { __showcaseTrace?: unknown[] };
    if (!w.__showcaseTrace) w.__showcaseTrace = [];
    if (w.__showcaseTrace.length < 400) {
      w.__showcaseTrace.push({
        rev: snap.revision,
        step: stableStep.kind,
        seat: 'seat' in stableStep ? stableStep.seat : null,
        // 记录**实际**等待时长（含随机思考时长），便于 E2E 取证：
        // 「连续多次 AI 决策耗时都在区间内」这条验收要求就靠这个字段核对。
        delay: 'delayMs' in stableStep ? stableStep.delayMs : null,
        acting: st?.actingSeat ?? null,
        actions: st?.actions.length ?? -1,
        board: st?.board.length ?? -1,
        revealed: view.visibleBoardCount,
        thinking: view.thinkingSeat,
        canHeroAct: view.canHeroAct,
        finished: st?.finished ?? false,
      });
    }
  }, [snap.revision, stableStep, st, view, snap]);

  /** 演出中是否有待办的一步（供 App 的调度定时器判断是否需要排期）。 */
  const busy = step.kind !== 'idle';

  // ── 非生产环境不变量自检（第二处：不能无限重排）──
  // 结束停顿已走完却仍排 `settle` 步 → 上层定时器会被无限重排，
  // 表现为「结算面板永不出现」的卡死。这是本任务最容易写错的一处。
  //
  // 同样**只记录、不 throw**：渲染期 throw 会直接卸载整棵树（白屏），
  // 而这里想要的只是「让开发者在控制台看到」。改到 effect 里做，顺带避免
  // 渲染期产生副作用。
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (st?.finished && step.kind === 'settle' && settleHold) {
      console.error('[showcase] 结束停顿已完成但仍排 settle 步，会导致无限重排（结算面板不出现）');
    }
  }, [step.kind, st?.finished, settleHold]);

  /**
   * 一步最多推进一个单位。
   *
   * 关键不变量：
   *   - 揭示公共牌时游标一次只 +1（否则 flop 会一次性弹出三张）；
   *   - 游标永不越过真实牌数（否则会提前露出 turn/river）；
   *   - `ai-action` 步只推进**一名** AI（若换成 `controller.runAI()`，
   *     一次调用会跑完所有 AI，分步立刻失效——这是本任务的核心陷阱）。
   */
  const run = useCallback(
    (s: ShowcaseStep) => {
      switch (s.kind) {
        case 'ai-action': {
          const guard = aiGuardRef.current + 1;
          if (process.env.NODE_ENV !== 'production' && guard > MAX_SHOWCASE_STEPS) {
            // 只记录、不 throw：dev 模式下 throw 会让整页白屏。
            // MAX_SHOWCASE_STEPS=500，正常一手远达不到，这条只是「死循环可见化」的保险。
            console.error(`[showcase] AI 步数超过 ${MAX_SHOWCASE_STEPS}，疑似死循环（本手未结束）`);
          }
          aiGuardRef.current = guard;
          runAiStep();
          break;
        }
        case 'board':
          // 游标推进由内部 hook 负责：恒为 min(当前可见 + 1, 真实张数)，
          // 天然单调不减，所以旧实现里那条「游标回退」throw 已无存在必要。
          reveal.advance();
          break;
        case 'settle':
          setSettleHold(true);
          break;
        case 'hero-action':
        case 'idle':
          break;
      }
    },
    [runAiStep, reveal, setSettleHold],
  );

  return { view, step: stableStep, busy, run, epoch };
}
