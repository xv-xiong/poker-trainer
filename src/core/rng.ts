/**
 * 种子化伪随机数生成器（mulberry32）。
 *
 * 为什么不用 Math.random()：本项目的核心可验证性要求「同一手牌可精确复现」。
 * 种子写入每手历史记录，使任意一手都能被重新发牌、重放与缺陷复现。
 * 测试中所有随机行为必须显式传种子，不允许隐式全局随机。
 */

export interface Rng {
  /** 返回 [0, 1) 的浮点数。 */
  next(): number;
  /** 返回 [0, maxExclusive) 的整数。 */
  nextInt(maxExclusive: number): number;
  /** 当前内部状态（用于序列化）。 */
  readonly state: number;
}

/** 创建 mulberry32 生成器。种子相同 → 序列完全相同。 */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    nextInt(maxExclusive: number): number {
      if (maxExclusive <= 0) throw new Error('nextInt 需要正整数上界');
      return Math.floor(next() * maxExclusive);
    },
    get state() {
      return s;
    },
  };
}

/** 由当前时间与计数器生成一个种子（仅在开局时调用一次）。 */
export function randomSeed(): number {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}
