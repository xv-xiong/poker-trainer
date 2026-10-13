/**
 * JSON / CSV 导出。
 *
 * 无后端：全部在浏览器本地完成。
 * JSON 保留完整结构（可再导入）；CSV 逐决策点展开，便于外部分析。
 */

import { cardToString } from '../core/cards.js';
import type { HandRecord } from '../core/types.js';
import { ACTION_LABELS } from '../core/types.js';

/** 导出完整历史为 JSON 文本。 */
export function exportJson(history: readonly HandRecord[], state?: unknown): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      handCount: history.length,
      state: state ?? null,
      hands: history,
    },
    null,
    2,
  );
}

const CSV_HEADER = [
  'handId',
  'timestamp',
  'street',
  'actionIndex',
  'action',
  'actionZh',
  'amount',
  'toAmount',
  'pot',
  'toCall',
  'potOdds',
  'equity',
  'bestAction',
  'evLoss',
  'grade',
  'thinkMs',
].join(',');

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 导出逐决策点 CSV。
 * 每行对应玩家本人的一个决策点；摊牌信息另起一列以便对照。
 */
export function exportCsv(history: readonly HandRecord[]): string {
  const lines: string[] = [CSV_HEADER];
  for (const h of history) {
    const reviewByIndex = new Map(h.review.map((r) => [r.actionIndex, r]));
    for (const [i, a] of h.actions.entries()) {
      if (a.seat !== h.heroSeat) continue;
      const r = reviewByIndex.get(i);
      lines.push(
        [
          h.handId,
          new Date(h.timestamp).toISOString(),
          a.street,
          i,
          a.type,
          ACTION_LABELS[a.type].zh,
          a.amount,
          a.toAmount,
          a.potAtAction,
          a.toCall,
          r ? r.potOdds.toFixed(4) : '',
          r ? r.equity.toFixed(4) : '',
          r ? r.bestAction : '',
          r ? r.evLoss.toFixed(2) : '',
          r ? r.grade : '',
          a.thinkMs,
        ]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return lines.join('\n');
}

/** 单手摘要文本（用于历史列表展示）。 */
export function handSummary(h: HandRecord): string {
  const hole = h.holeCards[h.heroSeat]?.map(cardToString).join(' ') ?? '';
  const board = h.board.map(cardToString).join(' ');
  const net = h.heroNet >= 0 ? `+${h.heroNet}` : String(h.heroNet);
  return `${hole} | ${board || '(无公共牌)'} | ${net}`;
}

/** 触发浏览器下载（仅在浏览器环境调用）。 */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
