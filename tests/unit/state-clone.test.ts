/**
 * 阶段四 4.5：`HandState` 深拷贝与「不可变快照」契约。
 *
 * 这两条是同一个设计的两面：
 *   1. `cloneHandState` 必须**真的**深拷贝——漏掉任何一个容器，
 *      下游就会拿到与引擎共享的引用，之后被引擎原地改写（表现是「历史帧自己变了」）；
 *   2. `controller.snapshot().state` 必须是每次 emit 的新对象，
 *      这样 `useMemo`/`useEffect` 才能直接以它做依赖（旧实现靠 `viewKey` 七段字符串模拟）。
 *
 * 为什么值得单独测：这两个不变量一旦破了，症状是「画面停在某一帧」或
 * 「复盘里早期决策被后来的状态污染」，两者都极难从现象反推到拷贝漏字段。
 */

import { describe, it, expect } from 'vitest';
import { createHand, applyAction } from '../../src/core/hand.js';
import { defaultSettings } from '../../src/core/types.js';
import type { HandState } from '../../src/core/types.js';
import { cloneHandState } from '../../src/ui/stateClone.js';
import { GameController } from '../../src/ui/controller.js';
import { createMemoryStorage } from '../../src/store/persistence.js';

/** 造一手已经打了几步、底池非空的牌（这样各个容器字段都有内容）。 */
function sampleHand(): HandState {
  const settings = { ...defaultSettings(), seatCount: 6, startingStack: 1000 };
  const st = createHand({
    handId: 'hand-clone',
    seed: 20260101,
    settings,
    heroSeat: 0,
    dealerSeat: 0,
  });
  // 推进几步，让 actions / committed / pots 都有实际内容
  let guard = 0;
  while (!st.finished && st.actions.length < 6 && guard++ < 50) {
    const seat = st.actingSeat;
    if (seat < 0) break;
    // 统一用 check/call 推进，避免依赖具体合法动作集
    const acted = applyAction(st, st.currentBet > st.seats[seat].committedThisStreet ? 'call' : 'check', 0, 0);
    if (!acted.ok) break;
  }
  return st;
}

describe('cloneHandState：真的深拷贝', () => {
  it('内容相等但所有容器都是新对象', () => {
    const st = sampleHand();
    const copy = cloneHandState(st);

    // 值相等（含嵌套）
    expect(copy).toEqual(st);
    // 顶层对象不同
    expect(copy).not.toBe(st);
    // 每个容器字段都不共享引用
    expect(copy.seats).not.toBe(st.seats);
    expect(copy.board).not.toBe(st.board);
    expect(copy.deck).not.toBe(st.deck);
    expect(copy.actions).not.toBe(st.actions);
    expect(copy.initialStacks).not.toBe(st.initialStacks);
    expect(copy.results).not.toBe(st.results);
    expect(copy.showdownValues).not.toBe(st.showdownValues);
    expect(copy.pots).not.toBe(st.pots);
    // 数组元素也不共享
    for (let i = 0; i < st.seats.length; i++) {
      expect(copy.seats[i]).not.toBe(st.seats[i]);
      expect(copy.seats[i].holeCards).not.toBe(st.seats[i].holeCards);
    }
    for (let i = 0; i < st.actions.length; i++) expect(copy.actions[i]).not.toBe(st.actions[i]);
    for (let i = 0; i < st.pots.length; i++) {
      expect(copy.pots[i]).not.toBe(st.pots[i]);
      expect(copy.pots[i].eligible).not.toBe(st.pots[i].eligible);
    }
  });

  it('改副本不影响原状态（逐层验证）', () => {
    const st = sampleHand();
    const copy = cloneHandState(st);
    const before = JSON.stringify(st);

    copy.seats[0].stack += 999;
    copy.seats[0].holeCards.push(51);
    copy.board.push(7);
    copy.deck.push(8);
    if (copy.actions.length > 0) {
      // ActionRecord 的字段是 readonly（引擎不允许外部改写动作记录），
      // 这里为了验证「拷贝与原状态不共享」必须绕过类型系统改一次。
      const mutableActions = copy.actions as unknown as { thinkMs: number }[];
      mutableActions[0].thinkMs += 123;
    }
    copy.initialStacks[0] += 1;
    copy.results[0] += 1;
    copy.showdownValues[0] = 424242;
    if (copy.pots.length > 0) {
      copy.pots[0].eligible.push(5);
      if (copy.pots[0].contributors) copy.pots[0].contributors.push(5);
    }

    // 原状态一个字节都不该变
    expect(JSON.stringify(st)).toBe(before);
  });

  it('改原状态不影响副本', () => {
    const st = sampleHand();
    const copy = cloneHandState(st);
    const before = JSON.stringify(copy);

    st.seats[0].stack += 777;
    st.board.push(9);

    expect(JSON.stringify(copy)).toBe(before);
  });

  it('空的 / 边角状态也能安全拷贝（未结束、无底池、无动作）', () => {
    const settings = { ...defaultSettings(), seatCount: 2 };
    const st = createHand({ handId: 'hand-empty', seed: 7, settings, heroSeat: 0, dealerSeat: 0 });
    const copy = cloneHandState(st);
    expect(copy).toEqual(st);
    expect(copy.actions).not.toBe(st.actions);
    expect(copy.pots).not.toBe(st.pots);
  });
});

describe('controller.snapshot：每次 emit 产出新的 state 对象', () => {
  it('快照与内部状态值相等，但不是同一个对象', () => {
    const c = new GameController({ storage: createMemoryStorage(), heroSeat: 0 });
    c.startHand();
    const snap = c.snapshot();
    expect(snap.state).not.toBeNull();
    expect(snap.state).toEqual(c.currentState());
    expect(snap.state).not.toBe(c.currentState());
  });

  it('动作之后快照身份变化（这就是下游的「状态变了」信号）', () => {
    const c = new GameController({ storage: createMemoryStorage(), heroSeat: 0 });
    c.startHand();
    c.runAI();
    const before = c.snapshot();
    const beforeState = before.state;

    const legal = before.legal!;
    if (legal.canCheck) c.act('check', 0, 10);
    else if (legal.canCall) c.act('call', 0, 10);
    else c.act('fold', 0, 10);

    const after = c.snapshot();
    expect(after.state).not.toBe(beforeState);
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('旧快照不会被后续动作污染（不可变快照的核心保证）', () => {
    const c = new GameController({ storage: createMemoryStorage(), heroSeat: 0 });
    c.startHand();
    c.runAI();
    const frozen = c.snapshot();
    const snapshotJson = JSON.stringify(frozen.state);

    // 再推进几步（引擎会原地改写内部 state）
    let guard = 0;
    while (!c.currentState()!.finished && guard++ < 40) {
      const s = c.snapshot();
      if (s.heroTurn) {
        if (s.legal!.canCheck) c.act('check', 0, 10);
        else if (s.legal!.canCall) c.act('call', 0, 10);
        else c.act('fold', 0, 10);
      } else {
        c.runAI();
      }
    }

    // 之前拿到的快照必须原封不动
    expect(JSON.stringify(frozen.state)).toBe(snapshotJson);
  });
});
