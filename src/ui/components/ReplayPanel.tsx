/**
 * 回放视图：复用牌桌渲染，逐帧展示一手历史牌局。
 *
 * 关键点：这里**只渲染快照**，不推进任何状态机。牌桌上的每个像素差异都来自
 * `frame.state` 与据此构造的 `ShowcaseView`（与活牌局共用同一个 TableView，
 * 所以座位布局、公共牌、底池、动作气泡全部一致）。
 */

import { useMemo } from 'react';
import { TableView } from './TableView.js';
import { SHOWCASE_TIMING, type ShowcaseView } from '../useTableShowcase.js';
import { replayStepLabel, type ReplayFrame } from '../replay.js';
import type { ReplayController } from '../useReplay.js';
import '../styles/replay.css';

/** 把一帧快照包装成 TableView 需要的演出视图。 */
function viewOf(frame: ReplayFrame): ShowcaseView {
  const state = frame.state;
  return {
    // 回放是「看录像」：没有思考态、玩家也不能行动
    thinking: false,
    thinkingSeat: -1,
    canHeroAct: false,
    lastAction: frame.action,
    // 公共牌按帧里已有的张数整体呈现：翻牌三张同帧出现，转牌/河牌各一帧
    visibleBoardCount: state.board.length,
    shownBoard: state.board,
    settled: state.finished,
    handOver: state.finished,
    winnerSeat: state.finished ? state.results.findIndex((v) => v > 0) : -1,
    dealt: frame.index === 0,
    timing: SHOWCASE_TIMING,
  };
}

export function ReplayPanel({ replay }: { replay: ReplayController }) {
  const { session, frame } = replay;
  const view = useMemo(() => (frame ? viewOf(frame) : undefined), [frame]);

  if (!session || !frame) return null;

  const record = session.record;
  const steps = session.frames.length - 1;
  const atEnd = replay.index >= steps;

  return (
    <div className="panel replay-panel" data-testid="replay-panel">
      <div className="replay-bar">
        <div className="replay-heading">
          <h2>第 {record.handId} 手回放</h2>
          <span className="muted small" data-testid="replay-progress">
            第 {replay.index} / {steps} 步 · {replayStepLabel(record, frame)}
          </span>
        </div>
        <div className="replay-controls">
          <button
            className="ghost"
            onClick={replay.prev}
            disabled={replay.index === 0}
            data-testid="replay-prev"
          >
            上一步
          </button>
          <button onClick={replay.togglePlay} data-testid="replay-play">
            {replay.playing ? '暂停' : '自动播放'}
          </button>
          <button
            className="ghost"
            onClick={replay.next}
            disabled={atEnd}
            data-testid="replay-next"
          >
            下一步
          </button>
          <button className="ghost" onClick={replay.close} data-testid="replay-exit">
            退出回放
          </button>
        </div>
      </div>

      <div className="replay-stage">
        <TableView
          state={frame.state}
          heroSeat={record.heroSeat}
          revealAll={false}
          view={view}
        />
      </div>

      <ol className="replay-log" data-testid="replay-log" aria-label="动作流水">
        {session.frames.map((f) => (
          <li key={f.index} className={f.index === replay.index ? 'cur' : ''}>
            <button
              className="ghost"
              onClick={() => replay.goTo(f.index)}
              aria-current={f.index === replay.index ? 'step' : undefined}
            >
              <span className="num replay-log-index">{f.index}</span>
              <span>{replayStepLabel(record, f)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
