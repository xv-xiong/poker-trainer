/**
 * 线上部署验收（对真实 GitHub Pages 地址跑，非本地构建产物）。
 *
 * 为什么必须单独跑：本地 `vite preview` 与 GitHub Pages 的差异恰好是本项目
 * 最容易出问题的地方——项目站点位于 `/poker-trainer/` 子路径，若 `base` 配置
 * 缺失或 Worker 用绝对路径引用，本地全绿但线上资源 404。
 *
 * 运行方式：
 *   LIVE_URL=https://xv-xiong.github.io/poker-trainer/ npx playwright test tests/e2e/live.spec.ts
 * 或（Windows PowerShell）：
 *   $env:LIVE_URL="https://xv-xiong.github.io/poker-trainer/"; npx playwright test tests/e2e/live.spec.ts
 *
 * 未设置 LIVE_URL 时整组跳过，避免离线环境下误报失败。
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

const LIVE_URL = process.env.LIVE_URL;

/**
 * 从开始界面进入牌桌。
 *
 * 线上验收同样要覆盖新的开始界面入口：首访不再直接发牌，
 * 若少了这一步，线上用例会停在开始界面并全线失败。
 */
async function enterTable(page: Page): Promise<void> {
  const start = page.getByRole('button', { name: '开始练习' });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
  }
  await page.waitForSelector('[role="tab"]', { timeout: 30_000 });
}

test.describe('线上部署验收（GitHub Pages）', () => {
  test.skip(!LIVE_URL, '未设置 LIVE_URL，跳过线上验收');

  test('首页返回 200 且标题正确', async ({ page }) => {
    const resp = await page.goto(LIVE_URL!, { waitUntil: 'domcontentloaded' });
    expect(resp?.status()).toBe(200);
    // 首访是开始界面，标题在进桌后才出现
    await enterTable(page);
    await expect(page.getByRole('heading', { name: '德州扑克练习台' })).toBeVisible();
  });

  test('全部静态资源加载成功（子路径 base 配置正确）', async ({ page }) => {
    const failed: string[] = [];
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(LIVE_URL!, { waitUntil: 'networkidle' });
    await enterTable(page);
    await expect(page.locator('.felt')).toBeVisible();
    expect(failed).toEqual([]);
  });

  test('线上可完成一整手对局，且无 console error', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(LIVE_URL!, { waitUntil: 'domcontentloaded' });
    await enterTable(page);
    await expect(page.getByText('底池（Pot）')).toBeVisible();

    // 打到本手结束
    for (let i = 0; i < 80; i++) {
      if (await page.getByRole('heading', { name: '本手结果' }).isVisible().catch(() => false)) break;
      if (
        await page
          .getByRole('button', { name: '下一手（Next Hand）' })
          .isVisible()
          .catch(() => false)
      ) {
        break;
      }
      const btn = page.getByRole('button', { name: /跟注|过牌/ }).first();
      const can = (await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false));
      if (can) {
        await btn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(180);
      } else {
        await page.waitForTimeout(220);
      }
    }
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 30_000 });

    // 复盘面板可用
    await page.getByRole('tab', { name: '复盘' }).click();
    await expect(page.getByRole('heading', { name: '决策复盘（Hand Review）' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '底池赔率' })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('Web Worker 在线上真实加载（重计算不阻塞主线程）', async ({ page }) => {
    const workerUrls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('worker')) workerUrls.push(r.url());
    });
    await page.goto(LIVE_URL!, { waitUntil: 'domcontentloaded' });
    await enterTable(page);
    await expect(page.getByText('底池（Pot）')).toBeVisible();

    // 触发提示以真正实例化 Worker
    for (let i = 0; i < 40; i++) {
      const hint = page.getByRole('button', { name: /查看提示|计算中/ });
      if ((await hint.isVisible().catch(() => false)) && (await hint.isEnabled().catch(() => false))) {
        await hint.click();
        await expect(page.getByText('估算胜率')).toBeVisible({ timeout: 30_000 });
        break;
      }
      await page.waitForTimeout(250);
    }
    // 线上 Worker 脚本应被请求过（路径位于 /poker-trainer/assets/ 下）
    expect(workerUrls.length).toBeGreaterThan(0);
    expect(workerUrls.every((u) => u.includes('/poker-trainer/'))).toBe(true);
  });
});
