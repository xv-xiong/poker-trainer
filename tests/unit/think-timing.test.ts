/**
 * AI 思考时长抽样（阶段二：节奏档位）的单测。
 *
 * 覆盖四类断言：
 *   1. **产品硬要求**：拟真档下限 > 1000ms，且任何输入都不能抽到低于下限的值；
 *   2. **三档定义**：拟真 / 快速 / 瞬时各自的区间与相对关系；
 *   3. **分布质量**：不是「伪随机但恒定」，10 个桶都要有足够样本（近似均匀）；
 *   4. **不影响决策**：`thinkTiming.ts` 在架构上不依赖 `src/ai/**` / `src/core/**`，
 *      且同一牌局状态下 AI 的动作序列与「等待多久」「哪个档位」完全无关（逐条比对）。
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createHand } from '../../src/core/hand.js';
import { defaultSettings, type AITier, type Settings } from '../../src/core/types.js';
import { stepAiAction } from '../../src/ui/showcaseStep.js';
import {
  AI_THINK_RANGE,
  AI_THINK_RANGES,
  aiThinkDelayMs,
  hashUnit,
  sampleAiThinkMs,
} from '../../src/ui/thinkTiming.js';
import { DEFAULT_PACE, normalizePace } from '../../src/store/schema.js';

describe('thinkTiming：区间定义（产品硬要求）', () => {
  it('拟真档下限必须 > 1000ms（不允许 1 秒内出决策），上限不能太长', () => {
    expect(AI_THINK_RANGE.minMs).toBeGreaterThan(1000);
    expect(AI_THINK_RANGE.maxMs).toBeGreaterThan(AI_THINK_RANGE.minMs);
    // 上限不能太长：单手 12–20 次 AI 决策，若单步上限过大，训练节奏会失控
    expect(AI_THINK_RANGE.maxMs).toBeLessThanOrEqual(3000);
  });

  it('AI_THINK_RANGE 恒等于默认档的区间（向后兼容别名不能漂移）', () => {
    expect(AI_THINK_RANGE).toEqual(AI_THINK_RANGES[DEFAULT_PACE]);
  });

  it('三档区间：拟真 > 快速 > 瞬时，且瞬时真的是 0', () => {
    const { realistic, fast, instant } = AI_THINK_RANGES;
    expect(realistic.minMs).toBeGreaterThan(fast.maxMs);
    expect(fast.minMs).toBeGreaterThan(instant.maxMs);
    expect(instant).toEqual({ minMs: 0, maxMs: 0 });
    // 快速档要明显快于拟真（否则档位没有意义）：拟真档最快的等待
    // 也至少是快速档最长等待的 1.5 倍
    expect(realistic.minMs / fast.maxMs).toBeGreaterThanOrEqual(1.5);
  });

  it('每个档位自身 min <= max，且都不为负', () => {
    for (const [name, r] of Object.entries(AI_THINK_RANGES)) {
      expect(r.minMs, name).toBeGreaterThanOrEqual(0);
      expect(r.maxMs, name).toBeGreaterThanOrEqual(r.minMs);
      expect(Number.isFinite(r.minMs), name).toBe(true);
      expect(Number.isFinite(r.maxMs), name).toBe(true);
    }
  });
});

describe('thinkTiming：sampleAiThinkMs', () => {
  const range = { minMs: 1100, maxMs: 2400 };

  it('两端都可达，且返回值恒为整数', () => {
    expect(sampleAiThinkMs(range, 0)).toBe(1100);
    expect(sampleAiThinkMs(range, 0.9999999999)).toBe(2400);
    for (const u of [0.1, 0.33, 0.5, 0.75, 0.9]) {
      expect(Number.isInteger(sampleAiThinkMs(range, u))).toBe(true);
    }
  });

  it('unit 单调不减（同样的 unit 永远给同样的值）', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = sampleAiThinkMs(range, i / 101);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('越界 / 非有限的 unit 被夹住，绝不产生 NaN 或低于下限的值', () => {
    for (const u of [-1, -0.0001, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const v = sampleAiThinkMs(range, u);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(range.minMs);
      expect(v).toBeLessThanOrEqual(range.maxMs);
    }
  });

  it('minMs > maxMs 的畸形区间不会崩溃（退化为 minMs）', () => {
    expect(sampleAiThinkMs({ minMs: 1500, maxMs: 1200 }, 0.5)).toBe(1500);
  });
});

describe('thinkTiming：hashUnit', () => {
  it('确定性：同一个键永远得到同一个数', () => {
    expect(hashUnit('12345|7|3')).toBe(hashUnit('12345|7|3'));
  });

  it('落在 [0, 1) 内', () => {
    for (const key of ['0|0|0', '1|2|3', '', 'a'.repeat(64), '999999|500|8']) {
      const v = hashUnit(key);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('相邻 revision 不会产生相关性（连续键的样本近似均匀）', () => {
    // 这是本模块最容易被写坏的一点：键是 "seed|revision|seat" 十进制拼接，
    // 若只用 FNV-1a 而不做雪崩，连续 revision 抽出的时长会呈明显规律。
    const buckets = new Array(10).fill(0);
    const N = 5000;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let rev = 0; rev < N; rev++) {
      const v = sampleAiThinkMs(AI_THINK_RANGE, hashUnit(`20260101|${rev}|${rev % 6}`));
      min = Math.min(min, v);
      max = Math.max(max, v);
      const span = AI_THINK_RANGE.maxMs - AI_THINK_RANGE.minMs + 1;
      const idx = Math.min(9, Math.floor(((v - AI_THINK_RANGE.minMs) / span) * 10));
      buckets[idx] += 1;
    }
    expect(min).toBeGreaterThanOrEqual(AI_THINK_RANGE.minMs);
    expect(max).toBeLessThanOrEqual(AI_THINK_RANGE.maxMs);
    // 均匀性：每个桶至少 2%（理论上 ~10%，给足余量避免偶发抖动导致假红）
    for (const [i, n] of buckets.entries()) {
      expect(n / N, `第 ${i} 桶占比过低：${n}/${N}`).toBeGreaterThan(0.02);
    }
    // 真的在波动：样本要基本铺满整个区间（不写死毫秒数，跟着区间走，
    // 否则以后调整 AI_THINK_RANGE 会变成假红）
    const rangeSpan = AI_THINK_RANGE.maxMs - AI_THINK_RANGE.minMs;
    expect(max - min).toBeGreaterThan(rangeSpan * 0.9);
  });
});

describe('thinkTiming：aiThinkDelayMs', () => {
  const base = {
    kind: 'ai-action',
    seat: 3,
    baseMs: 560,
    seed: 20260101,
    revision: 42,
    pace: DEFAULT_PACE,
  };

  it('只有 ai-action 步需要思考时长，其余步一律 0', () => {
    for (const kind of ['board', 'settle', 'hero-action', 'idle']) {
      expect(aiThinkDelayMs({ ...base, kind })).toBe(0);
    }
  });

  it('baseMs = 0（reduced-motion）时等待必须归零——优先级高于档位', () => {
    for (const pace of ['realistic', 'fast', 'instant'] as const) {
      expect(aiThinkDelayMs({ ...base, baseMs: 0, pace })).toBe(0);
    }
  });

  it('拟真档恒落在区间内，且 ≥ 下限 > 1000ms', () => {
    for (let rev = 0; rev < 500; rev++) {
      for (const seat of [1, 2, 3, 4, 5]) {
        const v = aiThinkDelayMs({ ...base, seat, revision: rev, pace: 'realistic' });
        expect(v).toBeGreaterThanOrEqual(AI_THINK_RANGES.realistic.minMs);
        expect(v).toBeLessThanOrEqual(AI_THINK_RANGES.realistic.maxMs);
        expect(v).toBeGreaterThan(1000);
      }
    }
  });

  it('快速档落在自己的区间内（不套用拟真档的下限）', () => {
    for (let rev = 0; rev < 300; rev++) {
      const v = aiThinkDelayMs({ ...base, revision: rev, pace: 'fast' });
      expect(v).toBeGreaterThanOrEqual(AI_THINK_RANGES.fast.minMs);
      expect(v).toBeLessThanOrEqual(AI_THINK_RANGES.fast.maxMs);
    }
  });

  it('瞬时档恒为 0', () => {
    for (let rev = 0; rev < 100; rev++) {
      expect(aiThinkDelayMs({ ...base, revision: rev, pace: 'instant' })).toBe(0);
    }
  });

  it('未知档位回退到默认档（绝不产生 NaN / undefined）', () => {
    const v = aiThinkDelayMs({ ...base, pace: 'bogus' as never });
    expect(v).toBeGreaterThanOrEqual(AI_THINK_RANGES[DEFAULT_PACE].minMs);
    expect(v).toBeLessThanOrEqual(AI_THINK_RANGES[DEFAULT_PACE].maxMs);
  });

  it('同一步只对应一个值（重渲染 / 双调用不会重抽）', () => {
    const a = aiThinkDelayMs(base);
    const b = aiThinkDelayMs(base);
    const c = aiThinkDelayMs({ ...base });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('不同步 / 不同手牌会抽到不同值（体感上确实在波动）', () => {
    const values = new Set<number>();
    for (let rev = 0; rev < 20; rev++) {
      values.add(aiThinkDelayMs({ ...base, revision: rev }));
    }
    for (let seat = 1; seat <= 5; seat++) {
      values.add(aiThinkDelayMs({ ...base, seat }));
    }
    values.add(aiThinkDelayMs({ ...base, seed: 777 }));
    expect(values.size).toBeGreaterThan(5);
  });
});

describe('store/schema：节奏档位持久化', () => {
  it('normalizePace 只放行三个合法值，其余回退默认', () => {
    expect(normalizePace('realistic')).toBe('realistic');
    expect(normalizePace('fast')).toBe('fast');
    expect(normalizePace('instant')).toBe('instant');
    for (const bad of [undefined, null, '', 'FAST', 'slow', 0, 1, {}, []]) {
      expect(normalizePace(bad), String(bad)).toBe(DEFAULT_PACE);
    }
  });

  it('默认档是拟真（用户拍板选项 C：默认不改成「快速」）', () => {
    expect(DEFAULT_PACE).toBe('realistic');
  });
});

describe('thinkTiming：不影响 AI 的实际决策', () => {
  it('本模块不依赖决策层（唯一 import 是 type-only 的 Pace）', () => {
    const src = readFileSync(new URL('../../src/ui/thinkTiming.ts', import.meta.url), 'utf8');
    const imports = src.match(/^\s*import\s.+$/gm) ?? [];
    // 只允许 import type —— 类型在编译期被擦除，运行时零依赖，因此
    // 该模块在架构上就没有能力改变任何决策。
    for (const line of imports) {
      expect(line, `出现了非 type-only 的 import：${line}`).toMatch(/^\s*import\s+type\s/);
    }
    // 不允许 import 任何策略 / 规则模块
    expect(src).not.toMatch(/from\s+'[^']*\/ai\//);
    expect(src).not.toMatch(/from\s+'[^']*\/core\//);
  });

  it('同一牌局状态下，AI 动作序列与「等待时长」「档位」都无关（逐条比对）', () => {
    const settings: Settings = { ...defaultSettings(), seatCount: 6, aiTier: 'medium' as AITier };
    const makeState = () =>
      createHand({
        handId: 'think-timing-fixed',
        seed: 20260101,
        settings,
        heroSeat: 0,
        dealerSeat: 2,
      });

    /** 把一手牌推进到结束（或上限），返回动作序列；每步按给定档位抽一次等待。 */
    const run = (
      state: ReturnType<typeof makeState>,
      pace: 'realistic' | 'fast' | 'instant',
    ): string[] => {
      const out: string[] = [];
      let guard = 0;
      while (!state.finished && guard++ < 200) {
        const seat = state.actingSeat;
        if (seat < 0) break;
        const before = state.actions.length;
        const r = stepAiAction(state, 0, guard);
        if (!r.advanced) break;
        // 只记录真正生效的动作
        if (state.actions.length > before) {
          const a = state.actions[state.actions.length - 1];
          out.push(`${a.seat}:${a.type}:${a.toAmount}`);
        }
        // 顺便抽一个思考时长：它不应以任何方式影响上面的动作
        aiThinkDelayMs({
          kind: 'ai-action',
          seat,
          baseMs: 560,
          seed: state.seed,
          revision: guard,
          pace,
        });
      }
      return out;
    };

    const a = run(makeState(), 'realistic');
    const b = run(makeState(), 'realistic');
    const fast = run(makeState(), 'fast');
    const instant = run(makeState(), 'instant');

    expect(a.length).toBeGreaterThan(0);
    // 同档位两次：完全一致（可复现）
    expect(a).toEqual(b);
    // 跨档位：动作序列必须逐条相同——档位只压缩等待，不能改变决策
    expect(fast).toEqual(a);
    expect(instant).toEqual(a);
  });
});
