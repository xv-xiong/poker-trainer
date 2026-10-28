/**
 * AI「思考时长」抽样规则（纯函数，无副作用、无依赖）。
 *
 * 归属：任务一（AI 决策耗时模拟真人）。本模块刻意做成**纯计算**，原因有三：
 *
 *   1. **可测**：`useTableShowcase` 是 React hook，没有 @testing-library 就难以
 *      直接断言「每一步抽了几次随机数」；把抽样逻辑抽成纯函数后，边界与分布
 *      都能在单测里穷举验证。
 *   2. **不碰决策**：思考时长只影响「等多久再执行」，绝不能影响「执行什么」。
 *      因此本模块不 import `src/ai/**`、`src/core/**` 的任何东西——它在架构上
 *      就没有能力改变决策（见 tests/unit/think-timing.test.ts 的静态断言）。
 *   3. **可复现**：抽样用「键 → 均匀数」的哈希派生，而不是 `Math.random()`。
 *      同一 (seed, revision, seat) 永远得到同一个时长，重渲染 / StrictMode
 *      双调用 / effect 重跑都不会重新抽样，定时器也不会因此被重置。
 *
 * 为什么不用 `Math.random()`：本 hook 的 `step` 会在每次渲染重算，若在渲染期
 * 调用 `Math.random()`，React 严格模式的双渲染会抽出两个不同值，而上层定时器
 * 依赖的 `step` 身份却只在 `stepKey` 变化时更新 —— 于是「画面显示的等待」
 * 与「实际等待」可能不一致，且 E2E 无法复现。哈希派生把这个不确定性彻底消掉。
 */

/** AI 单步思考时长区间（毫秒，两端都含）。 */
export interface AiThinkRange {
  /** 下限（含）。 */
  minMs: number;
  /** 上限（含）。 */
  maxMs: number;
}

/**
 * 单步思考时长区间。
 *
 * 取值理由（产品要求：下限必须 > 1 秒、上限不能太长）：
 *   - 下限 1100ms：要求「不允许 1 秒内出决策」，留 100ms 余量吸收调度抖动；
 *   - 上限 1800ms：一手 6 人桌通常有 12–20 次 AI 决策，一条街常有 2–4 个 AI
 *     连续行动，累计等待 = 步数 × 单步时长。上限 2400ms 时，一条 4 步的街最坏
 *     要等 9.6 秒，体感像「卡住」（用户实测反馈：困难模式六人桌转牌偏长）。
 *     收到 1800ms 后同样场景最坏 7.2 秒、典型 3 步约 4.4 秒；
 *   - 区间跨度 700ms ≈ 1.6 倍，仍能让「快想」与「长考」在体感上可分辨。
 */
export const AI_THINK_RANGE: AiThinkRange = { minMs: 1100, maxMs: 1800 };

/** 把 32 位哈希做一次 fmix32 雪崩（murmur3 的收尾混合）。 */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 把任意字符串键映射到 `[0, 1)` 的均匀数（FNV-1a + fmix32）。
 *
 * 为什么需要雪崩：键是 `seed|revision|seat` 这种十进制拼接，相邻键只差最后
 * 一两位。纯 FNV-1a 的末位混合不足，连续 revision 会抽出高度相关的时长
 * （表现为「越打越慢」这种肉眼可见的规律）；加一次 fmix32 后分布才近似均匀
 * （tests/unit/think-timing.test.ts 用 10 个桶各 ≥2% 的卡方式断言验证）。
 */
export function hashUnit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h) / 4294967296;
}

/** 把 `unit` 夹到 `[0, 1)`，非有限值按 0 处理（防御性，避免 NaN 传播成 delayMs）。 */
function clampUnit(unit: number): number {
  if (!Number.isFinite(unit)) return 0;
  if (unit <= 0) return 0;
  if (unit >= 1) return 0.9999999999;
  return unit;
}

/**
 * 在 `range` 内按 `unit ∈ [0,1)` 均匀抽样（整数毫秒，两端都可达）。
 *
 * 不变量：返回值恒 ≥ `minMs`（只要 minMs ≥ 0）——这是「下限 > 1 秒」这条
 * 产品要求的最后一道防线，任何 unit 输入都不能突破它。
 */
export function sampleAiThinkMs(range: AiThinkRange, unit: number): number {
  const lo = Math.max(0, Math.round(range.minMs));
  const hi = Math.max(lo, Math.round(range.maxMs));
  const span = hi - lo + 1;
  const u = clampUnit(unit);
  return lo + Math.min(span - 1, Math.floor(u * span));
}

/** `aiThinkDelayMs` 的入参。 */
export interface AiThinkDelayInput {
  /** 该步的类型（只有 `'ai-action'` 需要思考时长）。 */
  kind: string;
  /** 该步的座位号（`idle` / `board` 步没有座位，传 -1 即可）。 */
  seat: number;
  /** 当前节奏的思考基线（毫秒）。**为 0 表示 reduced-motion**，此时必须返回 0。 */
  baseMs: number;
  /** 本手牌局种子（用于让不同手牌抽到不同时长）。 */
  seed: number;
  /** 控制器单调递增的修订号（每个动作 +1，保证同一步只对应一个键）。 */
  revision: number;
}

/**
 * 计算某一步的实际等待时长。
 *
 * 三条硬规则（单测逐条覆盖）：
 *   1. 非 `ai-action` 步 → 0（由调用方沿用 `planShowcaseStep` 自己的 delayMs）；
 *   2. `baseMs <= 0` → 0。这是 `prefers-reduced-motion` 语义：等待必须归零，
 *      否则「减少动态效果」的用户反而被迫多等 1–2 秒；
 *   3. 其余情况 → `AI_THINK_RANGE` 内的抽样值，恒 ≥ `minMs` > 1000。
 */
export function aiThinkDelayMs(input: AiThinkDelayInput): number {
  if (input.kind !== 'ai-action') return 0;
  if (!(input.baseMs > 0)) return 0;
  const key = `${input.seed}|${input.revision}|${input.seat}`;
  return sampleAiThinkMs(AI_THINK_RANGE, hashUnit(key));
}
