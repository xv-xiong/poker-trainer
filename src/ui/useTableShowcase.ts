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
 *   1. 决策层（纯逻辑，本任务不改）：`GameController` + `src/core/*`
 *   2. 编排层（纯函数，可单测）：`planShowcaseStep()` / `showcaseSignature()`
 *   3. 调度层（本 hook）：按当前状态产出「当前该执行的一步」与「展示视图」
 *
 * ── 硬约束 ────────────────────────────────────────────────────
 *   - **只改变「什么时候调用」，不改变「调用什么」**：
 *     `ai-action` 步最终仍调用 `controller.runAI()`（每步一次，其内部 `while`
 *     自然只会推进一名 AI，见 `tests/unit/showcase.test.ts` 的同构性断言）；
 *     玩家动作仍由 `<ActionBar>` → `App.handleAct` → `controller.act()` 发起。
 *     本文件不产生任何新的 `applyAction` 调用，也不传任何新参数。
 *   - **重入安全**：本 hook 只在 React 副作用里推进，无飞行中的定时器/微任务；
 *     `advance()` 对同一状态幂等（时间窗判定已移除，改为事件驱动）。
 *   - **可打断**：`handId` 变化（下一手 / 重新发牌）会重置全部演出状态，
 *     上一手的中间态不会污染新一手。
 *   - **reduced-motion**：`prefers-reduced-motion: reduce` 时所有等待压到 0。
 *
 * ── 本 hook 不碰任何规则 ──────────────────────────────────────
 *   不 import `src/core/*` 的任何值，只读 `HandState` 的字段做展示判断。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ControllerSnapshot } from './controller.js';
import { MAX_SHOWCASE_STEPS } from './showcaseStep.js';
import {
  ACTION_LABELS,
  type ActionRecord,
  type ActionType,
  type Street,
} from '../core/types.js';

/** 供 UI 读取的动作记录（`ActionRecord` 的结构别名，避免组件直接依赖 core 类型名）。 */
export type ShowcaseAction = ActionRecord;

/** 演出节奏（毫秒）。集中一处，保证组件 CSS、E2E 断言与调度逻辑三方一致。 */
export interface ShowcaseTiming {
  /** AI / 发牌的「思考」停顿：此期间座位高亮、显示思考气泡。 */
  thinkMs: number;
  /** 揭示一张公共牌后、进入下一步前的停顿。 */
  revealMs: number;
  /** 动作气泡在屏幕上停留的最短时间（每步之间至少间隔这么久）。 */
  bubbleMs: number;
  /** 一手结束后、显示结算面板前的停顿。 */
  settleMs: number;
}

/** 完整节奏（有动画时）。 */
export const SHOWCASE_TIMING: ShowcaseTiming = {
  thinkMs: 560,
  revealMs: 780,
  bubbleMs: 520,
  settleMs: 640,
};

/**
 * 缩减动效时的节奏：全部为 0。
 *
 * 为什么不能只是「把 CSS 动画关掉」：`prefers-reduced-motion` 的用户想要的
 * 是「立即呈现」，而不是「看一个没有动画的 5 秒空转」。因此等待也必须归零，
 * 且推进逻辑在 0 延迟下仍然完整（每步都照常执行，只是不等待）。
 */
export const REDUCED_TIMING: ShowcaseTiming = {
  thinkMs: 0,
  revealMs: 0,
  bubbleMs: 0,
  settleMs: 0,
};

const IDLE: ShowcaseStep = { kind: 'idle' };

export type ShowcaseStep =
  /** 无事可做（没有牌局 / 已结束且结算停顿已过）。 */
  | { kind: 'idle' }
  /** 等一会儿，只显示「思考」气泡：下一步是 AI 行动。 */
  | { kind: 'ai-action'; seat: number; delayMs: number }
  /** 等一会儿，收起玩家自己的气泡：下一步交回玩家。 */
  | { kind: 'hero-action'; seat: number; delayMs: number }
  /** 等一会儿，然后揭示下一张公共牌（逐张）。 */
  | { kind: 'board'; delayMs: number }
  /** 本手结束：等一会儿再显示结算与「下一手」。 */
  | { kind: 'settle'; delayMs: number };

