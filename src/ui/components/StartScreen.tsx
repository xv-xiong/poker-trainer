/**
 * 开始界面（Start Screen / Lobby）。
 *
 * 为什么需要一个独立开始界面（而不是直接进牌桌）：
 *   牌桌一进去就先手就发牌、盲注已下、AI 开始行动，新用户没有任何
 *   「我上桌之前先看一眼参数」的机会。开始界面把本局的四个关键参数
 *   （桌人数 / 盲注 / 起始筹码 / AI 难度）和累计战绩摆在按钮之前，
 *   让「开始练习」是一次有意识的决定，而不是一次意外。
 *
 * 数据来源：只读 `localStorage` 的 `poker-trainer:state`（由 store/persistence
 * 写入），本组件不写入任何存储、不触碰核心结算逻辑。
 */

import { useState } from 'react';
import { CardView } from './CardView.js';
import { makeCard } from '../../core/cards.js';
import { AI_TIER_LABELS, defaultSettings, emptyStats, type AITier } from '../../core/types.js';
import { STORAGE_KEYS } from '../../store/schema.js';

/** 开始界面展示所需的只读概要（settings + 战绩，全部有默认值）。 */
interface LobbySummary {
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  aiTier: AITier;
  handsPlayed: number;
  netProfit: number;
  bankroll: number;
  /** 是否读到了真实存档；false 表示显示的是默认值。 */
  hasSave: boolean;
}

/**
 * 读取存档概要。
 *
 * 只读、且全程 try/catch：存档损坏或隐私模式下 localStorage 抛异常时，
 * 必须仍然能渲染出默认值的开始界面（绝不因读存档失败而白屏）。
 */
function readSummary(): LobbySummary {
  const fallback = defaultSettings();
  const base: LobbySummary = {
    seatCount: fallback.seatCount,
    smallBlind: fallback.smallBlind,
    bigBlind: fallback.bigBlind,
    startingStack: fallback.startingStack,
    aiTier: fallback.aiTier,
    handsPlayed: 0,
    netProfit: 0,
    bankroll: fallback.startingStack,
    hasSave: false,
  };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.state);
    if (raw === null) return base;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return base;
    const p = parsed as Record<string, unknown>;

    // settings 与 stats 都是可选读取：任一项非对象就退回默认值，
    // 不做严格校验（严格校验属 store/schema 的职责，这里只负责展示）。
    const rawSettings = (typeof p.settings === 'object' && p.settings !== null ? p.settings : {}) as Record<
      string,
      unknown
    >;
    const rawStats = (typeof p.stats === 'object' && p.stats !== null ? p.stats : {}) as Record<string, unknown>;
    const st = emptyStats();

    const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const tier: AITier =
      rawSettings.aiTier === 'easy' || rawSettings.aiTier === 'medium' || rawSettings.aiTier === 'hard'
        ? rawSettings.aiTier
        : fallback.aiTier;

    return {
      seatCount: num(rawSettings.seatCount, fallback.seatCount),
      smallBlind: num(rawSettings.smallBlind, fallback.smallBlind),
      bigBlind: num(rawSettings.bigBlind, fallback.bigBlind),
      startingStack: num(rawSettings.startingStack, fallback.startingStack),
      aiTier: tier,
      handsPlayed: num(rawStats.handsPlayed, st.handsPlayed),
      netProfit: num(rawStats.netProfit, st.netProfit),
      bankroll: num(p.bankroll, fallback.startingStack),
      hasSave: true,
    };
  } catch {
    return base;
  }
}

/** 大盲为 0 时不做除法，避免出现 Infinity BB 这种荒谬展示。 */
function bigBlindCount(stack: number, bigBlind: number): string {
  if (bigBlind <= 0) return '—';
  return (stack / bigBlind).toFixed(0);
}

/** 规则要点（与设置页规则说明同源，此处只取新手最先要知道的几条）。 */
const RULE_HIGHLIGHTS: { title: string; desc: string }[] = [
  { title: '无限注德州', desc: '无前注、无抽水，盲注不递增（现金局结构）' },
  { title: '三档 AI 对手', desc: '同一策略 + 不同参数：松紧、赔率纪律、诈唬频率' },
  { title: '逐步决策复盘', desc: '逐决策点算实际 EV 与最优 EV 之差，按偏离幅度分级' },
  { title: '全部本地运行', desc: '战绩存在浏览器本地，不联网、不注册、不上传' },
];

