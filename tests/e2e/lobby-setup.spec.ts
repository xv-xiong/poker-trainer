/**
 * 阶段 2-1 的回归 E2E：开始界面（首屏）直接编辑建桌参数。
 *
 * 为什么必须用浏览器断言：这一批改动的核心不是「值算得对不对」（clamp 与
 * 账本重建由单测覆盖），而是**首屏控件是否真的接到了控制器**——受控值写错、
 * onChange 没接线、写进 localStorage 却没进控制器，都会让单测全绿而界面照旧。
 *
 * 三条不变量：
 *   1. 首屏改完点「开始练习」，牌桌用的是新参数（不是默认 6 人 / 1000 筹码）
 *   2. 改完的参数落进 localStorage，刷新后首屏控件仍显示新值
 *   3. 首屏的「继承上一手筹码」开关可用，进桌后确实进了继承模式（有 AI 账本条）
 */

import { expect, test, type Page } from '@playwright/test';

const STATE_KEY = 'poker-trainer:state';

/** 读当前存档（应用在动作发生后落库，首屏改参数也会落库）。 */
async function readState(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }, STATE_KEY);
}

test.describe('阶段 2-1：首屏编辑建桌参数', () => {
  test('首屏改建桌参数 → 进桌后牌桌用新参数', async ({ page }) => {
    await page.goto('/poker-trainer/');
    await expect(page.locator('[data-testid="lobby-setup"]')).toBeVisible();

    // 2 人桌 / 起始筹码 2000 / 盲注 10-20 / 困难
    await page.getByTestId('lobby-seat-count').selectOption('2');
    await page.getByTestId('lobby-ai-tier').selectOption('hard');
    await page.getByTestId('lobby-starting-stack').fill('2000');
    await page.getByTestId('lobby-small-blind').fill('10');
    await page.getByTestId('lobby-big-blind').fill('20');

    // 左栏脚注跟着桌人数走（证明改动已进控制器，不是只改了输入框显示）
    await expect(page.locator('.lobby-foot')).toContainText('2 人桌');
    // 起始筹码下方的 BB 换算跟着走：2000 / 20 = 100BB
    await expect(page.locator('.lobby-field-hint').first()).toContainText('100BB');

    // 落库的参数就是新值（不是默认值）
    const saved = await readState(page);
    expect(saved).not.toBeNull();
    const settings = saved!.settings as Record<string, unknown>;
    expect(settings.seatCount).toBe(2);
    expect(settings.aiTier).toBe('hard');
    expect(settings.startingStack).toBe(2000);
    expect(settings.smallBlind).toBe(10);
    expect(settings.bigBlind).toBe(20);

    // 进桌：牌桌是 2 人桌，资金按 2000 起
    await page.locator('button.lobby-start').click();
    await expect(page.locator('[data-testid="felt"]')).toHaveAttribute('data-seat-count', '2');
    await expect(page.locator('.bankroll .amount')).toHaveText('2000');
  });

  test('刷新后首屏仍显示上次改的参数', async ({ page }) => {
    await page.goto('/poker-trainer/');
    await page.getByTestId('lobby-seat-count').selectOption('9');
    await page.getByTestId('lobby-starting-stack').fill('3000');
    await page.getByTestId('lobby-ai-tier').selectOption('easy');

    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('lobby-seat-count')).toHaveValue('9');
    await expect(page.getByTestId('lobby-starting-stack')).toHaveValue('3000');
    await expect(page.getByTestId('lobby-ai-tier')).toHaveValue('easy');
    // 左栏脚注也是读自存档的 9 人桌
    await expect(page.locator('.lobby-foot')).toContainText('9 人桌');
  });

  test('起始筹码非法输入被夹住：0 回落到默认值，50 夹到下限 100', async ({ page }) => {
    await page.goto('/poker-trainer/');
    const stack = page.getByTestId('lobby-starting-stack');

    // 清空 → Number('') === 0 → 回落到默认 1000（不是留在 0，0 筹码开不了局）
    await stack.fill('');
    await expect(stack).toHaveValue('1000');

    // 低于下限 → 夹到 100
    await stack.fill('50');
    await expect(stack).toHaveValue('100');

    const saved = await readState(page);
    const settings = saved!.settings as Record<string, unknown>;
    expect(settings.startingStack).toBe(100);
    // NaN 不能漏进存档（NaN 会让 validateSettings 判损坏 → 归档重建 → 丢战绩）
    expect(Number.isFinite(settings.startingStack as number)).toBe(true);
  });

  test('首屏的继承模式开关可用，进桌后确实在继承模式', async ({ page }) => {
    await page.goto('/poker-trainer/');
    const carry = page.getByTestId('lobby-carry-over');
    await expect(carry).not.toBeChecked();

    await carry.check();
    await expect(carry).toBeChecked();
    // 开启后提示文案换成「一局牌桌」口径
    await expect(page.locator('.lobby-mode-note')).toContainText('输光要选是否补码');

    const saved = await readState(page);
    expect(saved!.carryOverStacks).toBe(true);

    await page.locator('button.lobby-start').click();
    await expect(page.locator('[data-testid="felt"]')).toBeVisible();
    // 继承模式才有 AI 账本条（单局练习模式没有）
    await expect(page.locator('[data-testid="roster-strip"]')).toBeVisible();
  });
});
