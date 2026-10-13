/**
 * 起手牌强度表（按位置分档）。
 *
 * 强度值 0..1：由「169 手牌类对随机手牌的胜率」映射而来，
 * 再叠加位置修正（后位可放宽，前位收紧）。
 *
 * 该表为**启发式**，用于 AI 的入池决策，不作为测试断言基准。
 */

import { cardRank, type Card } from '../core/cards.js';

const RANK_CHARS = '23456789TJQKA';

/** 169 类手牌的基准强度（0..1，越大越强）。 */
export const PREFLOP_STRENGTH: Record<string, number> = {
  AA: 1.0, KK: 0.96, QQ: 0.92, JJ: 0.87, TT: 0.82, '99': 0.76, '88': 0.71,
  '77': 0.66, '66': 0.61, '55': 0.57, '44': 0.53, '33': 0.5, '22': 0.47,
  AKs: 0.87, AQs: 0.83, AJs: 0.79, ATs: 0.75, A9s: 0.68, A8s: 0.65,
  A7s: 0.63, A6s: 0.62, A5s: 0.63, A4s: 0.6, A3s: 0.58, A2s: 0.56,
  AKo: 0.82, AQo: 0.77, AJo: 0.72, ATo: 0.67, A9o: 0.58, A8o: 0.55,
  A7o: 0.53, A6o: 0.52, A5o: 0.53, A4o: 0.5, A3o: 0.48, A2o: 0.46,
  KQs: 0.79, KJs: 0.75, KTs: 0.71, K9s: 0.64, K8s: 0.6, K7s: 0.57,
  K6s: 0.55, K5s: 0.53, K4s: 0.51, K3s: 0.49, K2s: 0.47,
  KQo: 0.73, KJo: 0.68, KTo: 0.63, K9o: 0.54, K8o: 0.5, K7o: 0.47,
  K6o: 0.45, K5o: 0.43, K4o: 0.41, K3o: 0.39, K2o: 0.37,
  QJs: 0.74, QTs: 0.7, Q9s: 0.63, Q8s: 0.58, Q7s: 0.54, Q6s: 0.51,
  Q5s: 0.49, Q4s: 0.47, Q3s: 0.45, Q2s: 0.43,
  QJo: 0.67, QTo: 0.62, Q9o: 0.53, Q8o: 0.48, Q7o: 0.44, Q6o: 0.41,
  Q5o: 0.39, Q4o: 0.37, Q3o: 0.35, Q2o: 0.33,
  JTs: 0.72, J9s: 0.65, J8s: 0.59, J7s: 0.54, J6s: 0.5, J5s: 0.47,
  J4s: 0.45, J3s: 0.43, J2s: 0.41,
  JTo: 0.64, J9o: 0.55, J8o: 0.49, J7o: 0.44, J6o: 0.4, J5o: 0.37,
  J4o: 0.35, J3o: 0.33, J2o: 0.31,
  T9s: 0.67, T8s: 0.61, T7s: 0.55, T6s: 0.5, T5s: 0.46, T4s: 0.43,
  T3s: 0.41, T2s: 0.39,
  T9o: 0.57, T8o: 0.51, T7o: 0.45, T6o: 0.4, T5o: 0.36, T4o: 0.33,
  T3o: 0.31, T2o: 0.29,
  '98s': 0.62, '97s': 0.56, '96s': 0.5, '95s': 0.45, '94s': 0.42,
  '93s': 0.39, '92s': 0.37,
  '98o': 0.52, '97o': 0.46, '96o': 0.4, '95o': 0.35, '94o': 0.32,
  '93o': 0.29, '92o': 0.27,
  '87s': 0.58, '86s': 0.52, '85s': 0.46, '84s': 0.41, '83s': 0.38,
  '82s': 0.35,
  '87o': 0.48, '86o': 0.42, '85o': 0.36, '84o': 0.31, '83o': 0.28,
  '82o': 0.26,
  '76s': 0.54, '75s': 0.48, '74s': 0.42, '73s': 0.37, '72s': 0.34,
  '76o': 0.44, '75o': 0.38, '74o': 0.32, '73o': 0.28, '72o': 0.24,
  '65s': 0.51, '64s': 0.44, '63s': 0.38, '62s': 0.33,
  '65o': 0.41, '64o': 0.34, '63o': 0.29, '62o': 0.25,
  '54s': 0.47, '53s': 0.4, '52s': 0.34,
  '54o': 0.37, '53o': 0.3, '52o': 0.26,
  '43s': 0.43, '42s': 0.36, '32s': 0.35,
  '43o': 0.33, '42o': 0.28, '32o': 0.27,
};

/** 规范化两张底牌为 169 类键。 */
export function handKey(hero: readonly Card[]): string {
  const r1 = cardRank(hero[0]);
  const r2 = cardRank(hero[1]);
  const s1 = hero[0] & 3;
  const s2 = hero[1] & 3;
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  if (hi === lo) return `${RANK_CHARS[hi]}${RANK_CHARS[lo]}`;
  return `${RANK_CHARS[hi]}${RANK_CHARS[lo]}${s1 === s2 ? 's' : 'o'}`;
}

/** 查询起手牌基准强度；未知键返回 0.3。 */
export function preflopStrength(hero: readonly Card[]): number {
  return PREFLOP_STRENGTH[handKey(hero)] ?? 0.3;
}

/**
 * 位置修正系数。
 * @param seatFromDealer 距庄家的座位距离（1 = 小盲，越大越靠前/越早行动）
 * @param seatCount 座位数
 */
export function positionFactor(seatFromDealer: number, seatCount: number): number {
  // 越靠后（距庄家越近、且不是盲注位）越宽松
  const ratio = seatFromDealer / Math.max(1, seatCount);
  // 盲注位略收紧，按钮位最宽松
  return 0.82 + 0.36 * (1 - ratio);
}
