/**
 * 本局结算面板（继承模式的两种结局：玩家出局 / 赢下整桌）。
 *
 * 信息层级按「先结论、再数据、后细节」排列：
 *   标题 + 手数/净盈亏 → 关键指标 → 决策分级 → 最亏的几个决策 → 建议 → 结语。
 * 全部内容来自纯函数 `buildSessionSummary`，本组件只负责呈现，不重复计算。
 */

import type { JSX } from 'react';
import type { SessionSummary } from '../../review/session.js';
import type { SessionEndKind } from '../../store/schema.js';
import '../styles/session.css';

export interface SessionEndPanelProps {
  kind: SessionEndKind;
  summary: SessionSummary;
  bankroll: number;
  bigBlind: number;
  onRestart: () => void;
  onOpenReview: () => void;
  onOpenStats: () => void;
}

/** 0..1 的比例转成整数百分比文案。 */
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function SessionEndPanel({
  kind,
  summary,
  onRestart,
  onOpenReview,
  onOpenStats,
}: SessionEndPanelProps): JSX.Element {
  const { handsPlayed, netBB, vpip, pfr, okRatio, decisions, grades, worst, advice, headline, closing } =
    summary;

  return (
    <section className="session-panel" data-testid="session-end" data-kind={kind}>
      <header className="session-head">
        <h2>{headline}</h2>
        <p className="session-sub muted small">
          {`共 ${handsPlayed} 手 · 净盈亏 ${netBB >= 0 ? '+' : ''}${netBB.toFixed(1)} BB`}
        </p>
      </header>

      <div className="session-metrics">
        <div className="session-metric">
          <span className="k">入池率</span>
          <span className="v">{pct(vpip)}</span>
        </div>
        <div className="session-metric">
          <span className="k">翻前加注</span>
          <span className="v">{pct(pfr)}</span>
        </div>
        <div className="session-metric">
          <span className="k">正常决策</span>
          <span className="v">{pct(okRatio)}</span>
        </div>
        <div className="session-metric">
          <span className="k">决策数</span>
          <span className="v">{decisions}</span>
        </div>
      </div>

      <div className="session-grades">
        <span className="g-ok">正常 {grades.ok}</span>
        <span className="g-review">值得复盘 {grades.review}</span>
        <span className="g-major">明显偏离 {grades.major}</span>
      </div>

      {worst.length > 0 && (
        <section className="session-block">
          <h3>最亏的几个决策</h3>
          <ul className="session-worst">
            {worst.slice(0, 3).map((w, i) => (
              <li key={`${w.street}-${i}`}>
                {`${w.streetLabel} · 你${w.actualLabel} → 建议${w.bestLabel} · 损失 ${w.evLossBB.toFixed(1)} BB`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="session-block">
        <h3>建议</h3>
        <ul className="session-advice">
          {advice.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </section>

      <p className="session-closing">{closing}</p>

      <div className="session-actions">
        <button type="button" className="primary" data-testid="session-restart" onClick={onRestart}>
          再来一局
        </button>
        <button type="button" className="ghost" onClick={onOpenReview}>
          查看复盘
        </button>
        <button type="button" className="ghost" onClick={onOpenStats}>
          查看统计
        </button>
      </div>
    </section>
  );
}
