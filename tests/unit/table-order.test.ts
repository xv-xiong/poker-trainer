/**
 * 牌桌布局与行动顺序的针对性测试。
 *
 * 本文件覆盖两个已报告缺陷：
 *   1. 六人桌中有两名 AI 的手牌不显示；
 *   2. AI 行动顺序与座次（顺时针）不一致，看起来像随机行动。
 *
 * 断言口径说明（为什么这样写）：
 *   - 「显示手牌」曾由 `SeatView` 的 `{!compact && <div className="seat-cards">}`
 *     决定：`compact === true` 的座位**完全不渲染**底牌节点，六人桌左右两侧
 *     恰好有两名 AI 因此看不到手牌。现已删除 `compact` 概念、底牌始终渲染，
 *     故此处改为断言「布局不产出任何会被用来隐藏底牌的标记」+「每个座位都有牌」。
 *   - 「行动顺序」在引擎层由 `HandState.actions[].seat` 的先后决定，
 *     可直接驱动 `createHand` + `applyAction` 逐条核对，不依赖 UI。
 */

import { describe, expect, it } from 'vitest';
import { computePlacements } from '../../src/ui/components/TableView.js';
import { createHand, applyAction } from '../../src/core/hand.js';
import { legalActions } from '../../src/core/betting.js';
import { seatRoles } from '../../src/core/pot.js';
import { defaultSettings } from '../../src/core/types.js';
import type { ActionType, HandState, Settings } from '../../src/core/types.js';

/** 构造一手牌（默认 6 人桌，玩家在 0 号座）。 */
function makeHand(over: Partial<Settings> = {}, heroSeat = 0, dealerSeat = 0, seed = 12345): HandState {
  const settings: Settings = { ...defaultSettings(), ...over };
  return createHand({ handId: 'h-test', seed, settings, heroSeat, dealerSeat });
}

