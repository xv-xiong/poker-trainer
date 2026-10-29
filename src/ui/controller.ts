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
import { appendHistory, buildRoster } from '../store/schema.js';
import { loadAll, saveState, saveHistory, type StorageLike } from '../store/persistence.js';
import type { PersistedState, Pace, RosterSeat, SessionEndKind } from '../store/schema.js';
import type {
  ActionType,
  HandRecord,
  HandState,
  ReviewEntry,
  Settings,
  Stats,
} from '../core/types.js';
import { defaultSettings, emptyStats } from '../core/types.js';

/** 一个「输光待决策」的座位。 */
export interface PendingBust {
  /** 'hero' 表示玩家本人，数字表示 roster 里的 AI 座位 id。 */
  who: 'hero' | number;
  name: string;
  /** 当前筹码（已低于一个大盲）。 */
  stack: number;
}

/** 继承模式下本局的最终结局。 */
export interface SessionEnd {
  kind: SessionEndKind;
  /** 结局发生时的累计手数（用于结算画面标题）。 */
  handsPlayed: number;
}

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
  /** 是否继承上一手筹码。 */
  carryOverStacks: boolean;
  /** 继承模式下的 AI 座位账本（含已下桌者，供半透明展示）。 */
  roster: RosterSeat[];
  /** 待玩家决定的补码队列（队首即当前弹窗）。空数组表示无需决策。 */
  pendingBusts: PendingBust[];
  /** 本局结局；null 表示仍在进行中。 */
  sessionEnd: SessionEnd | null;
  /** 节奏档位（只影响 AI 每步等待多久，不影响决策）。 */
  pace: Pace;
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

/**
 * 判定「该座位是否已输光、需要补码决策」。
 *
 * 阈值取「不足一个大盲」而非「等于 0」：筹码小于大盲时连盲注都交不起，
 * 引擎无法为它发牌，继续用「<= 0」会在 1..bigBlind-1 区间留一个卡死状态。
 */
function isBusted(stack: number, bigBlind: number): boolean {
  return stack < bigBlind;
}

/**
 * 由持久化状态推导本局结局（纯函数，便于单测）。
 *
 * 为什么结局是**派生**的而不是存一个 sessionEnd 字段：
 * 结局完全由「玩家是否已出局」「AI 是否全部下桌」决定，存两份状态就要同步两处，
 * 一旦漏同步就会出现「弹窗已选不补码但结算画面不出现」。派生则不可能不一致。
 */
export function sessionEndOf(persisted: PersistedState): SessionEnd | null {
  if (!persisted.carryOverStacks) return null;
  if (persisted.heroOut) return { kind: 'hero-bust', handsPlayed: persisted.stats.handsPlayed };
  if (persisted.roster.length > 0 && persisted.roster.every((r) => r.out)) {
    return { kind: 'victory', handsPlayed: persisted.stats.handsPlayed };
  }
  return null;
}

/**
 * 由持久化状态推导待补码队列（纯函数）。
 *
 * 顺序：玩家优先（他的决定会终止整局），随后按座位号。
 * 之所以「玩家优先」：玩家一旦选择不补码，整局立即结束，其余 AI 的补码问题
 * 已经没有意义，先问玩家可以避免让用户回答一串无效问题。
 */
