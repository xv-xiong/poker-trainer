/**
 * 会话级总结与建议（纯函数，无 DOM、无存储）。
 *
 * 用途有二：
 *   1. 继承模式的两种结局画面（玩家出局 / 赢下整桌）——统计决策质量并给建议/鼓励；
 *   2. 单局练习模式下一手结束后的即时点评。
 *
 * 为什么单独成模块：这些判断只依赖 `Stats` + 历史记录 + 盲注，全是可枚举的
 * 数值关系，做成纯函数就能用单测固定住「什么数据该说什么话」，
 * 而不用在 JSX 里堆条件分支。
 */

import type { ActionType, HandRecord, ReviewEntry, Stats, Street } from '../core/types.js';
import type { SessionEndKind } from '../store/schema.js';

const STREET_LABEL: Record<Street, string> = {
  preflop: '翻前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
};

const ACTION_LABEL: Record<ActionType, string> = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  bet: '下注',
  raise: '加注',
  allin: '全下',
};

const BEST_LABEL: Record<ActionType, string> = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  bet: '下注',
  raise: '加注',
  allin: '全下',
};

/** 一个「打得很亏」的决策点。 */
export interface WorstDecision {
  street: Street;
  streetLabel: string;
  actual: ActionType;
  actualLabel: string;
  bestLabel: string;
  evLossBB: number;
}

