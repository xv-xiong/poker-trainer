/**
 * 单张牌的渲染。支持四色牌与传统两色（由祖先容器的 .two-color 类控制）。
 *
 * 动画相关（task-4 分步演出）：
 * - `dealIn`：本张牌是「刚发出来的」，播放发牌动画（flop 时三张各播一次，
 *   由 TableView 逐张推进 `visibleBoardCount` 触发）。
 * - `unused`：本张公共牌不参与最终牌型（参考站 `.unused-card`，看牌型时不被干扰）。
 * - `winning`：本张牌属于赢家的成牌（参考站 `.winning-hole`）。
 * 动画 keyframes 见 ./showcase.css，遵守 `prefers-reduced-motion`。
 */

import { cardRank, cardSuit, RANKS, SUIT_SYMBOLS, type Card } from '../../core/cards.js';

const SUIT_CLASS = ['suit-spade', 'suit-heart', 'suit-diamond', 'suit-club'];

export function CardView({
  card,
  small = false,
  hidden = false,
  dim = false,
  winning = false,
  dealIn = false,
  unused = false,
  animationKey,
}: {
  card?: Card;
  small?: boolean;
  hidden?: boolean;
  dim?: boolean;
  winning?: boolean;
  /** 刚发出：播放一次发牌动画。 */
  dealIn?: boolean;
  /** 未参与最终牌型：压暗（参考站 unused-card）。 */
  unused?: boolean;
  /** 重放动画用的 key。 */
  animationKey?: string | number;
}) {
  const cls = ['card'];
  if (small) cls.push('small');
  if (dim) cls.push('dim');
  if (winning) cls.push('winning', 'winning-card');
  if (unused) cls.push('unused-card');
  if (dealIn) cls.push('deal-in');

  if (hidden || card === undefined) {
    cls.push('hidden');
    return (
      <div
        className={cls.join(' ')}
        key={animationKey}
        data-testid="card"
        data-face="down"
        aria-hidden="true"
      />
    );
  }

  const rank = RANKS[cardRank(card)];
  const suit = SUIT_SYMBOLS[cardSuit(card)];
  cls.push(SUIT_CLASS[cardSuit(card)]);

  return (
    <div
      className={cls.join(' ')}
      key={animationKey}
      role="img"
      aria-label={`${rank}${suit}`}
      data-testid="card"
      data-face="up"
      data-deal-in={dealIn ? '1' : '0'}
    >
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
  /** 只显示前 N 张（分步发牌时逐张增加）；不传表示全部显示。 */
  visibleCount,
  /** 最近一张发出来的牌播放发牌动画。 */
  animateLatest = false,
  /** 参与/不参与最终牌型的判定；返回 true 表示压暗。 */
  isUnused,
  /** 赢家成牌判定。 */
  isWinning,
  /** 重放动画的基准 key（变化时全部重播）。 */
  animationKey = 0,
}: {
  cards: readonly Card[];
  small?: boolean;
  placeholderCount?: number;
  dim?: boolean;
  visibleCount?: number;
  animateLatest?: boolean;
  isUnused?: (card: Card, index: number) => boolean;
  isWinning?: (card: Card, index: number) => boolean;
  animationKey?: number | string;
}) {
  const shown = typeof visibleCount === 'number' ? cards.slice(0, Math.max(0, visibleCount)) : cards;
  const placeholders = Math.max(0, placeholderCount - shown.length);
  const latest = animateLatest && shown.length > 0 ? shown.length - 1 : -1;

  return (
    <>
      {shown.map((c, i) => (
        <CardView
          key={`${animationKey}-${c}-${i}`}
          card={c}
          small={small}
          dim={dim}
          dealIn={i === latest}
          unused={isUnused ? isUnused(c, i) : false}
          winning={isWinning ? isWinning(c, i) : false}
          animationKey={`${animationKey}-${c}-${i}`}
        />
      ))}
      {Array.from({ length: placeholders }, (_, i) => (
        <div
          key={`ph-${animationKey}-${i}`}
          className={`card placeholder ${small ? 'small' : ''}`}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
