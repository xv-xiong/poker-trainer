/**
 * 操作区：动作按钮、加注滑杆与快捷尺度、提示面板、快捷键提示。
 */

import { useEffect, useMemo, useState } from 'react';
import { ACTION_LABELS, type ActionType } from '../../core/types.js';
import type { LegalActions } from '../../core/betting.js';

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
}) {
  const minRaise = legal?.minRaiseTo ?? 0;
  const maxRaise = legal?.maxRaiseTo ?? 0;
  const [raiseTo, setRaiseTo] = useState(minRaise);

  useEffect(() => {
    setRaiseTo(minRaise);
  }, [minRaise, maxRaise]);

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
  useEffect(() => {
    if (!heroTurn || !legal) return;
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
  }, [heroTurn, legal, raiseTo, onAct]);

  if (finished) {
    return (
      <div className="action-panel">
        <h3>本手已结束</h3>
        <button className="primary" onClick={onNextHand}>
          下一手（Next Hand）
        </button>
        <div className="keyhints">按 <kbd>N</kbd> 也可开始下一手</div>
      </div>
    );
  }

  if (!heroTurn) {
    return (
      <div className="action-panel">
        <h3>等待中</h3>
        <div className="muted small">对手正在行动（AI 思考中）…</div>
      </div>
    );
  }

  const canRaise = legal?.canRaise ?? false;
  const callLabel = legal?.canCheck
    ? `${ACTION_LABELS.check.zh}（Check）`
    : `${ACTION_LABELS.call.zh}（Call） ${legal?.callAmount ?? 0}`;

  return (
    <div className="action-panel">
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
            <button onClick={() => onAct('allin')} disabled={!legal?.canAllIn}>
              全下（All-in）
            </button>
          </div>
        </div>
      )}

      <button className="ghost" onClick={onHint} disabled={hintLoading}>
        {hintLoading ? '计算中…' : '查看提示（Hint）'}
      </button>

      {hint && (
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