/** 会话总结。 */
export interface SessionSummary {
  handsPlayed: number;
  netProfit: number;
  netBB: number;
  /** 入池率（0..1）。 */
  vpip: number;
  /** 翻前加注率（0..1）。 */
  pfr: number;
  /** 主动入池中「加注」的占比（0..1）；0 表示样本不足。 */
  aggression: number;
  grades: { ok: number; review: number; major: number };
  decisions: number;
  /** 「正常」决策占比（0..1）；无决策时为 1。 */
  okRatio: number;
  worst: WorstDecision[];
  /** 针对性的改进建议（最多 4 条）。 */
  advice: string[];
  /** 标题。 */
  headline: string;
  /** 结语（鼓励或总结）。 */
  closing: string;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function toWorst(e: ReviewEntry, bigBlind: number): WorstDecision {
  return {
    street: e.street,
    streetLabel: STREET_LABEL[e.street],
    actual: e.actual,
    actualLabel: ACTION_LABEL[e.actual],
    bestLabel: BEST_LABEL[e.bestAction],
    evLossBB: e.evLoss / bigBlind,
  };
}

/** 从历史里挑出 EV 损失最大的若干个决策点。 */
export function worstDecisions(history: HandRecord[], bigBlind: number, limit = 3): WorstDecision[] {
  const all: ReviewEntry[] = [];
  for (const rec of history) {
    for (const e of rec.review) all.push(e);
  }
  all.sort((a, b) => b.evLoss - a.evLoss);
  return all.slice(0, limit).map((e) => toWorst(e, bigBlind));
}

/**
 * 生成会话总结。
 *
 * 建议规则按「先影响最大、再补充」排序，最多 4 条，避免用户面对一屏文字。
 * 每条建议都带具体数字，否则「多弃牌」这类空话没有可操作性。
 */
export function buildSessionSummary(input: {
  stats: Stats;
  history: HandRecord[];
  bigBlind: number;
  kind: SessionEndKind;
}): SessionSummary {
  const { stats, history, bigBlind, kind } = input;
  const hands = stats.handsPlayed;
  const safeHands = Math.max(1, hands);
  const vpip = stats.vpipHands / safeHands;
  const pfr = stats.pfrHands / safeHands;
  const aggression = stats.vpipHands > 0 ? stats.pfrHands / stats.vpipHands : 0;
  const decisions = stats.reviewCounts.ok + stats.reviewCounts.review + stats.reviewCounts.major;
  const okRatio = decisions > 0 ? stats.reviewCounts.ok / decisions : 1;

  const advice: string[] = [];

  // 1) 入池宽度：6 人桌的经验区间约 20%–30%
  if (hands >= 10) {
    if (vpip > 0.45) {
      advice.push(
        `入池偏宽：你打了 ${pct(vpip)} 的手牌，明显高于 20%–30% 的常规区间。` +
          `放宽入池会让翻后经常处在弱踢脚、被压制的局面，建议先收紧到 25% 左右。`,
      );
    } else if (vpip < 0.15) {
      advice.push(
        `入池偏紧：你只打了 ${pct(vpip)} 的手牌，可能放掉了不少有价值的手牌。` +
          `在没人入池的后位可以适当放宽，否则长期会被盲注与底注磨掉筹码。`,
      );
    }
  }

  // 2) 翻前主动性：入池里加注的比例
  if (stats.vpipHands >= 10 && aggression < 0.4) {
    advice.push(
      `翻前过于被动：主动入池的 ${pct(1 - aggression)} 是跟注而非加注。` +
        `跟注进入底池会失去主动权、且难以在翻后诈唬，建议把可玩手牌里较强的一部分改成加注。`,
    );
  }

  // 3) 决策质量：明显偏离的占比
  if (decisions >= 10 && stats.reviewCounts.major / decisions > 0.15) {
    advice.push(
      `明显偏离的决策占 ${pct(stats.reviewCounts.major / decisions)}（${stats.reviewCounts.major}/${decisions}），` +
        `建议先复盘「EV 损失」最大的几个决策点，它们对结果的伤害远大于小偏差。`,
    );
  }

  // 4) 摊牌质量：看是不是跟注过宽
  if (stats.showdownsSeen >= 8 && stats.showdownsWon / stats.showdownsSeen < 0.4) {
    advice.push(
      `摊牌胜率偏低（${stats.showdownsWon}/${stats.showdownsSeen}）：这通常是跟注过宽或河牌跟注太松的信号，` +
        `河牌面对大额下注时可以先问「他能被什么更差的手牌价值下注」。`,
    );
  }

  // 5) 提示依赖
  if (hands >= 10 && stats.hintsUsed / safeHands > 0.5) {
    advice.push(
      `提示使用较频繁（平均每 ${(safeHands / Math.max(1, stats.hintsUsed)).toFixed(1)} 手用一次）。` +
        `试着先自己给出判断再对照提示，练习效果会更好。`,
    );
  }

  const netBB = stats.netProfit / bigBlind;
  const headline =
    kind === 'victory'
      ? `你赢下了整桌！`
      : `本局结束：筹码输光`;

  let closing: string;
  if (kind === 'victory') {
    closing =
      `共 ${hands} 手，净盈亏 ${netBB >= 0 ? '+' : ''}${netBB.toFixed(1)} BB。` +
      `把对手逐个打到下桌，说明你的筹码管理与翻后判断在这个级别已经稳定——` +
      `可以试试把 AI 难度调高一档，或换 9 人桌检验更宽的对手范围。`;
  } else if (hands <= 5) {
    closing =
      `只打了 ${hands} 手就输光，样本很小，先别急着改打法：` +
      `建议用「单局练习」模式多打几手，把每手的复盘看完再回来。`;
  } else {
    closing =
      `共 ${hands} 手，净盈亏 ${netBB >= 0 ? '+' : ''}${netBB.toFixed(1)} BB。` +
      `输光不等于打错，但下面的建议里有可量化的改进方向；` +
      `先补码继续打，或切回「单局练习」模式专注复盘都可以。`;
  }

  if (advice.length === 0) {
    advice.push(
      hands < 10
        ? `样本还太少（${hands} 手），暂时看不出稳定的倾向；多打几手再看建议更准。`
        : `这一局没有明显可量化的漏洞：入池 ${pct(vpip)}、翻前加注 ${pct(pfr)}、` +
          `正常决策占比 ${pct(okRatio)}。继续保持，可以尝试提高 AI 难度。`,
    );
  }

  return {
    handsPlayed: hands,
    netProfit: stats.netProfit,
    netBB,
    vpip,
    pfr,
    aggression,
    grades: { ...stats.reviewCounts },
    decisions,
    okRatio,
    worst: worstDecisions(history, bigBlind, 3),
    advice: advice.slice(0, 4),
    headline,
    closing,
  };
}

/** 单手即时点评：给「单局练习」模式的结算面板用。 */
export interface HandFeedback {
  /** 最亏的一个决策点；没有决策或全部正常时为 null。 */
  worst: WorstDecision | null;
  /** 一句话结论。 */
  verdict: string;
}

/**
 * 单手点评。
 *
 * 只看「值得复盘」及以上的决策，避免把 0.1BB 的噪声也拿出来讲；
 * 全部正常时给一句正向确认，让玩家知道这手打得没问题。
 */
export function handFeedback(review: ReviewEntry[], bigBlind: number): HandFeedback {
  const notable = review.filter((e) => e.grade !== 'ok');
  if (notable.length === 0) {
    return {
      worst: null,
      verdict:
        review.length === 0
          ? '这一手你没有需要决策的地方。'
          : `这一手的 ${review.length} 个决策都在正常范围内，打得没问题。`,
    };
  }
  const worstEntry = notable.reduce((a, b) => (b.evLoss > a.evLoss ? b : a));
  const worst = toWorst(worstEntry, bigBlind);
  const verdict =
    `最值得复盘的是${worst.streetLabel}的${worst.actualLabel}：` +
    `当时更优的是${worst.bestLabel}，EV 损失约 ${worst.evLossBB.toFixed(1)} BB。`;
  return { worst, verdict };
}
