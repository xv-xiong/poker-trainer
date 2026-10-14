/**
 * 牌桌：座位环绕布局 + 中央底池与公共牌 + 演出层。
 *
 * 演出层（task-4）：
 *   - 公共牌按 `view.shownBoard` 逐张显示（flop 三张逐张，turn/river 各一张）；
 *   - 当前行动者座位光晕（`.seat.active` + showcase.css 的 `sc-turn-glow`）；
 *   - 动作气泡绑定在座位上；
 *   - 筹码从座位飞向底池中央（`.chip-fly`，起止点由座位坐标算出，纯 CSS 动画）。
 *
 * 本组件不修改任何牌局数据：`state` 只读，展示差异全部来自 `view`。
 * 不传 `view` 时退化为「一次性呈现」，与改动前的行为一致（便于降级与单测）。
 */

import { useMemo } from 'react';
import { SeatView, type SeatShowcase } from './SeatView.js';
import { CardRow } from './CardView.js';
import type { ShowcaseView } from '../useTableShowcase.js';
import { seatRoles } from '../../core/pot.js';
import { STREET_LABELS, type HandState } from '../../core/types.js';

/** 座位在牌桌上的位置（百分比坐标）与紧凑模式。 */
export interface SeatPlacement {
  index: number;
  compact: boolean;
  x: number;
  y: number;
}

/** 飞筹码的终点：桌面中心（`.table-center` 居中）。 */
export const POT_CENTER = { x: 50, y: 46 };

/**
 * 计算座位坐标。
 *
 * 为什么用百分比而不是 `grid-template-areas`：座位在牌桌上是**环绕**排布的，
 * 网格的四个角落位置无法表达「3 个在顶部、左右各一、玩家在底部居中」这种
 * 随人数变化的环绕关系；一旦人数可变，坐标表比分格更直接。
 * 百分比还有一个好处：响应式重排后飞筹码的起止点自动跟随，无需监听 resize。
 *
 * 坐标刻意保持左右对称，使桌面上任何人数下玩家（底部居中）到各座位的
 * 视觉距离都与真实牌桌一致。
 */
export function computePlacements(seatCount: number, heroSeat: number): SeatPlacement[] {
  const out: SeatPlacement[] = [];
  const n = Math.max(2, seatCount);

  if (n === 2) {
    out.push({ index: (heroSeat + 1) % n, compact: false, x: 50, y: 10 });
    out.push({ index: heroSeat, compact: false, x: 50, y: 90 });
    return out;
  }

  if (n === 3) {
    out.push({ index: (heroSeat + 1) % n, compact: false, x: 22, y: 14 });
    out.push({ index: (heroSeat + 2) % n, compact: false, x: 78, y: 14 });
    out.push({ index: heroSeat, compact: false, x: 50, y: 90 });
    return out;
  }

  const others: number[] = [];
  for (let i = 1; i < n; i++) others.push((heroSeat + i) % n);

  const topCount = Math.min(3, others.length - 2);
  const top = others.slice(0, topCount);
  const rest = others.slice(topCount);
  const left = rest.length > 0 ? rest[0] : null;
  const right = rest.length > 1 ? rest[rest.length - 1] : null;
  const middle = rest.length > 2 ? rest.slice(1, rest.length - 1) : [];

  const topRow = [...top, ...middle];
  topRow.forEach((idx, i) => {
    out.push({ index: idx, compact: topRow.length > 3, x: ((i + 1) / (topRow.length + 1)) * 100, y: 10 });
  });
  if (left !== null) out.push({ index: left, compact: true, x: 7, y: 48 });
  if (right !== null) out.push({ index: right, compact: true, x: 93, y: 48 });
  out.push({ index: heroSeat, compact: false, x: 50, y: 90 });
  return out;
}

