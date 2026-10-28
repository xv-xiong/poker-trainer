/**
 * 阶段 1-1 的回归 E2E：筹码继承模式（补码弹窗 / 出局结算 / 赢下整桌 / AI 下桌）
 * 与单局练习模式的即时反馈。
 *
 * 为什么必须用浏览器断言：这一批改动全部是「跨手状态」驱动的界面分支——
 * 弹窗何时出现、结算画面替换牌桌、下桌 AI 是否半透明。单测只能验证派生量与
 * 账本（tests/unit/carry-over.test.ts 已覆盖），验证不了「到底渲染出来了没有」。
 *
 * 存档用 `addInitScript` 注入：应用只在动作发生后落库，等它自己出现会白等到超时。
 * 注入的是**当前版本**的完整存档（含阶段 1-1 的三个新字段），因此这里也顺带
 * 证明了 v2 存档能被正常读入。
 */

import { expect, test, type Page } from '@playwright/test';

const STATE_KEY = 'poker-trainer:state';

interface RosterSeed {
  id: number;
  name: string;
  stack: number;
  out: boolean;
}

/** 与 `initialState()` 同构的合法存档（v2）。 */
function makeState(opts: {
  bankroll: number;
  carryOverStacks: boolean;
  roster: RosterSeed[];
  heroOut?: boolean;
  handsPlayed?: number;
}) {
  const startingStack = 1000;
  return {
    schemaVersion: 2,
    bankroll: opts.bankroll,
    settings: {
      seatCount: 6,
      startingStack,
      smallBlind: 5,
      bigBlind: 10,
      aiTier: 'medium',
      fourColorDeck: false,
      showShortcuts: true,
      enableFlopExact: false,
    },
    stats: {
      handsPlayed: opts.handsPlayed ?? 0,
      handsWon: 0,
      showdownsSeen: 0,
      showdownsWon: 0,
      totalWagered: 0,
      netProfit: 0,
      vpipHands: 0,
      pfrHands: 0,
      hintsUsed: 0,
      reviewCounts: { ok: 0, review: 0, major: 0 },
      topUps: 0,
      topUpAmount: 0,
    },
    nextDealerSeat: 0,
    handCounter: 0,
    carryOverStacks: opts.carryOverStacks,
    roster: opts.roster,
    heroOut: opts.heroOut ?? false,
  };
}

/** 五个 AI 座位，筹码统一为给定值。 */
function fiveAis(stack = 1000, outIds: number[] = []): RosterSeed[] {
  return [1, 2, 3, 4, 5].map((id) => ({
    id,
    name: `AI-${id}`,
    stack: outIds.includes(id) ? 0 : stack,
    out: outIds.includes(id),
  }));
}

async function seed(page: Page, state: unknown): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key as string, JSON.stringify(value));
    },
    [STATE_KEY, state] as const,
  );
  await page.goto('/poker-trainer/?skip-lobby=1');
}

