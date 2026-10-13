/**
 * 截取线上站点各标签页的截图（交付用证据）。
 *
 * 注意：本文件必须保存为 UTF-8。开发期曾用 PowerShell 的 Set-Content 写脚本，
 * 而系统 ANSI 代码页为 936（GBK），导致脚本中的中文字符串字面量被破坏，
 * 表现为 Playwright 找不到「复盘」标签（locator count = 0）——
 * 那是脚本编码问题，不是应用缺陷。因此本文件用 UTF-8 写入工具生成。
 *
 * 用法：node scripts/capture-live.mjs [url]
 */

import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'https://xv-xiong.github.io/poker-trainer/';
const OUT = process.argv[3] ?? '.';

const TABS = [
  ['复盘', 'live-review.png'],
  ['统计', 'live-stats.png'],
  ['历史', 'live-history.png'],
  ['设置', 'live-settings.png'],
];

/** 等页面完全就绪（networkidle + 标签出现），失败时重试。 */
async function readyPage(browser) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    try {
      await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
      await page.waitForSelector('[role="tab"]', { timeout: 30_000 });
      await page.waitForTimeout(1500);
      return page;
    } catch (e) {
      console.log(`  加载重试 ${attempt + 1}：${e.message.split('\n')[0]}`);
      await page.close();
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error('页面加载失败（重试 4 次后仍失败）');
}

/** 打完一手（一直跟注/过牌）。 */
async function playOneHand(page) {
  for (let i = 0; i < 80; i++) {
    if (await page.getByRole('heading', { name: '本手结果' }).isVisible().catch(() => false)) return true;
    const btn = page.getByRole('button', { name: /跟注|过牌/ }).first();
    const can = (await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false));
    if (can) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(180);
    } else {
      await page.waitForTimeout(240);
    }
  }
  return false;
}

const browser = await chromium.launch();
const page = await readyPage(browser);

console.log('牌桌截图…');
await page.screenshot({ path: `${OUT}/live-table.png` });

console.log('打一手以产生复盘与统计数据…');
const done = await playOneHand(page);
console.log('本手是否结束：', done);
await page.waitForTimeout(1000);

// 顺带确认持久化真的写入了 localStorage
const keys = await page.evaluate(() => Object.keys(localStorage));
console.log('localStorage 键：', JSON.stringify(keys));

for (const [name, file] of TABS) {
  await page.getByRole('tab', { name }).click({ timeout: 20_000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${file}` });
  console.log('已截图', file);
}

await browser.close();
console.log('完成');
