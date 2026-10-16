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
| 三档 AI | 简单 / 中等 / 困难，由同一套策略 + 正交参数实现，难度可测可分辨 |
| 决策复盘 | 每个决策点给出实际动作 EV、最优动作 EV、EV 损失与分级（>0.5BB 值得复盘，>2BB 明显偏离） |
| 主动提示 | 默认关闭；按「查看提示」显示估算胜率、底池赔率要求与建议动作，查看次数计入统计 |
| 分级胜率 | 翻牌前查表；单挑转牌/河牌精确枚举；多人桌与翻牌用蒙特卡洛（Web Worker 内执行） |
| 数据持久化 | 资金与历史存 `localStorage`，上限 500 手（FIFO）；支持导出 JSON / CSV |
| 响应式 | 桌面完整布局；手机竖屏牌桌缩小、操作区固定底部 |
| 无障碍 | 四色牌（♠黑 ♥红 ♦蓝 ♣绿，可切两色）、快捷键、焦点可见、尊重「减少动态效果」 |

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

当前规模：单元与属性测试 **14 个文件 / 198 个用例**，E2E **31 个用例**（含线上部署验收，未配置 `LIVE_URL` 时跳过）。

另有针对性回归测试覆盖下列已修缺陷：

| 缺陷 | 回归测试 |
|---|---|
| 六人桌左右两侧座位不渲染底牌 | `tests/unit/table-order.test.ts`、`tests/e2e/bugfix.spec.ts` |
| 座位视觉顺时针顺序与座次不一致 | `tests/unit/table-order.test.ts`、`tests/e2e/bugfix.spec.ts` |
| 筹码飞行动画终态残留（永久停在底池上） | `tests/e2e/bugfix.spec.ts` |
| 空有资格层会静默销毁筹码 | `tests/property/pot-audit.test.ts` |
| AI 分步演出（思考先于动作、公共牌逐张） | `tests/unit/showcase.test.ts`、`tests/e2e/showcase.spec.ts` |

---

## 不支持项

- **不做多人联机**：面向单人练习，无后端、无账号、无跨设备同步。
- **不做 GTO 求解**：复盘用启发式 EV 阈值，不是博弈论最优基准。
- **不做牌谱导入**：不解析 PokerStars / GGPoker 等平台的历史牌局格式。
- **不做起手牌训练与赔率判断题**：属 v1.1 范围，当前版本未实现（但 `core/equity/` 与 `review/` 的纯函数接口已为其预留）。
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

