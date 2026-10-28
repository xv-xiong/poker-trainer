/**
 * 阶段一（审计剩余项）的回归 E2E：三处「用户能直接看见/感知」的修正。
 *
 *   1. 统计面板「当前资金」的盈亏配色跟随 `settings.startingStack`，
 *      不再硬编码 1000（旧实现：起始筹码改成 2000 后，资金 1500 仍显示绿色）。
 *   2. 全下需要二次确认，且 3 秒内不确认自动复位。
 *   3. ARIA 补齐：tab ↔ tabpanel 互指、加注滑杆 aria-valuetext、底池 aria-live。
 *
 * 为什么用浏览器断言而不是单测：这三项都只体现在**渲染结果**上。
 * 配色判据本身另有纯函数单测（tests/unit/format.test.ts），这里验的是「接上了」。
 *
 * 存档用 `addInitScript` 直接注入（而不是先打一手再改）：应用只在动作发生后才
 * 落库，初次加载时 localStorage 是空的，等它出现会白等到超时。
 */

import { expect, test, type Page } from '@playwright/test';

const STATE_KEY = 'poker-trainer:state';

/** 与 `initialState()` 同构的一份合法存档；只改起始筹码与资金。 */
function makeState(startingStack: number, bankroll: number) {
  return {
    schemaVersion: 1,
    bankroll,
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
      handsPlayed: 0,
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
  };
}

/** 注入存档后进牌桌。 */
async function seedBankroll(page: Page, startingStack: number, bankroll: number): Promise<void> {
  await page.addInitScript(
    ([key, state]) => {
      localStorage.setItem(key as string, JSON.stringify(state));
    },
    [STATE_KEY, makeState(startingStack, bankroll)] as const,
  );
  await page.goto('/poker-trainer/?skip-lobby=1');
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
}

/** 读统计面板「当前资金」那个数字的 class（`v pos` / `v neg`）。 */
async function currentBankrollClass(page: Page): Promise<string> {
  await page.click('#tab-stats');
  await page.waitForSelector('#panel-stats', { timeout: 10_000 });
  return page.evaluate(() => {
    const stat = [...document.querySelectorAll('#panel-stats .stat')].find((s) =>
      (s.querySelector('.k')?.textContent ?? '').includes('当前资金'),
    );
    return stat?.querySelector('.v')?.className ?? '';
  });
}

test.describe('阶段一：盈亏配色跟随起始筹码（审计 P2-6）', () => {
  test('起始筹码 2000、资金 1500 → 亏损（旧实现误判为盈利）', async ({ page }) => {
    await seedBankroll(page, 2000, 1500);
    expect(await currentBankrollClass(page)).toContain('neg');
  });

  test('起始筹码 500、资金 600 → 盈利（旧实现误判为亏损）', async ({ page }) => {
    await seedBankroll(page, 500, 600);
    expect(await currentBankrollClass(page)).toContain('pos');
  });
});

/**
 * 等到「玩家可行动且能全下」的一手。
 *
 * 不假设第几手一定满足：玩家可能在大盲位被人一路弃牌到结束，或翻前就被夹在
 * 中间。这里最多换 6 手，找不到就跳过断言（并打印原因），避免假红。
 */
async function waitHeroAllInAvailable(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const reached = await page
      .waitForFunction(
        () =>
          document.querySelector('[data-testid="action-my-turn"]') !== null ||
          document.querySelector('.result-panel') !== null,
        null,
        { timeout: 90_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!reached) return false;

    const hasPanel = await page.locator('[data-testid="action-my-turn"]').count();
    if (hasPanel > 0) {
      const btn = page.locator('[data-testid="btn-allin"]');
      if ((await btn.count()) > 0 && (await btn.first().isEnabled())) return true;
      // 本手不能全下（例如已全下/筹码不足），打完这一手再看下一手
    }

    const nextBtn = page.locator('button', { hasText: '下一手' });
    if ((await nextBtn.count()) === 0) return false;
    await nextBtn.first().click();
    await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
  }
  return false;
}

test.describe('阶段一：全下二次确认（审计 P1-6）', () => {
  test('第一次点击只进入确认态，3 秒后自动复位', async ({ page }) => {
    await page.goto('/poker-trainer/?skip-lobby=1');
    await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });

    const ok = await waitHeroAllInAvailable(page);
    test.skip(!ok, '6 手内没遇到「玩家可全下」的局面');

    const allIn = page.locator('[data-testid="btn-allin"]');
    await expect(allIn).toHaveText('全下（All-in）');

    // 第一次点击：进入确认态，且**不得**真的执行（面板还在，说明手牌没结束）
    await allIn.click();
    await expect(allIn).toHaveText('确认全下？');
    await expect(page.locator('[data-testid="action-my-turn"]')).toBeVisible();

    // 3 秒后自动复位（留 800ms 余量）
    await expect(allIn).toHaveText('全下（All-in）', { timeout: 5_000 });
  });
});

test.describe('阶段一：ARIA 补齐（审计无障碍项）', () => {
  test('tab ↔ tabpanel 互指、滑杆 aria-valuetext、底池 aria-live', async ({ page }) => {
    await page.goto('/poker-trainer/?skip-lobby=1');
    await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });

    // ① 底池有常驻的 polite 播报区
    const potLive = await page.evaluate(() => {
      const el = document.querySelector('.pot-display [role="status"]');
      return { text: el?.textContent ?? '', live: el?.getAttribute('aria-live') ?? '' };
    });
    expect(potLive.live).toBe('polite');
    expect(potLive.text).toContain('底池');

    // ② 轮到自己且能加注时，滑杆带语义化的 aria-valuetext
    const ok = await waitHeroAllInAvailable(page);
    test.skip(!ok, '6 手内没遇到「玩家可加注」的局面');

    const slider = page.locator('[data-testid="action-my-turn"] input[type="range"]');
    await expect(slider).toHaveCount(1);
    const valuetext = await slider.getAttribute('aria-valuetext');
    expect(valuetext).toBeTruthy();
    expect(valuetext).toMatch(/^加注到 \d+（约 [\d.]+ BB）$/);

    // ③ 逐个切换 tab：选中项的 aria-controls 必须指向真实存在的 tabpanel，
    //    未选中项不得挂 aria-controls（面板按需渲染，挂上就是悬空 IDREF）
    const tabIds = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')].map((t) => t.id),
    );
    expect(tabIds.length).toBeGreaterThanOrEqual(5);

    for (const id of tabIds) {
      await page.click(`#${id}`);
      const panelId = id.replace('tab-', 'panel-');
      const info = await page.evaluate((pid) => {
        const el = document.getElementById(pid as string);
        if (!el) return null;
        return { role: el.getAttribute('role'), labelledby: el.getAttribute('aria-labelledby') };
      }, panelId);
      expect(info, `${panelId} 应存在`).not.toBeNull();
      expect(info?.role, `${panelId} 应有 role=tabpanel`).toBe('tabpanel');
      expect(info?.labelledby, `${panelId} 应回指 ${id}`).toBe(id);
      await expect(page.locator(`#${id}`)).toHaveAttribute('aria-controls', panelId);
    }

    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')].map((t) => ({
        selected: t.getAttribute('aria-selected'),
        controls: t.getAttribute('aria-controls'),
      })),
    );
    expect(tabs.filter((t) => t.selected === 'true')).toHaveLength(1);
    for (const t of tabs) {
      if (t.selected !== 'true') expect(t.controls, '未选中的 tab 不应有 aria-controls').toBeNull();
    }
  });
});
