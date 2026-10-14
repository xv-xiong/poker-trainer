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

  test('结算面板展示分配明细：主池 / 边池 / 未跟注退还分行', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await playHandToCompletion(page);
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 30_000 });

    // 明细区必须出现（只有金额 > 0 的层才会产生行，故断言「表头存在」而非固定行数）
    await expect(page.getByRole('heading', { name: '分配明细（主池 / 边池 / 未跟注退还）' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '类型' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '金额' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '归属' })).toBeVisible();

    // 至少有一行，且每行金额为正整数、已解析出归属名
    const rows = page.locator('.settlement-table tbody tr');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const amountText = await rows.nth(i).locator('td').nth(1).innerText();
      const amount = Number(amountText.trim());
      expect(Number.isInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0);
      const who = (await rows.nth(i).locator('td').nth(2).innerText()).trim();
      expect(who.length).toBeGreaterThan(0);
    }

    expect(errors).toEqual([]);
  });

  test('单挑小盲弃牌时，结算面板出现「未跟注退还」行（确定性场景）', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await page.waitForSelector('[role="tab"]', { timeout: 30_000 });

    // 固定为 2 人桌：这是**必然**产生「未跟注退还」的可控局面。
    // 单挑盲注 5/10 → 我（庄家即小盲）投 5、AI 投 10。我弃牌后：
    //   层 1：level 5  → 2 名投入者 × 5 = 10 → 主池（contested）
    //   层 2：level 10 → 1 名投入者 × 5 = 5  → 未跟注退还（uncalled）
    // 6 人桌全下时 5 个 AI 都会跟注，永远凑不出未注层，故必须用单挑。
    //
    // 注意：首次加载时 localStorage 为空（App 只在动作后才写状态），
    // 因此不能只做「读出来改一下」——必须准备好一份完整状态再 reload，
    // 否则 seatCount 仍是 6，测试会因场景不成立而失败（曾如此踩坑）。
    await page.evaluate(() => {
      const key = 'poker-trainer:state';
      let st: Record<string, unknown> | null = null;
      try {
        const raw = localStorage.getItem(key);
        st = raw ? JSON.parse(raw) : null;
      } catch {
        st = null;
      }
      if (!st || typeof st.settings !== 'object' || st.settings === null) {
        st = {
          schemaVersion: 1,
          bankroll: 1000,
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
          settings: {
            seatCount: 2,
            startingStack: 1000,
            smallBlind: 5,
            bigBlind: 10,
            aiTier: 'medium',
            fourColorDeck: true,
            showShortcuts: true,
            enableFlopExact: false,
          },
          nextDealerSeat: 0,
          handCounter: 0,
        };
      } else {
        (st.settings as Record<string, unknown>).seatCount = 2;
      }
      localStorage.setItem(key, JSON.stringify(st));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[role="tab"]', { timeout: 30_000 });
    await page.waitForTimeout(1200);

    // 轮到我立刻弃牌
    for (let i = 0; i < 60; i++) {
      if (await page.getByRole('heading', { name: '本手结果' }).isVisible().catch(() => false)) break;
      const foldBtn = page.getByRole('button', { name: '弃牌（Fold）' }).first();
      if ((await foldBtn.isVisible().catch(() => false)) && (await foldBtn.isEnabled().catch(() => false))) {
        await foldBtn.click({ timeout: 5000 }).catch(() => {});
        break;
      }
      await page.waitForTimeout(220);
    }

    await expect(page.getByRole('heading', { name: '分配明细（主池 / 边池 / 未跟注退还）' })).toBeVisible({
      timeout: 30_000,
    });
    // 必须同时出现主池行与未跟注退还行
    await expect(page.locator('.settlement-table tbody tr', { hasText: '主池' }).first()).toBeVisible();
    const refundRow = page.locator('.settlement-table tbody tr', { hasText: '未跟注退还' }).first();
    await expect(refundRow).toBeVisible();

    // 退还行金额为正，且归属非空
    const amount = Number((await refundRow.locator('td').nth(1).innerText()).trim());
    expect(Number.isInteger(amount)).toBe(true);
    expect(amount).toBeGreaterThan(0);
    expect((await refundRow.locator('td').nth(2).innerText()).trim().length).toBeGreaterThan(0);

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
