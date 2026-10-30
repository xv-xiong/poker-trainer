/**
 * 死锁回归：玩家「关闭一街」且「下一街先行动」时，行动按钮必须可用。
 *
 * 背景（2026-10-30，由 G11 dev 冒烟连打 15 手抓到）：
 * 玩家是某一街最后一个行动的人时，他的动作会把这一街关掉、发出下一街的牌，
 * 而下一街又可能正好从玩家开始。此时
 *   `actingSeat === heroSeat`（轮到玩家）
 *   但 `actions` 末条是玩家**上一街**的动作
 * 旧的 `canHeroAct` 判据是「末条动作不是玩家」，于是恒为 false ——
 * 界面停在「你的行动 / 动作确认中…」且按钮全灰，而 `planShowcaseStep`
 * 返回的 `hero-action` 步在 `run()` 里不改变任何状态，定时器不会重新装载，
 * 整局永久冻结。现场 trace：
 *   {step:"hero-action", acting:0, actions:21, board:5, revealed:5,
 *    canHeroAct:false, finished:false}
 *
 * 修法：判据改成「玩家**本街**是否已动作」（`lastAction.street === st.street`）。
 * 这个用例用真实引擎扫种子找到该状态，再断言按钮可用——不是手搓状态。
 */

import { describe, expect, it } from 'vitest';
import { legalActions } from '../../src/core/betting.js';
import { applyAction, createHand } from '../../src/core/hand.js';
import { createRng } from '../../src/core/rng.js';
import { defaultSettings, type HandState } from '../../src/core/types.js';
import { decideAI } from '../../src/ai/policy.js';
import { SHOWCASE_TIMING, deriveShowcaseView } from '../../src/ui/showcasePlan.js';

const SIX = { ...defaultSettings(), seatCount: 6 };
const HERO = 0;

/**
 * 扫种子，找出「玩家上一街动作是末条动作、且现在又轮到玩家」的状态。
 *
 * 玩家固定用最被动的策略（能过牌就过牌、能跟就跟），AI 用真实 `decideAI`：
 * 这样才会自然出现「玩家是本街最后一个行动者」的牌局，而不是靠构造。
 */
function findStreetClosingHeroTurn(maxSeeds = 400): { seed: number; state: HandState } | null {
  for (let seed = 1; seed <= maxSeeds; seed++) {
    const state = createHand({
      handId: `deadlock-${seed}`,
      seed,
      settings: SIX,
      heroSeat: HERO,
      dealerSeat: seed % 6,
    });
    let guard = 0;
    while (!state.finished && guard++ < 400) {
      const seat = state.actingSeat;
      const last = state.actions.length > 0 ? state.actions[state.actions.length - 1] : null;
      if (seat === HERO && last !== null && last.seat === HERO && last.street !== state.street) {
        return { seed, state };
      }
      if (seat < 0) break;
      const legal = legalActions(state, seat);
      if (seat === HERO) {
        if (legal.canCheck) applyAction(state, 'check', 0);
        else if (legal.canCall) applyAction(state, 'call', 0);
        else if (legal.canFold) applyAction(state, 'fold', 0);
        else break;
      } else {
        const d = decideAI(state, seat, createRng(state.seed ^ (seat * 7919)));
        applyAction(state, d.type, d.toAmount, 0);
      }
    }
  }
  return null;
}

describe('死锁回归：玩家关闭一街后下一街先行动', () => {
  const found = findStreetClosingHeroTurn();

  it('能在真实牌局里找到这个状态（否则本用例没有覆盖到目标路径）', () => {
    expect(found).not.toBeNull();
  });

  it('该状态下玩家必须可以行动（旧判据会永久冻结）', () => {
    expect(found).not.toBeNull();
    if (!found) return;
    const { state } = found;
    const last = state.actions[state.actions.length - 1];

    // 前提自检：这正是那个死锁形态——末条动作是玩家，但已经换街了。
    expect(state.finished).toBe(false);
    expect(state.actingSeat).toBe(HERO);
    expect(last.seat).toBe(HERO);
    expect(last.street).not.toBe(state.street);

    const view = deriveShowcaseView({
      state,
      heroSeat: HERO,
      visibleBoardCount: state.board.length,
      settleHold: false,
      timing: SHOWCASE_TIMING,
    });

    expect(view.canHeroAct).toBe(true);
  });

});
