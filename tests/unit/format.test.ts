import { describe, expect, it } from 'vitest';
import { netClass } from '../../src/ui/format.js';

describe('netClass：当前资金的盈亏配色', () => {
  it('资金高于起始筹码 → 盈利（pos）', () => {
    expect(netClass(1500, 1000)).toBe('pos');
    expect(netClass(1200, 1000)).toBe('pos');
  });

  it('资金低于起始筹码 → 亏损（neg）', () => {
    expect(netClass(800, 1000)).toBe('neg');
    expect(netClass(999, 1000)).toBe('neg');
  });

  it('资金等于起始筹码 → 不亏（pos，与旧实现的 >= 边界一致）', () => {
    expect(netClass(1000, 1000)).toBe('pos');
  });

  it('起始筹码不是默认 1000 时，判据跟着走（旧实现 bug 的回归）', () => {
    // 起始筹码 2000：资金 1500 是亏损。旧实现 `bankroll >= 1000` 会误判为盈利。
    expect(netClass(1500, 2000)).toBe('neg');
    // 起始筹码 500：资金 600 是盈利。旧实现 `bankroll >= 1000` 会误判为亏损。
    expect(netClass(600, 500)).toBe('pos');
  });
});
