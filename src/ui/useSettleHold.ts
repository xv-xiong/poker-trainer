/**
 * 结束停顿（表现层内部 hook，阶段四从 `useTableShowcase.ts` 拆出）。
 *
 * ── 它解决的问题 ──────────────────────────────────────────────
 * 本手结束后不能立刻弹结算面板：要先让赢家高亮、底池推筹码被看见。
 * 这段「停顿走完」的标记就是 `settleHold`，`view.settled = finished && settleHold`。
 *
 * ── 必须等公共牌全部揭示完，才开始停顿 ────────────────────────
 * 全下摊牌时引擎会在 `finish()` 之前用 `runOutBoard` 一次性把公共牌补满 5 张，
 * 因此「`st.finished` 变 true」的那一刻，演出层的可见张数可能还停在 0 / 3 / 4。
 * 若只按 `finished` 计时，结算面板会在公共牌一张没翻时就弹出，剩下的牌全在面板
 * **背后**翻完 —— 玩家看不到这手是怎么结束的（实测 `data-revealed=0` 就出了面板）。
 * 所以这里的 gate 是「可见张数追平真实张数」。
 *
 * 注意 `planShowcaseStep` 本身顺序是对的（先 `board` 步，再 `settle` 步），
 * 本 hook 是另一条独立路径，两条都会置 `settleHold`，因此 gate 必须一致。
 */

import { useEffect, useState } from 'react';

export interface SettleHoldInput {
  /** 本手是否已结束。 */
  finished: boolean;
  /** 是否摊牌结束（只有摊牌才会出现「牌还没翻完就结束」的窗口）。 */
  showdown: boolean;
  /** 演出层已揭示的张数。 */
  visibleBoardCount: number;
  /** 引擎里真实公共牌张数。 */
  boardLen: number;
  /** 结束停顿时长（reduced-motion 下为 0）。 */
  settleMs: number;
  /** 演出代数：新一手自增，用于强制重新走一次停顿。 */
  epoch: number;
  /** 视图重算键（`state` 原地修改，引用不变，靠它触发自检）。 */
  signature: string;
}

export interface SettleHold {
  /** 结束停顿是否已走完（`view.settled` 的一半）。 */
  settleHold: boolean;
  /** 供外层在「换手」时复位。 */
  setSettleHold: (next: boolean) => void;
}

export function useSettleHold(input: SettleHoldInput): SettleHold {
  const { finished, showdown, visibleBoardCount, boardLen, settleMs, epoch, signature } = input;
  const [settleHold, setSettleHold] = useState(false);

  // ── 计时 ──
  useEffect(() => {
    if (!finished) {
      setSettleHold(false);
      return;
    }
    if (settleHold) return;
    if (visibleBoardCount < boardLen) return; // 等揭示游标追平真实张数
    const t = setTimeout(() => setSettleHold(true), Math.max(0, settleMs));
    return () => clearTimeout(t);
  }, [finished, settleHold, settleMs, epoch, visibleBoardCount, boardLen]);

  // ── 非生产环境不变量自检：停顿已开始但牌没翻完 → 撤销停顿（自愈） ──
  // 只记录、不 throw：渲染期 / effect 里 throw 会卸载整棵树（白屏），
  // 而这里想要的只是让开发者在控制台看到。
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (showdown && visibleBoardCount !== boardLen && settleHold) {
      console.error('[showcase] 结算已开始但公共牌未全部亮相，已自动撤销结算停顿（dev 自检）');
      setSettleHold(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showdown, visibleBoardCount, boardLen, settleHold, signature]);

  return { settleHold, setSettleHold };
}
