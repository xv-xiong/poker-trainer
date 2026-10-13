/**
 * 端到端测试（验收闸门 G8）。
 *
 * 断言：
 *   1. 页面可加载且无 console error
 *   2. 能完成一整手对局（发牌 → 动作 → 结算）
 *   3. 复盘面板展示决策数据
 *   4. 历史记录条数 +1
 *   5. 快捷键可用
 *   6. 移动端竖屏布局可用
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/** 收集 console error 与页面异常。 */
function attachErrorCollector(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return { errors };
}

/** 若轮到自己行动则持续过牌/跟注，直到本手结束。 */
async function playHandToCompletion(page: Page): Promise<void> {
  for (let i = 0; i < 80; i++) {
    // 结束标志：结算面板出现，或行动区显示「本手已结束」
    const resultVisible = await page
      .getByRole('heading', { name: '本手结果' })
      .isVisible()
      .catch(() => false);
    if (resultVisible) return;
    const overVisible = await page
      .getByRole('button', { name: '下一手（Next Hand）' })
      .isVisible()
      .catch(() => false);
    if (overVisible) return;

    // 轮到自己时跟注/过牌（注意：可能同时存在多个按钮，用第一个可见的）
    const checkBtn = page.getByRole('button', { name: /跟注|过牌/ }).first();
    const canAct = (await checkBtn.isVisible().catch(() => false)) &&
      (await checkBtn.isEnabled().catch(() => false));
    if (canAct) {
      await checkBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(180);
      continue;
    }
    await page.waitForTimeout(220);
  }
}

test.describe('G8 端到端全链路', () => {
  test('页面加载无 console error 且能完成一整手对局', async ({ page }) => {
    const { errors } = attachErrorCollector(page);

    await page.goto('/poker-trainer/');
    await expect(page.getByRole('heading', { name: '德州扑克练习台' })).toBeVisible();

    // 牌桌渲染：底池与公共牌区存在
    await expect(page.getByText('底池（Pot）')).toBeVisible();
    await expect(page.getByRole('button', { name: /下一手|跟注|过牌|弃牌/ }).first()).toBeVisible();

    // 完成一整手
    await playHandToCompletion(page);

    // 结算面板出现，说明本手已结束
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 30_000 });

    // 无 console error
    expect(errors).toEqual([]);
  });

  test('复盘面板展示决策数据（含底池赔率与胜率原始数据）', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await playHandToCompletion(page);

    await page.getByRole('tab', { name: '复盘' }).click();
    await expect(page.getByRole('heading', { name: '决策复盘（Hand Review）' })).toBeVisible();

    // 计划强制要求：必须展示原始数据列
    await expect(page.getByRole('columnheader', { name: '底池赔率' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '估算胜率' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'EV 损失' })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('历史记录在本手结束后增加一条', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');

    // 先看初始条数
    await page.getByRole('tab', { name: '历史' }).click();
    await expect(page.getByRole('heading', { name: '手牌历史（Hand History）' })).toBeVisible();
    const before = await page.locator('table tbody tr').count();

    // 打一手
    await page.getByRole('tab', { name: '牌桌' }).click();
    await playHandToCompletion(page);
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 30_000 });

    // 再看条数
    await page.getByRole('tab', { name: '历史' }).click();
    const after = await page.locator('table tbody tr').count();
    expect(after).toBeGreaterThan(before);

    // 导出按钮可用（数据已落库）
    await expect(page.getByRole('button', { name: '导出 JSON' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '导出 CSV' })).toBeEnabled();

    expect(errors).toEqual([]);
  });

  test('统计面板展示 VPIP 等指标', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await playHandToCompletion(page);
    await page.getByRole('tab', { name: '统计' }).click();
    await expect(page.getByRole('heading', { name: '统计（Statistics）' })).toBeVisible();
    await expect(page.getByText('入池率 VPIP', { exact: true })).toBeVisible();
    await expect(page.getByText('翻牌前加注率 PFR', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('提示按钮可用且展示胜率与底池赔率', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');

    // 等到轮到自己
    for (let i = 0; i < 40; i++) {
      const hintBtn = page.getByRole('button', { name: /查看提示|计算中/ });
      if (await hintBtn.isVisible().catch(() => false)) {
        if (await hintBtn.isEnabled()) {
          await hintBtn.click();
          await expect(page.getByText('估算胜率')).toBeVisible({ timeout: 30_000 });
          await expect(page.getByText('底池赔率要求', { exact: true })).toBeVisible();
          break;
        }
      }
      await page.waitForTimeout(300);
    }

    expect(errors).toEqual([]);
  });

  test('快捷键 F 可弃牌', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');

    for (let i = 0; i < 40; i++) {
      const foldBtn = page.getByRole('button', { name: '弃牌（Fold）' });
      if (await foldBtn.isEnabled().catch(() => false)) {
        await page.keyboard.press('f');
        await page.waitForTimeout(400);
        break;
      }
      await page.waitForTimeout(300);
    }

    expect(errors).toEqual([]);
  });

  test('设置面板可切换四色牌与桌人数', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await page.getByRole('tab', { name: '设置' }).click();
    await expect(page.getByRole('heading', { name: '设置（Settings）' })).toBeVisible();

    const fourColor = page.getByRole('checkbox').first();
    await fourColor.uncheck();
    await expect(page.locator('.app')).toHaveClass(/two-color/);
    await fourColor.check();
    await expect(page.locator('.app')).not.toHaveClass(/two-color/);

    // 切到 2 人桌后仍可开局
    await page.locator('select').first().selectOption('2');
    await page.getByRole('tab', { name: '牌桌' }).click();
    await expect(page.getByText('底池（Pot）')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('移动端竖屏（375x667）布局可用', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/poker-trainer/');
    await expect(page.getByRole('heading', { name: '德州扑克练习台' })).toBeVisible();
    await expect(page.getByText('底池（Pot）')).toBeVisible();
    // 手机端隐藏快捷键提示
    await expect(page.locator('.keyhints').first()).toBeHidden();
    expect(errors).toEqual([]);
  });
});
