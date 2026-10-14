/**
 * 单手对局编排：盲注 → 四条街 → 结算。
 *
 * 本模块是纯逻辑层：不接触 DOM、不读写 localStorage、不做 AI 决策。
 * AI 决策由调用方（ai/policy.ts）通过 `applyAction` 注入，使状态机可独立测试。
 */

import type { Card } from './cards.js';
import { shuffledDeck } from './deck.js';
import { createRng } from './rng.js';
import {
  amountToCall,
  cardsForStreet,
  firstToActPostflop,
  isStreetComplete,
  lastToActPreflop,
  legalActions,
  liveCount,
  nextStreet,
  resetForNewStreet,
} from './betting.js';
import { seatRoles, validatePots } from './pot.js';
import { settleHand } from './showdown.js';
import { rank7 } from './rank7.js';
import type {
  ActionType,
  AITier,
  HandState,
  PotLayer,
  Seat,
  Settings,
} from './types.js';
import { STREET_ORDER } from './types.js';

export interface CreateHandOptions {
  handId: string;
  seed: number;
  settings: Settings;
  heroSeat: number;
  dealerSeat: number;
  /** 各座位起始筹码（默认全部为 settings.startingStack）。 */
  stacks?: number[];
  /** 各 AI 座位的难度档位（默认全部为 settings.aiTier）。 */
  tiers?: AITier[];
  /** 座位名。 */
  names?: string[];
}

/** 创建一手新牌局。 */
export function createHand(opts: CreateHandOptions): HandState {
  const { handId, seed, settings, heroSeat, dealerSeat } = opts;
  const n = settings.seatCount;
  const rng = createRng(seed);
  const deck = shuffledDeck(rng);

  const seats: Seat[] = [];
  for (let i = 0; i < n; i++) {
    seats.push({
      index: i,
      stack: opts.stacks?.[i] ?? settings.startingStack,
      committed: 0,
      committedThisStreet: 0,
      folded: false,
      allIn: false,
      holeCards: [],
      hasActedThisStreet: false,
      isAI: i !== heroSeat,
      tier: opts.tiers?.[i] ?? settings.aiTier,
      name: opts.names?.[i] ?? `座位 ${i + 1}`,
    });
  }

  const state: HandState = {
    handId,
    seed,
    seatCount: n,
    dealerSeat,
    smallBlind: settings.smallBlind,
    bigBlind: settings.bigBlind,
    initialStacks: seats.map((s) => s.stack),
    seats,
    board: [],
    deck,
    deckIndex: 0,
    street: 'preflop',
    actingSeat: -1,
    currentBet: 0,
    lastRaiseSize: settings.bigBlind,
    actions: [],
    finished: false,
    finishReason: 'none',
    results: new Array(n).fill(0),
    showdownValues: {},
    pots: [],
    hintsUsed: 0,
  };

  dealHoleCards(state);
  postBlinds(state);
  state.actingSeat = lastToActPreflop(state, seatRoles(n, dealerSeat).bigBlindSeat);
  return state;
}

/** 每人发 2 张底牌（从庄家左侧开始，逐张发，符合真实发牌顺序）。 */
function dealHoleCards(state: HandState): void {
  const n = state.seatCount;
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i <= n; i++) {
      const s = (state.dealerSeat + i) % n;
      state.seats[s].holeCards.push(state.deck[state.deckIndex++]);
    }
  }
}

/** 下盲注。 */
function postBlinds(state: HandState): void {
  const { smallBlindSeat, bigBlindSeat } = seatRoles(state.seatCount, state.dealerSeat);
  postBet(state, smallBlindSeat, state.smallBlind);
  postBet(state, bigBlindSeat, state.bigBlind);
  state.currentBet = state.bigBlind;
  state.lastRaiseSize = state.bigBlind;
}

/** 强制投入筹码（盲注用），处理筹码不足的情况。 */
function postBet(state: HandState, seatIndex: number, amount: number): void {
  const seat = state.seats[seatIndex];
  const actual = Math.min(amount, seat.stack);
  seat.stack -= actual;
  seat.committed += actual;
  seat.committedThisStreet += actual;
  if (seat.stack === 0) seat.allIn = true;
}

/** 本街需要发几张公共牌。 */
export function dealBoardForStreet(state: HandState): void {
  const count = cardsForStreet(state.street);
  for (let i = 0; i < count; i++) {
    state.board.push(state.deck[state.deckIndex++]);
  }
}

/** 当前行动座位是否就是玩家本人。 */
export function isHeroTurn(state: HandState, heroSeat: number): boolean {
  return state.actingSeat === heroSeat && !state.finished;
}

/** 获取当前行动座位的合法动作。 */
export function currentLegalActions(state: HandState) {
  return legalActions(state, state.actingSeat);
}

export interface ApplyActionResult {
  ok: boolean;
  error?: string;
}

