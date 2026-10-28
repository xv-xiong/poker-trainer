/**
 * 操作区：动作按钮、加注滑杆与快捷尺度、提示面板、快捷键提示。
 *
 * 演出接入（task-4）：
 *   - `heroTurnActive`：把「演出中的禁用」（AI 思考中 / 公共牌还没发完 /
 *     自己的动作气泡还没退场）算进去。**必须用它，而不是 controller 的
 *     `heroTurn`**——后者在 AI 交回行动的同一帧就为 true，但画面上 AI 的动作
 *     还没演完，此时放行点击会造成「动作被动画吞掉」的误操作。
 *   - `waiting`：AI 思考 / 发牌中，显示等待态（而不是「轮到你」的按钮）。
 *   - 禁用只作用于按钮与快捷键；`onAct` 的结果仍由 controller 判定，
 *     因此即使禁用被绕过也不会改变对局结果。
 *
 * 全下二次确认（审计 P1-6）：
 *   全下是唯一「一次误点就不可挽回」的动作（弃牌同样不可撤销，但它是高频动作，
 *   每次加确认会显著拖慢练习节奏，因此不加）。实现方式是**同一个按钮二次点击**，
 *   而不是弹窗：弹窗会打断键盘流，也会在移动端遮住牌桌。3 秒内不确认则自动复位，
 *   避免「以为没点上、其实已经进入确认态」的歧义。
 */

import { useEffect, useMemo, useState } from 'react';
import { ACTION_LABELS, type ActionType } from '../../core/types.js';
import type { LegalActions } from '../../core/betting.js';
import '../styles/actionbar.css';

/** 全下确认态的有效时长（毫秒）。超时自动复位，防止误判「卡在确认态」。 */
const ALLIN_CONFIRM_MS = 3000;

