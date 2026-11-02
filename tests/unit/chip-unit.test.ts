/**
 * 筹码单位纯函数层测试（阶段六）。
 *
 * 为什么要单独测这一层：
 * 同一个数字在三处出现——牌桌座位上（筹码）、底池（筹码）、操作区下注框（多为 BB）。
 * 这三处如果各自 `(x / bigBlind).toFixed(1)`，同一个底池会在不同位置漂移出
 * 「3.5 BB」「3.50 BB」「4 BB」三种写法，用户读到的是三个数。
 * 把换算收敛成 `src/ui/chipUnit.ts` 的纯函数，才有唯一的口径。
 *
 * 本文件守的第二条更关键：**单位只影响展示，绝不改金额**。
 * core 的规则、结算、持久化全部用筹码整数，单位只是显示的皮。
 * 所以这里不只测「显示成什么样」，还要测「显示出来的文本能不能反解析回
 * 原本那个筹码整数」——反解析漂了，说明展示层偷偷改了钱。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHIP_UNIT,
  clampRaiseTo,
  formatAmount,
  formatChips,
  normalizeChipUnit,
  parseChipInput,
} from '../../src/ui/chipUnit.js';

/** 测试统一用的大盲，取 10 便于心算：1 BB = 10 筹码。 */
const BB = 10;

describe('normalizeChipUnit：非法单位静默回退，不当作存档损坏', () => {
  it('只把精确的字符串 "bb" 认作 BB 档', () => {
    expect(normalizeChipUnit('bb')).toBe('bb');
  });

  it('"BB" 大写不算合法单位，回退默认值（读取时容错，不判损坏）', () => {
    expect(normalizeChipUnit('BB')).toBe('chips');
  });

  it('undefined / null / 空串都回退 chips', () => {
    expect(normalizeChipUnit(undefined)).toBe('chips');
    expect(normalizeChipUnit(null)).toBe('chips');
    expect(normalizeChipUnit('')).toBe('chips');
  });

  it('"chips" 本身原样返回', () => {
    expect(normalizeChipUnit('chips')).toBe('chips');
  });

  it('数字 0 / 1 不是单位，回退 chips', () => {
    expect(normalizeChipUnit(0)).toBe('chips');
    expect(normalizeChipUnit(1)).toBe('chips');
  });

  it('对象与数组不是单位，回退 chips（存档里被污染也不会崩）', () => {
    expect(normalizeChipUnit({})).toBe('chips');
    expect(normalizeChipUnit([])).toBe('chips');
  });

  it('默认单位常量是 chips', () => {
    expect(DEFAULT_CHIP_UNIT).toBe('chips');
  });
});

describe('formatChips 筹码档：原样整数，不加千分位', () => {
  it('整数筹码原样输出', () => {
    expect(formatChips(1200, 'chips', BB)).toBe('1200');
    expect(formatChips(35, 'chips', BB)).toBe('35');
  });

  it('1200 不带千分位（"1,234" 会破坏既有文本比对与用户读法）', () => {
    expect(formatChips(1234, 'chips', BB)).toBe('1234');
  });

  it('小数按四舍五入取整', () => {
    expect(formatChips(12.6, 'chips', BB)).toBe('13');
    expect(formatChips(12.4, 'chips', BB)).toBe('12');
  });

  it('负数小数也按四舍五入取整', () => {
    expect(formatChips(-12.6, 'chips', BB)).toBe('-13');
  });

  it('0 显示为 "0"', () => {
    expect(formatChips(0, 'chips', BB)).toBe('0');
  });

  it('筹码档完全不看 bigBlind（含非法值）', () => {
    expect(formatChips(1200, 'chips', 0)).toBe('1200');
    expect(formatChips(1200, 'chips', -10)).toBe('1200');
    expect(formatChips(1200, 'chips', Number.NaN)).toBe('1200');
  });
});

describe('formatChips BB 档：1 位小数，去掉尾随 .0', () => {
  it('1000 筹码 / 10 = 100，不带 ".0"', () => {
    expect(formatChips(1000, 'bb', BB)).toBe('100');
  });

  it('35 / 10 = 3.5，保留一位小数', () => {
    expect(formatChips(35, 'bb', BB)).toBe('3.5');
  });

  it('3 / 10 = 0.3，整数部分为 0 也要带出来', () => {
    expect(formatChips(3, 'bb', BB)).toBe('0.3');
  });

  it('1234 / 10 = 123.4', () => {
    expect(formatChips(1234, 'bb', BB)).toBe('123.4');
  });

  it('0 换算后仍是 "0"', () => {
    expect(formatChips(0, 'bb', BB)).toBe('0');
  });

  it('负值按同样规则：-25 / 10 = -2.5', () => {
    expect(formatChips(-25, 'bb', BB)).toBe('-2.5');
    expect(formatChips(-100, 'bb', BB)).toBe('-10');
  });

  it('浮点噪声不会让整数涨出 ".0"（先舍入再判整）', () => {
    expect(formatChips(1000 + 1e-9, 'bb', BB)).toBe('100');
  });
});