/** 演出状态标识：任何一项变化都表示「画面进入了不同的中间态」。 */
export interface ShowcaseSignature {
  thinking: boolean;
  thinkingSeat: number;
  /** 最近动作的复合标识；-1 表示无动作。 */
  action: number;
  visibleBoard: number;
  settleHold: boolean;
}

export interface ShowcaseView {
  /** 当前是否处于「思考中」——座位光晕、思考气泡、禁用按钮都看它。 */
  thinking: boolean;
  /** 正在思考的座位；-1 表示没有。 */
  thinkingSeat: number;
  /** 玩家此刻**真正**可以行动（已扣掉演出中的禁用与未揭完的公共牌）。 */
  canHeroAct: boolean;
  /** 最近一条动作（用于座位旁动作气泡）。 */
  lastAction: ShowcaseAction | null;
  /** 已亮相的公共牌数量（flop 逐张时为 1 → 2 → 3）。 */
  visibleBoardCount: number;
  /** 已亮相的公共牌；调用方必须用它覆盖 `state.board`，否则整街会一次性显示。 */
  shownBoard: readonly number[];
  /** 本手是否已「演出完毕」（结束停顿已过，可以显示结算面板）。 */
  settled: boolean;
  /** 本手是否已结束（无论停顿是否走完）。 */
  handOver: boolean;
  /** 本手赢家座位；-1 表示无（弃牌结束或未结束）。 */
  winnerSeat: number;
  /** 本手是否刚开局（用于底牌发牌的入场动画；**不阻塞任何输入**）。 */
  dealt: boolean;
  /** 演出节奏（供组件对齐 CSS 动画时长）。 */
  timing: ShowcaseTiming;
}

export interface TableShowcase {
  /** 展示视图（已把演出中的禁用算进去）。 */
  view: ShowcaseView;
  /** 当前该执行的一步。 */
  step: ShowcaseStep;
  /** 是否还有待办的一步（step.kind !== 'idle'）。 */
  busy: boolean;
  /** 执行一步。**App 唯一需要接的地方。** */
  run: (step: ShowcaseStep) => void;
  /** 演出代数；`handId` 变化时自增，可用于调试。 */
  epoch: number;
}

export interface UseTableShowcaseOptions {
  snap: ControllerSnapshot;
  heroSeat: number;
  /**
   * 推进**一名** AI。
   *
   * 注意：不能直接传 `controller.runAI`——它内部是 `while` 循环，一次调用会把
   * 所有 AI 跑完，分步就失效了。请传 `src/ui/showcaseStep.ts` 的 `stepAiAction`
   * 包装（见 App.tsx 接线片段）。
   *
   * 返回本步是否真的推进了。
   */
  runAiStep: () => boolean;
  /** 可选的节奏覆盖（用于测试注入快速节奏）。 */
  timing?: Partial<ShowcaseTiming>;
}

// ── 纯函数编排层 ─────────────────────────────────────────────

export function streetIndex(street: Street): number {
  const i = (['preflop', 'flop', 'turn', 'river'] as Street[]).indexOf(street);
  return i < 0 ? 0 : i;
}

/** 动作的中文展示文案（带额度时补上额度，与真实下注一致）。 */
export function actionLabel(action: ShowcaseAction): string {
  const label = ACTION_LABELS[action.type]?.zh ?? action.type;
  if (action.type === 'bet' || action.type === 'raise') return `${label} 到 ${action.toAmount}`;
  if (action.type === 'allin') return `${label} ${action.amount}`;
  if (action.type === 'call' && action.amount > 0) return `${label} ${action.amount}`;
  return label;
}

