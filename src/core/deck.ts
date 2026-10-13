/**
 * 牌堆构造与种子化洗牌（Fisher-Yates）。
 */

import { fullDeck, type Card } from './cards.js';
import type { Rng } from './rng.js';

/** 用给定随机源做 Fisher-Yates 洗牌，返回新数组（不修改入参）。 */
export function shuffle(deck: readonly Card[], rng: Rng): Card[] {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = d[i];
    d[i] = d[j];
    d[j] = tmp;
  }
  return d;
}

/** 生成一副已洗好的牌。 */
export function shuffledDeck(rng: Rng): Card[] {
  return shuffle(fullDeck(), rng);
}
