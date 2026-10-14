/**
 * 对局控制器：把引擎、AI、复盘、持久化粘合起来，供 React 层调用。
 *
 * 本模块不含 JSX，是纯 TypeScript 状态机，便于单测。
 * React 层通过 subscribe 订阅状态变化。
 */

import { applyAction, createHand, heroVoluntarilyEntered, heroPreflopRaised, heroSawShowdown, heroWon } from '../core/hand.js';
import { legalActions, type LegalActions } from '../core/betting.js';
import { decideAI } from '../ai/policy.js';
import { buildReview } from '../review/ev.js';
import { computeEquity, potOdds, AI_ITERATIONS } from '../core/equity/index.js';
import { createRng } from '../core/rng.js';
import { appendHistory } from '../store/schema.js';
import { loadAll, saveState, saveHistory, type StorageLike } from '../store/persistence.js';
import type { PersistedState } from '../store/schema.js';
import type {
  ActionType,
  HandRecord,
  HandState,
  ReviewEntry,
  Settings,
  Stats,
} from '../core/types.js';
import { defaultSettings, emptyStats } from '../core/types.js';

export interface ControllerSnapshot {
  state: HandState | null;
  /**
   * 单调递增的修订号，每次 emit 递增。
   *
   * 为什么需要它：`applyAction` 是**原地修改** HandState（为性能避免每步深拷贝），
   * 因此 React 的 useEffect 若以 `snap.state` 为依赖，引用不变会导致副作用不再触发，
   * 表现为「玩家行动后 AI 永远不行动」。修订号给 React 一个可靠的变化信号。
   */
  revision: number;
  legal: LegalActions | null;
  /** 是否轮到玩家本人行动。 */
  heroTurn: boolean;
  bankroll: number;
  settings: Settings;
  stats: Stats;
  history: HandRecord[];
  /** 上一手的复盘结果。 */
  lastReview: ReviewEntry[];
  /** 上一手记录。 */
  lastRecord: HandRecord | null;
  /** 提示（玩家主动查看）。 */
  hint: { equity: number; potOdds: number; source: string; action: string } | null;
  /** 界面提示消息（如数据迁移通知）。 */
  notices: string[];
  /** AI 是否正在思考。 */
  aiThinking: boolean;
}

type Listener = (s: ControllerSnapshot) => void;

/** 胜率计算客户端接口（可注入：浏览器传 Web Worker 客户端，测试传同步实现）。 */
export interface EquityClientLike {
  request(req: import('../core/equity/index.js').EquityRequest): Promise<import('../core/equity/index.js').EquityResponse>;
  readonly usingWorker: boolean;
}

export interface ControllerOptions {
  storage: StorageLike;
  heroSeat?: number;
  /** 胜率计算客户端；不传则退化为同步计算（主线程）。 */
  equityClient?: EquityClientLike;
}

export class GameController {
  private state: HandState | null = null;
  private persisted: PersistedState;
  private history: HandRecord[] = [];
  private lastReview: ReviewEntry[] = [];
  private lastRecord: HandRecord | null = null;
  private hint: ControllerSnapshot['hint'] = null;
  private notices: string[] = [];
  private aiThinking = false;
  private listeners = new Set<Listener>();
  private revision = 0;
  private readonly storage: StorageLike;
  private readonly equityClient: EquityClientLike | null;
  readonly heroSeat: number;

  constructor(opts: ControllerOptions) {
    this.storage = opts.storage;
    this.heroSeat = opts.heroSeat ?? 0;
    this.equityClient = opts.equityClient ?? null;
    const loaded = loadAll(this.storage);
    this.persisted = loaded.state;
    this.history = loaded.history;
    this.notices = loaded.notices;
    // 同步起始筹码与设置
    if (this.persisted.bankroll <= 0) {
      this.persisted.bankroll = this.persisted.settings.startingStack;
    }
  }

