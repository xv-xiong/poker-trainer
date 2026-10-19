/**
 * 设置面板 + 规则说明（含已定案规则，便于查阅）。
 */

import { AI_TIER_LABELS, type AITier, type Settings } from '../../core/types.js';

export function SettingsPanel({
  settings,
  onChange,
  onResetBankroll,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onResetBankroll: () => void;
}) {
  return (
    <div className="panel">
      <h2>设置（Settings）</h2>

      <div className="settings-row">
        <div className="label">
          <span>桌人数</span>
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
          <span>AI 难度</span>
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

      <div className="settings-row">
        <div className="label">
          <span>起始筹码</span>
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
          <span>盲注</span>
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
          checked={settings.fourColorDeck}
          onChange={(e) => onChange({ fourColorDeck: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      <div className="settings-row">
        <div className="label">
          <span>显示快捷键提示</span>
          <span className="hint">F 弃牌 / C 跟注 / R 加注 / Space 确认</span>
        </div>
        <input
          type="checkbox"
          checked={settings.showShortcuts}
          onChange={(e) => onChange({ showShortcuts: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      <div className="settings-row">
        <div className="label">
          <span>翻牌单挑精确枚举</span>
          <span className="hint">
            精确但慢：实测约 1.8 秒（1,070,190 次摊牌）。默认关闭，开启后仅在单挑翻牌时生效
          </span>
        </div>
        <input
          type="checkbox"
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
          用户主动查看的胜率提示在 Web Worker（浏览器后台线程）内计算，不阻塞界面。
        </li>
        <li>
          注意口径：AI 决策与赛后复盘的胜率计算是<strong>主线程同步</strong>执行的（实测 hard
          档单次决策 p95 约 33ms、复盘每决策点约 5ms），当前未迁入 Worker；仅当提高迭代次数
          导致明显卡顿时才需要迁移。
        </li>
      </ul>
    </div>
  );
}
