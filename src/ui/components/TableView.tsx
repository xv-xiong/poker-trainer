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

/** 座位所在的布局槽位（环绕牌桌的四段）。 */
export type SeatSlot = 'top' | 'left' | 'right' | 'bottom';

/** 座位在牌桌上的位置（百分比坐标）与所属槽位。 */
export interface SeatPlacement {
  index: number;
  x: number;
  y: number;
  /**
   * 槽位：渲染时必须按槽位分组，**不要**再用 x / y 阈值反推。
   *
   * 曾经的 `others.find(p => p.x < 25)` / `find(p => p.x > 75)` 在 7 人及以上
   * 会把顶排座位也判成左 / 右侧：顶排 x = ((i+1)/(topCount+1))*100 在 9 人桌
   * 是 14.3%…85.7%，首尾两个正好越过 25 / 75 阈值，于是同一个座位被渲染两次、
   * 另一个座位完全不渲染（实测九人桌 9 个 `.seat` 的 data-seat 是
   * 2,3,4,5,6,7,1,7,0 —— 座位 7 重复、座位 8 缺失）。
   */
  slot: SeatSlot;
}

/** 飞筹码的终点：桌面中心（`.table-center` 居中）。 */
export const POT_CENTER = { x: 50, y: 46 };

/**
 * 计算座位坐标。
 *
 * 为什么用百分比而不是 `grid-template-areas`：座位在牌桌上是**环绕**排布的，
 * 网格的四个角落位置无法表达「顶部若干、左右各一、玩家在底部居中」这种
 * 随人数变化的环绕关系；一旦人数可变，坐标表比分格更直接。
 * 百分比还有一个好处：响应式重排后飞筹码的起止点自动跟随，无需监听 resize。
 *
 * ── 顺时针不变式（本函数的核心约束）──────────────────────────
 * 引擎的行动顺序是 `(seat + 1) % seatCount`（见 `core/betting.ts` 的
 * `nextActionableSeat` / `findNextActor`）。为了让玩家**看到的**行动光晕
 * 与这个顺序一致，座位的排布必须满足：
 *
 *     从玩家座位出发、沿屏幕顺时针读，座次恰好是
 *     hero → hero+1 → hero+2 → … → hero+n-1
 *
 * 屏幕坐标 y 向下，所以「顺时针」= 下 → 左 → 上 → 右。
 * 因此槽位的顺时针次序固定为：**左侧 → 顶排(从左到右) → 右侧**，
 * 玩家自己在底部居中。
 *
 * 早前的实现把 hero+1…hero+3 铺在顶排、hero+4 放左侧、hero+5 放右侧，
 * 于是视觉顺时针顺序变成 `[hero, hero+4, hero+1, hero+2, hero+3, hero+5]`
 * ——行动光晕在「顶排三连」之后突然跳到左边、再跳回右边，主观感受就是
 * 「AI 在随机行动」。现在按顺时针槽位顺序分配座次，从根上消除该错位。
 *
 * 注意：这里**没有** `compact` 字段。早前左侧/右侧座位被标为 compact，
 * 而 `SeatView` 用 `{!compact && …}` 决定是否渲染底牌，导致六人桌恰好
 * 有两名 AI（左右两侧）完全不显示手牌。槽位大小由 CSS 负责，不能用来
 * 决定「是否渲染底牌」。
 */
export function computePlacements(seatCount: number, heroSeat: number): SeatPlacement[] {
  const out: SeatPlacement[] = [];
  const n = Math.max(2, seatCount);

  if (n === 2) {
    // 单挑：对手在正上方（从玩家出发顺时针的唯一位置）
    out.push({ index: (heroSeat + 1) % n, x: 50, y: 10, slot: 'top' });
    out.push({ index: heroSeat, x: 50, y: 90, slot: 'bottom' });
    return out;
  }

  if (n === 3) {
    // 3 人：顺时针为 下(玩家) → 左 → 右
    out.push({ index: (heroSeat + 1) % n, x: 22, y: 14, slot: 'top' });
    out.push({ index: (heroSeat + 2) % n, x: 78, y: 14, slot: 'top' });
    out.push({ index: heroSeat, x: 50, y: 90, slot: 'bottom' });
    return out;
  }

  // 4 人及以上：按「左侧 → 顶排 → 右侧」的顺时针槽位顺序分配座次。
  // 分配用下标算术表达，保证**双射**：others 有 n-1 个 = 左 1 + 顶 (n-3) + 右 1，
  // 恰好把 0..n-1 每个座号覆盖一次（n=4..9 由单测逐人数、逐 hero 核对）。
  const others: number[] = [];
  for (let i = 1; i < n; i++) others.push((heroSeat + i) % n);

  const topCount = n - 3; // 顶排座位数：4 人桌 1 个，9 人桌 6 个
  const leftSeat = others[0];
  const topSeats = others.slice(1, 1 + topCount);
  const rightSeat = others[1 + topCount]; // 最后一个（others 长度 n-1，末下标 n-2）

  // 左侧（顺时针第一个）：y 取中部偏下，视觉上紧跟玩家之后
  out.push({ index: leftSeat, x: 7, y: 46, slot: 'left' });

  // 顶排：从左到右均匀铺开，正好对应顺时针的中间段
  topSeats.forEach((idx, i) => {
    out.push({ index: idx, x: ((i + 1) / (topSeats.length + 1)) * 100, y: 10, slot: 'top' });
  });

  // 右侧（顺时针最后一个）
  out.push({ index: rightSeat, x: 93, y: 46, slot: 'right' });

  out.push({ index: heroSeat, x: 50, y: 90, slot: 'bottom' });
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
    placements.find((p) => p.index === idx) ?? { index: idx, x: 50, y: 50, slot: 'top' };

  // 按槽位分组渲染。**不要**用 x / y 阈值反推左右侧：7 人及以上顶排会铺到
  // x < 25 / x > 75（九人桌顶排 x 是 14.3%…85.7%），阈值反推会把顶排座位
  // 重复渲染成左 / 右侧 —— 实测九人桌 9 个 .seat 里座位 7 出现两次、座位 8 消失。
  const topRow = placements.filter((p) => p.slot === 'top');
  const left = placements.find((p) => p.slot === 'left') ?? null;
  const right = placements.find((p) => p.slot === 'right') ?? null;

  const shownBoard = view ? view.shownBoard : state.board;
  /** 本街发牌过程中，最近一张公共牌播放发牌动画。 */
  const boardAnimKey = `${state.handId}-${state.street}-${shownBoard.length}`;

  const handOver = view ? view.handOver : state.finished;
  const lastAction = view?.lastAction ?? null;

  const renderSeat = (idx: number) => {
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
    <div className="felt" data-testid="felt" data-seat-count={n}>
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

      <div className="seats-top">{topRow.map((p) => renderSeat(p.index))}</div>

      {left !== null && <div className="seat-left">{renderSeat(left.index)}</div>}

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

      {right !== null && <div className="seat-right">{renderSeat(right.index)}</div>}

      <div className="seats-bottom">{renderSeat(heroSeat)}</div>
    </div>
  );
}
