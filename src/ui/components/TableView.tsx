/**
 * 牌桌：座位环绕布局 + 中央底池与公共牌。
 */

import { SeatView } from './SeatView.js';
import { CardRow } from './CardView.js';
import { seatRoles } from '../../core/pot.js';
import { STREET_LABELS, type HandState } from '../../core/types.js';

export function TableView({
  state,
  heroSeat,
  revealAll,
}: {
  state: HandState;
  heroSeat: number;
  revealAll: boolean;
}) {
  const n = state.seatCount;
  const { smallBlindSeat, bigBlindSeat } = seatRoles(n, state.dealerSeat);
  const pot = state.seats.reduce((a, s) => a + s.committed, 0);
  const winners = new Set(state.results.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0));

  // 座位分区：顶部、左右、底部（玩家本人固定在底部居中）
  const others: number[] = [];
  for (let i = 1; i < n; i++) others.push((heroSeat + i) % n);

  const topCount = Math.min(3, Math.max(0, n - 3));
  const top = others.slice(0, topCount);
  const rest = others.slice(topCount);
  const left = rest.length > 0 ? rest[0] : null;
  const right = rest.length > 1 ? rest[rest.length - 1] : null;
  const middle = rest.length > 2 ? rest.slice(1, rest.length - 1) : [];

  const renderSeat = (idx: number, compact = false) => {
    const seat = state.seats[idx];
    return (
      <SeatView
        key={idx}
        seat={seat}
        state={state}
        isHero={idx === heroSeat}
        isActive={state.actingSeat === idx && !state.finished}
        isWinner={state.finished && winners.has(idx)}
        revealCards={revealAll || (state.finished && !seat.folded)}
        smallBlindSeat={smallBlindSeat}
        bigBlindSeat={bigBlindSeat}
        compact={compact}
      />
    );
  };

  return (
    <div className="felt">
      <div className="seats-top">
        {top.map((i) => renderSeat(i))}
        {middle.map((i) => renderSeat(i, true))}
      </div>

      {left !== null && <div className="seat-left">{renderSeat(left, true)}</div>}

      <div className="table-center">
        <div className="pot-display">
          <div className="label">底池（Pot）</div>
          <div className="value">{pot}</div>
        </div>
        <div className="board">
          <CardRow cards={state.board} placeholderCount={5} />
        </div>
        <div className="street-badge">
          {state.finished
            ? state.finishReason === 'showdown'
              ? '已摊牌'
              : '已结束（对手弃牌）'
            : `${STREET_LABELS[state.street].zh}（${STREET_LABELS[state.street].en}）`}
        </div>
      </div>

      {right !== null && <div className="seat-right">{renderSeat(right, true)}</div>}

      <div className="seats-bottom">{renderSeat(heroSeat)}</div>
    </div>
  );
}
