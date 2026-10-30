/**
 * `HandState` 的深拷贝（阶段四 4.5：把「原地修改」关进 controller 内部）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * `applyAction` 为了性能**原地修改** `HandState`：座位、动作数组、底池都是同一个
 * 对象被逐字段改写。这对引擎是对的（一手牌几十次动作，不必每次深拷贝整棵树），
 * 但对 UI 有害：
 *
 *   - `snap.state` 的引用永远不变，`useMemo` / `useEffect` 以它为依赖时**永远不触发**；
 *   - 于是所有下游被迫改用「primitive 组合键」来模拟变化信号
 *     （旧实现的 `viewKey` 七段字符串、`App.tsx` 里 `[snap.revision, snap.state]`
 *     这种「双依赖」写法都是这个副作用的产物）。
 *   这类依赖写漏一个字段就表现为「画面停在某一帧」，是演出层历史上最难查的一类 bug。
 *
 * 现在改为：**controller 的 `snapshot()` 返回一份拷贝**，订阅者拿到的是不可变快照，
 * 身份本身就是变化信号。引擎侧仍然是原地修改（`currentState()` 依旧返回内部对象，
 * 供 `stepAiAction` 推进），所以规则与性能都不受影响。
 *
 * ── 为什么手写而不是 `structuredClone` ────────────────────────
 *   1. 手写能明确「哪些字段是可变容器」，加字段时 TS 会在这里报错提醒同步，
 *      `structuredClone` 则会静默放过（漏拷贝一个容器就变成共享引用）。
 *   2. 不依赖运行时全局（jsdom / 老浏览器里 `structuredClone` 不一定存在）。
 *   3. 手写比 `structuredClone` 快，而本函数每次 `emit()` 都会跑一次。
 */

import type { HandState } from '../core/types.js';

/**
 * 深拷贝一手牌的状态。
 *
 * 约定：**所有数组 / 对象容器都要新建**，标量直接复制。
 * 新增 `HandState` 字段时，若它是容器（数组 / 对象 / `Record`），必须在这里补一行；
 * `tests/unit/state-clone.test.ts` 会逐字段验证「不共享引用」。
 */
export function cloneHandState(state: HandState): HandState {
  return {
    // 标量字段：直接浅拷贝即可
    ...state,
    // ── 容器字段：逐个新建 ──
    initialStacks: [...state.initialStacks],
    seats: state.seats.map((seat) => ({
      ...seat,
      // 底牌是本手内唯一会被「发牌」改写的数组（摊牌时也只是读）
      holeCards: [...seat.holeCards],
    })),
    board: [...state.board],
    deck: [...state.deck],
    actions: state.actions.map((action) => ({ ...action })),
    results: [...state.results],
    showdownValues: { ...state.showdownValues },
    pots: state.pots.map((pot) => ({
      ...pot,
      eligible: [...pot.eligible],
      // contributors 是可选的（v1 旧记录没有），未定义时保持未定义
      ...(pot.contributors ? { contributors: [...pot.contributors] } : {}),
    })),
  };
}
