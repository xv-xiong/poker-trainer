/**
 * 手牌回放：把一条 `HandRecord` 重建成「逐动作」的快照序列。
 *
 * 为什么用重放而不是存录像：`HandRecord` 已经记录了 `seed`、完整的 `actions`
 * （含每步的 `toAmount`）与 `results`，而 `createHand(seed)` 的洗牌是确定性的
 * —— 只要按顺序把动作重新喂给 `applyAction`，就能逐帧复原整手牌。因此回放是
 * **纯前端零新增数据**的能力：不需要新的存储字段，也不给存档增加任何字节。
 *
 * 三个必须守住的约束：
 *   1. **只读**：绝不修改传入的 `record`，也绝不写库（回放不产生历史与统计）。
 *   2. **不抛错**：任何记录残缺、或与引擎重放结果不一致，都返回
 *      `{ ok: false, reason }`，由界面降级为「这一手不可回放」，而不是白屏。
 *   3. **逐帧独立**：`applyAction` 是原地修改状态机的，所以每帧必须存深拷贝；
 *      否则所有帧会指向同一个被后续动作继续改写的对象，回放时每一帧看起来
 *      都像最后一帧。
 */

import { applyAction, createHand } from '../core/hand.js';
import {
  ACTION_LABELS,
  STREET_LABELS,
  defaultSettings,
  type ActionRecord,
  type HandRecord,
  type HandState,
  type Settings,
} from '../core/types.js';

/** 一帧：某个动作执行完之后的完整牌局快照。 */
export interface ReplayFrame {
  /** 0 = 开局（盲注已下、尚无动作）；i = 第 i 个动作执行完之后。 */
  readonly index: number;
  readonly state: HandState;
  /** 本帧刚执行完的动作；帧 0 为 null。 */
  readonly action: ActionRecord | null;
}

export type ReplayBuild =
  | { readonly ok: true; readonly frames: readonly ReplayFrame[] }
  | { readonly ok: false; readonly reason: string };

const MIN_SEATS = 2;
const MAX_SEATS = 9;

function isSeat(value: number, seatCount: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < seatCount;
}

/**
 * 结构预检（不重放，O(动作数)）。
 *
 * 为什么要有它：历史列表要决定「回放」按钮是否可点。若为每一行都跑一次完整
 * 重放，500 手历史 × 数十个动作会在打开历史页时白烧几百毫秒。这里只检查重放
 * 所必需字段的存在性与形状，把「明显残缺」的记录先挡掉；真正的重放一致性
 * 校验仍在 `buildReplayFrames` 里做。
 *
 * @returns null 表示结构上可回放；否则返回不可回放的原因（可直接展示给用户）。
 */
export function replayabilityOf(record: HandRecord): string | null {
  if (!Number.isFinite(record.seed)) return '缺少可复现的随机种子';
  const n = record.seatCount;
  if (!Number.isInteger(n) || n < MIN_SEATS || n > MAX_SEATS) {
    return `桌人数 ${String(record.seatCount)} 不在可回放范围内`;
  }
  if (!Array.isArray(record.initialStacks) || record.initialStacks.length !== n) {
    return '起始筹码记录不完整';
  }
  if (!Array.isArray(record.holeCards) || record.holeCards.length !== n) {
    return '底牌记录不完整';
  }
  if (!isSeat(record.heroSeat, n) || !isSeat(record.dealerSeat, n)) {
    return '座位索引超出范围';
  }
  if (!Array.isArray(record.actions)) return '动作记录缺失';
  return null;
}

/**
 * 深拷贝牌局状态。
 *
 * `applyAction` 原地修改 seats / board / actions / pots 等，因此每帧都要一份
 * 独立副本。字段全是可枚举的普通值，逐层复制即可，不必上结构化克隆
 * （后者在浏览器里要额外判断，且对本结构没有额外收益）。
 */
