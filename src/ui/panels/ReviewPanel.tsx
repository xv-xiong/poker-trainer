/**
 * 复盘面板：逐决策点展示 EV 偏离分级与**原始数据**。
 *
 * 计划强制要求（Q14）：每个标记必须同时展示原始数据
 * （底池赔率、估算胜率、底池额、筹码额、思考耗时），否则无法学习。
 *
 * ## 单位口径（v1.2 修复）
 *
 * 旧版「EV 损失」列直接输出筹码数（如 611.54），而阈值文案写的是 BB（0.5 / 2）。
 * 两套单位并排且都没标，用户无法判断 611.54 到底算不算严重。
 * 现在：EV 损失一律以 **BB** 为主单位（阈值本来就是 BB），筹码原值放 title 里；
 * 底池与需跟注在筹码下方补 BB 对照。
 *
 * ## 为什么有「表格」和「卡片」两套渲染
 *
 * 10 列表格在 1100px 以下必然横向溢出、手机上完全不可读（评估报告 P1-3）。
 * 宽屏用表格做横向对比，窄屏（≤ 900px）改逐决策卡片：街 + 你的动作 →
 * 建议动作 + 关键数字 + 右侧分级标记。两套结构由 CSS 切换，只渲染一次数据。
 */

import { ACTION_LABELS, STREET_LABELS, type HandRecord, type ReviewEntry } from '../../core/types.js';
import { CardRow } from '../components/CardView.js';
import { bestFive, rank7, categoryNameOf } from '../../core/rank7.js';
import { CATEGORY_LABELS } from '../../core/cards.js';
import { ACCEPT_TOLERANCE_BB } from '../../review/ev.js';
import '../styles/review.css';

const GRADE_LABEL: Record<ReviewEntry['grade'], string> = {
  ok: '正常',
  review: '值得复盘',
  major: '明显偏离',
};

function fmtBB(chips: number, bigBlind: number): string {
  const bb = chips / bigBlind;
  const digits = Math.abs(bb) >= 10 ? 1 : 2;
  return `${bb.toFixed(digits)}BB`;
}

function actionText(type: ReviewEntry['actual'], amount: number): string {
  return `${ACTION_LABELS[type].zh}${amount > 0 ? ` ${amount}` : ''}`;
}

function ReviewRow({ e, bigBlind }: { e: ReviewEntry; bigBlind: number }) {
  const cls = e.grade === 'ok' ? '' : `grade-${e.grade}`;
  return (
    <tr className={cls}>
      <td>{STREET_LABELS[e.street].zh}</td>
      <td>{actionText(e.actual, e.actualAmount)}</td>
      <td>{actionText(e.bestAction, e.bestAmount)}</td>
      <td className="num">
        {e.pot}
        <span className="sub">{fmtBB(e.pot, bigBlind)}</span>
      </td>
      <td className="num">
        {e.toCall}
        {e.toCall > 0 && <span className="sub">{fmtBB(e.toCall, bigBlind)}</span>}
      </td>
      <td className="num">{(e.potOdds * 100).toFixed(1)}%</td>
      <td className="num">{(e.equity * 100).toFixed(1)}%</td>
      <td className="num" title={`${e.evLoss.toFixed(2)} 筹码`}>
        {fmtBB(e.evLoss, bigBlind)}
      </td>
      <td className="num">{e.thinkMs > 0 ? `${(e.thinkMs / 1000).toFixed(1)}s` : '—'}</td>
      <td>
        <span className={`tag ${e.grade}`}>{GRADE_LABEL[e.grade]}</span>
      </td>
    </tr>
  );
}