export function StartScreen({ onStart }: { onStart: () => void }) {
  const [summary] = useState<LobbySummary>(readSummary);
  const [rulesOpen, setRulesOpen] = useState(false);

  // 装饰用牌：♠A 与 ♥K，与参考站首页同构（仅视觉，不参与对局）。
  // 花色索引 0=♠ 1=♥（见 core/cards.ts 编码约定），点数索引 12=A、11=K。
  const decorA = makeCard(12, 0);
  const decorK = makeCard(11, 1);

  const net = summary.netProfit;
  const netText = `${net >= 0 ? '+' : ''}${net}`;

  return (
    <div className="lobby">
      {/* 左栏：定位 + 关键信息 + 装饰 */}
      <div className="lobby-intro">
        <p className="eyebrow">SINGLE-PLAYER TRAINER · 单人练习</p>
        <h1>
          先想清楚，
          <br />
          再上桌。
        </h1>
        <p className="lobby-lede">
          一个人、一台设备就能练的德州扑克。
          <br />
          每一手都记下你的决策、当时该跟多少、赢面有多少。
        </p>

        <div className="deck-decor" aria-hidden="true">
          <CardView card={decorA} />
          <CardView card={decorK} />
        </div>

        <p className="lobby-foot">
          {summary.seatCount} 人桌
          <i>/</i>
          无限注德州
          <i>/</i>
          虚拟筹码
          <i>/</i>
          无后端
        </p>
      </div>

      {/* 右栏：操作卡片，承载「本局参数 + 战绩 + 进入按钮」 */}
      <div className="panel panel-wide lobby-entry">
        <p className="eyebrow">本局参数 · TABLE SETUP</p>
        <h2>你的牌局，从这里开始</h2>

        <dl className="lobby-facts">
          <div className="fact">
            <dt>桌人数</dt>
            <dd>
              {summary.seatCount} 人 <span className="muted">{summary.seatCount === 2 ? '（单挑）' : '桌'}</span>
            </dd>
          </div>
          <div className="fact">
            <dt>盲注</dt>
            <dd>
              {summary.smallBlind} / {summary.bigBlind}
            </dd>
          </div>
          <div className="fact">
            <dt>起始筹码</dt>
            <dd>
              {summary.startingStack}
              <span className="muted"> （{bigBlindCount(summary.startingStack, summary.bigBlind)}BB）</span>
            </dd>
          </div>
          <div className="fact">
            <dt>AI 难度</dt>
            <dd>
              {AI_TIER_LABELS[summary.aiTier].zh}
              <span className="muted"> （{AI_TIER_LABELS[summary.aiTier].en}）</span>
            </dd>
          </div>
        </dl>

        <div className="lobby-record">
          <div className="rock">
            <span className="rk">已打手数</span>
            <span className="rv">{summary.handsPlayed}</span>
          </div>
          <div className="rock">
            <span className="rk">当前资金</span>
            <span className="rv">{summary.bankroll}</span>
          </div>
          <div className="rock">
            <span className="rk">累计盈亏</span>
            <span className={`rv ${net >= 0 ? 'pos' : 'neg'}`}>{netText}</span>
          </div>
        </div>
        <p className="muted small lobby-record-note">
          {summary.hasSave
            ? '以上战绩读自本机浏览器存档，开始后可随时在「统计 / 历史」查看。'
            : '本机还没有存档，以上为默认值；打完第一手后会开始记录。'}
        </p>

        <button className="primary lobby-start" onClick={onStart}>
          开始练习 →
        </button>
        <p className="muted small lobby-hint">进入后先手自动发牌；桌人数、难度等可在「设置」中随时调整。</p>

        {/* 规则要点：默认折叠，想快速上手的人不必先读一遍长文 */}
        <details className="lobby-rules" open={rulesOpen} onToggle={(e) => setRulesOpen(e.currentTarget.open)}>
          <summary>规则要点（Rules）</summary>
          <ul>
            {RULE_HIGHLIGHTS.map((r) => (
              <li key={r.title}>
                <strong>{r.title}</strong>
                <span>{r.desc}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">更完整的规则与胜率口径，进入后在「设置」页可以看到完整说明。</p>
        </details>
      </div>
    </div>
  );
}