test.describe('阶段 1-1：继承模式的补码弹窗', () => {
  test('玩家输光后弹出补码选择，选「不补码」进入出局结算画面', async ({ page }) => {
    // 资金 5 < 大盲 10 —— 已输光，必须等玩家回答补码
    await seed(
      page,
      makeState({ bankroll: 5, carryOverStacks: true, roster: fiveAis(), handsPlayed: 12 }),
    );

    const dialog = page.locator('[data-testid="rebuy-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // 弹窗必须说明「还有多少 / 补到多少」，否则用户不知道自己在决定什么
    await expect(dialog).toContainText('5');
    await expect(dialog).toContainText('1000');

    await page.click('[data-testid="rebuy-no"]');

    const end = page.locator('[data-testid="session-end"]');
    await expect(end).toBeVisible({ timeout: 15_000 });
    await expect(end).toHaveAttribute('data-kind', 'hero-bust');
    // 出局结算必须给出决策统计与建议，而不是只说一句「你输了」
    await expect(end).toContainText('建议');
    // 出局后不应还能点「下一手」
    await expect(page.locator('button', { hasText: '下一手' })).toHaveCount(0);
  });

  test('选择补码后资金回到起始筹码，牌桌重新开打（弹窗消失）', async ({ page }) => {
    await seed(
      page,
      makeState({ bankroll: 5, carryOverStacks: true, roster: fiveAis(), handsPlayed: 12 }),
    );

    const dialog = page.locator('[data-testid="rebuy-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await page.click('[data-testid="rebuy-yes"]');

    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-testid="felt"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.bankroll .amount')).toHaveText('1000');
  });

  test('AI 输光时弹窗点名是哪个 AI，并提示「不补码就下桌」', async ({ page }) => {
    await seed(
      page,
      makeState({
        bankroll: 2000,
        carryOverStacks: true,
        // AI-2 只剩 4，不足一个大盲
        roster: fiveAis().map((r) => (r.id === 2 ? { ...r, stack: 4 } : r)),
        handsPlayed: 20,
      }),
    );

    const dialog = page.locator('[data-testid="rebuy-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('AI-2');

    await page.click('[data-testid="rebuy-no"]');
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });

    // 下桌后账本里该座位标记为已下桌，且牌桌座位数从 6 缩到 5
    await expect(page.locator('[data-testid="roster-2"]')).toHaveAttribute('data-out', '1');
    await expect(page.locator('[data-testid="felt"]')).toHaveAttribute('data-seat-count', '5');
  });
});

test.describe('阶段 1-1：AI 下桌与赢下整桌', () => {
  test('已下桌的 AI 在座位账本里半透明显示，而不是直接消失', async ({ page }) => {
    await seed(
      page,
      makeState({
        bankroll: 2000,
        carryOverStacks: true,
        roster: fiveAis(1000, [2, 4]),
        handsPlayed: 30,
      }),
    );

    const strip = page.locator('[data-testid="roster-strip"]');
    await expect(strip).toBeVisible({ timeout: 30_000 });
    // 下桌的两个座位：半透明 + 删除线（用 .out 类表达），并且仍留在条带里
    await expect(page.locator('[data-testid="roster-2"]')).toHaveAttribute('data-out', '1');
    await expect(page.locator('[data-testid="roster-4"]')).toHaveAttribute('data-out', '1');
    await expect(page.locator('[data-testid="roster-2"]')).toHaveClass(/out/);
    // 还在打的座位不能被标成下桌
    await expect(page.locator('[data-testid="roster-1"]')).toHaveAttribute('data-out', '0');
    // 牌桌只剩 4 人（玩家 + AI-1/3/5）
    await expect(page.locator('[data-testid="felt"]')).toHaveAttribute('data-seat-count', '4');
  });

  test('所有 AI 都下桌 → 赢下整桌的结算画面（带鼓励文案）', async ({ page }) => {
    await seed(
      page,
      makeState({
        bankroll: 6800,
        carryOverStacks: true,
        roster: fiveAis(0, [1, 2, 3, 4, 5]),
        handsPlayed: 40,
      }),
    );

    const end = page.locator('[data-testid="session-end"]');
    await expect(end).toBeVisible({ timeout: 30_000 });
    await expect(end).toHaveAttribute('data-kind', 'victory');
    await expect(end).toContainText('赢下');
    // 胜利画面同样要有决策统计与鼓励
    await expect(end).toContainText('建议');
    await expect(page.locator('button', { hasText: '下一手' })).toHaveCount(0);
  });

  test('结算画面上的「重新开始」把整局重置，回到牌桌', async ({ page }) => {
    await seed(
      page,
      makeState({
        bankroll: 6800,
        carryOverStacks: true,
        roster: fiveAis(0, [1, 2, 3, 4, 5]),
        handsPlayed: 40,
      }),
    );

    await expect(page.locator('[data-testid="session-end"]')).toBeVisible({ timeout: 30_000 });
    await page.click('[data-testid="session-restart"]');

    await expect(page.locator('[data-testid="session-end"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-testid="felt"]')).toBeVisible({ timeout: 30_000 });
    // 账本重建：五个 AI 全部回到起始筹码
    for (const id of [1, 2, 3, 4, 5]) {
      await expect(page.locator(`[data-testid="roster-${id}"]`)).toHaveAttribute('data-out', '0');
    }
  });
});

test.describe('阶段 1-1：单局练习模式的即时反馈', () => {
  test('不继承筹码时，结算面板出现「本手点评」与累计进度', async ({ page }) => {
    await page.goto('/poker-trainer/?skip-lobby=1');
    await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });

    // 打一手到结束：能过牌/跟注就一直打，直到结算面板出现
    const result = page.locator('.result-panel');
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if ((await result.count()) > 0) break;
      const myTurn = page.locator('[data-testid="action-my-turn"]');
      if ((await myTurn.count()) > 0) {
        const call = myTurn.locator('button', { hasText: /跟注|过牌/ });
        if ((await call.count()) > 0 && (await call.first().isEnabled())) {
          await call.first().click();
        }
      }
      await page.waitForTimeout(200);
    }

    await expect(result).toBeVisible({ timeout: 30_000 });
    // 单局练习的核心反馈：这一手打得怎么样 + 累计进度
    await expect(result).toContainText('本手点评');
    await expect(result).toContainText('单局练习累计');
    // 继承模式的座位账本在单局练习下不出现
    await expect(page.locator('[data-testid="roster-strip"]')).toHaveCount(0);
  });
});