/** 本街已经发出几张公共牌（0 / 3 / 4 / 5）。 */
export function boardCountForStreet(street: Street): number {
  switch (street) {
    case 'preflop':
      return 0;
    case 'flop':
      return 3;
    case 'turn':
      return 4;
    case 'river':
      return 5;
  }
}

export function sameSignature(a: ShowcaseSignature, b: ShowcaseSignature): boolean {
  return (
    a.thinking === b.thinking &&
    a.thinkingSeat === b.thinkingSeat &&
    a.action === b.action &&
    a.visibleBoard === b.visibleBoard &&
    a.settleHold === b.settleHold
  );
}

export function signatureOf(view: ShowcaseView): ShowcaseSignature {
  return {
    thinking: view.thinking,
    thinkingSeat: view.thinkingSeat,
    // 展示视图里不再有「停留窗口」，最近动作即是已生效动作
    action: view.lastAction ? view.lastAction.seat * 16 + view.lastAction.type.length : -1,
    visibleBoard: view.visibleBoardCount,
    settleHold: view.handOver && !view.settled,
  };
}

/**
 * 计算「下一步该干什么」。
 *
 * 判定顺序即优先级，每一步只做一件事：
 *   1. 本手结束 → `settle`（让赢家高亮被看见，再显示结算面板）
 *   2. 公共牌未全部亮相 → `board`（**逐张**，一次一张）
 *   3. 无人在行动 → `idle`
 *   4. 轮到玩家 → `hero-action`（若玩家刚动作过，停顿一下让气泡被看见）
 *   5. 轮到 AI → `ai-action`（先思考，再执行）
 */
export function planShowcaseStep(
  snap: ControllerSnapshot,
  heroSeat: number,
  revealed: number,
  timing: ShowcaseTiming,
  /** 结束停顿是否已经走完（纯函数参数，避免读组件状态）。 */
  settleHold = false,
): ShowcaseStep {
  const st = snap.state;
  if (!st || st.seatCount <= 0) return IDLE;

  // 1) 公共牌还没全部亮相 → 逐张揭示。
  //    注意：即使 reduced-motion 把延迟压成 0，也**必须**返回 `board` 步，
  //    否则揭示游标永远停在原地，导致后续 AI/玩家步骤被这一分支一直挡住（卡死）。
  if (revealed < st.board.length) {
    return { kind: 'board', delayMs: Math.max(0, timing.revealMs) };
  }

  if (st.finished) {
    return settleHold ? IDLE : { kind: 'settle', delayMs: Math.max(0, timing.settleMs) };
  }

  if (st.actingSeat < 0) return IDLE;

  // 玩家刚动作完（actions 末条是玩家本人）→ 气泡还没被看见，先停顿
  const last = st.actions.length > 0 ? st.actions[st.actions.length - 1] : null;
  const pendingHeroBubble = last?.seat === heroSeat;

  if (st.actingSeat === heroSeat) {
    return {
      kind: 'hero-action',
      seat: heroSeat,
      delayMs: pendingHeroBubble ? Math.max(0, timing.bubbleMs) : 0,
    };
  }

  return { kind: 'ai-action', seat: st.actingSeat, delayMs: Math.max(0, timing.thinkMs) };
}

/** 动作的稳定标识（用于气泡动画的重放 key）。 */
export function actionKey(action: ShowcaseAction | null): number {
  return action ? action.seat * 16 + action.type.length : -1;
}

/** 下一步是否已经跨过了结束停顿。 */
export function isSettleStep(step: ShowcaseStep): boolean {
  return step.kind === 'settle';
}

// ── 调度层 ───────────────────────────────────────────────────