  // ---- 订阅 ----

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    this.revision++;
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }

  snapshot(): ControllerSnapshot {
    return {
      state: this.state,
      revision: this.revision,
      legal: this.state && this.state.actingSeat >= 0 ? legalActions(this.state, this.state.actingSeat) : null,
      heroTurn: Boolean(this.state && !this.state.finished && this.state.actingSeat === this.heroSeat),
      bankroll: this.persisted.bankroll,
      settings: this.persisted.settings,
      stats: this.persisted.stats,
      history: this.history,
      lastReview: this.lastReview,
      lastRecord: this.lastRecord,
      hint: this.hint,
      notices: this.notices,
      aiThinking: this.aiThinking,
    };
  }

  // ---- 设置 ----

  updateSettings(patch: Partial<Settings>): void {
    this.persisted.settings = { ...this.persisted.settings, ...patch };
    saveState(this.storage, this.persisted);
    this.emit();
  }

  resetBankroll(): void {
    this.persisted.bankroll = this.persisted.settings.startingStack;
    this.persisted.stats = emptyStats();
    saveState(this.storage, this.persisted);
    this.notices = ['资金与统计已重置'];
    this.emit();
  }

  clearHistory(): void {
    this.history = [];
    saveHistory(this.storage, this.history);
    this.emit();
  }

  dismissNotices(): void {
    this.notices = [];
    this.emit();
  }

  // ---- 开局 ----

  /** 开始新手牌。若资金不足则补码到起始筹码，并把补码计入统计（账本可审计）。 */
  startHand(): void {
    const s = this.persisted.settings;
    // 注意：notices 必须在函数末尾统一赋值，不能先写后被 this.notices = [] 覆盖
    let notice: string | null = null;
    if (this.persisted.bankroll < s.bigBlind) {
      const injected = s.startingStack - this.persisted.bankroll;
      this.persisted.bankroll = s.startingStack;
      // 补码是外部注入，必须单独记账，否则账本恒等式失效
      this.persisted.stats.topUps += 1;
      this.persisted.stats.topUpAmount += injected;
      notice = `资金不足，已补码到 ${s.startingStack}（补码 ${injected}）`;
    }

    // 各座位起始筹码统一为 settings.startingStack；
    // 玩家本人也按起始筹码开局，使「单手盈亏」口径与其他人一致，
    // 资金则通过 bankroll 独立累计（bankroll = 起始 + Σ 各手净盈亏 + Σ 补码）。
    const stacks = new Array(s.seatCount).fill(s.startingStack);

    const dealerSeat = this.persisted.nextDealerSeat % s.seatCount;
    this.persisted.handCounter += 1;
    const handId = `hand-${this.persisted.handCounter}`;
    const seed = (Date.now() ^ (this.persisted.handCounter * 2654435761)) >>> 0;

    const names = ['你', 'AI-1', 'AI-2', 'AI-3', 'AI-4', 'AI-5', 'AI-6', 'AI-7', 'AI-8'];
    this.state = createHand({
      handId,
      seed,
      settings: s,
      heroSeat: this.heroSeat,
      dealerSeat,
      stacks,
      names: names.map((n, i) => (i === this.heroSeat ? '你' : `${n}`)),
    });
    this.hint = null;
    this.lastReview = [];
    this.lastRecord = null;
    this.notices = notice ? [notice] : [];
    this.emit();
  }

  // ---- 玩家动作 ----

  /** 玩家本人执行动作。 */
  act(type: ActionType, toAmount = 0, thinkMs = 0): { ok: boolean; error?: string } {
    if (!this.state || this.state.finished) return { ok: false, error: '本手已结束' };
    if (this.state.actingSeat !== this.heroSeat) return { ok: false, error: '当前不是你的行动' };
    const r = applyAction(this.state, type, toAmount, thinkMs);
    if (r.ok) {
      this.hint = null;
      if (this.state.finished) this.finalizeHand();
    }
    this.emit();
    return r;
  }

  /**
   * 请求提示（计入统计）。
   *
   * 计算路径：优先走 Web Worker（浏览器后台线程），避免阻塞渲染；
   * 无 Worker 时退化为同步计算。两条路径返回同源结果。
   */
  async requestHint(): Promise<void> {
    if (!this.state || this.state.finished || this.state.actingSeat !== this.heroSeat) return;
    const st = this.state;
    const seat = st.seats[this.heroSeat];
    const live = st.seats.filter((x) => !x.folded).length;
    const opponents = Math.max(1, live - 1);
    const legal = legalActions(st, this.heroSeat);
    const pot = st.seats.reduce((a, x) => a + x.committed, 0);

    const req = {
      hero: [...seat.holeCards],
      board: [...st.board],
      opponents,
      iterations: 20_000,
      allowFlopExact:
        st.board.length === 3 && opponents === 1 && this.persisted.settings.enableFlopExact,
      rng: createRng(st.seed ^ 0x1234),
    };

    let r: import('../core/equity/index.js').EquityResponse;
    if (this.equityClient) {
      try {
        r = await this.equityClient.request(req);
      } catch {
        // Worker 失败时降级为同步计算，保证功能可用
        r = computeEquity(req);
      }
    } else {
      r = computeEquity(req);
    }

    const po = potOdds(legal.callAmount, pot);
    let action: string;
    if (legal.canCheck) action = '过牌或下注';
    else if (r.equity >= po) action = '跟注或加注（胜率高于底池赔率要求）';
    else action = '建议弃牌（胜率低于底池赔率要求）';

    this.hint = { equity: r.equity, potOdds: po, source: r.source, action };
    st.hintsUsed += 1;
    this.persisted.stats.hintsUsed += 1;
    saveState(this.storage, this.persisted);
    this.emit();
  }

  /**
   * AI 连续行动直到轮到玩家或本手结束。
   *
   * 关键：必须 emit 让 React 重渲染（state 是原地修改，引用不变）。
   * 返回本手是否已结束，便于调用方决定是否立即进入下一手。
   */
  runAI(): boolean {
    if (!this.state) return false;
    if (this.state.finished) {
      this.emit();
      return true;
    }
    this.aiThinking = true;
    this.emit();

    let guard = 0;
    while (this.state && !this.state.finished && this.state.actingSeat >= 0 && guard++ < 500) {
      const seat = this.state.actingSeat;
      if (seat === this.heroSeat) break;
      const decision = decideAI(
        this.state,
        seat,
        createRng(this.state.seed ^ (seat * 7919) ^ (guard * 104729)),
      );
      const r = applyAction(this.state, decision.type, decision.toAmount, 0);
      if (!r.ok) {
        // 兜底，避免卡死
        const legal = legalActions(this.state, seat);
        if (legal.canCheck) applyAction(this.state, 'check', 0);
        else if (legal.canCall) applyAction(this.state, 'call', 0);
        else applyAction(this.state, 'fold', 0);
      }
    }

    this.aiThinking = false;
    const finished = Boolean(this.state?.finished);
    if (finished) this.finalizeHand();
    this.emit();
    return finished;
  }

  /**
   * 分步演出的收尾钩子：在一次「单步」AI 动作之后同步对外状态。
   *
   * 为什么需要它：`runAI()` 的 while 循环里除了推进 AI，还夹着两件必须发生的事——
   * 每轮 `emit()` 通知订阅者，以及本手结束时调 `finalizeHand()`（复盘 / 落库 / 统计 / 推进庄家）。
   * 改成「一次只推一名 AI」的分步演出后，这两件事就没人做了：
   * 不 emit 则界面不动，不 finalize 则这一手不落库、统计不更新。
   *
   * 本方法**只做这两件事**，不推进任何 AI、不修改任何对局数据，
   * 因此不会影响金额与结算结果（符合「动画不得影响结算准确性」约束）。
   */
  settleAfterAiStep(): void {
    if (this.state?.finished) this.finalizeHand();
    this.emit();
  }

  /** 一手结束后的收尾：复盘、落库、更新统计、推进庄家。 */
  private finalizeHand(): void {
    const st = this.state;
    if (!st || !st.finished) return;

    // 复盘：逐决策点计算 EV 偏离
    const review = buildReview(st, this.heroSeat, {
      equityAt: (actionIndex, seat) => {
        const live = st.seats.filter((x) => !x.folded).length;
        const opponents = Math.max(1, live - 1);
        const boardAtAction = this.boardAtAction(st, actionIndex);
        try {
          const r = computeEquity({
            hero: st.seats[seat].holeCards,
            board: boardAtAction,
            opponents,
            iterations: AI_ITERATIONS,
            rng: createRng(st.seed ^ actionIndex ^ 0x777),
          });
          return r.equity;
        } catch {
          return 0.5;
        }
      },
    });
    this.lastReview = review;

    const heroNet = st.results[this.heroSeat] ?? 0;
    const record: HandRecord = {
      handId: st.handId,
      seed: st.seed,
      timestamp: Date.now(),
      seatCount: st.seatCount,
      heroSeat: this.heroSeat,
      dealerSeat: st.dealerSeat,
      smallBlind: st.smallBlind,
      bigBlind: st.bigBlind,
      initialStacks: [...st.initialStacks],
      holeCards: st.seats.map((s) => [...s.holeCards]),
      board: [...st.board],
      actions: [...st.actions],
      pots: [...st.pots],
      results: [...st.results],
      heroNet,
      review,
      hintsUsed: st.hintsUsed,
    };
    this.lastRecord = record;
    this.history = appendHistory(this.history, record);

    // 更新统计
    const stats = this.persisted.stats;
    stats.handsPlayed += 1;
    stats.netProfit += heroNet;
    stats.totalWagered += st.seats[this.heroSeat].committed;
    if (heroWon(st, this.heroSeat)) stats.handsWon += 1;
    if (heroSawShowdown(st, this.heroSeat)) {
      stats.showdownsSeen += 1;
      if (heroWon(st, this.heroSeat)) stats.showdownsWon += 1;
    }
    if (heroVoluntarilyEntered(st, this.heroSeat)) stats.vpipHands += 1;
    if (heroPreflopRaised(st, this.heroSeat)) stats.pfrHands += 1;
    for (const e of review) stats.reviewCounts[e.grade] += 1;

    this.persisted.bankroll += heroNet;
    this.persisted.nextDealerSeat = (st.dealerSeat + 1) % st.seatCount;

    saveState(this.storage, this.persisted);
    saveHistory(this.storage, this.history);
  }

  /** 取某决策点发生时的公共牌（从动作记录反推：按街切分）。 */
  private boardAtAction(st: HandState, actionIndex: number): number[] {
    const action = st.actions[actionIndex];
    if (!action) return [];
    switch (action.street) {
      case 'preflop':
        return [];
      case 'flop':
        return st.board.slice(0, 3);
      case 'turn':
        return st.board.slice(0, 4);
      case 'river':
        return st.board.slice(0, 5);
    }
  }

  /** 当前手牌状态（供渲染）。 */
  currentState(): HandState | null {
    return this.state;
  }

  persistedState(): PersistedState {
    return this.persisted;
  }
}

export function createController(storage: StorageLike, equityClient?: EquityClientLike): GameController {
  return new GameController({ storage, equityClient });
}

export { defaultSettings };
