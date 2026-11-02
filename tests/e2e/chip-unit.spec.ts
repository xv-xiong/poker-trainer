/**
 * 阶段六：滑杆自适应 / 下注输入框 / 筹码单位切换。
 *
 * 三条断言各自对应一个用户可见承诺：
 *   1. 按 B（或设置面板下拉）能在真实筹码与大盲倍数之间切换，且**只改展示**——
 *      localStorage 里的金额一分不动。
 *   2. 下注输入框能直接打数字，回车/失焦后加注额生效；非法输入不写 NaN。
 *   3. 滑杆能精确表示任意整数加注额（`SLIDER_STEP = 1` 的回归护栏）——
 *      早先按大盲取整时，输入框打 515 会被滑杆吸附成 520，用户看到一个
 *      自己没输入过的数字。
 *
 * 辅助函数里的两个坑（都已避开）：
 *   - **不要用 `addInitScript` 清 localStorage**：它在**每次**导航前都会执行，
 *     `page.reload()` 会把刚写入的存档又清掉，于是「刷新后设置还在」永远失败。
 *     正确做法是先 goto、再 `evaluate(clear)`、再 reload。
 *   - **新会话第一次落库发生在「第一次状态变更」时**，纯加载不会写存档。
 *     所以断言「金额没变」要在切换过一次单位（已经触发 persist）之后读。
 */

import { expect, test, type Page } from '@playwright/test';

/** 进入牌桌（跳过开始界面），并保证从一份干净的存档开始。 */
async function enterTable(page: Page) {
  await page.goto('/poker-trainer/?skip-lobby=1');
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
}

/** 等到轮到自己行动（出现可操作的仪表盘）。 */
async function waitHeroTurn(page: Page, timeoutMs = 60_000) {
  await page.waitForSelector('[data-testid="action-my-turn"]', { timeout: timeoutMs });
}

/** 读顶栏资金文本。 */
async function bankrollText(page: Page): Promise<string> {
  return (await page.locator('.bankroll .amount').innerText()).trim();
}

/** 读 localStorage 里的 bankroll（存档不存在时返回 null）。 */
async function storedBankroll(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('poker-trainer:state');
    if (!raw) return null;
    return JSON.parse(raw).bankroll as number;
  });
}

