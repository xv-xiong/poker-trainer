/**
 * 统计面板：累计数据与数据可视化。
 */

import type { Stats } from '../../core/types.js';

function pct(n: number, d: number): string {
  if (d === 0) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

export function StatsPanel({ stats, bankroll }: { stats: Stats; bankroll: number }) {
  const vpip = stats.handsPlayed > 0 ? (stats.vpipHands / stats.handsPlayed) * 100 : 0;
  const pfr = stats.handsPlayed > 0 ? (stats.pfrHands / stats.handsPlayed) * 100 : 0;
  const wtsd = stats.handsPlayed > 0 ? (stats.showdownsSeen / stats.handsPlayed) * 100 : 0;
  const totalDecisions = stats.reviewCounts.ok + stats.reviewCounts.review + stats.reviewCounts.major;
  const okRate = totalDecisions > 0 ? (stats.reviewCounts.ok / totalDecisions) * 100 : 0;

  return (
    <div className="panel">
      <h2>统计（Statistics）</h2>

      <div className="stats-grid">
        <div className="stat">
          <div className="k">当前资金</div>
          <div className={`v ${bankroll >= 1000 ? 'pos' : 'neg'}`}>{bankroll}</div>
        </div>
        <div className="stat">
          <div className="k">累计净盈亏</div>
          <div className={`v ${stats.netProfit >= 0 ? 'pos' : 'neg'}`}>
            {stats.netProfit >= 0 ? '+' : ''}
            {stats.netProfit}
          </div>
        </div>
        <div className="stat">
          <div className="k">已打手数</div>
          <div className="v">{stats.handsPlayed}</div>
        </div>
        <div className="stat">
          <div className="k">赢下手数</div>
          <div className="v">
            {stats.handsWon}
            <span className="muted small"> （{pct(stats.handsWon, stats.handsPlayed)}）</span>
          </div>
        </div>
        <div className="stat">
          <div className="k">摊牌次数</div>
          <div className="v">{stats.showdownsSeen}</div>
        </div>
        <div className="stat">
          <div className="k">摊牌胜率</div>
          <div className="v">{pct(stats.showdownsWon, stats.showdownsSeen)}</div>
        </div>
        <div className="stat">
          <div className="k">总投入筹码</div>
          <div className="v">{stats.totalWagered}</div>
        </div>
        <div className="stat">
          <div className="k">查看提示次数</div>
          <div className="v">{stats.hintsUsed}</div>
        </div>
      </div>

      <h3>打法特征（Style Metrics）</h3>
      <div className="settings-row">
        <div className="label">
          <span>入池率 VPIP</span>
          <span className="hint">主动投钱进池的手数占比</span>
        </div>
        <div style={{ minWidth: 190 }}>
          <div className="kv num" style={{ textAlign: 'right', fontFamily: 'var(--font-num)' }}>
            {vpip.toFixed(1)}%
          </div>
          <div className="bar">
            <span style={{ width: `${Math.min(100, vpip)}%` }} />
          </div>
        </div>
      </div>

      <div className="settings-row">
        <div className="label">
          <span>翻牌前加注率 PFR</span>
          <span className="hint">翻牌前主动加注的手数占比</span>
        </div>
        <div style={{ minWidth: 190 }}>
          <div style={{ textAlign: 'right', fontFamily: 'var(--font-num)' }}>{pfr.toFixed(1)}%</div>
          <div className="bar">
            <span style={{ width: `${Math.min(100, pfr)}%` }} />
          </div>
        </div>
      </div>

      <div className="settings-row">
        <div className="label">
          <span>看到摊牌的比率 WTSD</span>
          <span className="hint">打到摊牌的手数占比</span>
        </div>
        <div style={{ minWidth: 190 }}>
          <div style={{ textAlign: 'right', fontFamily: 'var(--font-num)' }}>{wtsd.toFixed(1)}%</div>
          <div className="bar">
            <span style={{ width: `${Math.min(100, wtsd)}%` }} />
          </div>
        </div>
      </div>

      <h3>决策质量（Decision Quality）</h3>
      {totalDecisions === 0 ? (
        <div className="empty">还没有决策数据。</div>
      ) : (
        <>
          <div className="settings-row">
            <div className="label">
              <span>正常决策占比</span>
              <span className="hint">共 {totalDecisions} 个决策点</span>
            </div>
            <div style={{ minWidth: 190 }}>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-num)' }}>
                {okRate.toFixed(1)}%
              </div>
              <div className="bar">
                <span style={{ width: `${okRate}%` }} />
              </div>
            </div>
          </div>

          <div className="stats-grid" style={{ marginTop: 12 }}>
            <div className="stat">
              <div className="k">正常</div>
              <div className="v pos">{stats.reviewCounts.ok}</div>
            </div>
            <div className="stat">
              <div className="k">值得复盘</div>
              <div className="v" style={{ color: 'var(--warn)' }}>
                {stats.reviewCounts.review}
              </div>
            </div>
            <div className="stat">
              <div className="k">明显偏离</div>
              <div className="v neg">{stats.reviewCounts.major}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
