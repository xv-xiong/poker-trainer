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
  },
};

export function tierParams(tier: AITier): AITierParams {
  return TIER_PARAMS[tier];
}