export function pendingBustsOf(persisted: PersistedState): PendingBust[] {
  if (!persisted.carryOverStacks) return [];
  if (sessionEndOf(persisted)) return [];
  const bb = persisted.settings.bigBlind;
  const out: PendingBust[] = [];
  if (isBusted(persisted.bankroll, bb)) {
    out.push({ who: 'hero', name: '你', stack: persisted.bankroll });
  }
  for (const r of persisted.roster) {
    if (r.out) continue;
    if (isBusted(r.stack, bb)) out.push({ who: r.id, name: r.name, stack: r.stack });
  }
  return out;
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
  /** 已提示过的存储写入失败种类（去重，避免配额耗尽时每手刷一条提示）。 */
  private saveFailuresReported = new Set<string>();
  /** 当前这手牌实际入座的 AI 座位 id（顺序与座位号一致），用于把 results 写回账本。 */
  private currentRosterIds: number[] = [];
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
    // 自愈：资金 <= 0 只可能是损坏（继承模式下的「输光」由补码弹窗处理，不在这里重置）
    if (!this.persisted.carryOverStacks && this.persisted.bankroll <= 0) {
      this.persisted.bankroll = this.persisted.settings.startingStack;
    }
    // 继承模式下账本必须与设置一致，否则补码弹窗会漏掉座位
    if (this.persisted.carryOverStacks) this.ensureRoster();
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
      carryOverStacks: this.persisted.carryOverStacks,
      roster: this.persisted.roster,
      pendingBusts: pendingBustsOf(this.persisted),
      sessionEnd: sessionEndOf(this.persisted),
      pace: this.persisted.pace,
    };
  }

  // ---- 设置 ----

  /**
   * 存储写入失败的统一处理。
   *
   * 为什么必须显式处理：saveState / saveHistory 在配额耗尽或隐私模式受限时
   * 会 catch 后返回 false（不抛异常）。若调用方丢弃返回值，用户会以为数据已保存，
   * 实际已丢失——这与 SECURITY.md「不得静默丢数据」直接冲突。
   * 这里把失败转成 notices 提示（复用既有提示通道，无需新增 UI）。
   *
   * 用 Set 去重：配额持续耗尽时，每手结束都会失败；若每手都追加一条提示，
   * notices 会无限增长。只在「本会话首次失败」时提示一次。
   */
  private reportSaveFailure(kind: 'state' | 'history'): void {
    const key = kind === 'state' ? 'save-state' : 'save-history';
    if (this.saveFailuresReported.has(key)) return;
    this.saveFailuresReported.add(key);
    const label = kind === 'state' ? '资金与设置' : '历史记录';
    this.notices = [
      ...this.notices,
      `${label}未能写入本地存储（可能是配额已满或浏览器限制），本局数据可能不会被保存，建议先导出历史再清理`,
    ];
  }

  /** 写状态并在失败时提示（所有 saveState 调用点都应走这里）。 */
  private persistState(): void {
    if (!saveState(this.storage, this.persisted)) this.reportSaveFailure('state');
  }

  /** 写历史并在失败时提示（所有 saveHistory 调用点都应走这里）。 */
  private persistHistory(): void {
    if (!saveHistory(this.storage, this.history)) this.reportSaveFailure('history');
  }

  updateSettings(patch: Partial<Settings>): void {
    this.persisted.settings = { ...this.persisted.settings, ...patch };
    this.persistState();
    this.emit();
  }

  /**
   * 切换节奏档位（阶段二 P1-1）。
   *
   * 与 `updateSettings` 分开是因为 `pace` **不在** `Settings` 里：`Settings` 定义在
   * 冻结的 `src/core/types.ts`，不能加字段；它落在 `PersistedState`。
   *
   * 与其它设置项不同，档位**立即生效**（不用等下一手）：它只改「等多久」，
   * 不参与任何规则计算，因此不会让进行中的手牌出现「规则中途变了」的问题。
   * 这也是设置面板里唯一不挂「下一手生效」标签的项。
   */
  setPace(pace: Pace): void {
    if (this.persisted.pace === pace) return;
    this.persisted.pace = pace;
    this.persistState();
    this.emit();
  }

  /**
   * 切换「是否继承上一手筹码」。
   *
   * 切换模式等价于**换一张新桌子**：资金回到起始筹码、AI 账本重建、结局清空。
   * 这里必须同时重置 stats，否则账本恒等式（资金 = 起始 + Σ净盈亏 + Σ补码）会破，
   * 而该恒等式有单测守着（tests/unit/controller.test.ts）。
   */
  setCarryOverStacks(on: boolean): void {
    if (this.persisted.carryOverStacks === on) return;
    this.persisted.carryOverStacks = on;
    this.persisted.bankroll = this.persisted.settings.startingStack;
    this.persisted.stats = emptyStats();
    this.persisted.roster = on ? buildRoster(this.persisted.settings.seatCount - 1, this.persisted.settings.startingStack) : [];
    this.persisted.heroOut = false;
    this.persisted.nextDealerSeat = 0;
    this.state = null;
    this.lastReview = [];
    this.lastRecord = null;
    this.hint = null;
    this.notices = [
      on
        ? '已切换为「继承筹码」模式：资金与 AI 筹码在牌局间延续，输光后可选择补码'
        : '已切换为「单局练习」模式：每手重新从起始筹码开始',
    ];
    this.persistState();
    this.emit();
    this.startHand();
  }

  resetBankroll(): void {
    this.persisted.bankroll = this.persisted.settings.startingStack;
    this.persisted.stats = emptyStats();
    this.persisted.roster = this.persisted.carryOverStacks
      ? buildRoster(this.persisted.settings.seatCount - 1, this.persisted.settings.startingStack)
      : [];
    this.persisted.heroOut = false;
    this.persistState();
    this.notices = ['资金与统计已重置'];
    this.emit();
  }

  clearHistory(): void {
    this.history = [];
    this.persistHistory();
    this.emit();
  }

  dismissNotices(): void {
    this.notices = [];
    this.emit();
  }

  // ---- 继承模式：账本与补码 ----

  /**
   * 保证 AI 账本与当前桌人数一致。
   *
   * 已下桌的座位仍留在数组里（只是 out=true），所以长度只会在用户改了桌人数时
   * 才对不上。此时整桌重建——「换人数」在语义上就是换一张桌子，上一桌的筹码
   * 不该跨桌继承。
   */
  private ensureRoster(): void {
    const want = Math.max(0, this.persisted.settings.seatCount - 1);
    if (this.persisted.roster.length === want) return;
    this.persisted.roster = buildRoster(want, this.persisted.settings.startingStack);
  }

  /**
   * 回答「是否补码」。
   *
   * @param who 'hero' 或 roster 座位 id
   * @param rebuy true=补码到起始筹码；false=不补码（玩家出局 / AI 下桌）
   */
  resolveBust(who: 'hero' | number, rebuy: boolean): void {
    const s = this.persisted.settings;
    if (!this.persisted.carryOverStacks) return;
    if (who === 'hero') {
      if (!isBusted(this.persisted.bankroll, s.bigBlind)) return;
      if (rebuy) {
        const injected = s.startingStack - this.persisted.bankroll;
        this.persisted.bankroll = s.startingStack;
        // 补码是外部注入，必须单独记账，否则账本恒等式失效
        this.persisted.stats.topUps += 1;
        this.persisted.stats.topUpAmount += injected;
        this.notices = [`已补码到 ${s.startingStack}`];
      } else {
        this.persisted.heroOut = true;
        this.notices = [];
      }
    } else {
      const r = this.persisted.roster.find((x) => x.id === who);
      if (!r || r.out || !isBusted(r.stack, s.bigBlind)) return;
      if (rebuy) {
        r.stack = s.startingStack;
        this.notices = [`${r.name} 已补码到 ${s.startingStack}`];
      } else {
        r.out = true;
        this.notices = [`${r.name} 已输光下桌`];
      }
    }
    this.persistState();
    this.emit();
    // 弹窗是「开下一手」的前置闸门：所有补码问题都答完、且本局还没结束时，
    // 立刻开下一手。否则回答完会停在空桌上，用户以为卡死。
    // （`startHand()` 自己会再检查这两个前置条件，这里不必重复判断。）
    this.startHand();
  }

  /**
   * 结算画面上的「重新开始」：把资金补回起始筹码并开下一手。
   *
   * 必须走补码记账而不是直接赋值，理由同 setCarryOverStacks。
   */
  restartSession(): void {
    const s = this.persisted.settings;
    if (this.persisted.bankroll < s.startingStack) {
      const injected = s.startingStack - this.persisted.bankroll;
      this.persisted.stats.topUps += 1;
      this.persisted.stats.topUpAmount += injected;
    }
    this.persisted.bankroll = s.startingStack;
    this.persisted.roster = this.persisted.carryOverStacks
      ? buildRoster(s.seatCount - 1, s.startingStack)
      : [];
    this.persisted.heroOut = false;
    this.persisted.nextDealerSeat = 0;
    this.state = null;
    this.lastReview = [];
    this.lastRecord = null;
    this.hint = null;
    this.notices = [];
    this.persistState();
    this.emit();
    this.startHand();
  }

  // ---- 开局 ----

  /** 开始新手牌。若资金不足则补码到起始筹码，并把补码计入统计（账本可审计）。 */
  startHand(): void {
    const s = this.persisted.settings;
    // 会话已结束或还有补码问题没回答时，不允许开新手牌（由 UI 引导先处理）
    if (sessionEndOf(this.persisted)) return;
    if (pendingBustsOf(this.persisted).length > 0) return;
    if (this.persisted.carryOverStacks) {
      this.startHandCarryOver();
      return;
    }

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
    this.currentRosterIds = [];
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

  /**
   * 继承模式下的开局：用账本里的余额作为各座位起始筹码。
   *
   * 桌人数是**动态**的：AI 下桌后座位数减少，因此这里传给引擎的 settings
   * 是一份派生的副本（只改 seatCount），不写回持久化设置——否则「AI 下桌」
   * 会污染用户配置，玩家下次改桌人数时看到的是被改过的值。
   */
  private startHandCarryOver(): void {
    const s = this.persisted.settings;
    this.ensureRoster();
    const active = this.persisted.roster.filter((r) => !r.out && !isBusted(r.stack, s.bigBlind));
    const seatCount = active.length + 1;
    if (seatCount < 2) return;

    const stacks = [this.persisted.bankroll, ...active.map((r) => r.stack)];
    const names = ['你', ...active.map((r) => r.name)];
    const derived: Settings = { ...s, seatCount };

    const dealerSeat = this.persisted.nextDealerSeat % seatCount;
    this.persisted.handCounter += 1;
    const handId = `hand-${this.persisted.handCounter}`;
    const seed = (Date.now() ^ (this.persisted.handCounter * 2654435761)) >>> 0;

    this.currentRosterIds = active.map((r) => r.id);
    this.state = createHand({
      handId,
      seed,
      settings: derived,
      heroSeat: this.heroSeat,
      dealerSeat,
      stacks,
      names,
    });
    this.hint = null;
    this.lastReview = [];
    this.lastRecord = null;
    this.notices = [];
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
    this.persistState();
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
    //
    // 对手数必须取「该决策发生时」的存活人数，不能取终局存活人数。
    // 根因：buildReview 遍历的是历史动作，而本方法在整手结束后才执行；
    // 若用 st.seats[].folded（终局状态），早期决策点会漏掉「当时还在池里、
    // 后来才弃牌」的对手，对手数偏少 → 胜率被系统性高估。
    // 实测（6 人桌采样）：受影响决策点最大偏差 7.2 个百分点、平均 2.9 个百分点，
    // 且方向恒为高估，会让玩家误以为当时的决策比实际更好。
    // 修法：按动作序列重放，动作 i 发生前已弃牌者 = actions[0..i-1] 中的 fold。
    const foldsBefore = this.foldCountPrefix(st);
    const review = buildReview(st, this.heroSeat, {
      equityAt: (actionIndex, seat) => {
        const live = st.seatCount - (foldsBefore[actionIndex] ?? 0);
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
    // 继承模式：把各 AI 的净盈亏写回账本。
    // 映射依据 currentRosterIds——座位号 i+1 对应账本里的第 i 个 id，
    // 因为下桌的 AI 不在座位里，不能直接用 roster 下标。
    if (this.persisted.carryOverStacks) {
      for (let i = 0; i < this.currentRosterIds.length; i++) {
        const seat = this.persisted.roster.find((r) => r.id === this.currentRosterIds[i]);
        if (seat) seat.stack += st.results[i + 1] ?? 0;
      }
    }
    this.persisted.nextDealerSeat = (st.dealerSeat + 1) % st.seatCount;

    this.persistState();
    this.persistHistory();
  }

  /**
   * 每个决策点「发生前」的累计弃牌数（前缀和）。
   *
   * 返回数组长度 == actions.length + 1，下标 i 表示动作 i 发生前的弃牌人数：
   * 动作 i 的决策时点存活人数 = seatCount - prefix[i]。
   * 之所以用「动作前」而非「动作后」：复盘问的是「你做这个决定时，有几个对手
   * 还可能跟你打」，即该动作尚未生效时的局面。弃牌动作本身不应把自己算作已弃牌。
   *
   * 为什么需要它：本方法在整手结束后调用，而 st.seats[].folded 已是终局状态，
   * 无法还原中间时点。只有重放动作序列才能得到决策时点的真实对手数。
   */
  private foldCountPrefix(st: HandState): number[] {
    const prefix = new Array<number>(st.actions.length + 1).fill(0);
    let count = 0;
    for (let i = 0; i < st.actions.length; i++) {
      prefix[i] = count;
      if (st.actions[i].type === 'fold') count++;
    }
    prefix[st.actions.length] = count;
    return prefix;
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
