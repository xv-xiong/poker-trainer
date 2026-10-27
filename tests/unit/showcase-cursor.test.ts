/**
 * 公共牌揭示游标的纯函数单测（task-3 / dev「下一手」白屏回归）。
 *
 * 背景：修复前，揭示游标是一个裸数字 state，换手时靠 effect 去 `setRevealedBoard(0)`。
 * 那次 setState 只是**排队**，同一个 commit 里的 dev 不变量自检读到的仍是旧值
 * （例如 5），而新牌局的 `board.length` 已经是 0 —— 于是 throw
 * 「[showcase] 揭示的张数 5 超过真实公共牌 0」，整棵 React 树卸载 → 白屏。
 *
 * 修复后游标变成 `{ handId, n }` 作用域化的**派生量**：换手同一帧派生值即为 0，
 * 不存在「重置还没生效」的中间态。本文件锁住的正是这三条不变量：
 *   1. 换手后游标归零，且**绝不**沿用上一手的进度；
 *   2. 同一手内推进单调不减、且永不越过真实牌数；
 *   3. board 变短（或跨手）时 clamp 到合法值。
 */
import { describe, expect, it } from 'vitest';
import {
  advanceBoardCursor,
  clampBoardCursor,
  visibleBoardCountOf,
  type BoardCursor,
} from '../../src/ui/useTableShowcase.js';

describe('visibleBoardCountOf：按 handId 作用域派生可见张数', () => {
  it('换手后立刻归零，且不沿用上一手的进度（白屏 bug 的核心回归）', () => {
    // 上一手打到河牌、游标停在 5；新一手刚开始、公共牌还是 0 张。
    const staleCursor: BoardCursor = { handId: 'hand-1', n: 5 };
    expect(visibleBoardCountOf(staleCursor, 'hand-2', 0)).toBe(0);
    // 即使新一手已经有公共牌，也不能把上一手的 5 带过来。
    expect(visibleBoardCountOf(staleCursor, 'hand-2', 3)).toBe(0);
    // 修复前的场景：旧游标 5 + 新牌局 board 0 —— 派生值是 0，不再越界。
    expect(visibleBoardCountOf(staleCursor, 'hand-2', 0)).toBeLessThanOrEqual(0);
  });

  it('还没有牌局（handId 为 null）时一律为 0', () => {
    expect(visibleBoardCountOf({ handId: 'hand-1', n: 5 }, null, 5)).toBe(0);
    expect(visibleBoardCountOf({ handId: null, n: 0 }, 'hand-1', 5)).toBe(0);
  });

  it('同一手内返回游标值，但被真实牌数 clamp', () => {
    expect(visibleBoardCountOf({ handId: 'h', n: 2 }, 'h', 5)).toBe(2);
    // board 变短（例如状态被外部重置 / 重新开局但 handId 未变）→ clamp
    expect(visibleBoardCountOf({ handId: 'h', n: 5 }, 'h', 0)).toBe(0);
    expect(visibleBoardCountOf({ handId: 'h', n: 5 }, 'h', 3)).toBe(3);
    expect(visibleBoardCountOf({ handId: 'h', n: 5 }, 'h', 5)).toBe(5);
  });

  it('游标为负数时归零（防御性，返回值必须永远合法）', () => {
    expect(visibleBoardCountOf({ handId: 'h', n: -3 }, 'h', 5)).toBe(0);
  });
});

describe('advanceBoardCursor：一步只推进一张', () => {
  it('同一手内单调推进 0→1→2→3→4→5，到顶后不再增长', () => {
    let cursor: BoardCursor = { handId: 'h', n: 0 };
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      cursor = advanceBoardCursor(cursor, 'h', 5);
      seen.push(visibleBoardCountOf(cursor, 'h', 5));
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);

    // 再推进也不越过真实张数
    for (let i = 0; i < 5; i++) cursor = advanceBoardCursor(cursor, 'h', 5);
    expect(visibleBoardCountOf(cursor, 'h', 5)).toBe(5);
  });

  it('推进过程单调不减（永不存在「游标回退」）', () => {
    let cursor: BoardCursor = { handId: 'h', n: 0 };
    let prev = 0;
    for (let i = 0; i < 20; i++) {
      cursor = advanceBoardCursor(cursor, 'h', 4);
      const now = visibleBoardCountOf(cursor, 'h', 4);
      expect(now).toBeGreaterThanOrEqual(prev);
      prev = now;
    }
    expect(prev).toBe(4);
  });

  it('换手后从 0 重新开始，不继承上一手进度', () => {
    expect(advanceBoardCursor({ handId: 'hand-1', n: 5 }, 'hand-2', 5)).toEqual({
      handId: 'hand-2',
      n: 1,
    });
    // 新一手还没发公共牌时推进，仍停在 0（不会越界）
    expect(advanceBoardCursor({ handId: 'hand-1', n: 5 }, 'hand-2', 0)).toEqual({
      handId: 'hand-2',
      n: 0,
    });
  });
});

describe('clampBoardCursor：自愈时把游标收敛回合法值', () => {
  it('越界时收敛到真实牌数', () => {
    expect(clampBoardCursor({ handId: 'h', n: 5 }, 'h', 0)).toEqual({ handId: 'h', n: 0 });
    expect(clampBoardCursor({ handId: 'h', n: 5 }, 'h', 3)).toEqual({ handId: 'h', n: 3 });
  });

  it('跨手时把作用域一并切到当前手并归零', () => {
    expect(clampBoardCursor({ handId: 'hand-1', n: 5 }, 'hand-2', 4)).toEqual({
      handId: 'hand-2',
      n: 0,
    });
  });

  it('已经合法时原样返回（引用不变，避免多余重渲染）', () => {
    const legal: BoardCursor = { handId: 'h', n: 2 };
    expect(clampBoardCursor(legal, 'h', 5)).toBe(legal);
  });
});