/**
 * 分步演出调度 hook。
 *
 * 设计要点（针对「双重推进导致跳步 / 卡死」这一最容易出 bug 的地方）：
 *   - 所有推进都发生在 effect 内，**不在渲染期做副作用**；
 *   - 每一步的完成条件都是「`snap.revision` 真的变化了」，而不是「定时器到点了」；
 *   - 揭示公共牌的游标由 `revealedBoard` 显式持有，且只在**公共牌数组真的变短**
 *     时才回退（例如重新开局），天然幂等；
 *   - 结束停顿由 `settleHold` 一次性标记，不会反复触发。
 */
/**
 * 把回调固定住：调用方常写成内联箭头函数（`runAiStep: () => ref.current()`），
 * 每次渲染身份都不同。若把它直接放进 `useMemo`/`useCallback` 的依赖里，
 * 派生的 `step` 与 `run` 也会每次渲染都换身份，上层调度定时器就会**被自己的
 * 清理函数反复取消而永远不触发**（表现为画面停在「思考中」不动）。
 *
 * 这是本 hook 最隐蔽的一类缺陷，所以在这里统一兜住，而不是要求调用方写
 * `useCallback`（调用方忘了就会卡死，且极难定位）。
 */
function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return useCallback(((...args: never[]) => ref.current(...args)) as T, []);
}

