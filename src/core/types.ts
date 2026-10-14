/**
 * 领域类型定义：座位、动作、街、对局状态、历史记录。
 */

import type { Card } from './cards.js';

/** 下注街。 */
export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export const STREET_ORDER: Street[] = ['preflop', 'flop', 'turn', 'river'];

export const STREET_LABELS: Record<Street, { zh: string; en: string }> = {
  preflop: { zh: '翻牌前', en: 'Pre-flop' },
  flop: { zh: '翻牌', en: 'Flop' },
  turn: { zh: '转牌', en: 'Turn' },
  river: { zh: '河牌', en: 'River' },
};

/** 动作类型。 */
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export const ACTION_LABELS: Record<ActionType, { zh: string; en: string }> = {
  fold: { zh: '弃牌', en: 'Fold' },
  check: { zh: '过牌', en: 'Check' },
  call: { zh: '跟注', en: 'Call' },
  bet: { zh: '下注', en: 'Bet' },
  raise: { zh: '加注', en: 'Raise' },
  allin: { zh: '全下', en: 'All-in' },
};

/** 一个座位的状态。 */
export interface Seat {
  readonly index: number;
  /** 本手开始时的筹码。 */
  stack: number;
  /** 本手累计投入（含盲注），用于构建边池。 */
  committed: number;
  /** 本街投入。 */
  committedThisStreet: number;
  folded: boolean;
  allIn: boolean;
  /** 底牌；对手的牌在摊牌前对玩家不可见（由 UI 控制展示）。 */
  holeCards: Card[];
  /** 本街是否已行动过（用于判断轮次是否结束）。 */
  hasActedThisStreet: boolean;
  /** 是否是 AI（false 表示玩家本人）。 */
  isAI: boolean;
  /** AI 难度档位。 */
  tier: AITier;
  /** 座位名。 */
  name: string;
}

export type AITier = 'easy' | 'medium' | 'hard';

export const AI_TIER_LABELS: Record<AITier, { zh: string; en: string }> = {
  easy: { zh: '简单', en: 'Easy' },
  medium: { zh: '中等', en: 'Medium' },
  hard: { zh: '困难', en: 'Hard' },
};

/** 一次动作记录。 */
export interface ActionRecord {
  readonly seat: number;
  readonly street: Street;
  readonly type: ActionType;
  /** 本动作实际额外投入的筹码额。 */
  readonly amount: number;
  /** 动作后该座位本街的投入额。 */
  readonly toAmount: number;
  /** 决策耗时（毫秒）；AI 动作为 0。 */
  readonly thinkMs: number;
  /** 动作发生时的底池总额（含本街已投入）。 */
  readonly potAtAction: number;
  /** 动作时还需跟注的额度。 */
  readonly toCall: number;
  /**
   * 动作发生时该座位的剩余筹码。
   *
   * 为什么必须记录：复盘是在**整手结束后**才计算的，此时 seats[].stack 已是
   * 终局筹码（可能为 0）。若复盘用终局筹码去推算「建议加注额」，会得出
   * 明显偏小甚至为 0 的建议（例如全下输光后建议「加注 20」）。
   * 该缺陷由交付前检查线上复盘输出发现，因此把决策时点的筹码固化进记录。
   */
  readonly stackAtAction: number;
}

/**
 * 一层底池的性质（结算口径标注）。
 *
 * 为什么需要区分：真实牌桌上「唯一最高投入者超出次高投入的那部分」并不参与胜负比较，
 * 而是原样退还（uncalled bet returned，未被跟注的退还）。参考站结算面板把同一笔钱
 * 拆成「主池」与「未跟注退还」两行显示；本字段让 core 层能给出同口径的数据，
 * 而不改动金额计算（金额本就正确，见 pot.ts 的层金额公式）。
 */
export type PotLayerKind =
  /** 被至少两名投入者争夺：该层由牌型决定归属。 */
  | 'contested'
  /** 仅一名投入者：该层即未被跟注的退还，必然原样回到该投入者手中。 */
  | 'uncalled';

/** 一个边池层。 */
export interface PotLayer {
  /** 该层总筹码。 */
  readonly amount: number;
  /** 有资格争夺该层的座位索引。 */
  readonly eligible: number[];
  /**
   * 参与该层投入的座位索引（含已弃牌者，升序）。
   *
   * 可选：v1 持久化记录（localStorage 中的历史）没有此字段，读取旧记录时必须容忍。
   * 新增此字段是纯增量，不改变任何金额，因此不递增 schemaVersion。
   */
  readonly contributors?: number[];
  /** 该层性质；同样为可选，以兼容 v1 旧记录。 */
  readonly kind?: PotLayerKind;
}

