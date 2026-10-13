/**
 * 座位组件：显示名字、筹码、底牌、角色徽章与本街投入。
 */

import { CardView } from './CardView.js';
import { AI_TIER_LABELS, type HandState, type Seat } from '../../core/types.js';

export function SeatView({
  seat,
  state,
  isHero,
  isActive,
  isWinner,
  revealCards,
  smallBlindSeat,
  bigBlindSeat,
  compact = false,
}: {
  seat: Seat;
  state: HandState;
  isHero: boolean;
  isActive: boolean;
  isWinner: boolean;
  revealCards: boolean;
  smallBlindSeat: number;
  bigBlindSeat: number;
  compact?: boolean;
}) {
  const cls = ['seat'];
  if (isHero) cls.push('hero');
  if (isActive) cls.push('active');
  if (seat.folded) cls.push('folded');

  const showCards = isHero || revealCards;

  return (
    <div className={cls.join(' ')}>
      <div className="seat-head">
        <span className="name" title={seat.name}>
          {seat.name}
        </span>
        <span className="stack">{seat.stack}</span>
      </div>

      {!compact && (
        <div className="seat-cards">
          {seat.holeCards.map((c, i) =>
            showCards ? (
              <CardView key={i} card={c} small winning={isWinner} />
            ) : (
              <CardView key={i} small hidden />
            ),
          )}
        </div>
      )}

      <div className="badges">
        {seat.index === state.dealerSeat && <span className="badge dealer">D</span>}
        {seat.index === smallBlindSeat && <span className="badge sb">SB</span>}
        {seat.index === bigBlindSeat && <span className="badge bb">BB</span>}
        {seat.isAI && (
          <span className="badge tier" title={`AI 难度：${AI_TIER_LABELS[seat.tier].zh}`}>
            {AI_TIER_LABELS[seat.tier].zh}
          </span>
        )}
        {seat.folded && <span className="badge folded">弃牌</span>}
        {seat.allIn && <span className="badge allin">全下</span>}
      </div>

      {seat.committedThisStreet > 0 && (
        <div className="committed">本街投入 {seat.committedThisStreet}</div>
      )}
    </div>
  );
}
