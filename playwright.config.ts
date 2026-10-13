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
  timeout: 90_000,
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