/** 单手对局状态。 */
export interface HandState {
  readonly handId: string;
  readonly seed: number;
  readonly seatCount: number;
  readonly dealerSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly initialStacks: number[];
  readonly seats: Seat[];
  readonly board: Card[];
  readonly deck: Card[];
  /** 牌堆中已发出的张数（索引）。 */
  deckIndex: number;
  street: Street;
  /** 当前行动座位；-1 表示本手已结束。 */
  actingSeat: number;
  /** 本街最高投入额。 */
  currentBet: number;
  /** 上一次加注的增量（用于计算最小加注）。 */
  lastRaiseSize: number;
  actions: ActionRecord[];
  /** 本手是否已结束。 */
  finished: boolean;
  /** 结束原因。 */
  finishReason: 'showdown' | 'fold' | 'none';
  /** 结算结果：各座位净盈亏。 */
  results: number[];
  /** 摊牌时各座位的牌型打包值（仅参与摊牌的座位）。 */
  showdownValues: Record<number, number>;
  /** 底池分层（结算时填充）。 */
  pots: PotLayer[];
  /** 玩家本次查看提示的次数。 */
  hintsUsed: number;
}

/** 一次决策的复盘条目。 */
export interface ReviewEntry {
  readonly seat: number;
  readonly street: Street;
  readonly actionIndex: number;
  readonly actual: ActionType;
  readonly actualAmount: number;
  readonly bestAction: ActionType;
  readonly bestAmount: number;
  /** 实际动作的 EV。 */
  readonly actualEv: number;
  /** 最优动作的 EV。 */
  readonly bestEv: number;
  /** EV 损失 = bestEv - actualEv。 */
  readonly evLoss: number;
  /** 分级：ok / review（值得复盘）/ major（明显偏离）。 */
  readonly grade: 'ok' | 'review' | 'major';
  /** 决策时底池额。 */
  readonly pot: number;
  /** 决策时需跟注额。 */
  readonly toCall: number;
  /** 底池赔率（toCall / (pot + toCall)）。 */
  readonly potOdds: number;
  /** 估算胜率。 */
  readonly equity: number;
  readonly thinkMs: number;
}

/** 单手历史记录（持久化单元）。 */
export interface HandRecord {
  readonly handId: string;
  readonly seed: number;
  readonly timestamp: number;
  readonly seatCount: number;
  readonly heroSeat: number;
  readonly dealerSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly initialStacks: number[];
  readonly holeCards: Card[][];
  readonly board: Card[];
  readonly actions: ActionRecord[];
  readonly pots: PotLayer[];
  readonly results: number[];
  readonly heroNet: number;
  readonly review: ReviewEntry[];
  readonly hintsUsed: number;
}

/** 累计统计。 */
export interface Stats {
  handsPlayed: number;
  handsWon: number;
  showdownsSeen: number;
  showdownsWon: number;
  totalWagered: number;
  netProfit: number;
  /** 玩家入池手数（VPIP 分子）。 */
  vpipHands: number;
  /** 玩家翻牌前加注手数（PFR 分子）。 */
  pfrHands: number;
  hintsUsed: number;
  /** 各分级决策计数。 */
  reviewCounts: { ok: number; review: number; major: number };
  /**
   * 自动补码次数。
   *
   * 为什么必须单独计数：补码是外部注入筹码，不属于牌局输赢。
   * 若不计入，账本恒等式「资金 = 起始 + Σ 各手净盈亏」会在补码后失效，
   * 表现为资金无故多出一笔（该缺陷由 tests/unit/controller.test.ts 捕获）。
   */
  topUps: number;
  /** 累计补码注入的筹码总额。 */
  topUpAmount: number;
}

export function emptyStats(): Stats {
  return {
    handsPlayed: 0,
    handsWon: 0,
    showdownsSeen: 0,
    showdownsWon: 0,
    totalWagered: 0,
    netProfit: 0,
    vpipHands: 0,
    pfrHands: 0,
    hintsUsed: 0,
    reviewCounts: { ok: 0, review: 0, major: 0 },
    topUps: 0,
    topUpAmount: 0,
  };
}

/** 设置。 */
export interface Settings {
  seatCount: number;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  aiTier: AITier;
  /** 四色牌（true）或传统两色（false）。 */
  fourColorDeck: boolean;
  /** 是否显示快捷键提示。 */
  showShortcuts: boolean;
  /** 是否启用翻牌单挑精确枚举（约 1.8 秒，默认关闭）。 */
  enableFlopExact: boolean;
}

export function defaultSettings(): Settings {
  return {
    seatCount: 6,
    startingStack: 1000,
    smallBlind: 5,
    bigBlind: 10,
    aiTier: 'medium',
    fourColorDeck: true,
    showShortcuts: true,
    enableFlopExact: false,
  };
}
