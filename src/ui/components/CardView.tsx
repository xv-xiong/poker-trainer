/**
 * 单张牌的渲染。支持四色牌与传统两色（由祖先容器的 .two-color 类控制）。
 */

import { cardRank, cardSuit, RANKS, SUIT_SYMBOLS, type Card } from '../../core/cards.js';

const SUIT_CLASS = ['suit-spade', 'suit-heart', 'suit-diamond', 'suit-club'];

export function CardView({
  card,
  small = false,
  hidden = false,
  dim = false,
  winning = false,
}: {
  card?: Card;
  small?: boolean;
  hidden?: boolean;
  dim?: boolean;
  winning?: boolean;
}) {
  const cls = ['card'];
  if (small) cls.push('small');
  if (dim) cls.push('dim');
  if (winning) cls.push('winning');

  if (hidden || card === undefined) {
    cls.push('hidden');
    return <div className={cls.join(' ')} aria-hidden="true" />;
  }

  const rank = RANKS[cardRank(card)];
  const suit = SUIT_SYMBOLS[cardSuit(card)];
  cls.push(SUIT_CLASS[cardSuit(card)]);

  return (
    <div className={cls.join(' ')} role="img" aria-label={`${rank}${suit}`}>
      <span className="rank">{rank}</span>
      <span className="suit">{suit}</span>
    </div>
  );
}

export function CardRow({
  cards,
  small = false,
  placeholderCount = 0,
  dim = false,
}: {
  cards: readonly Card[];
  small?: boolean;
  placeholderCount?: number;
  dim?: boolean;
}) {
  const placeholders = Math.max(0, placeholderCount - cards.length);
  return (
    <>
      {cards.map((c, i) => (
        <CardView key={`${c}-${i}`} card={c} small={small} dim={dim} />
      ))}
      {Array.from({ length: placeholders }, (_, i) => (
        <div key={`ph-${i}`} className={`card placeholder ${small ? 'small' : ''}`} aria-hidden="true" />
      ))}
    </>
  );
}
