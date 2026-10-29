/**
 * 展示层的纯函数工具（不依赖 React、不依赖 core 的规则，可单测）。
 */

/**
 * 「当前资金」的盈亏配色类。
 *
 * 为什么必须传入起始筹码、不能硬编码 1000：
 * `1000` 只是 `defaultSettings()` 的起始筹码值。用户在设置里把起始筹码改成
 * 2000 后，资金 1500 实际上是**亏损**，但旧判据 `bankroll >= 1000` 仍判为盈利（绿）；
 * 改成 500 后，资金 600 实际盈利却会被判为亏损（红）。判据只能与用户当前配置的
 * `settings.startingStack` 比较。
 *
 * 相等时算「不亏」（返回 pos）：与旧实现 `>= 1000` 的边界语义一致——打平不标红，
 * 避免「刚重置资金就一片红」的误读。
 */
export function netClass(bankroll: number, startingStack: number): 'pos' | 'neg' {
  return bankroll >= startingStack ? 'pos' : 'neg';
}

/**
 * 建桌参数的输入下限与兜底值。
 *
 * 为什么要有这一层：起始筹码 / 小盲 / 大盲这三个数字框在**首屏与设置面板**
 * 两处出现（阶段 2-1 把建桌参数搬到了首屏）。若两处各写一份 `Math.max(...)`，
 * 迟早会漂移——一处允许 100、另一处允许 50，用户会看到「同一项在两个地方
 * 能填的范围不同」。因此收敛到这里，两处共用同一份规则。
 *
 * 兜底值的选取与旧实现逐字一致（起始 1000 / 小盲 5 / 大盲 10），
 * 保证「清空输入框」的行为不变：不是留空，而是回到默认值。
 *
 * 注意 `Number.isFinite` 检查不能省：`Math.max(100, NaN)` 的结果是 `NaN`，
 * 会把 `NaN` 写进设置并落库，之后 `validateSettings` 判存档损坏 → 归档重建。
 */
export const MIN_STARTING_STACK = 100;
export const MIN_SMALL_BLIND = 1;
export const MIN_BIG_BLIND = 2;

/** 规范化起始筹码：非有限值或 0 回落到默认 1000，再夹到下限 100。 */
export function clampStartingStack(raw: number): number {
  const v = Number.isFinite(raw) ? raw || 1000 : 1000;
  return Math.max(MIN_STARTING_STACK, v);
}

/** 规范化小盲：非有限值或 0 回落到默认 5，再夹到下限 1。 */
export function clampSmallBlind(raw: number): number {
  const v = Number.isFinite(raw) ? raw || 5 : 5;
  return Math.max(MIN_SMALL_BLIND, v);
}

/** 规范化大盲：非有限值或 0 回落到默认 10，再夹到下限 2。 */
export function clampBigBlind(raw: number): number {
  const v = Number.isFinite(raw) ? raw || 10 : 10;
  return Math.max(MIN_BIG_BLIND, v);
}