export function ActionBar({
  legal,
  pot,
  bigBlind,
  heroTurn,
  finished,
  hint,
  hintLoading,
  showShortcuts,
  onAct,
  onHint,
  onNextHand,
  heroTurnActive,
  waiting = false,
  waitingLabel = '对手正在行动（AI 思考中）…',
  settleHold = false,
}: {
  legal: LegalActions | null;
  pot: number;
  bigBlind: number;
  heroTurn: boolean;
  finished: boolean;
  hint: { equity: number; potOdds: number; source: string; action: string } | null;
  hintLoading: boolean;
  showShortcuts: boolean;
  onAct: (type: ActionType, toAmount?: number) => void;
  onHint: () => void;
  onNextHand: () => void;
  /** 演出后**真正**可行动；不传则退化为 controller 的 `heroTurn`。 */
  heroTurnActive?: boolean;
  /** 是否处于「演出中」（AI 思考中 / 发牌中 / 自己的气泡停留中）。 */
  waiting?: boolean;
  waitingLabel?: string;
  /** 本手是否已结束但仍在结算停顿中（此时不显示「下一手」，避免连点）。 */
  settleHold?: boolean;
}) {
  const canAct = heroTurnActive ?? heroTurn;
  const minRaise = legal?.minRaiseTo ?? 0;
  const maxRaise = legal?.maxRaiseTo ?? 0;
  const [raiseTo, setRaiseTo] = useState(minRaise);
  /** 全下是否已进入「待确认」状态（再点一次才真正执行）。 */
  const [allinArmed, setAllinArmed] = useState(false);

  useEffect(() => {
    setRaiseTo(minRaise);
    // 行动权或可加注区间变化（含换街、换手、轮到别人）时，确认态一律复位：
    // 否则上一手残留的「确认中」会让下一次全下变成单击即执行。
    setAllinArmed(false);
  }, [minRaise, maxRaise, canAct]);

  // 确认态超时复位
  useEffect(() => {
    if (!allinArmed) return;
    const t = setTimeout(() => setAllinArmed(false), ALLIN_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [allinArmed]);

  const quickSizes = useMemo(() => {
    if (!legal?.canRaise) return [];
    const base = pot + legal.callAmount;
    const sizes: { label: string; value: number }[] = [
      { label: '1/2 池', value: Math.round(base * 0.5) },
      { label: '2/3 池', value: Math.round(base * 0.667) },
      { label: '满池', value: base },
      { label: '全下', value: maxRaise },
    ];
    return sizes
      .map((s) => ({
        ...s,
        value: Math.max(minRaise, Math.min(maxRaise, s.value)),
      }))
      .filter((s, i, arr) => arr.findIndex((x) => x.value === s.value) === i);
  }, [legal, pot, minRaise, maxRaise]);

  // 快捷键（桌面端）
  // 依赖里必须带 `canAct`：演出期间（canAct=false）不得响应任何动作快捷键，
  // 否则玩家能在 AI 还在演的时候用键盘抢先出牌。
  useEffect(() => {
    if (!canAct || !legal || waiting) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'f' && legal.canFold) {
        e.preventDefault();
        onAct('fold');
      } else if (k === 'c') {
        e.preventDefault();
        if (legal.canCheck) onAct('check');
        else if (legal.canCall) onAct('call');
      } else if (k === 'r' && legal.canRaise) {
        e.preventDefault();
        onAct('raise', raiseTo);
      } else if (k === ' ' && legal.canRaise) {
        e.preventDefault();
        onAct('raise', raiseTo);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canAct, waiting, legal, raiseTo, onAct]);

  if (finished) {
    return (
      <div className={`action-panel ${settleHold ? 'sc-waiting' : 'sc-my-turn'}`}>
        <h3>本手已结束</h3>
        {settleHold ? (
          <div className="muted small">结算中…</div>
        ) : (
          <button className="primary" onClick={onNextHand}>
            下一手（Next Hand）
          </button>
        )}
        {!settleHold && (
          <div className="keyhints">
            按 <kbd>N</kbd> 也可开始下一手
          </div>
        )}
      </div>
    );
  }

  if (!canAct) {
    return (
      <div className="action-panel sc-waiting" data-testid="action-waiting">
        <h3>{waiting ? '等待中' : '你的行动'}</h3>
        <div className="muted small">{waiting ? waitingLabel : '动作确认中…'}</div>
        <div className="sc-waiting-bar" aria-hidden="true">
          <span />
        </div>
        {/* 保留按钮结构但全部禁用：一方面让「稍后就能点」可预期，
            另一方面避免布局在等待/行动之间跳动 */}
        <div className="action-row">
          <button className="danger" disabled>
            弃牌（Fold）
          </button>
          <button className="primary" disabled>
            跟注 / 过牌（Call / Check）
          </button>
        </div>
        <div className="keyhints muted small">演出进行中，动作按钮已暂时禁用</div>
      </div>
    );
  }

  const canRaise = legal?.canRaise ?? false;
  const callLabel = legal?.canCheck
    ? `${ACTION_LABELS.check.zh}（Check）`
    : `${ACTION_LABELS.call.zh}（Call） ${legal?.callAmount ?? 0}`;

  /**
   * 全下点击：第一次只进入确认态，第二次才真正执行。
   * 用按钮文案本身表达状态（不额外插 DOM），避免确认态把仪表盘撑高、
   * 进而让牌桌高度变化（那会引起整页轻微跳动）。
   */
  const handleAllIn = () => {
    if (!allinArmed) {
      setAllinArmed(true);
      return;
    }
    setAllinArmed(false);
    onAct('allin');
  };

  return (
    <div className="action-panel sc-my-turn hint-host" data-testid="action-my-turn">
      <h3>你的行动</h3>

      <div className="action-row">
        <button className="danger" onClick={() => onAct('fold')} disabled={!legal?.canFold}>
          弃牌（Fold）
        </button>
        <button
          className="primary"
          onClick={() => (legal?.canCheck ? onAct('check') : onAct('call'))}
          disabled={!legal?.canCheck && !legal?.canCall}
        >
          {callLabel}
        </button>
      </div>

      {canRaise && (
        <div className="raise-box">
          <div className="row">
            <span className="muted small">加注到</span>
            <span className="amount">{raiseTo}</span>
          </div>
          <input
            type="range"
            min={minRaise}
            max={maxRaise}
            step={bigBlind}
            value={raiseTo}
            aria-label="加注额度"
            /* 读屏只念数字时听不出这是「加注到」还是「筹码数」，
               补上语义 + BB 对照（WCAG 2.2 · 1.3.1 / 4.1.2）。 */
            aria-valuetext={`加注到 ${raiseTo}（约 ${(raiseTo / Math.max(1, bigBlind)).toFixed(1)} BB）`}
            onChange={(e) => setRaiseTo(Number(e.target.value))}
          />
          <div className="quick-sizes">
            {quickSizes.map((s) => (
              <button key={s.label} onClick={() => setRaiseTo(s.value)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="action-row">
            <button className="primary" onClick={() => onAct('raise', raiseTo)}>
              加注（Raise）
            </button>
            <button
              className={allinArmed ? 'danger' : undefined}
              onClick={handleAllIn}
              disabled={!legal?.canAllIn}
              data-testid="btn-allin"
              title={allinArmed ? '再点一次确认全下' : '全下需要二次确认'}
            >
              {allinArmed ? '确认全下？' : '全下（All-in）'}
            </button>
          </div>
          {/* 确认态播报：放在 sr-only 里，不改变布局高度 */}
          <span className="sr-only" role="status" aria-live="polite">
            {allinArmed ? '已进入全下确认，请再点一次确认全下；3 秒后自动取消。' : ''}
          </span>
        </div>
      )}

      <button className="ghost" onClick={onHint} disabled={hintLoading}>
        {hintLoading ? '计算中…' : '查看提示（Hint）'}
      </button>

      {hint && (
        <div className="hint-pop">
          <div className="hint-box">
            <div className="kv">
              <span className="k">估算胜率</span>
              <span className="v">{(hint.equity * 100).toFixed(1)}%</span>
            </div>
            <div className="bar">
              <span style={{ width: `${Math.min(100, hint.equity * 100)}%` }} />
            </div>
            <div className="kv">
              <span className="k">底池赔率要求</span>
              <span className="v">{(hint.potOdds * 100).toFixed(1)}%</span>
            </div>
            <div className="bar warn">
              <span style={{ width: `${Math.min(100, hint.potOdds * 100)}%` }} />
            </div>
            <div className="kv">
              <span className="k">建议</span>
              <span className="v">{hint.action}</span>
            </div>
            <div className="muted small">
              来源：{hint.source === 'lookup' ? '查表值' : hint.source === 'exact' ? '精确枚举值' : '蒙特卡洛采样值'}
            </div>
          </div>
        </div>
      )}

      {showShortcuts && (
        <div className="keyhints">
          <span>
            <kbd>F</kbd> 弃牌
          </span>
          <span>
            <kbd>C</kbd> 跟注/过牌
          </span>
          <span>
            <kbd>R</kbd> 加注
          </span>
          <span>
            <kbd>Space</kbd> 确认加注
          </span>
        </div>
      )}
    </div>
  );
}
