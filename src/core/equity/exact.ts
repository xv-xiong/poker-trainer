/**
 * 精确枚举胜率（仅单挑，1 个对手）。
 *
 * 为什么限制为单挑：精确枚举需要对「未知牌的所有角色分配」求和。
 *   河牌：C(45,0) x C(45,2) = 990
 *   转牌：C(46,1) x C(45,2) = 45,540
 *   翻牌：C(47,2) x C(45,2) = 1,070,190
 * 而 6 人桌河牌的精确组合数为 361,767,238,232,400，组合上不可行。
 * 因此多人数桌一律走蒙特卡洛（见 montecarlo.ts）。
 *
 * 关键正确性约束（验收闸门 G3）：实际摊牌数必须精确等于上述组合数。
 * 开发期一个原型因递归未覆盖全部角色分配，摊牌数算成 15,180 / 178,365，
 * 与真值不符却仍给出「看似合理」的胜率——该闸门专门捕获此类缺陷。
 */

import { fullDeck, type Card } from '../cards.js';
import { rank7 } from '../rank7.js';

export interface ExactResult {
  /** 胜率（含平局折半），0..1。 */
  equity: number;
  /** 实际摊牌次数，必须等于组合数。 */
  showdowns: number;
}

/** 从组合数计算期望摊牌次数，用于断言。 */
export function expectedShowdowns(boardLen: number): number {
  const unknown = 52 - 2 - boardLen; // 扣掉自己 2 张 + 公共牌
  const boardToCome = 5 - boardLen;
  // C(unknown, boardToCome) x C(unknown - boardToCome, 2)
  const c = (n: number, k: number): number => {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  };
  return c(unknown, boardToCome) * c(unknown - boardToCome, 2);
}

/**
 * 单挑精确枚举。
 * 枚举「公共牌补牌」与「对手两张牌」的全部角色分配，逐一对摊牌计数。
 */
export function exactEquityHU(hero: readonly Card[], board: readonly Card[]): ExactResult {
  if (hero.length !== 2) throw new Error('hero 必须是 2 张牌');
  if (board.length > 5) throw new Error('board 最多 5 张牌');

  const known = new Set<number>([...hero, ...board]);
  const remaining = fullDeck().filter((c) => !known.has(c));
  const boardToCome = 5 - board.length;

  let wins = 0;
  let ties = 0;
  let showdowns = 0;

  const boardPick: number[] = [];

  const evaluate = (): void => {
    const used = new Set<number>([...board, ...boardPick]);
    const full = [...board, ...boardPick];
    const heroValue = rank7([...hero, ...full]);
    const rest = remaining.filter((c) => !used.has(c));
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        const oppValue = rank7([rest[i], rest[j], ...full]);
        showdowns++;
        if (heroValue > oppValue) wins++;
        else if (heroValue === oppValue) ties++;
      }
    }
  };

  const recBoard = (start: number): void => {
    if (boardPick.length === boardToCome) {
      evaluate();
      return;
    }
    for (let i = start; i < remaining.length; i++) {
      boardPick.push(remaining[i]);
      recBoard(i + 1);
      boardPick.pop();
    }
  };
  recBoard(0);

  return { equity: (wins + ties / 2) / showdowns, showdowns };
}
