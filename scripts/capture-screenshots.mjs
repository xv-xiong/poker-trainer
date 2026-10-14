/**
 * 重新截取 README 用的四张图（开始界面 / 牌桌 / 结算 / 复盘）。
 *
 * 默认截取线上地址，保证 README 展示的就是用户看到的样子。
 * 也可传本地地址，例如：
 *   node scripts/capture-screenshots.mjs http://127.0.0.1:4173/poker-trainer/ docs/screenshots
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] ?? 'https://xv-xiong.github.io/poker-trainer/';
const OUT = process.argv[3] ?? 'docs/screenshots';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

// 1) 开始界面
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/start.png` });
console.log('start.png 完成');

// 2) 牌桌（尽量抓到 AI 思考态）
await page.getByRole('button', { name: /开始练习/ }).click();
await page.waitForSelector('.felt', { timeout: 30_000 });
await page.waitForTimeout(2500);

for (let i = 0; i < 300; i++) {
  if ((await page.locator('.sc-think').count()) > 0) break;
  const btn = page.getByRole('button', { name: /跟注|过牌/ }).first();
  if ((await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false))) {
    await btn.click({ timeout: 4000 }).catch(() => {});
  }
  await page.waitForTimeout(80);
}
await page.screenshot({ path: `${OUT}/table.png` });
console.log('table.png 完成');

// 3) 打完一手 → 结算
for (let i = 0; i < 500; i++) {
  if (await page.getByRole('heading', { name: '本手结果' }).isVisible().catch(() => false)) break;
  const btn = page.getByRole('button', { name: /跟注|过牌/ }).first();
  if ((await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false))) {
    await btn.click({ timeout: 4000 }).catch(() => {});
  }
  await page.waitForTimeout(90);
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/settlement.png` });
console.log('settlement.png 完成');

// 4) 复盘
await page.getByRole('tab', { name: '复盘' }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/review.png` });
console.log('review.png 完成');

await browser.close();
