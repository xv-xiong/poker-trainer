import { describe, expect, it } from 'vitest';
import {
  MIN_BIG_BLIND,
  MIN_SMALL_BLIND,
  MIN_STARTING_STACK,
  clampBigBlind,
  clampSmallBlind,
  clampStartingStack,
  netClass,
} from '../../src/ui/format.js';

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

describe('建桌参数规范化：首屏与设置面板共用同一份规则', () => {
  it('合法值原样保留', () => {
    expect(clampStartingStack(2000)).toBe(2000);
    expect(clampSmallBlind(10)).toBe(10);
    expect(clampBigBlind(20)).toBe(20);
  });

  it('低于下限时夹到下限', () => {
    expect(clampStartingStack(50)).toBe(MIN_STARTING_STACK);
    expect(clampStartingStack(0.5)).toBe(MIN_STARTING_STACK);
    // 注意 0 走的是「清空输入框」分支（回落到默认值 5），不是夹到下限 1；
    // 要验证「夹到下限」必须用非 0 的小数。
    expect(clampSmallBlind(0.5)).toBe(MIN_SMALL_BLIND);
    expect(clampBigBlind(1)).toBe(MIN_BIG_BLIND);
  });

  it('清空输入框（空串 → Number 得到 0）回落到默认值，而不是留在 0', () => {
    // 这是受控 number 输入框最容易踩的坑：用户全选删除后 e.target.value === ''，
    // Number('') === 0，若不兜底就会把 0 写进设置（0 筹码直接开不了局）。
    expect(clampStartingStack(0)).toBe(1000);
    expect(clampSmallBlind(0)).toBe(5);
    expect(clampBigBlind(0)).toBe(10);
  });

  it('NaN / Infinity 不能漏进设置', () => {
    // `Math.max(100, NaN)` 是 NaN：NaN 一旦落库，validateSettings 会判存档损坏
    // → 归档重建，用户的战绩与资金全丢。所以非有限值必须先兜底再夹。
    expect(clampStartingStack(NaN)).toBe(1000);
    // Infinity 也按「非有限值」处理，回落到默认值——而不是把它原样写进设置
    // （那会让整桌筹码变成 Infinity，结算与校验全部失去意义）。
    expect(clampStartingStack(Infinity)).toBe(1000);
    expect(clampSmallBlind(NaN)).toBe(5);
    expect(clampBigBlind(NaN)).toBe(10);
    expect(Number.isFinite(clampStartingStack(NaN))).toBe(true);
    expect(Number.isFinite(clampSmallBlind(NaN))).toBe(true);
    expect(Number.isFinite(clampBigBlind(NaN))).toBe(true);
  });

  it('下限常量之间保持 起始 > 大盲 > 小盲 的常识关系', () => {
    expect(MIN_STARTING_STACK).toBeGreaterThan(MIN_BIG_BLIND);
    expect(MIN_BIG_BLIND).toBeGreaterThan(MIN_SMALL_BLIND);
    expect(MIN_SMALL_BLIND).toBeGreaterThan(0);
  });

  it('小数不会被截断（保留用户输入的精确值，交由 core 的取整口径处理）', () => {
    expect(clampStartingStack(1250.5)).toBe(1250.5);
    expect(clampSmallBlind(2.5)).toBe(2.5);
  });
});
