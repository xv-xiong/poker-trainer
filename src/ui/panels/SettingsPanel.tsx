/**
 * 设置面板 + 规则说明（含已定案规则，便于查阅）。
 *
 * 「下一手生效」标记的由来（审计 P1-5）：
 * 桌人数 / 盲注 / 起始筹码 / AI 难度 都是**开新一手时**才读取的配置，
 * 当前手进行中改动不会立即反映到牌桌上。此前界面没有任何提示，用户会以为
 * 「改了没反应」是 bug。这里用标签 + 顶部说明把生效时机讲清楚，而不是去
 * 做「热切换」——热切换会改变进行中手牌的规则参数，破坏金额与结算的可解释性。
 */

import { AI_TIER_LABELS, type AITier, type Settings } from '../../core/types.js';
import type { Pace, RosterSeat } from '../../store/schema.js';

/** 生效时机标签：这些项只在开新一手时读取。 */
function NextHandTag() {
  return <span className="tag next-hand">下一手生效</span>;
}

export function SettingsPanel({
  settings,
  onChange,
  onResetBankroll,
  handInProgress,
  carryOverStacks,
  onCarryOverChange,
  roster,
  pace,
  onPaceChange,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onResetBankroll: () => void;
  /** 当前是否有未结束的手牌。仅用于把「改动下一手生效」说得更具体。 */
  handInProgress: boolean;
  /** 是否让筹码在牌局之间延续（阶段 1-1）。 */
  carryOverStacks: boolean;
  onCarryOverChange: (on: boolean) => void;
  /** 继承模式下的 AI 账本（空数组表示尚未开局）。 */
  roster: RosterSeat[];
  /** 节奏档位（阶段二 P1-1）：只影响 AI 每步等待多久，不影响决策。 */
  pace: Pace;
  onPaceChange: (p: Pace) => void;
}) {
  return (
    <div className="panel">
      <h2>设置（Settings）</h2>

      <p className="panel-note">
        带「下一手生效」标记的项只影响之后新开的手牌
        {handInProgress ? '——本手正在进行中，改动不会改变当前这一手' : ''}。
        四色牌、快捷键提示与 AI 思考节奏立即生效。
      </p>

      {/* 继承模式开关放在最上面：它决定下面「起始筹码」的含义——
          关着时每手都从起始筹码重新开始（单局练习）；开着时起始筹码只在
          开局那一刻生效，之后筹码在玩家与各 AI 之间真实流转。 */}
      <div className="settings-row carry-over-row">
        <div className="label">
          <span>继承上一手筹码</span>
          <span className="hint">
            开启后玩家与 AI 的筹码跨手延续：输光要选择是否补码，AI 输光则下桌，
            直到只剩你一人有筹码即赢下整桌。切换会重置资金与 AI 账本。
          </span>
        </div>
        <input
          type="checkbox"
          data-testid="carry-over-toggle"
          aria-label="继承上一手筹码"
          checked={carryOverStacks}
          onChange={(e) => onCarryOverChange(e.target.checked)}
          style={{ width: 18, height: 18 }}
        />
      </div>

      {carryOverStacks && roster.length > 0 && (
        <div className="settings-row">
          <div className="label">
            <span>AI 筹码（本局账本）</span>
            <span className="hint">输光下桌的 AI 会以半透明保留在这里</span>
          </div>
          <div className="roster-mini">
            {roster.map((r) => (
              <span key={r.id} className={`roster-mini-seat${r.out ? ' out' : ''}`}>
                {r.name} <b>{r.out ? '已下桌' : r.stack}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="settings-row">
        <div className="label">
          <span>
            桌人数 <NextHandTag />
          </span>
          <span className="hint">2 / 6 / 9 人桌，默认 6 人</span>
        </div>
        <select
          value={settings.seatCount}
          onChange={(e) => onChange({ seatCount: Number(e.target.value) })}
        >
          <option value={2}>2 人（单挑）</option>
          <option value={6}>6 人</option>
          <option value={9}>9 人</option>
        </select>
      </div>

      <div className="settings-row">
        <div className="label">
          <span>
            AI 难度 <NextHandTag />
          </span>
          <span className="hint">三档由同一策略 + 不同参数实现</span>
        </div>
        <select
          value={settings.aiTier}
          onChange={(e) => onChange({ aiTier: e.target.value as AITier })}
        >
          <option value="easy">简单（{AI_TIER_LABELS.easy.en}）— 松、不看赔率</option>
          <option value="medium">中等（{AI_TIER_LABELS.medium.en}）— 位置分档</option>
          <option value="hard">困难（{AI_TIER_LABELS.hard.en}）— 蒙特卡洛 + 严格赔率</option>
        </select>
      </div>

      {/* 节奏档位（审计 P1-1）。它是本面板唯一「立即生效」的行为项：
          只改每步等多久，不参与任何规则计算，因此不会让进行中的手牌
          「规则中途变了」——这也是它不挂「下一手生效」标签的原因。 */}
      <div className="settings-row">
        <div className="label">
          <span>AI 思考节奏</span>
          <span className="hint">
            只影响每步等待多久，不改变 AI 的决策；立即生效。拟真档每次 1.1–1.8 秒，
            快速档 0.35–0.6 秒，瞬时档不等待。按住 S 可临时跳过当前等待。
          </span>
        </div>
        <select
          data-testid="pace-select"
          aria-label="AI 思考节奏"
          value={pace}
          onChange={(e) => onPaceChange(e.target.value as Pace)}
        >
          <option value="realistic">拟真（1.1–1.8 秒）</option>
          <option value="fast">快速（0.35–0.6 秒）</option>
          <option value="instant">瞬时（不等待）</option>
        </select>
      </div>

      <div className="settings-row">
        <div className="label">
          <span>
            起始筹码 <NextHandTag />
          </span>
          <span className="hint">以 BB 计，1000 = 100BB（盲注 5/10）</span>
        </div>
        <input
          type="number"
          min={100}
          step={100}
          value={settings.startingStack}
          onChange={(e) => onChange({ startingStack: Math.max(100, Number(e.target.value) || 1000) })}
          style={{ width: 110 }}
        />
      </div>

      <div className="settings-row">
        <div className="label">
          <span>
            盲注 <NextHandTag />
          </span>
          <span className="hint">小盲 / 大盲，盲注不递增</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="number"
            min={1}
            value={settings.smallBlind}
            onChange={(e) => onChange({ smallBlind: Math.max(1, Number(e.target.value) || 5) })}
            style={{ width: 76 }}
          />
          <span className="muted">/</span>
          <input
            type="number"
            min={2}
            value={settings.bigBlind}
            onChange={(e) => onChange({ bigBlind: Math.max(2, Number(e.target.value) || 10) })}
            style={{ width: 76 }}
          />
        </div>
      </div>

      <div className="settings-row">
        <div className="label">
          <span>四色牌</span>
          <span className="hint">♠ 黑 · ♥ 红 · ♦ 蓝 · ♣ 绿；对色觉障碍更友好</span>
        </div>
        <input
          type="checkbox"
          aria-label="四色牌"
          checked={settings.fourColorDeck}
          onChange={(e) => onChange({ fourColorDeck: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      <div className="settings-row">
        <div className="label">
          <span>显示快捷键提示</span>
          <span className="hint">F 弃牌 / C 跟注 / R 加注 / Space 确认 / 长按 S 跳过等待</span>
        </div>
        <input
          type="checkbox"
          aria-label="显示快捷键提示"
          checked={settings.showShortcuts}
          onChange={(e) => onChange({ showShortcuts: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      <div className="settings-row">
        <div className="label">
          <span>
            翻牌单挑精确枚举 <NextHandTag />
          </span>
          <span className="hint">
            精确但慢：实测约 1.8 秒（1,070,190 次摊牌）。默认关闭，开启后仅在单挑翻牌时生效
          </span>
        </div>
        <input
          type="checkbox"
          aria-label="翻牌单挑精确枚举"
          checked={settings.enableFlopExact}
          onChange={(e) => onChange({ enableFlopExact: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      <div className="settings-row">
        <div className="label">
          <span>重置资金与统计</span>
          <span className="hint">资金回到起始筹码，统计清零；历史记录不受影响</span>
        </div>
        <button className="danger" onClick={onResetBankroll}>
          重置
        </button>
      </div>

      <h3>规则说明（Rules）</h3>
      <ul className="small muted" style={{ lineHeight: 1.9, paddingLeft: 20 }}>
        <li>无限注德州扑克（No-Limit Hold'em），无前注（ante）、无 straddle、无抽水（rake）。</li>
        <li>盲注不递增（现金局结构）。默认小盲 5 / 大盲 10，起始筹码 1000（100BB）。</li>
        <li>翻牌前行动从大盲左侧开始；翻牌后从庄家左侧第一个未弃牌玩家开始。</li>
        <li>最小加注增量 = 上一次加注的增量；全下额不足最小加注时不重开加注权。</li>
        <li>实现边池（side pot）：全下且筹码不等时按投入额分层结算。</li>
        <li>摊牌按 7 张取最优 5 张比较；平局按人数均分，<strong>奇数筹码按位置序分配（从小盲起顺时针）</strong>。</li>
        <li>全部弃牌只剩一人时直接分配底池，不进入摊牌。</li>
        <li>2 人桌时庄家即小盲。</li>
      </ul>

      <h3>胜率计算说明（Equity Sources）</h3>
      <ul className="small muted" style={{ lineHeight: 1.9, paddingLeft: 20 }}>
        <li>翻牌前：查询构建期生成的 169 手牌类表（查表值，确定性）。</li>
        <li>单挑转牌 / 河牌：精确枚举（45,540 / 990 次摊牌）。</li>
        <li>单挑翻牌：默认蒙特卡洛；显式开启后走精确枚举（1,070,190 次摊牌，约 1.8 秒）。</li>
        <li>多人桌任意街：蒙特卡洛采样（默认 20,000 次迭代）。</li>
        <li>
          <strong>AI 决策的口径与上表不同</strong>：翻牌前查表，翻牌后统一走蒙特卡洛（3,000 次），
          不走精确枚举——AI 只需要胜率与底池赔率比较，±2% 的采样误差不影响判断，
          而精确枚举在单挑转牌要 45,540 次摊牌，会同步阻塞主线程。
        </li>
        <li>
          用户主动查看的胜率提示在 Web Worker（浏览器后台线程）内计算，不阻塞界面。
        </li>
        <li>
          注意口径：AI 决策与赛后复盘的胜率计算是<strong>主线程同步</strong>执行的（实测 hard
          档单次决策 p95 约 6ms、复盘每决策点约 5ms），当前未迁入 Worker；仅当提高迭代次数
          导致明显卡顿时才需要迁移。
        </li>
      </ul>
    </div>
  );
}
