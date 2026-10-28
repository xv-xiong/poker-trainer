/**
 * 补码决策弹窗（继承模式下，某个座位筹码不足一个大盲时出现）。
 *
 * 为什么用「模态弹窗」而不是行内提示：补码会改变整桌筹码结构，
 * 玩家必须给出明确选择，否则对局无法继续；行内提示容易被忽略。
 *
 * 交互约定：
 *   - Escape = 「不补码」（与「取消」语义一致，避免误触补码）；
 *   - 打开时焦点落在主按钮（补码）上，键盘用户可直接回车确认；
 *   - 两个按钮都是原生 <button>，Tab 顺序即 DOM 顺序。
 */

import { useEffect, useId, useRef } from 'react';
import type { JSX } from 'react';
import type { PendingBust } from '../controller.js';
import '../styles/session.css';

export interface RebuyDialogProps {
  /** 队首的待决策座位。 */
  bust: PendingBust;
  startingStack: number;
  bigBlind: number;
  /** 若该 AI 选择下桌后会只剩玩家有筹码（即赢下整桌）。 */
  winTableIfOut: boolean;
  onResolve: (rebuy: boolean) => void;
}

export function RebuyDialog({
  bust,
  startingStack,
  bigBlind,
  winTableIfOut,
  onResolve,
}: RebuyDialogProps): JSX.Element {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const isHero = bust.who === 'hero';

  // 打开时把焦点交给主按钮：键盘用户无需先 Tab 一轮。
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  // Escape 视为「不补码」；监听挂在 window 上，弹窗关闭即清理。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onResolve(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onResolve]);

  const title = isHero ? '你的筹码输光了' : `${bust.name} 的筹码输光了`;
  const body = isHero
    ? `当前资金 ${bust.stack}，低于一个大盲（${bigBlind}），无法继续入局。是否补码到 ${startingStack}？`
    : `${bust.name} 只剩 ${bust.stack}（不足一个大盲 ${bigBlind}）。是否给它补码到 ${startingStack}？`;

  return (
    <div className="rebuy-backdrop">
      <div
        className="rebuy-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="rebuy-dialog"
      >
        <h2 id={titleId}>{title}</h2>
        <p className="rebuy-body">{body}</p>
        {winTableIfOut && (
          <p className="rebuy-hint">
            {`如果不补码，${bust.name === '你' ? '你' : '它'}将下桌——届时只剩你有筹码，本局以你赢下整桌结束。`}
          </p>
        )}
        <div className="rebuy-actions">
          <button
            type="button"
            className="ghost"
            data-testid="rebuy-no"
            onClick={() => onResolve(false)}
          >
            不补码
          </button>
          <button
            type="button"
            className="primary"
            data-testid="rebuy-yes"
            ref={primaryRef}
            onClick={() => onResolve(true)}
          >
            补码到 {startingStack}
          </button>
        </div>
      </div>
    </div>
  );
}
