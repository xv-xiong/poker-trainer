/**
 * 开始界面（Start Screen / Lobby）。
 *
 * 为什么需要一个独立开始界面（而不是直接进牌桌）：
 *   牌桌一进去就先手就发牌、盲注已下、AI 开始行动，新用户没有任何
 *   「我上桌之前先看一眼参数」的机会。开始界面把本局的建桌参数与累计战绩
 *   摆在按钮之前，让「开始练习」是一次有意识的决定，而不是一次意外。
 *
 * 为什么建桌参数在首屏就能改（阶段 2-1）：
 *   此前首屏只把桌人数 / 盲注 / 起始筹码 / AI 难度当**只读展示**，想改必须
 *   先进牌桌、再翻到设置页、改完还要回到牌桌，并且那里标着「下一手生效」——
 *   绕两屏才生效，很容易被当成「改了没反应」。而这些参数本来就只在上桌前
 *   有意义，改它们的入口理应就在上桌前的这个界面里。
 *
 * 数据来源：settings / 战绩全部来自 `GameController` 的订阅快照（`snap`），
 * 与设置面板共用同一条 `controller.updateSettings` 写入路径。本组件**不再**
 * 自己读 localStorage——两份真相必然漂移（首屏读一份、控制器改另一份）。
 */

import { useState } from 'react';
import { CardView } from './CardView.js';
import { makeCard } from '../../core/cards.js';
import { AI_TIER_LABELS, type AITier, type Settings } from '../../core/types.js';
import type { Pace } from '../../store/schema.js';
import { clampBigBlind, clampSmallBlind, clampStartingStack } from '../format.js';

