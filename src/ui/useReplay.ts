/**
 * 回放态机：帧游标 + 上一步 / 下一步 / 自动播放 / 退出。
 *
 * 为什么单独成 hook 而不是塞进 `useTableShowcase`：演出层（showcase）负责的是
 * 「真实对局正在发生」时的节奏调度 —— 它有定时器、RNG 守卫、揭示游标、结算
 * 停顿，全部与**活牌局**耦合。回放只是把一串已经录好的快照翻页，没有任何
 * 异步推进需求。两者混在一起，任何一次演出层的改动都可能悄悄改变回放行为，
 * 反之亦然。因此这里只维护「第几帧」，不 import 任何演出层逻辑。
 *
 * 回放**绝不写库**：本 hook 不接触 controller、store 或 localStorage，
 * 只持有内存中的帧数组。
 */

import { useCallback, useEffect, useState } from 'react';
import { buildReplayFrames, type ReplayFrame } from './replay.js';
import type { HandRecord } from '../core/types.js';

/** 自动播放时每帧停留时长（毫秒）。比拟真节奏快，但足够看清每一步。 */
export const REPLAY_STEP_MS = 900;

export interface ReplaySession {
  readonly record: HandRecord;
  readonly frames: readonly ReplayFrame[];
}

export interface ReplayController {
  /** 当前回放的一手；null 表示未在回放。 */
  readonly session: ReplaySession | null;
  /** 当前帧；未在回放时为 null。 */
  readonly frame: ReplayFrame | null;
  /** 当前帧下标（0 = 开局）。 */
  readonly index: number;
  /** 帧总数（含开局帧）。 */
  readonly total: number;
  readonly playing: boolean;
  /** 打开失败的原因；null 表示没有错误。 */
  readonly error: string | null;
  open(record: HandRecord): void;
  close(): void;
  goTo(index: number): void;
  next(): void;
  prev(): void;
  togglePlay(): void;
  dismissError(): void;
}

export function useReplay(): ReplayController {
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = session ? session.frames.length : 0;
  const lastIndex = Math.max(0, total - 1);

  const close = useCallback(() => {
    setSession(null);
    setIndex(0);
    setPlaying(false);
  }, []);

  /**
   * 打开一手回放。
   *
   * 重建失败时不进入回放态，只把原因挂到 `error` 上让界面提示 —— 这正是
   * 路线图要求的降级路径：宁可说「这一手不可回放」，也不能抛错白屏。
   */
  const open = useCallback((record: HandRecord) => {
    const built = buildReplayFrames(record);
    if (!built.ok) {
      setError(built.reason);
      return;
    }
    setError(null);
    setSession({ record, frames: built.frames });
    setIndex(0);
    setPlaying(false);
  }, []);

  const goTo = useCallback(
    (target: number) => {
      setIndex(Math.min(Math.max(0, target), lastIndex));
    },
    [lastIndex],
  );

  const next = useCallback(() => {
    setIndex((i) => Math.min(i + 1, lastIndex));
  }, [lastIndex]);

  const prev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // 已在最后一帧时再点「自动播放」从开局重放，否则用户会以为按钮坏了
    if (index >= lastIndex) setIndex(0);
    setPlaying(true);
  }, [playing, index, lastIndex]);

  const dismissError = useCallback(() => setError(null), []);

  // 自动播放：每帧排一个定时器，到末尾自动停下（不循环，避免用户跟不上）
  useEffect(() => {
    if (!playing || !session) return;
    if (index >= lastIndex) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setIndex((i) => Math.min(i + 1, lastIndex));
    }, REPLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, session, index, lastIndex]);

  const frame = session ? (session.frames[index] ?? null) : null;

  return {
    session,
    frame,
    index,
    total,
    playing,
    error,
    open,
    close,
    goTo,
    next,
    prev,
    togglePlay,
    dismissError,
  };
}
