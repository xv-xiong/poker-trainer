/**
 * 复盘面板：逐决策点展示 EV 偏离分级与**原始数据**。
 *
 * 计划强制要求（Q14）：每个标记必须同时展示原始数据
 * （底池赔率、估算胜率、底池额、筹码额、思考耗时），否则无法学习。
 */

import { ACTION_LABELS, STREET_LABELS, type HandRecord, type ReviewEntry } from '../../core/types.js';
import { CardRow } from '../components/CardView.js';
import { bestFive, rank7, categoryNameOf } from '../../core/rank7.js';
import { CATEGORY_LABELS } from '../../core/cards.js';

const GRADE_LABEL: Record<ReviewEntry['grade'], string> = {
  ok: '正常',
  review: '值得复盘',
  major: '明显偏离',
};

function ReviewRow({ e }: { e: ReviewEntry }) {
  const cls = e.grade === 'ok' ? '' : `grade-${e.grade}`;
  return (
    <tr className={cls}>
      <td>{STREET_LABELS[e.street].zh}</td>
      <td>
        {ACTION_LABELS[e.actual].zh}
        {e.actualAmount > 0 ? ` ${e.actualAmount}` : ''}
      </td>
      <td>
        {ACTION_LABELS[e.bestAction].zh}
        {e.bestAmount > 0 ? ` ${e.bestAmount}` : ''}
      </td>
      <td className="num">{e.pot}</td>
      <td className="num">{e.toCall}</td>
      <td className="num">{(e.potOdds * 100).toFixed(1)}%</td>
      <td className="num">{(e.equity * 100).toFixed(1)}%</td>
      <td className="num">{e.evLoss.toFixed(2)}</td>
      <td className="num">{e.thinkMs > 0 ? `${(e.thinkMs / 1000).toFixed(1)}s` : '—'}</td>
      <td>
        <span className={`tag ${e.grade}`}>{GRADE_LABEL[e.grade]}</span>
      </td>
    </tr>
  );
}

export function ReviewPanel({
  record,
  review,
}: {
  record: HandRecord | null;
  review: readonly ReviewEntry[];
}) {
  if (!record) {
    return (
      <div className="panel">
        <h2>决策复盘（Hand Review）</h2>
        <div className="empty">打完一手后，这里会显示每个决策点的 EV 分析。</div>
      </div>
    );
  }

  const hole = record.holeCards[record.heroSeat] ?? [];
  const all = [...hole, ...record.board];
  const best = all.length >= 5 ? bestFive(all) : [];
  const categoryName = best.length === 5 ? CATEGORY_LABELS[categoryNameOf(rank7(best))] : null;

  const gradeCount = review.reduce(
    (acc, e) => {
      acc[e.grade]++;
      return acc;
    },
    { ok: 0, review: 0, major: 0 },
  );

  return (
    <div className="panel">
      <h2>决策复盘（Hand Review）</h2>

      <div className="settings-row">
        <div className="label">
          <span>你的底牌</span>
          <span className="hint">与公共牌</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <CardRow cards={hole} small />
          <span className="muted small">+</span>
          <CardRow cards={record.board} small placeholderCount={5} />
        </div>
      </div>

      {best.length === 5 && categoryName && (
        <div className="settings-row">
          <div className="label">
            <span>最优五张</span>
            <span className="hint">
              7 选 5 的最强组合 · {categoryName.zh}（{categoryName.en}）
            </span>
          </div>
          <CardRow cards={best} small />
        </div>
      )}

      <div className="stats-grid" style={{ marginTop: 12 }}>
        <div className="stat">
          <div className="k">本手净盈亏</div>
          <div className={`v ${record.heroNet >= 0 ? 'pos' : 'neg'}`}>
            {record.heroNet >= 0 ? '+' : ''}
            {record.heroNet}
          </div>
        </div>
        <div className="stat">
          <div className="k">正常决策</div>
          <div className="v">{gradeCount.ok}</div>
        </div>
        <div className="stat">
          <div className="k">值得复盘</div>
          <div className="v" style={{ color: 'var(--warn)' }}>
            {gradeCount.review}
          </div>
        </div>
        <div className="stat">
          <div className="k">明显偏离</div>
          <div className="v neg">{gradeCount.major}</div>
        </div>
        <div className="stat">
          <div className="k">查看提示次数</div>
          <div className="v">{record.hintsUsed}</div>
        </div>
      </div>

      <h3>逐决策点分析</h3>
      {review.length === 0 ? (
        <div className="empty">本手你没有做决策。</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>街</th>
              <th>你的动作</th>
              <th>建议动作</th>
              <th>底池</th>
              <th>需跟注</th>
              <th>底池赔率</th>
              <th>估算胜率</th>
              <th>EV 损失</th>
              <th>耗时</th>
              <th>分级</th>
            </tr>
          </thead>
          <tbody>
            {review.map((e) => (
              <ReviewRow key={e.actionIndex} e={e} />
            ))}
          </tbody>
        </table>
      )}

      <div className="muted small" style={{ marginTop: 10 }}>
        分级阈值：EV 损失 &gt; 0.5BB 标记「值得复盘」，&gt; 2BB 标记「明显偏离」。
        胜率来源：翻牌前为查表值，转牌/河牌单挑为精确枚举值，其余为蒙特卡洛采样值。
      </div>

      <h3>手牌编号</h3>
      <div className="muted small">
        {record.handId}（种子 {record.seed}，可用于精确复现本手）
      </div>
    </div>
  );
}
