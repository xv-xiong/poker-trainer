/**
 * 阶段三 3.4：手牌回放的端到端回归。
 *
 * 断言三条产品承诺：
 *   1. 历史面板每一手都能回放，且帧数 = 动作数 + 1（不多不少）；
 *   2. 回放里公共牌**按街**揭示（0 → 3 → 4 → 5，绝不出现「只翻 1 张」），
 *      到末帧未弃牌的座位全部亮出两张底牌（摊牌）；
 *   3. 退出回放后存档一个字节都没变 —— 回放只读，绝不写库。
 *
 * 另外覆盖降级路径：结构残缺的记录（能通过 `validateHistory` 的宽松校验，
 * 但无法被引擎重放）必须把「回放」按钮置灰并给出原因，而不是点进去才报错。
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

interface StoredRecord {
  handId: string;
  board: number[];
  actions: unknown[];
}

function attachErrorCollector(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return { errors };
}

async function enterTable(page: Page): Promise<void> {
  await page.goto('/poker-trainer/?skip-lobby=1');
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
}

/** 轮到自己时持续过牌/跟注，直到本手结束（与 app.spec.ts 同一套 deadline 策略）。 */
async function playHandToCompletion(page: Page, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resultVisible = await page
      .getByRole('heading', { name: '本手结果' })
      .isVisible()
      .catch(() => false);
    if (resultVisible) return;
    const overVisible = await page
      .getByRole('button', { name: /下一手/ })
      .first()
      .isVisible()
      .catch(() => false);
    if (overVisible) return;

    const candidates = page.getByRole('button', { name: /跟注|过牌/ });
    const total = await candidates.count();
    let clicked = false;
    for (let i = 0; i < total; i++) {
      const b = candidates.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      if (!(await b.isEnabled().catch(() => false))) continue;
      await b.click({ timeout: 5000 }).catch(() => {});
      clicked = true;
      break;
    }
    await page.waitForTimeout(clicked ? 180 : 220);
  }
  throw new Error(`playHandToCompletion 超时（${timeoutMs}ms）：本手仍未结束`);
}

async function storedHistory(page: Page): Promise<StoredRecord[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('poker-trainer:history');
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StoredRecord[]) : [];
    } catch {
      return [];
    }
  });
}

/** 打到「最新一手至少翻到翻牌」为止，返回该手的动作数。 */
async function playUntilPostflopHand(page: Page): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await playHandToCompletion(page);
    const list = await storedHistory(page);
    const last = list[list.length - 1];
    if (last && Array.isArray(last.board) && last.board.length >= 3) {
      return last.actions.length;
    }
    // 极少数情况下翻前就结束了（全桌弃牌到玩家），换一手再试
    await page.locator('button:visible', { hasText: '下一手' }).first().click();
    await page.waitForTimeout(400);
  }
  throw new Error('连续 6 手都没翻到翻牌，无法验证逐街揭示');
}

/** 读出回放进度里的当前帧号（「第 k / m 步」）。 */
async function replayIndex(page: Page): Promise<number> {
  const text = await page.getByTestId('replay-progress').innerText();
  const matched = /第\s*(\d+)\s*\//.exec(text);
  return matched ? Number(matched[1]) : -1;
}

