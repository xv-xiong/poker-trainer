/**
 * 顶层应用：标签页布局 + 状态订阅 + AI 轮转调度。
 *
 * 不使用路由库（已定案）：标签页用组件状态切换，避免额外依赖。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { GameController, type ControllerSnapshot } from './controller.js';
import { createEquityClient } from './equityClient.js';
import { createMemoryStorage, type StorageLike } from '../store/persistence.js';
import { TableView } from './components/TableView.js';
import { ActionBar } from './components/ActionBar.js';
import { ReviewPanel } from './panels/ReviewPanel.js';
import { StatsPanel } from './panels/StatsPanel.js';
import { HistoryPanel } from './panels/HistoryPanel.js';
import { SettingsPanel } from './panels/SettingsPanel.js';
import type { ActionType } from '../core/types.js';

type Tab = 'table' | 'review' | 'stats' | 'history' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'table', label: '牌桌' },
  { id: 'review', label: '复盘' },
  { id: 'stats', label: '统计' },
  { id: 'history', label: '历史' },
  { id: 'settings', label: '设置' },
];

/** 获取可用的 localStorage；不可用时降级为内存存储（隐私模式等）。 */
function resolveStorage(): StorageLike {
  try {
    const probe = '__poker_trainer_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return createMemoryStorage();
  }
}

export function App() {
  const controllerRef = useRef<GameController | null>(null);
  if (controllerRef.current === null) {
    // 胜率计算走 Web Worker（后台线程），避免重计算阻塞渲染
    controllerRef.current = new GameController({
      storage: resolveStorage(),
      heroSeat: 0,
      equityClient: createEquityClient(),
    });
  }
  const controller = controllerRef.current;

  const [snap, setSnap] = useState<ControllerSnapshot>(() => controller.snapshot());
  const [tab, setTab] = useState<Tab>('table');
  const [hintLoading, setHintLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionStartRef = useRef<number>(Date.now());

  useEffect(() => controller.subscribe(setSnap), [controller]);

  // 轮到 AI 时自动推进。
  // 依赖 snap.revision 而非 snap.state：state 是原地修改的对象，引用不会变，
  // 若依赖引用则「玩家行动后 AI 不再行动」，本手会永久卡住（已由 E2E 捕获）。
  useEffect(() => {
    if (!snap.state || snap.state.finished) return;
    if (snap.state.actingSeat >= 0 && snap.state.actingSeat !== controller.heroSeat) {
      const t = setTimeout(() => controller.runAI(), 300);
      return () => clearTimeout(t);
    }
  }, [snap.revision, snap.state, controller]);

  // 玩家回合开始时记录起始时间（用于思考耗时）
  useEffect(() => {
    if (snap.heroTurn) actionStartRef.current = Date.now();
  }, [snap.heroTurn, snap.revision]);

  const handleAct = (type: ActionType, toAmount = 0) => {
    const thinkMs = Date.now() - actionStartRef.current;
    const r = controller.act(type, toAmount, thinkMs);
    if (!r.ok) {
      setActionError(r.error ?? '动作失败');
      setTimeout(() => setActionError(null), 2600);
    } else {
      setActionError(null);
    }
  };

  const handleHint = async () => {
    setHintLoading(true);
    try {
      await controller.requestHint();
    } finally {
      setHintLoading(false);
    }
  };

  const handleNextHand = () => {
    controller.startHand();
    controller.runAI();
  };

  // 开局：首次进入自动发牌
  useEffect(() => {
    if (!snap.state) {
      controller.startHand();
      controller.runAI();
    }
    // 仅在首次挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 快捷键：N 开始下一手
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.key.toLowerCase() === 'n' && snap.state?.finished) {
        e.preventDefault();
        handleNextHand();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pot = useMemo(
    () => (snap.state ? snap.state.seats.reduce((a, s) => a + s.committed, 0) : 0),
    [snap.revision, snap.state],
  );

  const lastHandNet = snap.lastRecord?.heroNet ?? 0;

  return (
    <div className={`app ${snap.settings.fourColorDeck ? '' : 'two-color'}`}>
      <div className="topbar">
        <div className="brand">
          <h1>德州扑克练习台</h1>
          <span className="sub">Texas Hold'em Trainer · 单人练习</span>
        </div>

        <div className="tabs" role="tablist" aria-label="主导航">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="bankroll">
          <span className="muted small">资金</span>
          <span className="amount">{snap.bankroll}</span>
          {snap.lastRecord && (
            <span className={`delta ${lastHandNet >= 0 ? 'up' : 'down'}`}>
              {lastHandNet >= 0 ? '+' : ''}
              {lastHandNet}
            </span>
          )}
        </div>
      </div>

      {snap.notices.length > 0 && (
        <div className="notice" role="status">
          <span>{snap.notices.join('；')}</span>
          <button className="ghost" onClick={() => controller.dismissNotices()}>
            知道了
          </button>
        </div>
      )}

      {actionError && (
        <div className="notice" role="alert">
          <span>动作无效：{actionError}</span>
        </div>
      )}

      {tab === 'table' && (
        <>
          {!snap.state ? (
            <div className="panel">
              <div className="empty">正在发牌…</div>
            </div>
          ) : (
            <div className="table-wrap">
              <TableView state={snap.state} heroSeat={controller.heroSeat} revealAll={false} />
              <ActionBar
                legal={snap.legal}
                pot={pot}
                bigBlind={snap.settings.bigBlind}
                heroTurn={snap.heroTurn}
                finished={snap.state.finished}
                hint={snap.hint}
                hintLoading={hintLoading}
                showShortcuts={snap.settings.showShortcuts}
                onAct={handleAct}
                onHint={handleHint}
                onNextHand={handleNextHand}
              />
            </div>
          )}

          {snap.state?.finished && (
            <div className="panel" style={{ marginTop: 16 }}>
              <h2>本手结果</h2>
              <div className="stats-grid">
                <div className="stat">
                  <div className="k">你的净盈亏</div>
                  <div className={`v ${lastHandNet >= 0 ? 'pos' : 'neg'}`}>
                    {lastHandNet >= 0 ? '+' : ''}
                    {lastHandNet}
                  </div>
                </div>
                <div className="stat">
                  <div className="k">结束方式</div>
                  <div className="v" style={{ fontSize: 15 }}>
                    {snap.state.finishReason === 'showdown' ? '摊牌（Showdown）' : '对手弃牌'}
                  </div>
                </div>
                <div className="stat">
                  <div className="k">底池</div>
                  <div className="v">{snap.state.pots.reduce((a, p) => a + p.amount, 0)}</div>
                </div>
                <div className="stat">
                  <div className="k">底池层数</div>
                  <div className="v">{snap.state.pots.length}</div>
                </div>
              </div>
              <div className="action-row" style={{ marginTop: 12 }}>
                <button className="primary" onClick={() => setTab('review')}>
                  查看复盘
                </button>
                <button onClick={handleNextHand}>下一手</button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'review' && <ReviewPanel record={snap.lastRecord} review={snap.lastReview} />}
      {tab === 'stats' && <StatsPanel stats={snap.stats} bankroll={snap.bankroll} />}
      {tab === 'history' && (
        <HistoryPanel history={snap.history} onClear={() => controller.clearHistory()} />
      )}
      {tab === 'settings' && (
        <SettingsPanel
          settings={snap.settings}
          onChange={(patch) => controller.updateSettings(patch)}
          onResetBankroll={() => controller.resetBankroll()}
        />
      )}
    </div>
  );
}
