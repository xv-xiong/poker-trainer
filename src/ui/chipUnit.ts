/**
 * 筹码显示单位（阶段六）。
 *
 * 为什么需要一个独立单位而不是「到处乘除大盲」：
 * 同一个数字在三处的含义不同——牌桌座位上的数字是「筹码」，
 * 底池是「筹码」，而玩家的心智模型通常是「BB（大盲）」，例如
 * 「我有 100 个 BB」「这手要跟 2.5 BB」。把换算收敛成纯函数，
 * 才能保证牌桌、操作区、顶栏三处**同一时刻用同一个口径**，
 * 而不是各自 `(x / bigBlind).toFixed(1)` 漂移出不同位数。
 *
 * 真实筹码是权威值（core 的规则、结算、持久化全部用筹码整数），
 * 单位只影响**展示**。切换单位绝不改变任何金额、结算或落库数值——
 * 这条约束由 `tests/unit/chip-unit.test.ts` 守着。
 */
export type ChipUnit = 'chips' | 'bb';

export const DEFAULT_CHIP_UNIT: ChipUnit = 'chips';

/**
 * 规整任意输入为合法单位；非法值静默回退默认。
 *
 * 为什么**不**判成「存档损坏」：单位是纯展示字段，判损坏会走
 * 「归档 + 重建」，白白丢掉资金与历史统计。读取时回退即可。
 */
export function normalizeChipUnit(raw: unknown): ChipUnit {
  return raw === 'bb' ? 'bb' : DEFAULT_CHIP_UNIT;
}

/**
 * 筹码 → 显示文本。
 *
 * 筹码档返回**原样整数**（不加千分位）：这是改动前的既有行为，
 * 加分隔符会让「底池 1,234」与既有 E2E 里对数字文本的比对、以及
 * 用户习惯的读法都发生变化，属于本功能不需要的副作用。
 *
 * BB 档保留 1 位小数并去掉尾随 `.0`：`100` / `3.5`，而不是
 * `100.0` / `3.50`——牌桌上的数字是给人扫读的，位数越少越好。
 */
export function formatChips(chips: number, unit: ChipUnit, bigBlind: number): string {
  // 非有限值兜底。渲染层绝不能把 `NaN` / `Infinity` 直接印到牌桌上：
  // 一旦上游算出非有限值（例如夹取链路上某个 NaN 漏过来），
  // 「底池 NaN」比「底池 0」更难排查，也会让读屏播报变成噪音。
  // 这是**渲染守卫**，不是对账：真正的金额错误仍应由规则层与账本恒等式发现。
  if (!Number.isFinite(chips)) return '0';
  if (unit === 'chips') return String(Math.round(chips));
  const bb = bigBlind > 0 ? bigBlind : 1;
  const value = chips / bb;
  // 先按 1 位小数舍入，再判断是否整数：避免 0.1+0.2 之类的浮点噪声
  // 让 100 变成 "100.0"。
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 给金额补上单位后缀（筹码档不加后缀，保持改动前的观感）。 */
export function formatAmount(chips: number, unit: ChipUnit, bigBlind: number): string {
  const text = formatChips(chips, unit, bigBlind);
  return unit === 'bb' ? `${text} BB` : text;
}

/**
 * 用户在下注输入框里敲的文本 → 筹码整数。
 *
 * 返回 `null` 表示「无法解析」，调用方应保持原值不动（而不是写 0 或 NaN）：
 * 输入框在编辑过程中必然出现空串与半截数字（例如刚删光准备重打），
 * 此时把 NaN 写进 `raiseTo` 会让滑杆与按钮一起失效。
 *
 * 允许的写法：
 *   - `1200` / `1 200` / `1,200`（分隔符只为容错，不影响结果）
 *   - `3.5`（BB 档 → 35 筹码；筹码档 → 4，四舍五入到整数）
 *   - `3.5bb` / `100bb`（显式带单位时**忽略当前档位**，按 BB 换算）
 *   - `1200c` / `1200chips`（显式带筹码单位）
 */
export function parseChipInput(
  raw: string,
  unit: ChipUnit,
  bigBlind: number,
): number | null {
  const bb = bigBlind > 0 ? bigBlind : 1;
  // 去掉所有空白与千分位逗号，统一小写
  const cleaned = raw.replace(/[\s,_]/g, '').toLowerCase();
  if (cleaned === '') return null;

  const explicitBB = /(bb|盲注)$/.test(cleaned);
  const explicitChips = /(c|chips|chip|筹码)$/.test(cleaned);
  const numeric = cleaned.replace(/(bb|盲注|c|chips|chip|筹码)$/, '');
  if (numeric === '' || !/^\d*\.?\d*$/.test(numeric)) return null;

  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;

  const asBB = explicitBB || (!explicitChips && unit === 'bb');
  const chips = asBB ? value * bb : value;
  return Math.round(chips);
}

/**
 * 把筹码值夹进合法的加注区间，并对齐到整数。
 *
 * 与 core 的 `legalActions` 保持同一区间，但**不做规则判断**——
 * 是否真的能加注由 `legal.canRaise` 决定，这里只保证送进 `onAct`
 * 的数字不会越界（越界会被 core 拒绝，表现为「点了没反应」）。
 */
export function clampRaiseTo(value: number, minRaiseTo: number, maxRaiseTo: number): number {
  // 三个入参都要守：区间来自 `legalActions`，正常是有限整数，但调用方
  // （输入框、快捷尺度）可能算出 NaN（例如底池为 0 时做除法）。
  // 早先只守 `value`，于是 `clampRaiseTo(NaN, NaN, 100)` 会把 NaN 原样传出，
  // 最终经 `formatChips` 渲成 "NaN" 或让 `onAct` 收到非法金额。
  const lo = Number.isFinite(minRaiseTo) ? Math.round(minRaiseTo) : 0;
  const hi = Number.isFinite(maxRaiseTo) ? Math.round(maxRaiseTo) : lo;
  if (!Number.isFinite(value)) return lo;
  const v = Math.round(value);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