export function TableView({
  state,
  heroSeat,
  revealAll,
  view,
}: {
  state: HandState;
  heroSeat: number;
  revealAll: boolean;
  /** 演出视图；不传则退化为「一次性呈现」。 */
  view?: ShowcaseView;
}) {
  const n = state.seatCount;
  const { smallBlindSeat, bigBlindSeat } = seatRoles(n, state.dealerSeat);
  const pot = state.seats.reduce((a, s) => a + s.committed, 0);
  const winners = new Set(state.results.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0));

  const placements = useMemo(() => computePlacements(n, heroSeat), [n, heroSeat]);
  const placement = (idx: number): SeatPlacement =>
    placements.find((p) => p.index === idx) ?? { index: idx, compact: false, x: 50, y: 50 };

  const others = placements.filter((p) => p.index !== heroSeat);
  const topRow = others.filter((p) => p.y < 30);
  const left = others.find((p) => p.x < 25) ?? null;
  const right = others.find((p) => p.x > 75) ?? null;

  const shownBoard = view ? view.shownBoard : state.board;
  /** 本街发牌过程中，最近一张公共牌播放发牌动画。 */
  const boardAnimKey = `${state.handId}-${state.street}-${shownBoard.length}`;

  const handOver = view ? view.handOver : state.finished;
  const lastAction = view?.lastAction ?? null;

  const renderSeat = (idx: number, compact = false) => {
    const seat = state.seats[idx];
    const p = placement(idx);
    const isActive = view ? view.thinkingSeat === idx : state.actingSeat === idx && !state.finished;
    const isThinking = Boolean(view?.thinking && view.thinkingSeat === idx);
    const bubbleHere = lastAction && lastAction.seat === idx ? lastAction : null;

    /**
     * 气泡身份键：用「这条动作本身」而不是「第几步」。
     *
     * 早前实现是 `seat*64 + actions.length`（每步都变），再被上层当作 React key，
     * 结果是整手牌里气泡反复销毁重建、入场动画重启上百次，视觉上就是闪烁。
     * 改为：座位 + 动作类型 + 投注额 + 该座位的动作序号
     * （序号只在「本座位第 n 次动作」时变化，不再随别座位动作而变）。
     */
    const actionOrdinal = state.actions.filter((a) => a.seat === idx).length;
    const bubbleKey = bubbleHere
      ? `${bubbleHere.seat}-${bubbleHere.type}-${bubbleHere.amount}-${actionOrdinal}`
      : '';

    const showcase: SeatShowcase | undefined = view
      ? {
          thinking: isThinking,
          active: isActive,
          // 开局帧播放底牌入场动画（纯视觉，不阻塞输入）
          dealing: view.dealt,
          // 思考中的座位与「上一次动作」的气泡可以并存：
          // 前者说明「它接下来要做什么」，后者说明「它刚做了什么」，
          // 两者是同一座位上的不同信息，互相抑制会让动作完全看不见。
          bubble: bubbleHere,
          bubbleKey,
          chipKey: actionOrdinal,
          committedBump: Boolean(bubbleHere),
        }
      : undefined;

    return (
      <div
        className="seat-slot"
        style={{ left: `${p.x}%`, top: `${p.y}%` }}
        key={idx}
        data-slot={idx}
        // 顶部一排的思考/动作气泡必须向下弹出，否则会被桌面边缘裁掉
        data-row={p.y <= 20 ? 'top' : p.y >= 80 ? 'bottom' : 'mid'}
      >
        <SeatView
          seat={seat}
          state={state}
          isHero={idx === heroSeat}
          isActive={isActive}
          isWinner={handOver && winners.has(idx)}
          isWinnerSeat={handOver && winners.has(idx)}
          revealCards={revealAll || (handOver && !seat.folded)}
          smallBlindSeat={smallBlindSeat}
          bigBlindSeat={bigBlindSeat}
          compact={compact}
          showcase={showcase}
        />
      </div>
    );
  };

  // 筹码飞向底池：起点是座位坐标，终点是桌面中心
  const chipFlier = lastAction
    ? (() => {
        const from = placement(lastAction.seat);
        return {
          key: `${lastAction.seat}-${state.actions.length}`,
          from,
          hero: lastAction.seat === heroSeat,
        };
      })()
    : null;

  return (
    <div className="felt" data-testid="felt">
      {/* 飞向底池的筹码（纯 CSS 动画，不占用任何 JS 定时器） */}
      {chipFlier && (
        <span
          key={chipFlier.key}
          className={`chip-fly ${chipFlier.hero ? 'hero' : ''}`}
          style={
            {
              left: `${chipFlier.from.x}%`,
              top: `${chipFlier.from.y}%`,
              '--dx': `${POT_CENTER.x - chipFlier.from.x}%`,
              '--dy': `${POT_CENTER.y - chipFlier.from.y}%`,
            } as React.CSSProperties
          }
          aria-hidden="true"
          data-testid="chip-fly"
        />
      )}

      <div className="seats-top">{topRow.map((p) => renderSeat(p.index, p.compact))}</div>

      {left !== null && <div className="seat-left">{renderSeat(left.index, true)}</div>}

      <div className="table-center">
        <div className="pot-display">
          <div className="label">底池（Pot）</div>
          {/* 不加 key：pot 数字应在每次变化时只做「数值脉冲」而不是重挂载。
              早前 `key={'pot-'+actions.length}` 会让它每步重建，与 street-badge
              同时变化时视觉上就是「文案重叠/抖动」。 */}
          <div
            className={`value ${lastAction ? 'sc-pulse' : ''}`}
            data-testid="pot-value"
          >
            {pot}
          </div>
        </div>
        <div className="board" data-testid="board" data-revealed={shownBoard.length}>
          <CardRow
            cards={state.board}
            visibleCount={view ? shownBoard.length : undefined}
            animateLatest
            placeholderCount={5}
            animationKey={boardAnimKey}
          />
        </div>
        <div className="street-badge" data-testid="street-badge">
          {handOver
            ? state.finishReason === 'showdown'
              ? '已摊牌'
              : '已结束（对手弃牌）'
            : view?.thinking
              ? state.actingSeat === heroSeat
                ? '你的动作…'
                : '对手思考中…'
              : `${STREET_LABELS[state.street].zh}（${STREET_LABELS[state.street].en}）`}
        </div>
      </div>

      {right !== null && <div className="seat-right">{renderSeat(right.index, true)}</div>}

      <div className="seats-bottom">{renderSeat(heroSeat)}</div>
    </div>
  );
}