function ReviewCard({ e, bigBlind }: { e: ReviewEntry; bigBlind: number }) {
  return (
    <li className={`review-card grade-${e.grade}`}>
      <div className="rc-head">
        <span className="rc-street">{STREET_LABELS[e.street].zh}</span>
        <span className={`tag ${e.grade}`}>{GRADE_LABEL[e.grade]}</span>
      </div>
      <div className="rc-line">
        <span className="rc-k">你的动作</span>
        <span className="rc-v">{actionText(e.actual, e.actualAmount)}</span>
      </div>
      <div className="rc-line">
        <span className="rc-k">建议动作</span>
        <span className="rc-v">{actionText(e.bestAction, e.bestAmount)}</span>
      </div>
      <div className="rc-nums">
        <div>
          <span className="k">底池</span>
          <span className="v">{e.pot}</span>
          <span className="u">{fmtBB(e.pot, bigBlind)}</span>
        </div>
        <div>
          <span className="k">需跟注</span>
          <span className="v">{e.toCall}</span>
          <span className="u">{e.toCall > 0 ? fmtBB(e.toCall, bigBlind) : '—'}</span>
        </div>
        <div>
          <span className="k">赔率要求</span>
          <span className="v">{(e.potOdds * 100).toFixed(1)}%</span>
          <span className="u">跟注需的最低胜率</span>
        </div>
        <div>
          <span className="k">估算胜率</span>
          <span className="v">{(e.equity * 100).toFixed(1)}%</span>
          <span className="u">你的赢面</span>
        </div>
        <div>
          <span className="k">EV 损失</span>
          <span className="v">{fmtBB(e.evLoss, bigBlind)}</span>
          <span className="u">{e.evLoss.toFixed(2)} 筹码</span>
        </div>
        <div>
          <span className="k">耗时</span>
          <span className="v">{e.thinkMs > 0 ? `${(e.thinkMs / 1000).toFixed(1)}s` : '—'}</span>
          <span className="u">你的决策用时</span>
        </div>
      </div>
    </li>
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

  const bigBlind = record.bigBlind;
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
    <div className="panel review-panel">
      <h2>决策复盘（Hand Review）</h2>

      <div className="review-cards-head">
        <div className="review-card-group">
          <div className="label">
            <span>你的底牌</span>
            <span className="hint">与公共牌</span>
          </div>
          <div className="card-group">
            <CardRow cards={hole} small />
            <span className="muted small">+</span>
            <CardRow cards={record.board} small placeholderCount={5} />
          </div>
        </div>

        {best.length === 5 && categoryName && (
          <div className="review-card-group">
            <div className="label">
              <span>最优五张</span>
              <span className="hint">
                {categoryName.zh}（{categoryName.en}）
              </span>
            </div>
            <div className="card-group">
              <CardRow cards={best} small />
            </div>
          </div>
        )}
      </div>

      <div className="stats-grid" style={{ marginTop: 12 }}>
        <div className="stat">
          <div className="k">本手净盈亏</div>
          <div className={`v ${record.heroNet >= 0 ? 'pos' : 'neg'}`}>
            {record.heroNet >= 0 ? '+' : ''}
            {record.heroNet}
            <span className="sub">{fmtBB(record.heroNet, bigBlind)}</span>
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
        <>
          <div className="review-table-wrap">
            <table className="review-table">
              <thead>
                <tr>
                  <th>街</th>
                  <th>你的动作</th>
                  <th>建议动作</th>
                  <th>底池</th>
                  <th>需跟注</th>
                  <th>底池赔率</th>
                  <th>估算胜率</th>
                  <th title="以 BB 为单位（与分级阈值同口径）">EV 损失 (BB)</th>
                  <th>耗时</th>
                  <th>分级</th>
                </tr>
              </thead>
              <tbody>
                {review.map((e) => (
                  <ReviewRow key={e.actionIndex} e={e} bigBlind={bigBlind} />
                ))}
              </tbody>
            </table>
          </div>

          <ul className="review-card-list">
            {review.map((e) => (
              <ReviewCard key={e.actionIndex} e={e} bigBlind={bigBlind} />
            ))}
          </ul>
        </>
      )}

      <div className="muted small review-footnote">
        分级阈值：EV 损失 &gt; 0.5BB 标记「值得复盘」，&gt; 2BB 标记「明显偏离」；
        与最优动作相差不足 {ACCEPT_TOLERANCE_BB}BB 时视为等价，不推荐边际加注。
        胜率来源：翻牌前为查表值，转牌/河牌单挑为精确枚举值，其余为蒙特卡洛采样值。
      </div>

      <h3>手牌编号</h3>
      <div className="muted small">
        {record.handId}（种子 {record.seed}，可用于精确复现本手）
      </div>
    </div>
  );
}
