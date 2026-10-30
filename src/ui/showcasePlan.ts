/**
 * 演出编排的**纯函数层**（表现层，阶段四从 useTableShowcase.ts 拆出）。
 *
 * 这里只放「给定状态 → 该做什么」的计算：节奏常量、步进规划、公共牌游标数学、
 * 展示用标签。全部无副作用、无 React 依赖，因此可以脱离组件单测
 * （`tests/unit/showcase.test.ts` 正是这么用的）。
 *
 * 拆出来的原因：原文件 760 行，纯逻辑与 React 调度混在一起，
 * 改调度时容易误伤纯逻辑、改纯逻辑时又必须把整个 hook 读一遍。
 */

import { ACTION_LABELS, type ActionRecord, type HandState, type Street } from '../core/types.js';
import type { ControllerSnapshot } from './controller.js';

/** 供 UI 读取的动作记录（`ActionRecord` 的结构别名，避免组件直接依赖 core 类型名）。 */
export type ShowcaseAction = ActionRecord;
/** 演出节奏（毫秒）。集中一处，保证组件 CSS、E2E 断言与调度逻辑三方一致。 */
export interface ShowcaseTiming {
  /**
   * AI / 发牌的「思考」停顿基线：此期间座位高亮、显示思考气泡。
   *
   * **注意**：`ai-action` 步的实际等待时长不取本值，而是在
   * `src/ui/thinkTiming.ts` 的 `AI_THINK_RANGES[pace]` 内按
   * (seed, revision, seat) 哈希抽样（见 `aiThinkDelayMs`）。本字段在这里只剩
   * 两个作用：① 作为「是否启用等待」的开关（`0` = reduced-motion，等待归零）；
   * ② 供 `planShowcaseStep` 的纯函数单测保持一个确定的基线值。
   */
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

/**
 * 公共牌揭示游标：**带手牌作用域**的「已揭示张数」。
 *
 * 为什么必须把 `handId` 和 `n` 存在一起（而不是只存一个数字 n）：
 * 换手时若靠 `useEffect` 去 `setRevealedBoard(0)`，那只是一次**排队**的状态
 * 更新；同一个 commit 里其他 effect（尤其是 dev 不变量自检）读到的仍是旧值
 * （例如 5），而新牌局的 `board.length` 已经是 0 —— 于是误判「揭示张数超过
 * 真实公共牌」并抛错。dev 模式下没有 ErrorBoundary，错误会让整棵 React 树
 * 卸载，表现为点「下一手」后**整页白屏**。
 *
 * 改成「游标自带作用域 + 渲染期按 handId 派生」后，换手的**同一帧**里可见
 * 张数立刻就是 0，不存在新旧值混用的窗口；`n` 只是一个「本手内的进度」，
 * 跨手时天然失效。
 */
export interface BoardCursor {
  /** 游标所属的手牌 id；`null` 表示还没有任何牌局。 */
  handId: string | null;
  /** 本手已揭示的张数（可能暂时超过真实张数，派生时会被 clamp）。 */
  n: number;
}

/**
 * 由游标派生「当前这一手可见的公共牌张数」。
 *
 * 三条规则：
 *   - `cursor.handId !== handId`（换手 / 还没有牌局）→ 0，旧游标一律失效；
 *   - 同一手内 `n` 可能因牌局回退而大于真实张数 → clamp 到 `boardLen`；
 *   - 负数（理论上不会出现）也归零，保证返回值永远合法。
 *
 * 纯函数、无副作用，渲染期直接调用即可 —— 这正是「派生量」相对「state + 重置
 * effect」的关键优势：不存在「重置还没生效」的中间帧。
 */
export function visibleBoardCountOf(
  cursor: BoardCursor,
  handId: string | null,
  boardLen: number,
): number {
  if (cursor.handId !== handId) return 0;
  return Math.max(0, Math.min(cursor.n, boardLen));
}

/**
 * 把游标推进一张（不越过真实张数）；跨手时从 0 重新开始。
 *
 * 用于 `run('board')`：`setBoardCursor((prev) => advanceBoardCursor(prev, 当前手, 真实张数))`。
 * 因为结果恒为 `min(当前可见 + 1, boardLen)`，所以**单调不减**，不会出现
 * 「游标回退」——旧实现里那条 throw 因此不再需要。
 */
export function advanceBoardCursor(
  cursor: BoardCursor,
  handId: string | null,
  boardLen: number,
): BoardCursor {
  const current = visibleBoardCountOf(cursor, handId, boardLen);
  return { handId, n: Math.min(current + 1, boardLen) };
}

/**
 * 把游标收敛到合法值；已经合法时**原样返回**（引用不变，避免多余重渲染）。
 *
 * 供 dev 不变量自检做「自愈」：发现游标越界时用 console.error 记录并 clamp，
 * 而不是 throw —— dev 断言的目的应是「让问题可见」，不是「让应用崩溃」。
 */
export function clampBoardCursor(
  cursor: BoardCursor,
  handId: string | null,
  boardLen: number,
): BoardCursor {
  const n = visibleBoardCountOf(cursor, handId, boardLen);
  return cursor.handId === handId && cursor.n === n ? cursor : { handId, n };
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

/**
 * `signatureOf` 只需要视图的这几个字段。这里用结构化的最小接口而不是
 * 直接引用 `ShowcaseView`：后者定义在组合层 `useTableShowcase.ts` 里，
 * 引用它会形成「纯函数层 ←→ 组合层」的类型环。`ShowcaseView` 结构上满足本接口，
 * 所以调用方照旧传整个 view 即可。
 */
export interface SignatureSource {
  thinking: boolean;
  thinkingSeat: number;
  lastAction: ShowcaseAction | null;
  visibleBoardCount: number;
  handOver: boolean;
  settled: boolean;
}

export function signatureOf(view: SignatureSource): ShowcaseSignature {
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

// ── 对外类型与派生函数（阶段四从 useTableShowcase.ts 搬来）───────────
// 放在纯函数层的好处：这些类型与派生规则可以脱离 React 阅读和断言，
// 组合层只负责「什么时候重算」。

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

/**
 * 调度键：只由「原始值」构成。用它（而不是对象）做上层 effect 的依赖，
 * 才能保证「同一步骤不会因为重新渲染而被重新排队 / 被自己的清理函数取消」。
 *
 * **必须包含可见公共牌张数**：揭示公共牌时 `revision` 与 `actingSeat`
 * 都不变（只是展示游标 +1），漏掉它会让连续的 `board` 步共用同一个身份，
 * 上层 effect 便不再重排定时器 —— 表现为 flop 只翻出第一张就永久卡住。
 */
export function showcaseStepKey(
  revision: number,
  step: ShowcaseStep,
  visibleBoardCount: number,
  settleHold: boolean,
): string {
  return `${revision}:${step.kind}:${'seat' in step ? step.seat : ''}:${visibleBoardCount}:${
    settleHold ? 1 : 0
  }`;
}

export interface DeriveViewInput {
  state: HandState | null;
  heroSeat: number;
  visibleBoardCount: number;
  settleHold: boolean;
  timing: ShowcaseTiming;
}

/** 由「状态 + 演出游标」派生展示视图。纯函数，无副作用。 */
export function deriveShowcaseView(input: DeriveViewInput): ShowcaseView {
  const { state: st, heroSeat, visibleBoardCount, settleHold, timing } = input;

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

  // 可见张数由调用方按 handId 作用域化 + clamp 后传入，这里不再自己算，
  // 避免两处口径不一致。
  const settled = st.finished && settleHold;
  const lastAction = st.actions.length > 0 ? st.actions[st.actions.length - 1] : null;
  /**
   * 玩家在**当前这一街**是否已经动作过。
   *
   * 判据必须是「同一条街」，不能只看「末条动作是不是玩家」——否则会死锁：
   * 玩家动作恰好关闭了这一街（例如他是本街最后一个行动的人），下一街发完牌
   * 又轮到玩家先行动时，`actingSeat === heroSeat` 成立，但末条动作仍是玩家
   * 上一街的那一手，于是 `canHeroAct` 永远为 false。此时 `planShowcaseStep`
   * 返回的 `hero-action` 步在 `run()` 里不改变任何状态，定时器不会重新装载，
   * 界面就永久停在「你的行动 / 动作确认中…」且按钮全灰。
   *
   * 这个死锁是 2026-10-30 用 G11 dev 冒烟（连打 15 手）抓到的，现场 trace：
   * `{step:"hero-action", acting:0, actions:21, board:5, revealed:5,
   *   canHeroAct:false, finished:false}`。当时误判成「环境抖动」，实际是
   * 每手约 5% 概率会撞上的真 bug。
   */
  const heroActedThisStreet = lastAction !== null && lastAction.seat === heroSeat && lastAction.street === st.street;

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
      // 玩家本街刚动作完（气泡还没看完）不算可行动；跨街则必须放行，
      // 否则「玩家关闭一街 + 下一街先行动」会永久冻结（见上面的注释）。
      !heroActedThisStreet,
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
}
