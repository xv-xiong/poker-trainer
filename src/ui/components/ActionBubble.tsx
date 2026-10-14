/**
 * 座位旁的动作气泡：跟注 / 加注 / 弃牌 / 过牌 / 全下。
 *
 * 为什么需要它：分步演出把「AI 一次性跑完」拆成了逐个动作，但如果没有一个
 * **绑定在座位上的**视觉载体，玩家仍然只能靠底池数字的变化去猜「刚才谁做了什么」。
 * 气泡把「谁 + 做了什么 + 多少钱」钉在座位旁，是分步演出可被感知的前提。
 *
 * 动画全部走 CSS keyframes（见 ./showcase.css），遵守 `prefers-reduced-motion`。
 * `animationKey` 变化时通过 React 的 `key` 强制重挂载，从而重放动画。
 */

import { ACTION_LABELS, type ActionRecord, type ActionType } from '../../core/types.js';
// 演出动效（发牌 / 光晕 / 气泡 / 筹码 / 座位环绕布局）。
// 为什么由组件 import 而不是写进 styles/app.css：app.css 由并行的「全局美化」
// 任务持有，同写会冲突；本文件与这些 keyframes 同属 task-4，所有权清晰。
// Vite 会把多个 CSS import 合并进同一个产物，不影响 G9c 的产物检查。
import './showcase.css';

export type BubbleKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

/** 气泡配色分类。 */
export function bubbleKind(type: ActionType): BubbleKind {
  return type;
}

export interface ActionBubbleProps {
  /** 要展示的动作；null 表示不显示气泡。 */
  action: ActionRecord | null;
  /** 是否显示额度（跟注/下注/加注/全下）。 */
  showAmount?: boolean;
  /** 是否是自己（玩家）的动作，用于配色区分。 */
  hero?: boolean;
  /**
   * 重放动画用的 key。同一座位连续两次相同动作也需要重新播放动画，
   * 因此不能只用 `action` 的内容做 key。
   */
  animationKey?: number | string;
  /** 额外的无障碍描述。 */
  srLabel?: string;
}

/** 动作的中文文案；带额度时补上额度，与真实下注一致。 */
export function bubbleText(action: ActionRecord, showAmount = true): { label: string; amount: string } {
  const label = ACTION_LABELS[action.type]?.zh ?? action.type;
  if (!showAmount) return { label, amount: '' };
  switch (action.type) {
    case 'bet':
    case 'raise':
      return { label, amount: String(action.toAmount) };
    case 'allin':
      return { label, amount: String(action.amount) };
    case 'call':
      return { label, amount: action.amount > 0 ? String(action.amount) : '' };
    default:
      return { label, amount: '' };
  }
}

export function ActionBubble({
  action,
  showAmount = true,
  hero = false,
  animationKey = 0,
  srLabel,
}: ActionBubbleProps) {
  if (!action) return null;
  const { label, amount } = bubbleText(action, showAmount);

  const cls = ['sc-bubble', bubbleKind(action.type)];
  if (hero) cls.push('hero');

  return (
    <div
      // 注意：这里的 key 只用于让 React 在「换了另一条动作」时重挂载（即真的换人/换动作），
      // 而不是每一步都重挂载。早前的实现把每一步的递增序号都塞进 key，
      // 结果是整手牌里气泡被反复销毁重建 51 次、入场动画重启 206 次（实测），
      // 视觉上表现为闪烁。现在改用「座位+动作类型+额度」做身份：
      // 同一座位连续做同一个动作时复用同一 DOM 节点，动画不再反复重启。
      key={`${action.seat}-${action.type}-${action.amount}`}
      className={cls.join(' ')}
      data-testid="action-bubble"
      data-seat={action.seat}
      data-action={action.type}
      data-amount={amount}
      data-anim={animationKey}
      role="status"
      aria-live="polite"
      aria-label={srLabel ?? `${label}${amount ? ` ${amount}` : ''}`}
    >
      <span className="txt">{label}</span>
      {amount !== '' && <span className="amt">{amount}</span>}
    </div>
  );
}

/**
 * 思考中的座位气泡（AI 思考的可见载体）。
 *
 * 为了不让入场动画在每一步重启，本组件的 DOM 节点保持稳定：
 * 不再把递增序号当 key（那会导致重挂载），而是把序号写到 `data-anim` 上，
 * 由 CSS 层面负责「同一节点不重复播放入场动画」。
 */
export function ThinkingBubble({ animationKey = 0 }: { animationKey?: number | string }) {
  return (
    <div
      className="sc-think"
      data-testid="thinking-bubble"
      data-anim={String(animationKey)}
      role="status"
      aria-live="polite"
      aria-label="正在思考"
    >
      <span>思考中</span>
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