/** 首屏展示所需的战绩概要（来自控制器快照）。 */
export interface LobbyRecord {
  handsPlayed: number;
  netProfit: number;
  bankroll: number;
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

/**
 * 节奏档位选项（与 store/schema 的 Pace 一一对应）。
 *
 * 放在首屏是「选项 C」的取舍：默认仍是拟真（每次 > 1 秒，不违背
 * 「AI 不该秒出」这条原始要求），但想提升练习吞吐的人不必先翻设置。
 */
const PACE_OPTIONS: { value: Pace; label: string }[] = [
  { value: 'realistic', label: '拟真' },
  { value: 'fast', label: '快速' },
  { value: 'instant', label: '瞬时' },
];

export function StartScreen({
  onStart,
  settings,
  onSettingsChange,
  record,
  carryOverStacks,
  onCarryOverChange,
  pace,
  onPaceChange,
}: {
  onStart: () => void;
  /** 当前建桌参数（受控：单一真相源在控制器）。 */
  settings: Settings;
  /** 改一个或多个建桌参数；写入路径与设置面板完全相同。 */
  onSettingsChange: (patch: Partial<Settings>) => void;
  /** 累计战绩（只读展示）。 */
  record: LobbyRecord;
  /** 是否继承上一手筹码（阶段 1-1 的「一局牌桌」模式）。 */
  carryOverStacks: boolean;
  onCarryOverChange: (on: boolean) => void;
  /** 节奏档位（阶段二 P1-1）。 */
  pace: Pace;
  onPaceChange: (p: Pace) => void;
}) {
  const [rulesOpen, setRulesOpen] = useState(false);

  // 装饰用牌：♠A 与 ♥K，与参考站首页同构（仅视觉，不参与对局）。
  // 花色索引 0=♠ 1=♥（见 core/cards.ts 编码约定），点数索引 12=A、11=K。
  const decorA = makeCard(12, 0);
  const decorK = makeCard(11, 1);

  const net = record.netProfit;
  const netText = `${net >= 0 ? '+' : ''}${net}`;
  // 用「已打手数」而不是「存档是否存在」判断要不要提示「还没有战绩」：
  // 阶段 2-1 之后首屏改参数就会写存档，此时存档存在但一手都没打，
  // 用 hasSave 会把「没有战绩」误报成「已读自存档」。
  const hasRecord = record.handsPlayed > 0;

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
          {settings.seatCount} 人桌
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

        {/* 建桌参数：首屏即可编辑（阶段 2-1）。
            用受控表单而不是「点编辑再展开」，是因为这几项就是这一屏的主内容，
            没有需要保护的阅读态。 */}
        <div className="lobby-setup" data-testid="lobby-setup">
          <div className="lobby-field">
            <label htmlFor="lobby-seat-count">桌人数</label>
            <select
              id="lobby-seat-count"
              data-testid="lobby-seat-count"
              value={settings.seatCount}
              onChange={(e) => onSettingsChange({ seatCount: Number(e.target.value) })}
            >
              <option value={2}>2 人（单挑）</option>
              <option value={6}>6 人</option>
              <option value={9}>9 人</option>
            </select>
          </div>

          <div className="lobby-field">
            <label htmlFor="lobby-ai-tier">AI 难度</label>
            <select
              id="lobby-ai-tier"
              data-testid="lobby-ai-tier"
              value={settings.aiTier}
              onChange={(e) => onSettingsChange({ aiTier: e.target.value as AITier })}
            >
              <option value="easy">简单（{AI_TIER_LABELS.easy.en}）</option>
              <option value="medium">中等（{AI_TIER_LABELS.medium.en}）</option>
              <option value="hard">困难（{AI_TIER_LABELS.hard.en}）</option>
            </select>
          </div>

          <div className="lobby-field">
            <label htmlFor="lobby-starting-stack">起始筹码</label>
            <input
              id="lobby-starting-stack"
              data-testid="lobby-starting-stack"
              type="number"
              min={100}
              step={100}
              value={settings.startingStack}
              onChange={(e) => onSettingsChange({ startingStack: clampStartingStack(Number(e.target.value)) })}
            />
            <span className="lobby-field-hint">
              = {bigBlindCount(settings.startingStack, settings.bigBlind)}BB（盲注 {settings.smallBlind} /{' '}
              {settings.bigBlind}）
            </span>
          </div>

          <div className="lobby-field">
            <label htmlFor="lobby-small-blind">盲注（小 / 大）</label>
            <div className="lobby-blind-pair">
              <input
                id="lobby-small-blind"
                data-testid="lobby-small-blind"
                aria-label="小盲"
                type="number"
                min={1}
                value={settings.smallBlind}
                onChange={(e) => onSettingsChange({ smallBlind: clampSmallBlind(Number(e.target.value)) })}
              />
              <span aria-hidden="true">/</span>
              <input
                id="lobby-big-blind"
                data-testid="lobby-big-blind"
                aria-label="大盲"
                type="number"
                min={2}
                value={settings.bigBlind}
                onChange={(e) => onSettingsChange({ bigBlind: clampBigBlind(Number(e.target.value)) })}
              />
            </div>
            <span className="lobby-field-hint">盲注不递增（现金局结构）</span>
          </div>
        </div>

        {/* 继承模式：它决定「起始筹码」的含义，属于上桌前必须定下的模式。
            切换会重置资金与 AI 账本，因此把后果写在提示里。 */}
        <div className="lobby-mode">
          <label className="lobby-mode-main" htmlFor="lobby-carry-over">
            <input
              id="lobby-carry-over"
              data-testid="lobby-carry-over"
              type="checkbox"
              checked={carryOverStacks}
              onChange={(e) => onCarryOverChange(e.target.checked)}
            />
            <span>继承上一手筹码（一局牌桌）</span>
          </label>
          <p className="muted small lobby-mode-note">
            {carryOverStacks
              ? '本局筹码跨手延续：输光要选是否补码，AI 输光下桌，只剩你一人即赢下整桌。切换或改动建桌参数会重开一局并清零本局战绩。'
              : '关闭时每手都从起始筹码重新开始（单局练习）；开启后筹码跨手延续。'}
          </p>
        </div>

        <div className="lobby-record">
          <div className="rock">
            <span className="rk">已打手数</span>
            <span className="rv">{record.handsPlayed}</span>
          </div>
          <div className="rock">
            <span className="rk">当前资金</span>
            <span className="rv">{record.bankroll}</span>
          </div>
          <div className="rock">
            <span className="rk">累计盈亏</span>
            <span className={`rv ${net >= 0 ? 'pos' : 'neg'}`}>{netText}</span>
          </div>
        </div>
        <p className="muted small lobby-record-note">
          {hasRecord
            ? '以上战绩读自本机浏览器存档，开始后可随时在「统计 / 历史」查看。'
            : '本机还没有战绩；打完第一手后会开始记录。'}
        </p>

        <div className="lobby-pace" role="group" aria-label="AI 思考节奏">
          <span className="lobby-pace-label">节奏</span>
          {PACE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              data-testid={`pace-${o.value}`}
              aria-pressed={pace === o.value}
              className={`lobby-pace-btn${pace === o.value ? ' active' : ''}`}
              onClick={() => onPaceChange(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="muted small lobby-pace-note">
          只影响 AI 每步等多久，不改变它的决策；进入后也能在「设置」里改。
        </p>

        <button className="primary lobby-start" onClick={onStart}>
          开始练习 →
        </button>
        <p className="muted small lobby-hint">进入后先手自动发牌；以上参数随时可在「设置」中调整。</p>

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