/**
 * 应用一次动作并推进状态机。
 *
 * @param type 动作类型
 * @param toAmount 对 bet/raise 是「加注到」的额度；对 call 忽略；对 allin 忽略
 * @param thinkMs 决策耗时
 */
export function applyAction(
  state: HandState,
  type: ActionType,
  toAmount: number,
  thinkMs = 0,
): ApplyActionResult {
  if (state.finished) return { ok: false, error: '本手已结束' };
  const seatIndex = state.actingSeat;
  if (seatIndex < 0) return { ok: false, error: '没有待行动的座位' };
  const seat = state.seats[seatIndex];
  const legal = legalActions(state, seatIndex);
  const potBefore = totalPot(state);
  const toCall = amountToCall(state, seatIndex);

  let actualAmount = 0;

  switch (type) {
    case 'fold': {
      seat.folded = true;
      break;
    }
    case 'check': {
      if (!legal.canCheck) return { ok: false, error: '不能过牌：需先跟注' };
      break;
    }
    case 'call': {
      if (!legal.canCall) return { ok: false, error: '不能跟注：无需跟注' };
      actualAmount = toCall;
      commit(state, seatIndex, actualAmount);
      break;
    }
    case 'bet':
    case 'raise': {
      if (!legal.canRaise) return { ok: false, error: '不能加注' };
      if (toAmount < legal.minRaiseTo || toAmount > legal.maxRaiseTo) {
        return {
          ok: false,
          error: `加注额 ${toAmount} 超出范围 [${legal.minRaiseTo}, ${legal.maxRaiseTo}]`,
        };
      }
      const delta = toAmount - seat.committedThisStreet;
      actualAmount = delta;
      commit(state, seatIndex, delta);
      const raiseIncrement = toAmount - state.currentBet;
      state.lastRaiseSize = raiseIncrement > 0 ? raiseIncrement : state.lastRaiseSize;
      state.currentBet = Math.max(state.currentBet, toAmount);
      // 加注后其他人需重新行动
      for (const s of state.seats) {
        if (s.index !== seatIndex && !s.folded && !s.allIn) s.hasActedThisStreet = false;
      }
      break;
    }
    case 'allin': {
      if (!legal.canAllIn) return { ok: false, error: '不能全下' };
      const allInTo = seat.committedThisStreet + seat.stack;
      actualAmount = seat.stack;
      const isRaise = allInTo > state.currentBet;
      const raiseIncrement = allInTo - state.currentBet;
      commit(state, seatIndex, actualAmount);
      if (isRaise) {
        // 全下额不足最小加注时不重开加注权
        const minIncrement = Math.max(state.lastRaiseSize, state.bigBlind);
        if (raiseIncrement >= minIncrement) {
          state.lastRaiseSize = raiseIncrement;
          for (const s of state.seats) {
            if (s.index !== seatIndex && !s.folded && !s.allIn) s.hasActedThisStreet = false;
          }
        }
        state.currentBet = Math.max(state.currentBet, allInTo);
      }
      break;
    }
    default:
      return { ok: false, error: `未知动作: ${String(type)}` };
  }

  seat.hasActedThisStreet = true;

  state.actions.push({
    seat: seatIndex,
    street: state.street,
    type,
    amount: actualAmount,
    toAmount: seat.committedThisStreet,
    thinkMs,
    potAtAction: potBefore,
    toCall,
    // 记录决策时点的剩余筹码（commit 之前已扣除，故加回本次投入）
    stackAtAction: seat.stack + actualAmount,
  });

  advance(state);
  return { ok: true };
}

/** 扣除筹码并记录投入。 */
function commit(state: HandState, seatIndex: number, amount: number): void {
  const seat = state.seats[seatIndex];
  const actual = Math.min(amount, seat.stack);
  seat.stack -= actual;
  seat.committed += actual;
  seat.committedThisStreet += actual;
  if (seat.stack === 0) seat.allIn = true;
}

/** 当前总底池（含本街投入）。 */
export function totalPot(state: HandState): number {
  return state.seats.reduce((a, s) => a + s.committed, 0);
}

/** 推进状态机：判断本街是否结束、是否进入下一街、是否结算。 */
function advance(state: HandState): void {
  if (state.finished) return;

  // 只剩一名未弃牌者 → 直接结束
  if (liveCount(state) <= 1) {
    finish(state, 'fold');
    return;
  }

  if (!isStreetComplete(state)) {
    // 找下一个可行动者
    const next = findNextActor(state);
    if (next < 0) {
      // 无人可行动 → 直接跑到摊牌
      runOutBoard(state);
      finish(state, 'showdown');
      return;
    }
    state.actingSeat = next;
    return;
  }

  // 本街结束：进入下一街
  const ns = nextStreet(state.street);
  if (ns === null) {
    finish(state, 'showdown');
    return;
  }

  state.street = ns;
  state.currentBet = 0;
  state.lastRaiseSize = state.bigBlind;
  resetForNewStreet(state.seats);
  dealBoardForStreet(state);

  // 若所有剩余玩家都已全下，则连续发完剩余公共牌直接摊牌
  const canAct = state.seats.filter((s) => !s.folded && !s.allIn && s.stack > 0).length;
  if (canAct <= 1) {
    runOutBoard(state);
    finish(state, 'showdown');
    return;
  }

  const first = firstToActPostflop(state);
  if (first < 0) {
    runOutBoard(state);
    finish(state, 'showdown');
    return;
  }
  state.actingSeat = first;
}

