/**
 * 三档 AI 的正交参数定义。
 *
 * 设计要点：三档难度由**同一套策略代码 + 不同参数**实现，不是三套逻辑。
 * 这样「简单档」就是参数退化，且可写单测验证档位确实可分辨（验收闸门 G7）：
 *   - 困难档入池率（VPIP）严格低于简单档
 *   - 面对加注且胜率不达底池赔率要求时，困难档弃牌率严格高于简单档
 */

import type { AITier } from '../core/types.js';

export interface AITierParams {
  /** 起手牌入池强度阈值（0..1，越大越紧）。 */
  preflopThreshold: number;
  /** 是否使用蒙特卡洛胜率估算。 */
  useEquity: boolean;
  /** 蒙特卡洛迭代次数（仅在 useEquity 时有效）。 */
  equityIterations: number;
  /** 是否严格执行底池赔率（胜率不足则弃牌）。 */
  strictPotOdds: boolean;
  /** 底池赔率执行的宽容系数：要求胜率 > potOdds x margin 才跟注。 */
  potOddsMargin: number;
  /** 诈唬频率（0..1）。 */
  bluffFrequency: number;
  /** 面对加注时的弃牌阈值（0..1，越大越容易弃牌）。 */
  foldToRaiseThreshold: number;
  /** 加注尺度（相对底池的倍数）。 */
  raiseSizeFactor: number;
  /**
   * 「满足赔率（okToCall）」时仍跟注的概率门（0..1；1 = 满足就一定跟注）。
   *
   * 口径：仅非 strictPotOdds 档生效。okToCall 成立时，以 callFrequency 的概率
   * 跟注；未通过概率门则弃牌。用于打散「只要赔率允许就机械跟注」的行为，
   * 从而把偏高的跟注率降下来。
   */
  callFrequency: number;
  /**
   * 「不满足赔率」时仍宽松跟注的概率门（0..1；0 = 一定弃牌）。
   *
   * 口径：仅非 strictPotOdds 档生效。旧逻辑在 okToCall 不成立时会无条件
   * 「宽松跟注」，导致简单/中等档面对下注永不弃牌；改为概率门后，
   * 只有 looseCallChance 的概率继续跟注，其余弃牌。
   */
  looseCallChance: number;
  /**
   * 手牌强度抖动幅度（0..1）：决策前给 strength 叠加 ±strengthJitter 的
   * 均匀噪声（夹到 [0,1]），用于去机械化——同一局面不再恒定输出同一动作。
   * 0 = 不抖动。困难档的 strictPotOdds 判定用 equity，不受此抖动影响。
   */
  strengthJitter: number;
}

export const TIER_PARAMS: Record<AITier, AITierParams> = {
  // 简单：极松、不看胜率、忽略赔率、几乎不诈唬、很少弃牌
  easy: {
    preflopThreshold: 0.06,
    useEquity: false,
    equityIterations: 0,
    strictPotOdds: false,
    potOddsMargin: 0.4,
    bluffFrequency: 0.02,
    foldToRaiseThreshold: 0.86,
    raiseSizeFactor: 0.4,
    // 简单档仍偏松，但不再「面对下注永不弃牌」：12% 的赔率达标跟注会放弃，
    // 赔率不达标时 45% 仍宽松跟注（保留「松」的性格）。
    callFrequency: 0.88,
    looseCallChance: 0.45,
    strengthJitter: 0.1,
  },
  // 中等：位置分档表、粗略启发式、宽松参考赔率
  medium: {
    preflopThreshold: 0.34,
    useEquity: false,
    equityIterations: 0,
    strictPotOdds: false,
    potOddsMargin: 0.7,
    bluffFrequency: 0.08,
    foldToRaiseThreshold: 0.62,
    raiseSizeFactor: 0.55,
    // 中等档是本次「降跟注率」的主战场：赔率达标也只有 72% 跟注，
    // 不达标仅 30% 宽松跟注，其余弃牌。
    callFrequency: 0.72,
    looseCallChance: 0.3,
    strengthJitter: 0.08,
  },
  // 困难：蒙特卡洛胜率 + 严格执行底池赔率 + 更多诈唬 + 弱牌果断弃
  hard: {
    preflopThreshold: 0.52,
    useEquity: true,
    equityIterations: 3_000,
    strictPotOdds: true,
    potOddsMargin: 1.0,
    bluffFrequency: 0.15,
    foldToRaiseThreshold: 0.42,
    raiseSizeFactor: 0.66,
    // 困难档走 strictPotOdds 分支，两个概率门不生效（保持「胜率不足即弃」）；
    // 仅用极小的强度抖动去机械化。
    callFrequency: 1,
    looseCallChance: 0,
    strengthJitter: 0.04,
  },
};

export function tierParams(tier: AITier): AITierParams {
  return TIER_PARAMS[tier];
}
