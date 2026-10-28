/**
 * 顶层应用：标签页布局 + 状态订阅 + AI 轮转调度。
 *
 * 不使用路由库（已定案）：标签页用组件状态切换，避免额外依赖。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { GameController, type ControllerSnapshot } from './controller.js';
import { createEquityClient } from './equityClient.js';
import { createMemoryStorage, type StorageLike } from '../store/persistence.js';
import { settlementBreakdown, type SettlementLine } from '../core/showdown.js';
import { TableView } from './components/TableView.js';
import { ActionBar } from './components/ActionBar.js';
import { ReviewPanel } from './panels/ReviewPanel.js';
import { StatsPanel } from './panels/StatsPanel.js';
import { HistoryPanel } from './panels/HistoryPanel.js';
import { SettingsPanel } from './panels/SettingsPanel.js';
import { StartScreen } from './components/StartScreen.js';
import { useTableShowcase } from './useTableShowcase.js';
import { stepAiAction } from './showcaseStep.js';
import './styles/tokens.css';
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
  /**
   * 是否已通过开始界面进入牌桌。
   *
   * 为什么不让首访直达牌桌：首访会自动发牌、下盲注并让 AI 行动，
   * 新用户没有机会先确认「桌人数 / 盲注 / 难度」是否符合预期。
   * 因此必须先经过开始界面；但 `?skip-lobby=1` 或旧存档可直接进入，
   * 让既有 E2E 与外部链接（GitHub Pages 书签）无须改动即可直达。
   */
  const [entered, setEntered] = useState<boolean>(
    () => typeof window === 'undefined' || window.location.search.includes('skip-lobby'),
  );

  useEffect(() => controller.subscribe(setSnap), [controller]);

  /**
   * 分步演出：AI 与玩家的每个动作都按「思考 → 动作 → 停顿」逐个呈现，
   * 不再用 `controller.runAI()` 一次跑完整手（那会让结果瞬间跳出）。
   *
   * 接线要点见 useTableShowcase 的文档；这里只负责：
   *   1. 提供「推进一名 AI」的回调（`stepAiAction`，与 runAI 的循环体逐字同构）
   *   2. 用一个随 snap.revision 清理的定时器驱动「当前该执行的一步」
   */
  const runAiRef = useRef<() => boolean>(() => false);
  const aiGuardRef = useRef(0);

  const table = useTableShowcase({
    snap,
    heroSeat: controller.heroSeat,
    runAiStep: () => runAiRef.current(),
  });

  useEffect(() => {
    runAiRef.current = () => {
      const st = controller.currentState();
      if (!st) return false;
      const out = stepAiAction(st, controller.heroSeat, aiGuardRef.current + 1);
      if (!out.advanced) return false;
      aiGuardRef.current += 1;
      // 单步之后必须同步对外状态，否则界面不动、且本手结束时不落库
      controller.settleAfterAiStep();
      return true;
    };
  });

  // 唯一的推进定时器：只执行「当前该执行的一步」，执行完由下一次 revision 驱动下一步。
  // 依赖含 table.step（其身份已把揭示游标计入），否则翻牌会只翻第一张就卡住。
  useEffect(() => {
    if (table.step.kind === 'idle') return;
    const t = setTimeout(() => table.run(table.step), Math.max(0, table.step.delayMs));
    return () => clearTimeout(t);
  }, [snap.revision, table.step, table.run]);

  // 玩家回合开始时记录起始时间（用于思考耗时）
  useEffect(() => {
    if (table.view.canHeroAct) actionStartRef.current = Date.now();
  }, [table.view.canHeroAct, snap.revision]);

  const handleAct = (type: ActionType, toAmount = 0) => {
    // 演出闸：AI 思考中或公共牌未揭完时，不允许用脚本/快捷键抢出牌。
    // 注意这只挡「抢跑」，不会吞掉玩家回合——演出结束后 canHeroAct 会恢复为 true。
    if (!table.view.canHeroAct) return;
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
    // 重置演出守卫计数：它用于步进 AI 的 RNG 派生，必须在每手开始时归零，
    // 否则第二手起 AI 的决策序列会与「一次跑完」的基线不一致。
    aiGuardRef.current = 0;
    controller.startHand();
    // 不再调用 controller.runAI()：AI 推进改由分步演出驱动
  };

  // 开局：首次进入（且已从开始界面进桌）自动发牌
  useEffect(() => {
    if (entered && !snap.state) {
      aiGuardRef.current = 0;
      controller.startHand();
      // 同上：AI 由分步演出驱动，不在此处一次性跑完
    }
    // 仅在「已进桌 + 尚未发牌」时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered]);

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

  /**
   * 结算分行明细（主池 / 边池 / 未跟注退还）。
   *
   * 为什么要有这个展示：新手最典型的金额误解是「我下注后对手弃牌，我赢的是那整个底池」——
   * 实际上只有对手跟到的部分才是赢来的，超出部分是自己被退回来的钱。
   * 参考站把这两类分开列（`raw/EXPORT-texas-3CD198.json` 的 `pots[].refund` 实证），
   * 我方此前只显示「底池 30」，容易被误读成「赢了 30」（实际只赢 10）。
   *
   * 判据由 core 的 `settlementBreakdown` 提供（投入者人数，而非有资格者人数），
   * 金额与真实分配同源，此处只负责渲染，不参与任何计算。
   */
  const settlementLines: SettlementLine[] = useMemo(() => {
    const st = snap.state;
    if (!st?.finished) return [];
    // 必须用摊牌时的真实牌型值，不能用常量：
    // 若传常量，争夺层里所有有资格者都会「并列最强」，被错误地全部列为归属者
    // （例如两人摊牌会显示成两人都赢下主池）。无摊牌时 showdownValues 为空，
    // 此时争夺层只剩一名未弃牌者，任何 rankOf 都给出同一结果，故回退值安全。
    const rankOf = (seat: number): number => st.showdownValues[seat] ?? -Infinity;
    return settlementBreakdown(st.pots, rankOf);
  }, [snap.revision, snap.state]);

  const seatLabelOf = (seat: number): string =>
    snap.state?.seats[seat]?.name ?? `座位 ${seat + 1}`;

  const lastHandNet = snap.lastRecord?.heroNet ?? 0;
  // 结算面板何时真正出现：牌已打完且演出层已完成停顿。
  // 它一出现就说明这一手已经演完，牌桌不必再撑满视口，
  // 让出高度给结算内容（否则「下一手」会被挤到折叠线以下）。
  const showResult = Boolean(snap.state?.finished && table.view.settled);

  // 开始界面：未进桌之前不渲染牌桌与顶部标签栏，
  // 避免「还没开始就能点到设置/统计」的错位感。
  if (!entered) {
    return (
      <div className={`app ${snap.settings.fourColorDeck ? '' : 'two-color'}`}>
        <StartScreen onStart={() => setEntered(true)} />
      </div>
    );
  }

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
              id={`tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              // 只给「当前选中」的 tab 挂 aria-controls：
              // 面板是按需渲染的（未选中的 tab 在 DOM 里没有对应元素），
              // 而 ARIA 规定 aria-controls 必须指向一个真实存在的元素，
              // 给所有 tab 都挂会产出 4 个悬空 IDREF（读屏软件可能报「找不到受控元素」）。
              aria-controls={tab === t.id ? `panel-${t.id}` : undefined}
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
        /* game-stage：把「牌桌 + 操作仪表盘 + 结算面板」作为一个整体，
           在剩余高度里垂直居中（布局见 app.css 的 .game-stage）。
           空白区域过大时靠它把内容拉到视口中部，而不是全部堆在顶部。 */
        <div
          className={`game-stage${showResult ? ' has-result' : ''}`}
          role="tabpanel"
          id="panel-table"
          aria-labelledby="tab-table"
        >
          {!snap.state ? (
            <div className="panel">
              <div className="empty">正在发牌…</div>
            </div>
          ) : (
            <div className="table-wrap">
              <TableView
                state={snap.state}
                heroSeat={controller.heroSeat}
                revealAll={false}
                view={table.view}
              />
              <ActionBar
                legal={snap.legal}
                pot={pot}
                bigBlind={snap.settings.bigBlind}
                heroTurn={snap.heroTurn}
                heroTurnActive={table.view.canHeroAct}
                waiting={table.view.thinking}
                settleHold={Boolean(snap.state.finished && !table.view.settled)}
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

          {showResult && snap.state && (
            <div className="panel result-panel">
              <h2>本手结果</h2>
              <div className="result-grid">
                <div className="result-col">
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

                <div className="result-col">
                  {settlementLines.length > 0 && (
                    <>
                      <h3>分配明细（主池 / 边池 / 未跟注退还）</h3>
                      <table className="settlement-table">
                        <thead>
                          <tr>
                            <th>类型</th>
                            <th>金额</th>
                            <th>归属</th>
                          </tr>
                        </thead>
                        <tbody>
                          {settlementLines.map((line) => (
                            <tr key={`${line.layerIndex}-${line.kind}`}>
                              <td>
                                {line.kind === 'uncalled' ? (
                                  <span className="tag ok">未跟注退还</span>
                                ) : line.layerIndex === 0 ? (
                                  <span className="tag">主池</span>
                                ) : (
                                  <span className="tag">边池 {line.layerIndex}</span>
                                )}
                              </td>
                              <td className="num">{line.amount}</td>
                              <td>{line.recipients.map(seatLabelOf).join('、') || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="muted small" style={{ marginTop: 6 }}>
                        「未跟注退还」是你自己下注后无人跟到的部分，会原样退回，不计入赢来的筹码。
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'review' && (
        <div role="tabpanel" id="panel-review" aria-labelledby="tab-review">
          <ReviewPanel record={snap.lastRecord} review={snap.lastReview} />
        </div>
      )}
      {tab === 'stats' && (
        <div role="tabpanel" id="panel-stats" aria-labelledby="tab-stats">
          <StatsPanel
            stats={snap.stats}
            bankroll={snap.bankroll}
            startingStack={snap.settings.startingStack}
          />
        </div>
      )}
      {tab === 'history' && (
        <div role="tabpanel" id="panel-history" aria-labelledby="tab-history">
          <HistoryPanel history={snap.history} onClear={() => controller.clearHistory()} />
        </div>
      )}
      {tab === 'settings' && (
        <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings">
          <SettingsPanel
            settings={snap.settings}
            onChange={(patch) => controller.updateSettings(patch)}
            onResetBankroll={() => controller.resetBankroll()}
            handInProgress={Boolean(snap.state && !snap.state.finished)}
          />
        </div>
      )}
    </div>
  );
}
