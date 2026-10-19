/**
 * Playwright 配置。
 *
 * 关键点：
 * - 复用已缓存的 chromium-1234（与 @playwright/test 1.62.0 精确匹配），零下载
 * - 用 vite preview 起生产构建产物，验证真实产物而非 dev server
 * - 失败时保留 trace 与截图
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  /**
   * 单测超时预算。
   *
   * 为什么从 180s 提到 300s（评估报告 M5 自查中**复现并定位**的偶发失败根因）：
   * 最长的用例「页面加载无 console error 且能完成一整手对局」内部预算为
   *     enterTable 的 waitForSelector 30s
   *   + playHandToCompletion 的 deadline 120s
   *   + expect('本手结果') 30s
   *   = 180s
   * 而这里恰好写 180_000 —— **余量为 0**，与 v1.1.0 修掉的 G7 超时缺陷同类。
   * 机器繁忙时手牌未能在 120s 内结束：playHandToCompletion 到点返回，
   * 随后的 expect 再等 30s，累计触顶 → Playwright 关闭页面 →
   * 报 `page.waitForTimeout: Target page, context or browser has been closed`。
   * 该失败于 2026-10-19 实测复现（3 轮全量 E2E 的第 2 轮），即 handoff 中
   * 悬置的「偶发全量 E2E 失败」。提到 300s 后余量 120s。
   */
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173/poker-trainer/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
