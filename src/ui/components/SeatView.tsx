/**
 * 座位组件：名字、筹码、底牌、角色徽章、本街投入 + 演出层（光晕 / 思考 / 动作气泡 / 筹码入池）。
 *
 * 演出相关的可见元素全部由 props 驱动（不读全局状态），以便：
 *   1. TableView 能按座位精确下发；
 *   2. 单测/Storybook 能直接构造。
 * 动画 keyframes 见 ./showcase.css。
 */

import { CardView } from './CardView.js';
import { ActionBubble, ThinkingBubble } from './ActionBubble.js';
import type { ActionRecord } from '../../core/types.js';
import { AI_TIER_LABELS, type HandState, type Seat } from '../../core/types.js';

/** 该座位本街投入是否刚刚变化过（用于数字强调动画）。 */
export interface SeatShowcase {
  /** 该座位正在思考（AI 行动前 / 玩家自己的气泡停留期）。 */
  thinking: boolean;
  /** 该座位高度自定义（当前行动者光晕）。 */
  active: boolean;
  /** 该座位刚发出底牌。 */
  dealing: boolean;
  /** 该座位旁要显示的动作气泡。 */
  bubble: ActionRecord | null;
  /** 气泡重放动画的 key（用「哪条动作」标识，不用步数序号）。 */
  bubbleKey: string;
  /** 该座位的筹码正在飞向底池（用于 chip-fly 动画 key）。 */
  chipKey: number;
  /** 该座位本街投入刚变化（数字强调）。 */
  committedBump: boolean;
}

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
  showcase,
  isWinnerSeat = false,
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
  showcase?: SeatShowcase;
  /** 该座位是本手赢家（用于结算高亮，与 `isWinner` 的区别：后者含摊牌牌型高亮）。 */
  isWinnerSeat?: boolean;
}) {
  const cls = ['seat'];
  if (isHero) cls.push('hero');
  if (isActive) cls.push('active');
  if (seat.folded) cls.push('folded');
  if (showcase?.dealing) cls.push('sc-dealing');
  if (isWinnerSeat) cls.push('sc-winner');

  const showCards = isHero || revealCards;

  return (
    <div className={cls.join(' ')} data-seat={seat.index} data-thinking={showcase?.thinking ? '1' : '0'}>
      {/* 动作气泡：绑定在座位上，是「谁做了什么」的唯一可见载体。
          与「思考气泡」可以并存：前者是已发生的动作，后者是正在进行的思考。
          注意：`animationKey`（bubbleKey）作为 React key 传入，
          使「换了一条动作」时才重挂载；同一动作重复渲染不会重启入场动画。 */}
      {showcase?.bubble && (
        <ActionBubble
          key={`bubble-${showcase.bubbleKey}`}
          action={showcase.bubble}
          hero={isHero}
          animationKey={showcase.bubbleKey}
        />
      )}

      {/* 思考气泡：AI 思考的可见中间态。
          刻意不给 React key：只要 `thinking` 为真，React 就复用同一个 DOM 节点，
          入场动画只播一次。给 key 会让它在每一步重挂载并重启动画（实测整手 206 次），
          视觉上是闪烁。 */}
      {showcase?.thinking && <ThinkingBubble />}

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
        <div
          key={`${seat.committedThisStreet}-${showcase?.chipKey ?? 0}`}
          className={`committed ${showcase?.committedBump ? 'sc-bump' : ''}`}
          data-testid="committed"
        >
          本街投入 {seat.committedThisStreet}
        </div>
      )}
    </div>
  );
}