test.describe('阶段三：手牌回放', () => {
  test('逐帧步进、逐街揭示、末帧摊牌，退出后存档不变', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await enterTable(page);
    const actionCount = await playUntilPostflopHand(page);

    await page.getByRole('tab', { name: '历史' }).click();
    const replayButton = page.getByRole('button', { name: '回放' }).first();
    await expect(replayButton).toBeVisible();

    // 回放前存档快照
    const storageSnapshot = () =>
      page.evaluate(() =>
        JSON.stringify({
          state: window.localStorage.getItem('poker-trainer:state'),
          history: window.localStorage.getItem('poker-trainer:history'),
        }),
      );
    const before = await storageSnapshot();

    await replayButton.click();
    await expect(page.getByTestId('replay-panel')).toBeVisible();
    expect(await replayIndex(page)).toBe(0);

    // 帧数必须等于「动作数 + 1」：日志行就是帧列表
    await expect(page.getByTestId('replay-log').locator('li')).toHaveCount(actionCount + 1);

    // 逐帧前进，记录每帧的公共牌张数
    const revealed: number[] = [];
    const readRevealed = async (): Promise<number> =>
      Number(await page.getByTestId('board').getAttribute('data-revealed'));
    revealed.push(await readRevealed());
    for (let i = 0; i < actionCount; i++) {
      await page.getByTestId('replay-next').click();
      revealed.push(await readRevealed());
    }

    // 逐街揭示：只可能是 0 / 3 / 4 / 5，且单调不减
    expect(revealed.every((v) => [0, 3, 4, 5].includes(v))).toBe(true);
    for (let i = 1; i < revealed.length; i++) {
      expect(revealed[i], `第 ${i} 帧公共牌数不得回退`).toBeGreaterThanOrEqual(revealed[i - 1]);
    }
    expect(revealed[revealed.length - 1]).toBeGreaterThanOrEqual(3);

    // 末帧：进度到末尾，未弃牌座位全部亮出两张底牌
    expect(await replayIndex(page)).toBe(actionCount);
    await expect(page.getByTestId('replay-progress')).toContainText(
      `第 ${actionCount} / ${actionCount} 步`,
    );
    const liveSeats = page.locator('.seat:not(.folded)');
    const liveCount = await liveSeats.count();
    expect(liveCount).toBeGreaterThan(0);
    for (let i = 0; i < liveCount; i++) {
      await expect(liveSeats.nth(i).locator('.card')).toHaveCount(2);
    }

    // 退出回放：回到历史列表
    await page.getByTestId('replay-exit').click();
    await expect(page.getByTestId('replay-panel')).toBeHidden();
    await expect(page.getByRole('button', { name: '回放' }).first()).toBeVisible();

    // 回放绝不能写库
    expect(await storageSnapshot()).toBe(before);
    expect(errors).toEqual([]);
  });

  test('自动播放会自动推进帧，可以暂停', async ({ page }) => {
    await enterTable(page);
    await playUntilPostflopHand(page);

    await page.getByRole('tab', { name: '历史' }).click();
    await page.getByRole('button', { name: '回放' }).first().click();
    await expect(page.getByTestId('replay-panel')).toBeVisible();
    expect(await replayIndex(page)).toBe(0);

    await page.getByTestId('replay-play').click();
    // 每帧 900ms，等它至少推进 2 帧
    await expect.poll(() => replayIndex(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    // 暂停后按钮文案复原，且不再自行前进
    await page.getByTestId('replay-play').click();
    await expect(page.getByTestId('replay-play')).toHaveText('自动播放');
    const paused = await replayIndex(page);
    await page.waitForTimeout(2200);
    expect(await replayIndex(page)).toBe(paused);
  });

  test('结构残缺的记录：回放按钮置灰并给出原因', async ({ page }) => {
    // 这条记录能通过 validateHistory 的宽松校验（只查 handId / seed / actions），
    // 但缺少 initialStacks，引擎无法重建 —— 正是需要降级置灰的情形。
    await page.addInitScript(() => {
      const broken = {
        handId: 'BROKEN',
        seed: 1,
        timestamp: 0,
        seatCount: 6,
        heroSeat: 0,
        dealerSeat: 0,
        smallBlind: 5,
        bigBlind: 10,
        initialStacks: [],
        holeCards: [],
        board: [],
        actions: [],
        pots: [],
        results: [],
        heroNet: 0,
        review: [],
        hintsUsed: 0,
      };
      window.localStorage.setItem('poker-trainer:history', JSON.stringify([broken]));
    });
    await enterTable(page);

    await page.getByRole('tab', { name: '历史' }).click();
    const replayButton = page.getByRole('button', { name: '回放' }).first();
    await expect(replayButton).toBeVisible();
    await expect(replayButton).toBeDisabled();
    await expect(replayButton).toHaveAttribute('title', /起始筹码/);

    // 点不动，页面也不该崩
    await expect(page.getByTestId('replay-panel')).toHaveCount(0);
  });
});