test.describe('阶段六：筹码单位与下注输入', () => {
  test('B 键在真实筹码与大盲倍数之间切换，只改展示不改金额', async ({ page }) => {
    await enterTable(page);
    await waitHeroTurn(page);

    const chipsBefore = await bankrollText(page);
    // 真实筹码档：默认下资金应是纯整数文本
    expect(chipsBefore).toMatch(/^\d+$/);

    // 切到 BB 档
    await page.keyboard.press('b');
    await expect.poll(async () => bankrollText(page), { timeout: 5_000 }).not.toBe(chipsBefore);

    const bbText = await bankrollText(page);
    // 1000 筹码 / 10 大盲 = 100 BB
    expect(Number(bbText)).toBeCloseTo(Number(chipsBefore) / 10, 1);

    // 关键：切换已经触发过落库，此时存档里的金额必须仍是筹码原值
    const storedAfterToggle = await storedBankroll(page);
    expect(storedAfterToggle).toBe(Number(chipsBefore));

    // 再按一次切回来，文本应恢复原值，金额依旧不变
    await page.keyboard.press('b');
    await expect.poll(async () => bankrollText(page), { timeout: 5_000 }).toBe(chipsBefore);
    expect(await storedBankroll(page)).toBe(storedAfterToggle);
  });

  test('设置面板的下拉也能切换单位，且刷新后保持', async ({ page }) => {
    await enterTable(page);
    await waitHeroTurn(page);

    await page.getByRole('tab', { name: '设置' }).click();
    const select = page.getByTestId('chip-unit-select');
    await expect(select).toHaveValue('chips');
    await select.selectOption('bb');
    await expect(select).toHaveValue('bb');

    // 刷新后仍是 BB 档（落库字段生效，读时缺省回退）
    await page.reload();
    await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
    await page.getByRole('tab', { name: '设置' }).click();
    await expect(page.getByTestId('chip-unit-select')).toHaveValue('bb');
  });

  test('下注输入框：输入筹码数 → 回车后加注额生效', async ({ page }) => {
    await enterTable(page);
    await waitHeroTurn(page);

    const input = page.getByTestId('raise-input');
    await expect(input).toBeVisible();

    // 先拿到合法区间，选一个中点作为目标
    const range = page.locator('.raise-box input[type="range"]');
    const min = Number(await range.getAttribute('min'));
    const max = Number(await range.getAttribute('max'));
    expect(max).toBeGreaterThan(min);
    const target = Math.round((min + max) / 2);

    await input.fill(String(target));
    await input.press('Enter');

    // 回车后草稿提交，输入框与滑杆显示同一个数字（步长为 1 时必须精确相等）
    await expect(input).toHaveValue(String(target));
    await expect(range).toHaveValue(String(target));

    // 「加注（Raise）」按钮文案里带着同一个数字
    await expect(page.locator('.raise-box button.primary')).toContainText(String(target));
  });

  test('下注输入框：非法输入不写 NaN，越界被夹到上限', async ({ page }) => {
    await enterTable(page);
    await waitHeroTurn(page);

    const input = page.getByTestId('raise-input');
    const before = await input.inputValue();

    await input.fill('abc');
    await input.press('Enter');
    // 无法解析 → 回退到原值，而不是 0 / NaN
    await expect(input).toHaveValue(before);
    await expect(page.locator('.raise-box button.primary')).not.toContainText('NaN');

    // 越界输入被夹到上限
    const range = page.locator('.raise-box input[type="range"]');
    const max = Number(await range.getAttribute('max'));
    await input.fill('999999999');
    await input.press('Enter');
    await expect(input).toHaveValue(String(max));
  });

  test('输入框在 BB 档按大盲倍数解析，显式单位后缀优先', async ({ page }) => {
    await enterTable(page);
    await waitHeroTurn(page);

    // 切到 BB 档
    await page.keyboard.press('b');
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => JSON.parse(localStorage.getItem('poker-trainer:state') ?? '{}').chipUnit,
          ),
        { timeout: 5_000 },
      )
      .toBe('bb');

    const input = page.getByTestId('raise-input');
    const range = page.locator('.raise-box input[type="range"]');
    const min = Number(await range.getAttribute('min'));
    const max = Number(await range.getAttribute('max'));

    // 从合法区间里挑一个「大盲整数倍」的目标，避免依赖具体盲注结构。
    // 翻前最小加注通常是 3BB，所以不能硬编码 2BB（会低于下限被夹掉）。
    const bigBlind = await page.evaluate(
      () => JSON.parse(localStorage.getItem('poker-trainer:state') ?? '{}').settings.bigBlind,
    );
    const bbTarget = Math.ceil(min / bigBlind);
    const chips = bbTarget * bigBlind;
    expect(chips).toBeGreaterThanOrEqual(min);
    expect(chips).toBeLessThanOrEqual(max);

    // BB 档下打纯数字 → 按大盲倍数换算
    await input.fill(String(bbTarget));
    await input.press('Enter');
    await expect(range).toHaveValue(String(chips));

    // 显式 `bb` 后缀：与当前档位无关，始终按大盲换算
    await input.fill(`${bbTarget}bb`);
    await input.press('Enter');
    await expect(range).toHaveValue(String(chips));

    // 显式筹码后缀：当前虽是 BB 档，`Nc` 仍按真实筹码解析
    await input.fill(`${chips}c`);
    await input.press('Enter');
    await expect(range).toHaveValue(String(chips));
  });

  test('滑杆能精确表示任意整数加注额（不会吸附到别的值）', async ({ page }) => {
    await enterTable(page);
    await waitHeroTurn(page);

    const range = page.locator('.raise-box input[type="range"]');
    const min = Number(await range.getAttribute('min'));
    const max = Number(await range.getAttribute('max'));
    // 步长必须是 1：否则「输入框 515 / 滑杆 520」这类分叉会重现
    await expect(range).toHaveAttribute('step', '1');

    const input = page.getByTestId('raise-input');

    // 两端可达
    await input.fill('0');
    await input.press('Enter');
    await expect(range).toHaveValue(String(min));

    await input.fill(String(max));
    await input.press('Enter');
    await expect(range).toHaveValue(String(max));

    // 中间的非大盲整数倍也必须原样保留
    const odd = min + Math.floor((max - min) / 2);
    await input.fill(String(odd));
    await input.press('Enter');
    await expect(range).toHaveValue(String(odd));
  });
});