function cloneState(state: HandState): HandState {
  return {
    handId: state.handId,
    seed: state.seed,
    seatCount: state.seatCount,
    dealerSeat: state.dealerSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    initialStacks: [...state.initialStacks],
    seats: state.seats.map((seat) => ({
      ...seat,
      holeCards: [...seat.holeCards],
    })),
    board: [...state.board],
    deck: [...state.deck],
    deckIndex: state.deckIndex,
    street: state.street,
    actingSeat: state.actingSeat,
    currentBet: state.currentBet,
    lastRaiseSize: state.lastRaiseSize,
    actions: state.actions.map((action) => ({ ...action })),
    finished: state.finished,
    finishReason: state.finishReason,
    results: [...state.results],
    showdownValues: { ...state.showdownValues },
    pots: state.pots.map((pot) => ({
      ...pot,
      eligible: [...pot.eligible],
      ...(pot.contributors ? { contributors: [...pot.contributors] } : {}),
    })),
    hintsUsed: state.hintsUsed,
  };
}

/** 由一条历史记录反推 `createHand` 需要的设置（只用于重放，不参与任何计算）。 */
function settingsOf(record: HandRecord): Settings {
  return {
    ...defaultSettings(),
    seatCount: record.seatCount,
    // 重放时起始筹码由 `stacks` 逐座位指定，这里的值只是兜底，不影响结果。
    startingStack: record.initialStacks[0] ?? defaultSettings().startingStack,
    smallBlind: record.smallBlind,
    bigBlind: record.bigBlind,
  };
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * 重建回放帧。
 *
 * 帧数恒为 `record.actions.length + 1`（帧 0 是开局）。重放结束后还会校验
 * 公共牌、各座位底牌与结算结果是否与记录一致 —— 不一致说明记录与引擎的
 * 版本已经对不上（或记录被外部改坏），此时宁可报告「不可回放」，也不要
 * 让用户看到一手与历史不符的假牌局。
 */
export function buildReplayFrames(record: HandRecord): ReplayBuild {
  const blocked = replayabilityOf(record);
  if (blocked) return { ok: false, reason: blocked };

  let state: HandState;
  try {
    state = createHand({
      handId: record.handId,
      seed: record.seed,
      settings: settingsOf(record),
      heroSeat: record.heroSeat,
      dealerSeat: record.dealerSeat,
      stacks: [...record.initialStacks],
    });
  } catch (err) {
    return { ok: false, reason: `重建牌局失败：${err instanceof Error ? err.message : String(err)}` };
  }

  // 洗牌确定性校验：同 seed 必然发出同样的底牌。对不上就说明记录本身有问题，
  // 继续回放会显示一手「不是当时那手」的牌。
  for (let i = 0; i < record.seatCount; i++) {
    const expected = record.holeCards[i] ?? [];
    const actual = state.seats[i].holeCards;
    if (!sameNumbers(actual, expected)) {
      return { ok: false, reason: `座位 ${i + 1} 的底牌与记录不一致` };
    }
  }

  const frames: ReplayFrame[] = [{ index: 0, state: cloneState(state), action: null }];

  for (let i = 0; i < record.actions.length; i++) {
    const action = record.actions[i];
    const step = i + 1;
    if (state.finished) {
      return { ok: false, reason: `第 ${step} 个动作之前本手已结束` };
    }
    if (state.actingSeat !== action.seat) {
      return {
        ok: false,
        reason: `第 ${step} 个动作记录为座位 ${action.seat + 1}，但重放时轮到座位 ${state.actingSeat + 1}`,
      };
    }
    const applied = applyAction(state, action.type, action.toAmount, action.thinkMs);
    if (!applied.ok) {
      return { ok: false, reason: `第 ${step} 个动作无法重放：${applied.error ?? '未知原因'}` };
    }
    frames.push({ index: step, state: cloneState(state), action: { ...action } });
  }

  if (!sameNumbers(state.board, record.board)) {
    return { ok: false, reason: '公共牌与记录不一致' };
  }
  if (!sameNumbers(state.results, record.results)) {
    return { ok: false, reason: '结算结果与记录不一致' };
  }

  return { ok: true, frames };
}

/** 一步的人类可读描述（回放顶部条与动作日志共用）。 */
export function replayStepLabel(record: HandRecord, frame: ReplayFrame): string {
  const action = frame.action;
  if (!action) return '开局（盲注已下）';
  const who = action.seat === record.heroSeat ? '你' : `座位 ${action.seat + 1}`;
  const amount = action.amount > 0 ? ` ${action.amount}` : '';
  return `${STREET_LABELS[action.street].zh} · ${who} ${ACTION_LABELS[action.type].zh}${amount}`;
}