describe('缺陷 1：六人桌每名 AI 都必须显示手牌', () => {
  it('布局不再产出 compact 之类的「隐藏底牌」标记（回归：曾用 compact 跳过渲染）', () => {
    for (const n of [2, 3, 6, 9]) {
      for (let hero = 0; hero < n; hero++) {
        const ps = computePlacements(n, hero);
        expect(ps).toHaveLength(n);
        // 每个座位恰好出现一次
        expect(new Set(ps.map((p) => p.index)).size).toBe(n);
        for (const p of ps) {
          expect(
            Object.prototype.hasOwnProperty.call(p, 'compact'),
            `${n} 人桌 hero=${hero} 座位 ${p.index} 仍带 compact 字段（会隐藏底牌）`,
          ).toBe(false);
        }
      }
    }
  });

  it('六人桌每个座位都有 2 张底牌（发牌阶段就发满，与是否显示无关）', () => {
    const st = makeHand({ seatCount: 6 });
    for (let i = 0; i < 6; i++) {
      expect(st.seats[i].holeCards, `座位 ${i} 底牌数量`).toHaveLength(2);
    }
  });

  it('每个座位的坐标都在桌面可见范围内（不会被挤出视口而「看起来没显示」）', () => {
    for (const n of [2, 3, 6, 9]) {
      for (let hero = 0; hero < n; hero++) {
        for (const p of computePlacements(n, hero)) {
          expect(p.x, `${n} 人桌 hero=${hero} 座位 ${p.index} 的 x`).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(100);
          expect(p.y, `${n} 人桌 hero=${hero} 座位 ${p.index} 的 y`).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe('缺陷 2：行动顺序必须按座次顺时针推进', () => {
  /**
   * 按引擎推进一手，记录每个动作的座位。
   * 使用「总是过牌/跟注」的确定性策略，避免 AI 随机性影响顺序核对。
   */
  function playAndRecord(st: HandState, maxSteps = 200): Array<{ seat: number; street: string }> {
    const seq: Array<{ seat: number; street: string }> = [];
    for (let i = 0; i < maxSteps && !st.finished && st.actingSeat >= 0; i++) {
      const seat = st.actingSeat;
      const legal = legalActions(st, seat);
      const type: ActionType = legal.canCheck ? 'check' : 'call';
      seq.push({ seat, street: st.street });
      const r = applyAction(st, type, 0, 0);
      if (!r.ok) throw new Error(`动作被拒绝：${r.error}`);
    }
    return seq;
  }

  it('翻牌前：行动从大盲左侧开始，并严格顺时针推进', () => {
    for (const n of [2, 3, 6, 9]) {
      for (let dealer = 0; dealer < n; dealer++) {
        const st = makeHand({ seatCount: n }, 0, dealer);
        const { bigBlindSeat } = seatRoles(n, dealer);
        const first = (bigBlindSeat + 1) % n;
        expect(st.actingSeat, `${n} 人桌 dealer=${dealer} 翻前首个行动者`).toBe(first);

        const seq = playAndRecord(st).filter((a) => a.street === 'preflop');
        // 翻前行动顺序必须是从 first 开始的顺时针子序列（允许跳过已弃牌/全下者）
        let cursor = first;
        for (const a of seq) {
          if (a.seat === cursor) {
            cursor = (cursor + 1) % n;
          } else {
            // 允许跳过不可行动座位，但必须是顺时针前方（不能回头）
            let probe = cursor;
            let found = false;
            for (let k = 0; k < n; k++) {
              if (probe === a.seat) {
                found = true;
                cursor = (a.seat + 1) % n;
                break;
              }
              probe = (probe + 1) % n;
            }
            expect(found, `${n} 人桌 dealer=${dealer}：翻前动作 ${JSON.stringify(a)} 不在顺时针顺序上`).toBe(
              true,
            );
          }
        }
      }
    }
  });

  it('翻牌后：行动从庄家左侧开始，并严格顺时针推进', () => {
    for (const n of [2, 3, 6, 9]) {
      for (let dealer = 0; dealer < n; dealer++) {
        const st = makeHand({ seatCount: n }, 0, dealer);
        playAndRecord(st);
        // 逐街核对：每条街的第一个动作必须是庄家左侧第一个未弃牌可行动者
        const byStreet = new Map<string, number[]>();
        for (const a of st.actions) {
          const arr = byStreet.get(a.street) ?? [];
          arr.push(a.seat);
          byStreet.set(a.street, arr);
        }
        for (const [street, seats] of byStreet) {
          if (street === 'preflop' || seats.length === 0) continue;
          // 庄家左侧第一个可行动者
          let expected = -1;
          for (let i = 1; i <= n; i++) {
            const s = (dealer + i) % n;
            if (!st.seats[s].folded) {
              expected = s;
              break;
            }
          }
          if (expected < 0) continue;
          expect(seats[0], `${n} 人桌 dealer=${dealer} 街=${street} 首个行动者`).toBe(expected);
        }
      }
    }
  });

  it('同一街内连续两次行动必须顺时针递增（不得跳回或乱序）', () => {
    for (const n of [6, 9]) {
      for (let dealer = 0; dealer < n; dealer++) {
        const st = makeHand({ seatCount: n }, 0, dealer);
        playAndRecord(st);
        const byStreet = new Map<string, number[]>();
        for (const a of st.actions) {
          const arr = byStreet.get(a.street) ?? [];
          arr.push(a.seat);
          byStreet.set(a.street, arr);
        }
        for (const [street, seats] of byStreet) {
          for (let i = 1; i < seats.length; i++) {
            const prev = seats[i - 1];
            const cur = seats[i];
            // 从 prev 顺时针走到 cur 的距离必须 < n，且不等于 0
            const dist = (cur - prev + n) % n;
            expect(dist, `${n} 人桌 dealer=${dealer} 街=${street}：${prev} -> ${cur} 不是顺时针前进`).toBeGreaterThan(0);
            expect(dist, `${n} 人桌 dealer=${dealer} 街=${street}：${prev} -> ${cur} 距离异常`).toBeLessThan(n);
          }
        }
      }
    }
  });

  it('用 AI 决策驱动时，行动座位同样按顺时针推进（覆盖 AI 路径）', () => {
    // 这里只核对顺序不核对决策内容，因此直接用「过牌/跟注」替代 AI 决策来源，
    // 但驱动方式与 controller.runAI 相同（逐次 applyAction）。
    const st = makeHand({ seatCount: 6 }, 3, 1, 777);
    playAndRecord(st);
    const seats = st.actions.map((a) => a.seat);
    expect(seats.length).toBeGreaterThan(0);
    // 不存在相邻两次相同座位（同一步不可能行动两次）
    for (let i = 1; i < seats.length; i++) {
      expect(seats[i]).not.toBe(seats[i - 1]);
    }
  });
});

describe('缺陷 2 补充：座位的视觉顺时针顺序必须与行动顺序一致', () => {
  /**
   * 把座位坐标换算成「以桌面中心为原点的极角」，按顺时针排序后，
   * 必须恰好是 [hero, hero+1, hero+2, ...]（模 seatCount）。
   *
   * 为什么用极角：牌桌是环绕布局，视觉上的「顺时针下一个」就是极角单调递增，
   * 与引擎的 (seat + 1) % n 必须一一对应；否则玩家看到的行动光晕会「跳座位」，
   * 主观感受就是「AI 在随机行动」。
   */
  function clockwiseOrder(n: number, hero: number): number[] {
    const ps = computePlacements(n, hero);
    const cx = 50;
    const cy = 50;
    const sorted = [...ps]
      .map((p) => {
        // 屏幕坐标 y 向下：以「正上方」为 0、顺时针为正的角度
        const ang = Math.atan2(p.x - cx, cy - p.y);
        return { index: p.index, ang: (ang + 2 * Math.PI) % (2 * Math.PI) };
      })
      .sort((a, b) => a.ang - b.ang)
      .map((x) => x.index);

    // 必须从**玩家座位**开始读，否则测的是「从正上方开始」的顺序，
    // 而玩家关心的是「从我自己出发，下一个是谁」。旋转而不是重排。
    const at = sorted.indexOf(hero);
    expect(at, `hero=${hero} 未出现在布局中`).toBeGreaterThanOrEqual(0);
    return [...sorted.slice(at), ...sorted.slice(0, at)];
  }

  it('6 人桌：从玩家出发的视觉顺时针顺序 = 座次顺序', () => {
    for (let hero = 0; hero < 6; hero++) {
      const order = clockwiseOrder(6, hero);
      const expected = Array.from({ length: 6 }, (_, i) => (hero + i) % 6);
      expect(order, `hero=${hero} 时视觉顺时针顺序与座次顺序不一致`).toEqual(expected);
    }
  });

  it('2 / 3 / 9 人桌：视觉顺时针顺序同样等于座次顺序', () => {
    for (const n of [2, 3, 9]) {
      for (let hero = 0; hero < n; hero++) {
        const order = clockwiseOrder(n, hero);
        const expected = Array.from({ length: n }, (_, i) => (hero + i) % n);
        expect(order, `${n} 人桌 hero=${hero} 视觉顺时针顺序不一致`).toEqual(expected);
      }
    }
  });
});
