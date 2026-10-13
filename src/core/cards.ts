/**
 * 牌的整数编码与领域类型。
 *
 * 编码约定：card = rank * 4 + suit
 *   rank: 0..12 对应 2,3,4,5,6,7,8,9,T,J,Q,K,A
 *   suit: 0=♠ spades, 1=♥ hearts, 2=♦ diamonds, 3=♣ clubs
 * 该编码唯一且可逆，且 rank 提取为 `card >> 2`、suit 提取为 `card & 3`。
 */

export type Card = number; // 0..51
export type Rank = number; // 0..12
export type Suit = number; // 0..3

export const RANKS = '23456789TJQKA';
export const SUIT_CHARS = 'shdc'; // 与 suit 索引一致：0=s,1=h,2=d,3=c
export const SUIT_SYMBOLS = ['\u2660', '\u2665', '\u2666', '\u2663']; // ♠ ♥ ♦ ♣

/** 牌型类别，数值越大越强。 */
export const HAND_CATEGORIES = [
  'high_card', // 0 高牌
  'one_pair', // 1 一对
  'two_pair', // 2 两对
  'three_kind', // 3 三条
  'straight', // 4 顺子
  'flush', // 5 同花
  'full_house', // 6 葫芦
  'four_kind', // 7 四条
  'straight_flush', // 8 同花顺
] as const;

export type HandCategory = (typeof HAND_CATEGORIES)[number];

/** 牌型类别的中文名与英文名（界面双语术语用）。 */
export const CATEGORY_LABELS: Record<HandCategory, { zh: string; en: string }> = {
  high_card: { zh: '高牌', en: 'High Card' },
  one_pair: { zh: '一对', en: 'One Pair' },
  two_pair: { zh: '两对', en: 'Two Pair' },
  three_kind: { zh: '三条', en: 'Three of a Kind' },
  straight: { zh: '顺子', en: 'Straight' },
  flush: { zh: '同花', en: 'Flush' },
  full_house: { zh: '葫芦', en: 'Full House' },
  four_kind: { zh: '四条', en: 'Four of a Kind' },
  straight_flush: { zh: '同花顺', en: 'Straight Flush' },
};

export function makeCard(rank: Rank, suit: Suit): Card {
  return rank * 4 + suit;
}

export function cardRank(c: Card): Rank {
  return c >> 2;
}

export function cardSuit(c: Card): Suit {
  return c & 3;
}

/** 52 张标准牌堆（顺序固定：先点数后花色）。 */
export function fullDeck(): Card[] {
  const d: Card[] = [];
  for (let r = 0; r < 13; r++) {
    for (let s = 0; s < 4; s++) d.push(r * 4 + s);
  }
  return d;
}

/** 解析 'As' / 'Th' / '2c' 这类牌面文本。 */
export function parseCard(text: string): Card {
  const t = text.trim();
  if (t.length !== 2) throw new Error(`非法牌面文本: ${text}`);
  const rank = RANKS.indexOf(t[0].toUpperCase());
  const suit = SUIT_CHARS.indexOf(t[1].toLowerCase());
  if (rank < 0) throw new Error(`非法点数: ${text}`);
  if (suit < 0) throw new Error(`非法花色: ${text}`);
  return makeCard(rank, suit);
}

/** 输出形如 'As' 的紧凑文本（测试与存储用）。 */
export function cardToString(c: Card): string {
  return RANKS[cardRank(c)] + SUIT_CHARS[cardSuit(c)];
}

/** 输出形如 'A♠' 的显示文本（界面用）。 */
export function cardToDisplay(c: Card): string {
  return RANKS[cardRank(c)] + SUIT_SYMBOLS[cardSuit(c)];
}

export function cardsToString(cards: readonly Card[]): string {
  return cards.map(cardToString).join(' ');
}

export function parseCards(text: string): Card[] {
  return text.trim().split(/\s+/).filter(Boolean).map(parseCard);
}

/** 花色在四色牌方案下的颜色键（界面用）。 */
export function suitColorKey(c: Card): 'spade' | 'heart' | 'diamond' | 'club' {
  return (['spade', 'heart', 'diamond', 'club'] as const)[cardSuit(c)];
}
