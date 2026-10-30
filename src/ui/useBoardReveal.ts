/**
 * 公共牌揭示游标（表现层内部 hook，阶段四从 `useTableShowcase.ts` 拆出）。
 *
 * ── 它解决的问题 ──────────────────────────────────────────────
 * 公共牌必须**逐张**亮相（flop 三张分三次），所以演出层需要一个「已揭示张数」
 * 的游标，与引擎里 `state.board.length` 分开维护。
 *
 * ── 为什么游标是「派生量 + 作用域」而不是「state + 重置 effect」 ──
 * 游标是 `{ handId, n }`：`n` 只是**本手内**的进度，跨手天然失效。
 * 于是「换手」不需要任何 effect 去 `setRevealedBoard(0)` —— 那只是一次排队更新，
 * 同一个 commit 里其他 effect 仍会读到旧值（5），而新牌局的 `board.length` 已是 0，
 * 于是误判「揭示张数超过真实公共牌」。这正是 dev 模式点「下一手」整页白屏的根因
 * （旧实现直接 throw，而 dev 下没有 ErrorBoundary，整棵树被卸载）。
 * 现在 `visibleBoardCountOf` 在**渲染期**就返回 0，不存在新旧值混用的窗口。
 *
 * ── 推进与自愈 ────────────────────────────────────────────────
 * 推进只由 `run('board')` 调用 `advance()` 触发（一次一张，恒单调不减）。
 * dev 环境另有一条自检：发现原始 `n` 越界时 `console.error` 并 clamp 回合法值，
 * **不 throw** —— 断言的价值是让问题可见，不是把一个小状态问题放大成白屏。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  advanceBoardCursor,
  clampBoardCursor,
  visibleBoardCountOf,
  type BoardCursor,
} from './showcasePlan.js';

export interface BoardReveal {
  /** 当前这一手可见的公共牌张数（已按 handId 作用域化 + clamp）。 */
  visibleBoardCount: number;
  /** 揭示下一张（不越过真实张数）。身份稳定，可直接被 `run` 依赖。 */
  advance: () => void;
  /** 原始游标，仅调试 / 自检用。 */
  cursor: BoardCursor;
}

/**
 * @param handId   当前手牌 id（`null` = 还没有牌局）
 * @param boardLen 引擎里真实公共牌张数
 * @param signature 视图重算信号：4.5 之后 `snap.state` 是每次 emit 的深拷贝，
 *                  直接把对象传进来即可（自检 effect 靠它的身份变化重新执行）
 */
export function useBoardReveal(
  handId: string | null,
  boardLen: number,
  signature: unknown,
): BoardReveal {
  const [cursor, setCursor] = useState<BoardCursor>({ handId: null, n: 0 });

  const visibleBoardCount = visibleBoardCountOf(cursor, handId, boardLen);

  // `advance` 的身份必须稳定（它被 `run` 依赖，而 `run` 又被上层定时器依赖）。
  // 因此这里用 ref 读最新值，而不是把 handId / boardLen 放进依赖数组。
  const handIdRef = useRef<string | null>(handId);
  handIdRef.current = handId;
  const boardLenRef = useRef(boardLen);
  boardLenRef.current = boardLen;

  const advance = useCallback(() => {
    // 恒为 min(当前可见 + 1, 真实张数)，天然单调不减，不会出现「游标回退」。
    setCursor((prev) => advanceBoardCursor(prev, handIdRef.current, boardLenRef.current));
  }, []);

  // ── 非生产环境不变量自检：原始游标不得越界 ──
  // 生产构建中 `process.env.NODE_ENV` 被 Vite 静态替换，整块会被摇掉。
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (cursor.handId === handId && cursor.n > boardLen) {
      console.error(
        `[showcase] 揭示的张数 ${cursor.n} 超过真实公共牌 ${boardLen}，已自动收敛（dev 自检）`,
      );
      setCursor((cur) => clampBoardCursor(cur, handId, boardLen));
    }
    // signature 用来在「原地修改的 state」变化时重新自检。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, handId, boardLen, signature]);

  return { visibleBoardCount, advance, cursor };
}
