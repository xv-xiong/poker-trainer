# 德州扑克练习台 · Texas Hold'em Trainer

[![CI](https://github.com/xv-xiong/poker-trainer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xv-xiong/poker-trainer/actions/workflows/ci.yml)
[![Deploy to GitHub Pages](https://github.com/xv-xiong/poker-trainer/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/xv-xiong/poker-trainer/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

单人练习用的德州扑克网页。6 人桌（可切 2 / 6 / 9 人）与 5 个 AI 对手完整对局，每手结束后给出逐决策点的 EV 复盘。

**线上地址**：https://xv-xiong.github.io/poker-trainer/

---

## 这个项目解决什么问题

练习德州扑克时，最常见的困难不是「不知道规则」，而是：

1. **没有对手可打** —— 真人牌局需要凑人，且不能随时暂停。
2. **打完不知道自己错在哪** —— 只记得输赢，不记得哪个决策是负期望。
3. **胜率靠感觉** —— 「我这对子够不够跟」无法量化。

本工具把这三件事变成可操作的功能：随时可打的 AI 牌桌、逐决策点的 EV 偏离分级、分级胜率计算（查表 / 精确枚举 / 采样）。

---

## 界面截图

| 开始界面 | 牌桌与 AI 演出 |
|---|---|
| ![开始界面](https://raw.githubusercontent.com/xv-xiong/poker-trainer/main/docs/screenshots/start.png) | ![牌桌](https://raw.githubusercontent.com/xv-xiong/poker-trainer/main/docs/screenshots/table.png) |

| 结算明细 | 决策复盘 |
|---|---|
| ![结算](https://raw.githubusercontent.com/xv-xiong/poker-trainer/main/docs/screenshots/settlement.png) | ![复盘](https://raw.githubusercontent.com/xv-xiong/poker-trainer/main/docs/screenshots/review.png) |

---

## 主要功能

| 功能 | 说明 |
|---|---|
| 完整对局 | 无限注德州，盲注 5/10、起始 1000（100BB）；实现**边池**（全下筹码不等时正确分层结算） |
| 首屏建桌 | 桌人数（2 / 6 / 9）、AI 难度、起始筹码、盲注、继承模式开关**在开始界面直接可改**，不必先进入牌桌再翻设置；改动即时落库，刷新后仍在 |
| 三档 AI | 简单 / 中等 / 困难，由同一套策略 + 正交参数实现，难度可测可分辨；跟注频率由概率门控制，strength 带抖动，避免机械可预测 |
| 节奏三档 | AI 每步等待可在 **拟真 1100–1800ms / 快速 350–600ms / 瞬时 0** 之间切换（首屏与设置面板均可改，立即生效）；长按 **S** 可临时跳过当前等待。只影响等待时长，不改变决策结果 |
| 决策复盘 | 每个决策点给出实际动作 EV、最优动作 EV、EV 损失与分级（>0.5BB 值得复盘，>2BB 明显偏离） |
| 手牌回放 | 历史面板每一手都能在牌桌上逐步重放：用记录的种子重建牌局，逐帧看每个动作与逐街翻牌，可单步 / 自动播放；只读，不改资金、统计与历史 |
| 主动提示 | 默认关闭；按「查看提示」显示估算胜率、底池赔率要求与建议动作，查看次数计入统计 |
| 分级胜率 | 翻牌前查表；单挑转牌/河牌精确枚举；多人桌与翻牌用蒙特卡洛（用户主动查看提示时在 Web Worker 内执行） |
| 筹码继承（可选） | 默认每手重置回起始筹码（单局练习）；开启后玩家与 AI 的筹码按输赢带进下一手，输光可补码、AI 不补码则下桌，全桌下桌即「赢下整桌」并给出本局统计与建议 |
| 即时反馈 | 每手结束的结算面板给出本手点评（结论 + 最多 4 条可量化建议）；单局模式另显累计进度 |
| 数据持久化 | 资金与历史存 `localStorage`，上限 500 手（FIFO）；支持导出 JSON / CSV |
| 响应式 | 桌面完整布局；手机竖屏牌桌缩小、操作区固定底部 |
| 无障碍 | 四色牌（♠黑 ♥红 ♦蓝 ♣绿，可切两色）、快捷键、焦点可见、尊重「减少动态效果」 |

---

## 视觉与配色约定

金色是**决策信号**，不是装饰色。整屏只允许它出现在「要你决定的事」上：

| 用金色 | 用冷色（`--opp: #5ea9c7`） |
|---|---|
| 操作区主按钮（跟注 / 加注） | 当前行动座位的描边与呼吸光晕 |
| 底池金额 | 盲注徽标（SB / BB） |
| 玩家自己的筹码与资金 | 对手座位的筹码 |
| 赢家座位与赢家牌面高亮 | 导航页签选中态 |

理由：改前金色同时出现在这七个位置，视觉重量彼此相等，玩家反而看不出「现在该我做什么」；而多数时候「当前行动者」是对手，属环境信息，该退到冷色。冷色选 `#5ea9c7` 是因为它与金色明度接近、色相相反，放在绿绒上跳得出来又不抢主色，对红绿色觉障碍者也可分辨。

令牌定义在 `src/ui/styles/tokens.css`（`--opp` / `--opp-dim` / `--opp-soft`），改动集中在 `table.css`、`base.css` 与 `responsive.css` 的 `turn-glow`。

---

## 安装方法

需要 Node.js `^20.19.0 || >=22.12.0`（本项目在 `24.21.0` 上验证）。

```bash
git clone https://github.com/xv-xiong/poker-trainer.git
cd poker-trainer
npm install
```

## 使用方法

```bash
npm run dev        # 本地开发（默认 http://localhost:5173/poker-trainer/）
npm run build      # 生产构建（先 tsc --noEmit 再 vite build）
npm run preview    # 预览生产产物（http://127.0.0.1:4173/poker-trainer/）
npm run verify     # 一键跑全部验收闸门
npm test           # 单元 + 属性测试
npm run test:e2e   # Playwright 端到端
```

**操作**：轮到你时点「弃牌 / 跟注 / 加注」，或用快捷键 `F` 弃牌、`C` 跟注、`R` 加注、`Space` 确认、`N` 开始下一手。加注可用滑杆或 1/2 池、2/3 池、满池、全下快捷键。

---

### 两种练习模式

| 模式 | 筹码 | 适合 |
|---|---|---|
| **单局练习**（默认） | 每手结束都回到「起始筹码」，只看这一手打得对不对 | 练单个决策点、反复重开同一局面 |
| **一局牌桌**（设置里勾选「继承上一手筹码」） | 玩家与 AI 的筹码按输赢带进下一手，可能被磨到输光 | 练筹码深度变化、短码与全下的取舍 |

继承模式下：

- 任一座位（含玩家）某手结束后筹码**低于一个大盲**，下一手开始前弹补码询问；
  不补码即下桌。玩家不补码 → 「本局结束：筹码输光」结算画面（本局手数、净盈亏、
  入池率、翻前加注率、正常决策占比、最值得复盘的几个决策 + 改进建议）。
- AI 全部下桌 → 「你赢下了整桌！」结算画面，同样是本局统计 + 建议。
- 牌桌下方的座位账本常驻显示每个人的当前筹码，已下桌的半透明标记。
- 中途切回单局练习等价于换一张新桌（当前局的账本清空）。

---

## 输入输出示例

**输入**：打开页面，默认 6 人桌、AI 中等难度、起始资金 1000。

**输出**（一手结束后，复盘面板）：

| 街 | 你的动作 | 建议动作 | 底池 | 需跟注 | 底池赔率 | 估算胜率 | EV 损失 | 分级 |
|---|---|---|---|---|---|---|---|---|
| 翻牌前 | 跟注 10 | 加注 30 | 15 | 10 | 40.0% | 52.3% | 1.84 | 值得复盘 |
| 翻牌 | 过牌 | 下注 20 | 35 | 0 | 0.0% | 71.2% | 3.10 | 明显偏离 |
| 河牌 | 弃牌 | 跟注 40 | 95 | 40 | 29.6% | 18.4% | 0.00 | 正常 |

**导出 CSV** 每行一个决策点，列含 `handId, street, action, pot, toCall, potOdds, equity, bestAction, evLoss, grade, thinkMs`。

---

## 项目结构

```
src/
├── core/            纯逻辑层（无 DOM、无 React、无副作用，100% 可单测）
│   ├── cards.ts         牌编码：card = rank * 4 + suit
│   ├── rank7.ts         7 张取最优牌型判定（唯一生产求值器）
│   ├── rank5Reference.ts 独立参照实现（仅测试用，交叉校验）
│   ├── deck.ts / rng.ts 种子化洗牌（同种子 → 同牌序，可精确回放）
│   ├── betting.ts       下注轮状态机（合法动作集、最小加注、轮次推进）
│   ├── pot.ts           边池构建与分配
│   ├── showdown.ts      摊牌结算、平局分池
│   ├── hand.ts          单手对局编排
│   └── equity/          分级胜率：exact / montecarlo / lookup + 调度器
├── ai/              三档参数化 AI
├── review/          决策 EV 复盘
├── store/           持久化 + schemaVersion 迁移 + 导出
├── workers/         胜率计算 Web Worker
└── ui/              React 界面
    ├── controller.ts      对局控制器（状态机 + 订阅/快照，纯 TS 无 JSX）
    ├── showcasePlan.ts    演出编排纯函数层（步进规划 / 游标数学 / 视图派生）
    ├── stateClone.ts      HandState 深拷贝（controller 边界产出不可变快照）
    ├── useTableShowcase.ts 演出调度 hook（薄组合层，只负责何时推进）
    ├── useBoardReveal.ts / useSettleHold.ts  揭示游标 / 结算停顿（各自一件事）
    ├── replay.ts / useReplay.ts  手牌回放（只读，不写统计）
    └── styles/            全局样式，按层叠顺序引入：
                           base → lobby → table → actions → panels → responsive
tests/
├── unit/            单元测试
├── property/        属性测试（守恒、AI 档位可分辨）
├── fixtures/        冻结的查表值（preflop-table.json）与精确枚举锚点（equity-exact.json）
└── e2e/             Playwright 端到端
scripts/             构建期生成脚本 + 一键验收
```

**依赖方向（硬规则）**：`core/` 不依赖任何人；`ai/`、`review/`、`store/` 只依赖 `core/`；`ui/` 只调用下层，不实现规则逻辑。

---

## 关键算法

### 牌型判定

单次遍历计数法，**不做 C(7,5)=21 种组合枚举**：统计点数与花色计数后直接判定，结果打包为单个整数（`cat` 为最高有效位）以支持数值比较。

必须覆盖的边界：A-2-3-4-5 轮子顺（最大牌为 5）、同花顺优于四条、葫芦优于同花、踢脚逐级比较。

正确性策略：生产实现与独立参照实现（枚举子集 + 独立 5 张分类器）在 20 万手随机牌上必须逐手一致。

### 分级胜率路由

| 街 | 单挑（1 对手） | 多人桌（≥2 对手） |
|---|---|---|
| 翻牌前 | 查表（169 手牌类，确定性） | 查表 |
| 翻牌 | 精确枚举 1,070,190 次摊牌（约 1.8s，默认关闭） | 蒙特卡洛 |
| 转牌 | 精确枚举 45,540 次摊牌（约 80ms） | 蒙特卡洛 |
| 河牌 | 精确枚举 990 次摊牌（约 2ms，可同步） | 蒙特卡洛 |

**为什么多人桌不能精确枚举**：6 人桌河牌精确组合数为 `361,767,238,232,400`，组合上不可行。

**执行线程口径**（勿误解为「全部在 Worker 内」）：

| 调用场景 | 执行线程 | 实测耗时 |
|---|---|---|
| 用户主动点「查看提示」 | **Web Worker**（`src/workers/equity.worker.ts`） | 6 人桌 20,000 次约 210–245ms（后台线程，不阻塞界面） |
| AI 决策（hard 档蒙特卡洛） | **主线程同步** | 单次 p50 1.6ms / p95 6.4ms / max 10.7ms（60 手 / 720 次决策实测） |
| 赛后复盘（每决策点） | **主线程同步** | 每决策点约 4.8ms（一手 4 个决策点约 19ms） |

即：只有「用户主动请求的提示」走 Worker；AI 决策与复盘是主线程同步计算。
当前实测耗时可接受，故未迁移；**仅当提高 `equityIterations` 导致明显卡顿时**才需要迁入 Worker。
（评估报告 M6 记录：此前 README 与设置页笼统写作「所有重计算在 Worker 内执行」，与实现不符，已按实测修正。）

### AI 决策与演出节奏

**思考时长与节奏档位**（`src/ui/thinkTiming.ts`）：AI 每一步的等待时长按档位在固定区间内抽样。

| 档位 | 区间 | 一手墙钟（6 人桌实测） | 说明 |
|---|---|---|---|
| 拟真（默认） | 1100–1800ms | 20–30s | 下限严格大于 1 秒，跨度约 1.6 倍以便体感可分辨 |
| 快速 | 350–600ms | 8–12s | 牺牲「像真人」的观感换练习吞吐 |
| 瞬时 | 0 | 3–6s | 只看结果，适合复盘期快速刷手 |

- 默认档是**拟真**：这是产品取舍——「AI 不该在 1 秒内出决策」优先于练习吞吐，想要快的人可以自己切（首屏与设置面板都能改，且**立即生效**，不需要等下一手）。
- 抽样键为 `seed|revision|seat`，经 FNV-1a + murmur3 雪崩得到 `[0,1)`，因此**同一局面重渲染不会重抽**（不会出现「画面已过、定时器又被重置」的漂移）。
- 时长只进入 `ShowcaseStep.delayMs`，不参与 `decideAI`；`tests/unit/think-timing.test.ts` 用「同一 seed 三档各推进一遍、逐条比对动作序列完全相同」把这条不变量钉住。
- 尊重「减少动态效果」：`prefers-reduced-motion` 下 `timing.thinkMs` 为 0，所有等待归零，档位不再生效（无障碍语义优先）。
- **长按 S 跳过当前等待**：只把等待压到 0，动作序列与档位无关（同一条不变量守着）。松开恢复；窗口失焦也会自动解除，避免「按过一次之后每一手都瞬发」。
- 副作用（拟真档）：单手墙钟从约 8–14s 增至约 20–30s（6 人桌一手 12–20 次 AI 决策）。这是「下限 > 1 秒」这条需求的直接代价，档位就是它的出口。

**AI 胜率一律走蒙特卡洛**（`src/ai/policy.ts`）：困难档翻牌后直接调用 `monteCarloEquity`（3000 次采样），不经 `computeEquity`。原因：`computeEquity` 在「单挑 + 转牌/河牌」会走精确枚举（转牌 45,540 次摊牌），冷启动实测 52ms、慢机可达数百毫秒；而 AI 只需把胜率与底池赔率阈值比较，±2% 采样误差不改变判断。**提示与复盘仍走 `computeEquity`**（那里需要精确值），`src/core/` 未改动。

**翻前查表的对手数缺口**：`tests/fixtures/preflop-table.json` 只覆盖对手数 `{1, 2, 5, 8}`。6 人桌翻前常有 3–4 个对手仍在池中，此时查表未命中、退化为蒙特卡洛——AI 侧必须显式传 `iterations: AI_ITERATIONS`（3000），否则会用 `computeEquity` 的默认 20,000 次（实测 70–95ms 主线程停顿）。修复后 AI 单次决策最坏耗时从 94.8ms 降到 10.7ms。

**跟注率与去机械化**（`src/ai/tiers.ts` + `src/ai/policy.ts`）：`AITierParams` 在原 8 个字段外新增 3 个概率参数——`callFrequency`（赔率支持跟注时仍跟注的概率）、`looseCallChance`（赔率不足时仍跟注的概率）、`strengthJitter`（牌力评估的对称抖动幅度）。

| 档位 | callFrequency | looseCallChance | strengthJitter |
|---|---|---|---|
| 简单 | 0.88 | 0.45 | 0.10 |
| 中等 | 0.72 | 0.30 | 0.08 |
| 困难 | 1.00 | 0 | 0.04 |

困难档 `strictPotOdds` 语义逐字保留（赔率不足必弃牌），因此 `callFrequency=1`、`looseCallChance=0` 不改变其行为。

改动前后（800 手/档，固定种子，6 人桌，「面对下注时」统计）：

| 档位 | 跟注 | 弃牌 |
|---|---|---|
| 简单 | 57.5% → **46.4%** | 0% → **6.5%** |
| 中等 | 86.9% → **57.4%** | 0% → **23.6%** |
| 困难 | 27.0% → 26.5% | 66.7% → 66.1% |

改动前简单/中等档面对下注**永不弃牌**：非 `strictPotOdds` 分支在赔率不足时直接落到无条件的「宽松跟注」。现在改为概率门，未通过则弃牌。`tests/unit/ai-distribution.test.ts` 把三档接线与区间钉住。

### 边池

按各座位本手总投入额升序分层，每层记录有资格的座位集合。弃牌者的投入进池但无资格分得。

不变量：`Σ 各层金额 == 所有玩家投入总额`（由 10,000 手属性测试强制）。

---

## 断言基准约束（重要）

**断言只允许使用「精确枚举值」与「查表值」；蒙特卡洛采样值不得作为断言基准。**

原因：蒙特卡洛含随机误差，用作相等断言会同时产生两类错误——假阴性（正确实现因采样波动被判失败，更危险）与假阳性（错误实现偶尔落在容差内被放过）。

由此推出的测试写法：

- 精确枚举 → 断言「摊牌数 == 组合数」且「结果 == 锚点值」，**精确相等**
- 查表 → 断言「返回值 == 冻结表中的值」，**精确相等**
- 蒙特卡洛 → 只断言统计收敛性（固定种子，容差 ±1.5%），**不断言相等**

采样误差口径（实测经验标准差，非 `1/√N` 粗算）：

| 场景 | 迭代数 | 实测标准差 | 95% 置信区间 |
|---|---|---|---|
| 单挑 | 20,000 | 0.238% | ±0.47% |
| 单挑 | 100,000 | 0.102% | ±0.20% |
| 6 人桌 | 20,000 | 0.321% | ±0.63% |
| 6 人桌 | 100,000 | 0.190% | ±0.37% |

---

## 验收闸门

`npm run verify` 顺序执行，任一失败即整体失败（非零退出）。这是「完成」的机器定义。

| 闸门 | 内容 |
|---|---|
| G1 | 全量枚举 `C(52,5) = 2,598,960`，牌型直方图精确等于组合数学真值 |
| G2 | 生产求值器 vs 独立参照实现，20 万手随机牌错 0 手 |
| G3 | 精确枚举摊牌数精确等于组合数（990 / 45,540 / 1,070,190） |
| G4 | 筹码守恒：10,000 手随机对局，每手 Σ 筹码不变且净盈亏合计为 0 |
| G5 | 边池与平局分池（含奇数筹码按位置序分配） |
| G6 | 胜率路径正确性（精确/查表精确相等；采样仅收敛性） |
| G7 | AI 三档可分辨：困难档入池率严格低于简单档，面对加注弃牌率严格更高 |
| G8 | 端到端：全链路跑通、无 console error、历史入库、快捷键、移动端布局 |
| G9 | 类型检查 + 生产构建 + 产物存在性（含 Web Worker chunk） |
| G10 | 持久化健壮性：迁移、损坏数据不白屏、FIFO 上限 |
| G11 | dev 冒烟：vite dev 下连打 3 手、点「下一手」不白屏（生产构建看不到这类缺陷） |

当前规模：单元与属性测试 **22 个文件 / 324 个用例**，E2E **67 个用例**（含线上部署验收，未配置 `LIVE_URL` 时跳过）。

另有针对性回归测试覆盖下列已修缺陷：

| 缺陷 | 回归测试 |
|---|---|
| 六人桌左右两侧座位不渲染底牌 | `tests/unit/table-order.test.ts`、`tests/e2e/bugfix.spec.ts` |
| 座位视觉顺时针顺序与座次不一致 | `tests/unit/table-order.test.ts`、`tests/e2e/bugfix.spec.ts` |
| 筹码飞行动画终态残留（永久停在底池上） | `tests/e2e/bugfix.spec.ts` |
| 空有资格层会静默销毁筹码 | `tests/property/pot-audit.test.ts` |
| AI 分步演出（思考先于动作、公共牌逐张） | `tests/unit/showcase.test.ts`、`tests/e2e/showcase.spec.ts` |
| AI 思考时长过短（<1s 出决策）且无波动 | `tests/unit/think-timing.test.ts`、`tests/e2e/ai-think-timing.spec.ts` |
| 玩家弃牌后直接给出结果、不继续演算 | `tests/e2e/fold-flow.spec.ts` |
| 全下摊牌时结算面板先于公共牌揭示出现 | `tests/e2e/fold-flow.spec.ts`（第三个用例） |
| AI 面对下注永不弃牌、跟注率过高 | `tests/unit/ai-distribution.test.ts` |
| 复盘「建议动作」恒为加注（EV 模型弃牌概率与牌力无关） | `tests/unit/review-distribution.test.ts` |
| 开发模式点「下一手」白屏（揭示游标跨手残留） | `tests/unit/showcase-cursor.test.ts`、`scripts/dev-smoke.mjs`（G11） |
| 九人桌漏座 / 手机座位重叠 / 结算态压住公共牌 | `tests/unit/table-order.test.ts`、`tests/e2e/geometry.spec.ts` |
| 统计面板「当前资金」盈亏配色硬编码 1000（起始筹码改了仍按 1000 判盈亏） | `tests/unit/format.test.ts`、`tests/e2e/ux-fixes.spec.ts` |
| 全下单击即执行、无二次确认 | `tests/e2e/ux-fixes.spec.ts` |
| AI 每步等待固定不变、无法按需加速（审计 P1-1） | `tests/unit/think-timing.test.ts`、`tests/e2e/pace.spec.ts` |
| 切换节奏档位不影响等待时长（档位没接进调度链路） | `tests/e2e/pace.spec.ts` |
| 长按 S 跳过等待后不解除（后续每一手都瞬发） | `tests/e2e/pace.spec.ts` |
| 答完补码后停在空桌（补码流程不开下一手） | `tests/e2e/carry-over.spec.ts` |
| 快照被引擎原地改写（历史帧/复盘早期决策被后来的状态污染） | `tests/unit/state-clone.test.ts` |
| 继承模式筹码不跨手 / 输光无结局 / AI 下桌仍占座 | `tests/unit/carry-over.test.ts`、`tests/e2e/carry-over.spec.ts` |
| 加注滑杆无 `aria-valuetext`、tab 与面板未互指、底池变化不可播报 | `tests/e2e/ux-fixes.spec.ts` |
| 建桌参数只能在进桌后的设置里改（首屏只读，改完还要等下一手） | `tests/e2e/lobby-setup.spec.ts` |
| 继承模式下改起始筹码/桌人数不重建账本（牌桌仍显示旧筹码，改了像没改） | `tests/unit/carry-over.test.ts` |
| 非继承模式下改起始筹码后顶部资金与牌桌座位两个数对不上 | `tests/unit/carry-over.test.ts`、`tests/e2e/lobby-setup.spec.ts` |
| 历史记录无法回看（只有动作流水，不能重放某一手） | `tests/unit/replay.test.ts`、`tests/e2e/replay.spec.ts` |
| 回放与实时演出共用状态，退出后写库或改动统计 | `tests/e2e/replay.spec.ts`（退出后存档逐字节比对） |
| 结构残缺的历史记录点「回放」才报错（应提前置灰） | `tests/unit/replay.test.ts`、`tests/e2e/replay.spec.ts` |

---

## 不支持项

- **不做多人联机**：面向单人练习，无后端、无账号、无跨设备同步。
- **不做 GTO 求解**：复盘用启发式 EV 阈值，不是博弈论最优基准。
- **不做牌谱导入**：不解析 PokerStars / GGPoker 等平台的历史牌局格式。
- **不做起手牌训练与赔率判断题**：当前版本（v1.1.0）未实现，也**未排期**（`core/equity/` 与 `review/` 的纯函数接口已为其预留，便于后续接入）。
- **不做抽水 / 前注 / straddle / 盲注递增**：按现金局固定盲注结构实现。

---

## 数据与来源

| 数据 | 来源类型 | 说明 |
|---|---|---|
| 牌型直方图（40 / 624 / 3744 / 5108 / 10200 / 54912 / 123552 / 1098240 / 1302540） | 精确枚举值 | 全量枚举，合计校验 = 2,598,960 |
| `tests/fixtures/preflop-table.json` | 查表值 | 构建期生成并冻结，169 手牌类 × 4 档对手数，各 100,000 次迭代 |
| `tests/fixtures/equity-exact.json` | 精确枚举值 | 11 个锚点，覆盖河牌/转牌/翻牌 |
| README 与设置页中的耗时数字 | 实测值 | Node 24.21.0 / Windows，预热后取中位数 |

重新生成数据：

```bash
npm run gen:table     # 重建翻牌前查表（约 11 分钟）
npm run gen:anchors   # 重建精确枚举锚点（约 1 秒）
```

---

## 参与贡献

欢迎提交 Issue 与 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)——尤其是「`npm run verify` 必须全绿」与「不得为了让测试通过而放宽断言」两条。

安全问题请见 [SECURITY.md](SECURITY.md)，社区行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，版本发布流程见 [RELEASING.md](RELEASING.md)。

---

## 许可证

[MIT](LICENSE) © xv-xiong

