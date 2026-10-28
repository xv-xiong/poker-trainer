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