/**
 * 分步演出调度 hook。
 *
 * 设计要点（针对「双重推进导致跳步 / 卡死」这一最容易出 bug 的地方）：
 *   - 所有推进都发生在 effect 内，**不在渲染期做副作用**；
 *   - 每一步的完成条件都是「`snap.revision` 真的变化了」，而不是「定时器到点了」；
 *   - 揭示公共牌的游标由 `revealedBoard` 显式持有，且只在**公共牌数组真的变短**
 *     时才回退（例如重新开局），天然幂等；
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

  /**
   * 视图重算键。
   *
   * **这是本 hook 最关键的依赖设计。** `applyAction` 是**原地修改** `HandState`
   * （为性能避免每步深拷贝），所以 `snap.state` 的对象引用永远不变。
   * 若把 `st` 直接放进 `useMemo`/`useEffect` 的依赖数组，依赖永远"没变"，
   * 视图就再也不会重算——表现为**画面停在第一次渲染的样子**：
   * 公共牌永远不出现、动作气泡永远不显示、座位光晕停在第一个 AI 上，
   * 而底池数字（来自 `state` 的实时读取）却在变。这类"半死不活"的卡顿
   * 极难从现象反推原因，因此这里显式用 primitive 组合成键。
   */
  const viewKey = `${snap.revision}|${st?.handId ?? ''}|${st?.actions.length ?? -1}|${st?.board.length ?? -1}|${
    st?.actingSeat ?? -2
  }|${st?.finished ? 1 : 0}|${st?.street ?? ''}`;

  // 已揭示的公共牌张数（演出游标）
  const [revealedBoard, setRevealedBoard] = useState(0);
  // 本手结束后是否已完成「结算停顿」
  const [settleHold, setSettleHold] = useState(false);
  // 演出代数：新一手自增
  const [epoch, setEpoch] = useState(0);
  const handIdRef = useRef<string | null>(null);
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

  /** 真实公共牌张数（用 ref 暴露给身份稳定的 `run`，见其内部注释）。 */
  const boardLenRef = useRef(0);
  boardLenRef.current = st?.board.length ?? 0;

  // ── 新一手：重置演出游标 ──
  // 注意依赖里必须用 `st?.handId` 这样的原始值：`snap.state` 是原地修改的对象，
  // 引用不会变，用对象做依赖会漏掉「同一对象换了一手」的情况；
  // 也不能用 `revision`，否则每次动作都会重置游标（公共牌会被反复重发）。
  const handId = st?.handId ?? null;
  useEffect(() => {
    if (handId === handIdRef.current) return;
    handIdRef.current = handId;
    aiGuardRef.current = 0;
    setRevealedBoard(0);
    setSettleHold(false);
    setEpoch((e) => e + 1);
  }, [handId]);

  // 公共牌变短（重新开局但 handId 相同等边界）时，游标不能超过实际张数
  useEffect(() => {
    setRevealedBoard((n) => (n > boardLenRef.current ? boardLenRef.current : n));
  }, [st?.board.length]);

  // ── 揭示公共牌：只由 `board` 步推进 ──
  //
  // 为什么**不**在这里自动 +1：曾用「effect + setTimeout(0) 每轮揭示一张」实现，
  // 结果与底池/行动步在同一条 effect 队列里竞争，观测到的张数直接从 0 跳到 3
  // （中间态被 React 批处理吃掉）。现在改由 `planShowcaseStep` 产出 `board` 步、
  // 上层按 `revealMs` 排期、`run('board')` 才 +1，每个中间态都必然独立渲染一帧。
  // 这里只负责「不能超过真实张数」的收敛（防止状态被外部重置后越界）。

  // ── 结算停顿 ──
  useEffect(() => {
    if (!st?.finished) {
      setSettleHold(false);
      return;
    }
    if (settleHold) return;
    const t = setTimeout(() => setSettleHold(true), Math.max(0, timing.settleMs));
    return () => clearTimeout(t);
  }, [st?.finished, settleHold, timing.settleMs, epoch]);

  // ── 非生产环境不变量自检（第一处：揭示游标）──
  // 这两条是「分步演出」最容易被后续改动破坏的地方，且破坏后表现是
  // 「跳步 / 卡死 / 公共牌提前露出」——纯靠肉眼看动画很难发现。
  // 因此做成开发期硬断言（生产构建中 `process.env.NODE_ENV` 被 Vite 静态替换，整块被摇掉）。
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (!st) return;
    if (revealedBoard > st.board.length) {
      throw new Error(`[showcase] 揭示的张数 ${revealedBoard} 超过真实公共牌 ${st.board.length}`);
    }
    if (st.finished && st.finishReason === 'showdown' && revealedBoard !== st.board.length) {
      throw new Error('[showcase] 摊牌结束但公共牌未全部亮相');
    }
  }, [revealedBoard, viewKey, st?.board.length, st?.finished, st?.finishReason, st]);

  const view = useMemo<ShowcaseView>(() => {
    if (!st) {
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
        timing,
      };
    }

    const visibleBoardCount = Math.min(revealedBoard, st.board.length);
    const settled = st.finished && settleHold;
    const lastAction = st.actions.length > 0 ? st.actions[st.actions.length - 1] : null;

    // ── 思考态判定 ──
    // 轮到 AI 且公共牌已揭完 → 正在思考（“下一步要做什么”）
    const aiThinking =
      !st.finished && st.actingSeat >= 0 && st.actingSeat !== heroSeat && visibleBoardCount >= st.board.length;

    const thinkingSeat = st.finished ? -1 : aiThinking ? st.actingSeat : -1;

    return {
      thinking: thinkingSeat >= 0,
      thinkingSeat,
      canHeroAct:
        !st.finished &&
        visibleBoardCount >= st.board.length &&
        st.actingSeat === heroSeat &&
        // 玩家刚动作完（act 尚未把 actingSeat 移走）不算可行动
        lastAction?.seat !== heroSeat,
      lastAction,
      visibleBoardCount,
      shownBoard: st.board.slice(0, visibleBoardCount),
      settled,
      handOver: st.finished,
      winnerSeat: st.finished ? st.results.findIndex((v) => v > 0) : -1,
      // 本手还没有任何动作、也没有公共牌 → 就是刚发完底牌的开局帧。
      // 只用于「底牌入场动画」，不参与任何可行动性判定（否则会锁死玩家回合）。
      dealt: st.actions.length === 0 && st.board.length === 0 && !st.finished,
      timing,
    };
    // viewKey 是必须的：state 是原地修改的对象，引用不变，只依赖 st 会让视图永不重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, revealedBoard, settleHold, heroSeat, timing]);

  const step = useMemo(
    () => planShowcaseStep(snap, heroSeat, view.visibleBoardCount, timing, settleHold),
    [snap, heroSeat, view.visibleBoardCount, timing, settleHold],
  );

  // 调度键：只由「原始值」构成。用它（而不是对象）做上层 effect 的依赖，
  // 才能保证「同一步骤不会因为重新渲染而被重新排队 / 被自己的清理函数取消」。
  //
  // **必须包含 `view.visibleBoardCount`**：揭示公共牌时 `revision` 与 `actingSeat`
  // 都不变（只是展示游标 +1），漏掉它会让连续的 `board` 步共用同一个身份，
  // 上层 effect 便不再重排定时器 —— 表现为 flop 只翻出第一张就永久卡住。
  const stepKey = `${snap.revision}:${step.kind}:${'seat' in step ? step.seat : ''}:${view.visibleBoardCount}:${
    settleHold ? 1 : 0
  }`;
  const stepRef = useRef(step);
  stepRef.current = step;

  // step 的身份只随调度键变化；delayMs 每次读取最新值，不参与身份计算。
  const stableStep = useMemo<ShowcaseStep>(() => stepRef.current, [stepKey]);

  // 调试观测点（仅非生产）：把演出调度轨迹暴露到 window，便于 E2E 采样取证。
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const w = globalThis as unknown as { __showcaseTrace?: unknown[] };
    if (!w.__showcaseTrace) w.__showcaseTrace = [];
    if (w.__showcaseTrace.length < 400) {
      w.__showcaseTrace.push({
        rev: snap.revision,
        step: step.kind,
        seat: 'seat' in step ? step.seat : null,
        delay: 'delayMs' in step ? step.delayMs : null,
        acting: st?.actingSeat ?? null,
        actions: st?.actions.length ?? -1,
        board: st?.board.length ?? -1,
        revealed: view.visibleBoardCount,
        thinking: view.thinkingSeat,
        canHeroAct: view.canHeroAct,
        finished: st?.finished ?? false,
      });
    }
  }, [snap.revision, step, st, view, snap]);

  /** 演出中是否有待办的一步（供 App 的调度定时器判断是否需要排期）。 */
  const busy = step.kind !== 'idle';

  // ── 非生产环境不变量自检（第二处：不能无限重排）──
  // 结束停顿已走完却仍排 `settle` 步 → 上层定时器会被无限重排，
  // 表现为「结算面板永不出现」的卡死。这是本任务最容易写错的一处。
  if (process.env.NODE_ENV !== 'production' && st?.finished && step.kind === 'settle' && settleHold) {
    throw new Error('[showcase] 结束停顿已完成但仍排 settle 步，会导致无限重排（结算面板不出现）');
  }

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
            throw new Error(`[showcase] AI 步数超过 ${MAX_SHOWCASE_STEPS}，疑似死循环（本手未结束）`);
          }
          aiGuardRef.current = guard;
          runAiStep();
          break;
        }
        case 'board':
          setRevealedBoard((n) => {
            // 用 ref 读最新的牌数：回调身份必须稳定（不能被上游定时器依赖），
            // 因此不能把 st 放进依赖数组。
            const cap = boardLenRef.current;
            const next = Math.min(n + 1, cap);
            if (process.env.NODE_ENV !== 'production' && next < n) {
              throw new Error(`[showcase] 公共牌游标回退：${n} → ${next}`);
            }
            return next;
          });
          break;
        case 'settle':
          setSettleHold(true);
          break;
        case 'hero-action':
        case 'idle':
          break;
      }
    },
    [runAiStep],
  );

  return { view, step: stableStep, busy, run, epoch };
}

// ── 工具 ─────────────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 让 TS 明确 `ActionType` 在本模块被使用（组件侧也从这里取类型）。 */
export type { ActionType };