describe('formatChips：bigBlind 非法时按 1 兜底', () => {
  it('bigBlind = 0 不产生 Infinity', () => {
    expect(formatChips(1000, 'bb', 0)).toBe('1000');
  });

  it('bigBlind 为负数同样按 1 兜底', () => {
    expect(formatChips(35, 'bb', -50)).toBe('35');
  });

  it('bigBlind 为 NaN 时也按 1 兜底', () => {
    expect(formatChips(1000, 'bb', Number.NaN)).toBe('1000');
  });

  it('任何非法 bigBlind 下结果都不是 NaN / Infinity 文本', () => {
    for (const bad of [0, -1, -1000, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const text = formatChips(7, 'bb', bad);
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('Infinity');
      expect(text).toBe('7');
    }
  });
});

describe('formatAmount：筹码档无后缀，BB 档带 " BB"', () => {
  it('筹码档不加任何后缀', () => {
    expect(formatAmount(1200, 'chips', BB)).toBe('1200');
  });

  it('BB 档追加 " BB"（一个前导空格）', () => {
    expect(formatAmount(1200, 'bb', BB)).toBe('120 BB');
  });

  it('BB 档小数同样带后缀', () => {
    expect(formatAmount(35, 'bb', BB)).toBe('3.5 BB');
  });

  it('筹码档的后缀逻辑不受 bigBlind 影响', () => {
    expect(formatAmount(1200, 'chips', 0)).toBe('1200');
  });
});

describe('parseChipInput：解析不出来时返回 null，绝不写 0/NaN', () => {
  it('空串 → null（输入框被删光是编辑中的常态）', () => {
    expect(parseChipInput('', 'chips', BB)).toBeNull();
    expect(parseChipInput('', 'bb', BB)).toBeNull();
  });

  it('纯空白 → null（先去空白再判空）', () => {
    expect(parseChipInput('   ', 'chips', BB)).toBeNull();
    expect(parseChipInput('\t\n ', 'bb', BB)).toBeNull();
  });

  it('非数字 "abc" → null（不能当成 0，否则滑杆与按钮一起冻结）', () => {
    expect(parseChipInput('abc', 'chips', BB)).toBeNull();
    expect(parseChipInput('abc', 'bb', BB)).toBeNull();
  });

  it('畸形小数 "1.2.3" → null', () => {
    expect(parseChipInput('1.2.3', 'chips', BB)).toBeNull();
  });

  it('只有单位没有数字（"bb" / "c"）→ null', () => {
    expect(parseChipInput('bb', 'chips', BB)).toBeNull();
    expect(parseChipInput('c', 'bb', BB)).toBeNull();
  });
});

describe('parseChipInput：纯数字按当前档位解释', () => {
  it('筹码档 "1200" → 1200 筹码', () => {
    expect(parseChipInput('1200', 'chips', BB)).toBe(1200);
  });

  it('BB 档 "1200" → 12000 筹码（1200 BB × 10）', () => {
    expect(parseChipInput('1200', 'bb', BB)).toBe(12000);
  });

  it('BB 档 "3.5" → 35 筹码', () => {
    expect(parseChipInput('3.5', 'bb', BB)).toBe(35);
  });

  it('筹码档 "3.5" → 4 筹码（四舍五入到整数）', () => {
    expect(parseChipInput('3.5', 'chips', BB)).toBe(4);
  });

  it('BB 档换算跟着 bigBlind 走：bb=20 时 "2.5" → 50', () => {
    expect(parseChipInput('2.5', 'bb', 20)).toBe(50);
  });

  it('"0" 是合法输入，返回 0 而不是 null', () => {
    expect(parseChipInput('0', 'chips', BB)).toBe(0);
    expect(parseChipInput('0', 'bb', BB)).toBe(0);
  });

  it('小于 0.5 的小数在筹码档被舍成 0', () => {
    expect(parseChipInput('0.4', 'chips', BB)).toBe(0);
  });
});

describe('parseChipInput：空白与千分位只为容错，不影响结果', () => {
  it('"1 200" 空格分隔 → 1200', () => {
    expect(parseChipInput('1 200', 'chips', BB)).toBe(1200);
  });

  it('"1,200" 逗号千分位 → 1200', () => {
    expect(parseChipInput('1,200', 'chips', BB)).toBe(1200);
  });

  it('"1_200" 下划线分隔 → 1200', () => {
    expect(parseChipInput('1_200', 'chips', BB)).toBe(1200);
  });

  it('首尾空白被忽略', () => {
    expect(parseChipInput('  1200  ', 'chips', BB)).toBe(1200);
  });
});

describe('parseChipInput：显式单位覆盖当前档位', () => {
  it('筹码档下 "3.5bb" 仍按 BB 换算 → 35', () => {
    expect(parseChipInput('3.5bb', 'chips', BB)).toBe(35);
  });

  it('大写 "100BB" 也认 → 1000', () => {
    expect(parseChipInput('100BB', 'chips', BB)).toBe(1000);
  });

  it('BB 档下 "500c" 按筹码处理 → 500（不再乘大盲）', () => {
    expect(parseChipInput('500c', 'bb', BB)).toBe(500);
  });

  it('BB 档下 "500chips" 按筹码处理 → 500', () => {
    expect(parseChipInput('500chips', 'bb', BB)).toBe(500);
  });

  it('中文单位 "筹码" → 500', () => {
    expect(parseChipInput('500筹码', 'bb', BB)).toBe(500);
  });

  it('中文单位 "盲注" 按 BB 换算："3.5盲注" → 35', () => {
    expect(parseChipInput('3.5盲注', 'chips', BB)).toBe(35);
  });

  it('带空格的 "1200 chips" 也能认出筹码单位', () => {
    expect(parseChipInput('1200 chips', 'bb', BB)).toBe(1200);
  });
});

describe('parseChipInput：bigBlind 非法时按 1 兜底', () => {
  it('bigBlind = 0 时 "100" 在 BB 档 → 100 筹码', () => {
    expect(parseChipInput('100', 'bb', 0)).toBe(100);
  });

  it('bigBlind 为负数同样按 1 兜底', () => {
    expect(parseChipInput('100', 'bb', -10)).toBe(100);
  });

  it('bigBlind 为 NaN 时按 1 兜底', () => {
    expect(parseChipInput('7', 'bb', Number.NaN)).toBe(7);
  });

  it('兜底成 1 之后仍对结果取整（"3.5" → 4）', () => {
    expect(parseChipInput('3.5', 'bb', 0)).toBe(4);
  });
});

describe('clampRaiseTo：把非法/越界值收进合法加注区间', () => {
  it('低于下限 → 取下限（否则 core 拒绝，表现为点了没反应）', () => {
    expect(clampRaiseTo(5, 10, 100)).toBe(10);
  });

  it('高于上限 → 取上限', () => {
    expect(clampRaiseTo(500, 10, 100)).toBe(100);
  });

  it('区间内原样返回', () => {
    expect(clampRaiseTo(50, 10, 100)).toBe(50);
  });

  it('恰好在边界上返回自身', () => {
    expect(clampRaiseTo(10, 10, 100)).toBe(10);
    expect(clampRaiseTo(100, 10, 100)).toBe(100);
  });

  it('小数四舍五入对齐到整数', () => {
    expect(clampRaiseTo(49.6, 10, 100)).toBe(50);
    expect(clampRaiseTo(10.4, 10, 100)).toBe(10);
  });

  it('先取整再夹取：9.6 舍成 10 后不再被下限顶回', () => {
    expect(clampRaiseTo(9.6, 10, 100)).toBe(10);
  });

  it('舍入后越过上限时要被上限截住（100.6 → 101 → 100）', () => {
    expect(clampRaiseTo(100.6, 10, 100)).toBe(100);
  });

  it('NaN / Infinity / -Infinity → 下限', () => {
    expect(clampRaiseTo(Number.NaN, 10, 100)).toBe(10);
    expect(clampRaiseTo(Number.POSITIVE_INFINITY, 10, 100)).toBe(10);
    expect(clampRaiseTo(Number.NEGATIVE_INFINITY, 10, 100)).toBe(10);
  });

  it('下限等于上限时无论输入什么都是那个值', () => {
    expect(clampRaiseTo(50, 100, 100)).toBe(100);
    expect(clampRaiseTo(500, 100, 100)).toBe(100);
  });

  it('负值被夹到非负下限', () => {
    expect(clampRaiseTo(-3, 0, 100)).toBe(0);
  });
});

describe('关键不变量：单位只影响展示，反解析必须回到原筹码整数', () => {
  // 整数筹码、bigBlind=10 且取 10 的倍数：BB 档恰好是一位小数，信息不丢。
  const SAMPLES = [0, 10, 30, 100, 350, 1000, 1230, 999990];

  it('BB 档：formatChips 后 parse 回来等于原筹码值', () => {
    for (const chips of SAMPLES) {
      const text = formatChips(chips, 'bb', BB);
      expect(parseChipInput(text, 'bb', BB)).toBe(chips);
    }
  });

  it('筹码档：formatChips 后 parse 回来等于原筹码值', () => {
    for (const chips of SAMPLES) {
      const text = formatChips(chips, 'chips', BB);
      expect(parseChipInput(text, 'chips', BB)).toBe(chips);
    }
  });

  it('两档显示的是同一个金额：换单位不改变数值', () => {
    for (const chips of SAMPLES) {
      const asChips = parseChipInput(formatChips(chips, 'chips', BB), 'chips', BB);
      const asBB = parseChipInput(formatChips(chips, 'bb', BB), 'bb', BB);
      expect(asChips).toBe(chips);
      expect(asBB).toBe(chips);
      expect(asBB).toBe(asChips);
    }
  });

  it('BB 档展示文本永远是可解析的（展示层不会产出解析器不认的文本）', () => {
    for (const chips of SAMPLES) {
      expect(parseChipInput(formatAmount(chips, 'bb', BB), 'bb', BB)).not.toBeNull();
    }
  });
});

/**
 * 下面几条**不是**需求，而是对当前实现的如实记录（写测试时实测到的边界）。
 * 它们钉住的是「现状」，不是「应该如此」；是否要改由源码负责人决定，
 * 这里只保证行为一旦变化，测试会立刻报警。
 */
describe('已实测的边界现状（如实钉住，非需求）', () => {
  it('负筹码能显示成 "-2.5 BB"，但解析器不认负号 → 显示文本无法反向解析', () => {
    // formatChips 对负值的舍入规则成立（见上方 BB 档用例），
    // 但 parseChipInput 的正则 ^\d*\.?\d*$ 不接受前导 "-"，因此：
    expect(formatAmount(-25, 'bb', BB)).toBe('-2.5 BB');
    expect(parseChipInput('-2.5', 'bb', BB)).toBeNull();
    expect(parseChipInput('-1200', 'chips', BB)).toBeNull();
  });

  it('bigBlind > 10 且筹码不是大盲整数倍时，1 位小数会丢信息（bb=25：2 筹码显示 0.1，解析回 3）', () => {
    // 这是「BB 档只保留 1 位小数」的必然结果，不是换算错误：
    expect(formatChips(2, 'bb', 25)).toBe('0.1');
    expect(parseChipInput('0.1', 'bb', 25)).toBe(3);
    // 大盲是 10 的整数倍（本项目的常规配置）时仍然无损：
    expect(parseChipInput(formatChips(2, 'bb', 10), 'bb', 10)).toBe(2);
  });

  it('formatChips 守护非有限 chips（已加固：渲染层绝不印出 NaN / Infinity）', () => {
    // 初版实现只守 `bigBlind`，于是上游漏过的 NaN 会被原样渲染成「底池 NaN」。
    // 渲染守卫已补上；这里钉住「任何非有限值都退化为 0」的契约。
    expect(formatChips(Number.NaN, 'chips', BB)).toBe('0');
    expect(formatChips(Number.POSITIVE_INFINITY, 'bb', BB)).toBe('0');
    expect(formatChips(Number.NEGATIVE_INFINITY, 'chips', BB)).toBe('0');
    expect(formatAmount(Number.NaN, 'bb', BB)).toBe('0 BB');
  });

  it('clampRaiseTo 守护非有限的下限/上限（已加固：不会把 NaN 传出去）', () => {
    // 初版只守 `value`，`clampRaiseTo(NaN, NaN, 100)` 会把 NaN 原样传出，
    // 最终要么渲染成 'NaN'、要么让 onAct 收到非法金额。现在三个入参都收敛。
    expect(clampRaiseTo(Number.NaN, Number.NaN, 100)).toBe(0);
    expect(clampRaiseTo(50, Number.NaN, 100)).toBe(50);
    expect(clampRaiseTo(50, 20, Number.NaN)).toBe(20);
    // 上下限同时非法时退化为「夹到 0」而不是抛错或返回 NaN
    expect(clampRaiseTo(50, Number.NaN, Number.NaN)).toBe(0);
  });

  it('区间反向（下限 > 上限）时先撞下限就返回，给的是下限', () => {
    // 源码顺序是 `v < lo` 先判、`v > hi` 后判；min=100/max=10 且 v=50 时命中第一条，返回下限。
    expect(clampRaiseTo(50, 100, 10)).toBe(100);
  });
});