/** 找下一个可行动座位（从当前行动者之后顺时针）。 */
function findNextActor(state: HandState): number {
  const n = state.seatCount;
  for (let i = 1; i <= n; i++) {
    const s = (state.actingSeat + i) % n;
    const seat = state.seats[s];
    if (!seat.folded && !seat.allIn && seat.stack > 0) return s;
  }
  return -1;
}

/** 把所有剩余公共牌一次发完（全下情形）。 */
function runOutBoard(state: HandState): void {
  while (state.board.length < 5) {
    state.board.push(state.deck[state.deckIndex++]);
  }
}

/** 结算并落定状态。 */
function finish(state: HandState, reason: 'showdown' | 'fold'): void {
  const res = settleHand(state);
  state.results = res.results;
  state.showdownValues = res.values;
  state.pots = res.pots as PotLayer[];
  state.finished = true;
  state.finishReason = reason;
  state.actingSeat = -1;
  // 把净盈亏落回筹码
  for (let i = 0; i < state.seatCount; i++) {
    state.seats[i].stack = state.initialStacks[i] + res.results[i];
  }
}

/** 校验筹码守恒：Σ 各座位筹码 == Σ 起始筹码。 */
export function checkChipConservation(state: HandState): string[] {
  const errors: string[] = [];
  if (!state.finished) return errors;
  const now = state.seats.reduce((a, s) => a + s.stack, 0);
  const before = state.initialStacks.reduce((a, b) => a + b, 0);
  if (now !== before) errors.push(`筹码总额 ${now} != 起始总额 ${before}`);
  const netSum = state.results.reduce((a, b) => a + b, 0);
  if (netSum !== 0) errors.push(`净盈亏合计 ${netSum} != 0`);
  const totalCommitted = state.seats.reduce((a, s) => a + s.committed, 0);
  const potTotal = state.pots.reduce((a, p) => a + p.amount, 0);
  if (totalCommitted !== potTotal) {
    errors.push(`投入总额 ${totalCommitted} != 底池总额 ${potTotal}`);
  }
  // 分层结构校验：必须显式包含「层金额 > 0 但无有资格者」这一项。
  //
  // 为什么在此重复校验：settleHand 早已算出该诊断（ShowdownResult.errors），
  // 但结果对象在 finish() 中被丢弃，任何调用方都读不到——等于这条不变量没有被闸门强制。
  // 空有资格层会使该层金额既不分配也不退还（筹码守恒被破坏），是本项目最隐蔽的资金错乱形态，
  // 因此必须在验收闸门直接可见（G4 逐手调用本函数）。
  const potErrors = validatePots(
    { committed: state.seats.map((s) => s.committed), folded: state.seats.map((s) => s.folded) },
    state.pots,
  );
  errors.push(...potErrors);
  return errors;
}

/** 玩家本人的净盈亏。 */
export function heroNet(state: HandState, heroSeat: number): number {
  return state.results[heroSeat] ?? 0;
}

/** 玩家本手是否入池（用于 VPIP 统计）。 */
export function heroVoluntarilyEntered(state: HandState, heroSeat: number): boolean {
  return state.actions.some(
    (a) => a.seat === heroSeat && (a.type === 'call' || a.type === 'bet' || a.type === 'raise' || a.type === 'allin'),
  );
}

/** 玩家本手是否翻牌前加注（用于 PFR 统计）。 */
export function heroPreflopRaised(state: HandState, heroSeat: number): boolean {
  return state.actions.some(
    (a) => a.seat === heroSeat && a.street === 'preflop' && (a.type === 'raise' || a.type === 'bet'),
  );
}

/** 玩家是否看到摊牌。 */
export function heroSawShowdown(state: HandState, heroSeat: number): boolean {
  return state.finishReason === 'showdown' && !state.seats[heroSeat].folded;
}

/** 玩家是否赢得本手。 */
export function heroWon(state: HandState, heroSeat: number): boolean {
  return state.results[heroSeat] > 0;
}

/** 当前街的展示用公共牌。 */
export function visibleBoard(state: HandState): Card[] {
  return state.board;
}

export { STREET_ORDER, rank7 };
