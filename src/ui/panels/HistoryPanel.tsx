/**
 * 历史面板：最近手牌列表 + 导出（JSON / CSV）。
 */

import { Fragment, useState } from 'react';
import { ACTION_LABELS, STREET_LABELS, type HandRecord } from '../../core/types.js';
import { cardToString } from '../../core/cards.js';
import { exportCsv, exportJson, downloadText } from '../../store/export.js';
import { replayabilityOf } from '../replay.js';

export function HistoryPanel({
  history,
  onClear,
  onReplay,
}: {
  history: readonly HandRecord[];
  onClear: () => void;
  /** 点「回放」时回调；不传则不渲染回放按钮（便于其他入口复用本面板）。 */
  onReplay?: (record: HandRecord) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const doExportJson = () => {
    downloadText(`poker-trainer-history-${Date.now()}.json`, exportJson(history), 'application/json');
  };
  const doExportCsv = () => {
    downloadText(`poker-trainer-decisions-${Date.now()}.csv`, exportCsv(history), 'text/csv');
  };

  return (
    <div className="panel">
      <h2>手牌历史（Hand History）</h2>

      <div className="action-row history-toolbar">
        <button onClick={doExportJson} disabled={history.length === 0}>
          导出 JSON
        </button>
        <button onClick={doExportCsv} disabled={history.length === 0}>
          导出 CSV
        </button>
        <button className="danger" onClick={onClear} disabled={history.length === 0}>
          清空历史
        </button>
      </div>

      <div className="muted small history-summary">
        共 {history.length} 手（上限 500，超出按 FIFO 淘汰）。JSON 保留完整结构，CSV 逐决策点展开。
      </div>

      {history.length === 0 ? (
        <div className="empty">还没有历史记录。</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>手牌</th>
              <th>底牌</th>
              <th>公共牌</th>
              <th>净盈亏</th>
              <th>决策点</th>
              <th>偏离</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...history].reverse().map((h) => {
              const hole = h.holeCards[h.heroSeat] ?? [];
              const deviations = h.review.filter((r) => r.grade !== 'ok').length;
              const isOpen = expanded === h.handId;
              // 结构残缺的记录直接置灰：比点进去才报错更早暴露问题
              const replayBlocked = onReplay ? replayabilityOf(h) : '未启用';
              return (
                <Fragment key={h.handId}>
                  <tr>
                    <td className="num">{h.handId}</td>
                    <td>{hole.map(cardToString).join(' ')}</td>
                    <td>{h.board.map(cardToString).join(' ') || '—'}</td>
                    <td className={`num ${h.heroNet >= 0 ? 'num-hero' : 'neg'}`}>
                      {h.heroNet >= 0 ? '+' : ''}
                      {h.heroNet}
                    </td>
                    <td className="num">{h.review.length}</td>
                    <td className="num">{deviations > 0 ? deviations : '—'}</td>
                    <td>
                      <div className="history-actions">
                        {onReplay && (
                          <button
                            className="ghost"
                            data-testid={`replay-${h.handId}`}
                            onClick={() => onReplay(h)}
                            disabled={replayBlocked !== null}
                            title={replayBlocked ?? '在牌桌上逐步重放这一手（只读，不写入统计）'}
                          >
                            回放
                          </button>
                        )}
                        <button className="ghost" onClick={() => setExpanded(isOpen ? null : h.handId)}>
                          {isOpen ? '收起' : '详情'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${h.handId}-detail`}>
                      <td colSpan={7}>
                        <div className="muted small history-detail-meta">
                          种子 {h.seed} · {h.seatCount} 人桌 · 庄家座位 {h.dealerSeat} · 盲注 {h.smallBlind}/{h.bigBlind}
                        </div>
                        {h.actions.length === 0 ? (
                          <div className="muted small">无动作记录。</div>
                        ) : (
                          <table>
                            <thead>
                              <tr>
                                <th>街</th>
                                <th>座位</th>
                                <th>动作</th>
                                <th>额度</th>
                                <th>底池</th>
                              </tr>
                            </thead>
                            <tbody>
                              {h.actions.map((a, i) => (
                                <tr key={i}>
                                  <td>{STREET_LABELS[a.street].zh}</td>
                                  <td>{a.seat === h.heroSeat ? '你' : `座位 ${a.seat + 1}`}</td>
                                  <td>{ACTION_LABELS[a.type].zh}</td>
                                  <td className="num">{a.amount > 0 ? a.amount : '—'}</td>
                                  <td className="num">{a.potAtAction}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
