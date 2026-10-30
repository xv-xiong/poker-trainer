#!/usr/bin/env node
/**
 * dev 模式冒烟：起一个真实的 vite dev server，用 Playwright 连打 3 手，
 * 验证「点下一手」不会把页面打白屏。
 *
 * 为什么需要它：白屏 bug 只在 dev 模式出现——生产构建会把
 * `process.env.NODE_ENV === 'production'` 的不变量断言整块摇掉，
 * 所以 vite preview + Playwright E2E（G8）永远看不到它。
 * 这个脚本跑的是 `vite`（development），专门盯这类「仅 dev 可见」的崩溃。
 *
 * 判定口径（每一手都断言）：
 *   1. 无 pageerror（未捕获异常 / React 卸载整树）；
 *   2. document.body.innerText 非空（白屏的直接特征就是空 body）；
 *   3. 控制台没有含 `[showcase]` 的错误。
 *
 * 退出码：0 = 3 手全过；1 = 任一断言失败或服务/浏览器起不来。
 *
 * 用法：node scripts/dev-smoke.mjs
 * 环境变量：DEV_SMOKE_PORT（默认 5181）、DEV_SMOKE_HANDS（默认 3）、DEV_SMOKE_HEADFUL=1。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEV_SMOKE_PORT ?? 5181);
// vite.config.ts 里 base 是 '/poker-trainer/'，dev server 同样按这个子路径提供页面。
const BASE_PATH = '/poker-trainer/';
const PAGE_URL = `http://127.0.0.1:${PORT}${BASE_PATH}?skip-lobby=1`;
const HANDS = Math.max(1, Number(process.env.DEV_SMOKE_HANDS ?? 3));
const HANDS_TIMEOUT_MS = 150_000;
const SERVER_TIMEOUT_MS = 90_000;
const isWindows = process.platform === 'win32';

/** 失败明细：按手记录，最后统一打印，避免一处失败就看不到其他信息。 */
const failures = [];
let currentHand = 0;

function log(msg) {
  console.log(`[dev-smoke] ${msg}`);
}
function recordFailure(kind, text) {
  failures.push({ hand: currentHand, kind, text });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 起 vite dev server；返回 child 与就绪 Promise。 */
function startDevServer() {
  const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) {
    throw new Error(`找不到 vite 入口：${viteBin}（是否忘了 npm install？）`);
  }
  const child = spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );
  let stderrTail = '';
  child.stdout.on('data', (buf) => {
    const text = String(buf);
    if (process.env.DEV_SMOKE_VERBOSE) process.stdout.write(text);
  });
  child.stderr.on('data', (buf) => {
    const text = String(buf);
    stderrTail = (stderrTail + text).slice(-4000);
    if (process.env.DEV_SMOKE_VERBOSE) process.stderr.write(text);
  });
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  return {
    child,
    getStderr: () => stderrTail,
    getExit: () => exited,
  };
}

/** 轮询 dev server 是否可访问（vite 首次冷启动要预构建依赖，可能十几秒）。 */
async function waitForServer(server) {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exit = server.getExit();
    if (exit) {
      throw new Error(`vite dev server 提前退出（code=${exit.code}，signal=${exit.signal}）`);
    }
    try {
      const res = await fetch(PAGE_URL, { redirect: 'follow' });
      if (res.ok) return;
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(300);
  }
  throw new Error(`vite dev server 在 ${SERVER_TIMEOUT_MS}ms 内未就绪：${PAGE_URL}`);
}

function killServer(server) {
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
  }
}

async function bodyText(page) {
  // 页面可能正好处于卸载 / 导航中（白屏场景常见），返回值未必是字符串；统一收敛成 ''。
  const text = await page.evaluate(() =>
    (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
  );
  return typeof text === 'string' ? text : '';
}

async function bodyLength(page) {
  return (await bodyText(page)).length;
}

async function resultVisible(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('h2')).some((h) => (h.textContent ?? '').includes('本手结果')),
  );
}

/**
 * 轮询点击「跟注 / 过牌」按钮，直到本手结束（结算面板出现）。
 *
 * 为什么要留「弃牌」兜底：玩家筹码短于需跟注额时，合法动作只剩「弃牌 / 全下」，
 * 界面上根本没有跟注或过牌按钮。这不是缺陷而是正常牌局（例如盲注战里跟一手大注
 * 后只剩几十筹码，对面再推全下）。早先只认跟注/过牌，遇到这种牌就空转到超时，
 * 把「冒烟脚本找不到按钮」误报成「页面卡死」——G11 的价值是抓真白屏，
 * 不能因为一手合法的短码牌而失败，所以这里退一步弃牌，让 AI 把这一手打完。
 */
async function playOneHand(page, index) {
  const deadline = Date.now() + HANDS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 一旦出现未捕获异常，立刻中止——继续等只会等到超时，掩盖真正的报错。
    if (failures.some((f) => f.hand === index && f.kind === 'pageerror')) {
      throw new Error(`第 ${index} 手出现未捕获异常，页面已不可用`);
    }
    if (await resultVisible(page)) return;
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).filter((b) => !b.disabled);
      // 优先跟注/过牌（能继续参与这一手，最接近真实练习的路径）。
      const passive = buttons.find((b) => /跟注|过牌/.test(b.textContent ?? ''));
      if (passive) {
        passive.click();
        return true;
      }
      // 兜底：只剩弃牌/全下时主动弃牌。弃牌不需要二次确认（全下需要），
      // 且同样会让 AI 继续把这一手打完，满足「白屏只会发生在换手时」的观测目标。
      const fold = buttons.find((b) => /弃牌/.test(b.textContent ?? ''));
      if (fold) {
        fold.click();
        return true;
      }
      return false;
    });
    await sleep(clicked ? 160 : 120);
  }
  throw new Error(`第 ${index} 手在 ${HANDS_TIMEOUT_MS}ms 内未打完（结算面板未出现）`);
}

/** 点「下一手」，等结算面板消失（新手开始）。白屏 bug 就在这一步触发。 */
async function clickNextHand(page) {
  const btn = page.getByRole('button', { name: '下一手', exact: true });
  await btn.waitFor({ state: 'visible', timeout: 20_000 });
  await btn.click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('h2')).some((h) => (h.textContent ?? '').includes('本手结果')),
    undefined,
    { timeout: 20_000 },
  );
  // 等一帧以上，让 React 的 effect（含 dev 不变量断言）全部跑完再判定。
  await sleep(400);
}

function printFailureReport(pageText) {
  console.error('\n[dev-smoke] ✗ 冒烟失败');
  for (const f of failures) {
    console.error(`  - 第 ${f.hand} 手 / ${f.kind}: ${f.text}`);
  }
  if (typeof pageText === 'string') {
    console.error(`  - 失败时 body 文本长度：${pageText.length}`);
    if (pageText.length > 0) console.error(`  - body 片段：${pageText.slice(0, 200)}`);
  }
}

async function main() {
  log(`vite dev server 启动中：http://127.0.0.1:${PORT}${BASE_PATH}`);
  const server = startDevServer();
  let browser = null;
  let page = null;
  try {
    await waitForServer(server);
    log('dev server 就绪，启动 Chromium');

    browser = await chromium.launch({ headless: process.env.DEV_SMOKE_HEADFUL !== '1' });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    page = await context.newPage();
    page.on('pageerror', (err) => recordFailure('pageerror', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('[showcase]')) {
        recordFailure('console.error', msg.text());
      }
    });

    log(`打开页面：${PAGE_URL}`);
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('[data-testid="felt"]', { timeout: 60_000 });
    log('牌桌已渲染');

    let lastBodyLen = 0;
    for (let i = 1; i <= HANDS; i++) {
      currentHand = i;
      const handFailuresBefore = failures.length;
      await playOneHand(page, i);
      // 结算面板出现后再等一拍，确保 dev 断言 effect 已执行。
      await sleep(250);
      lastBodyLen = await bodyLength(page);
      const handFailures = failures.slice(handFailuresBefore);
      if (handFailures.length > 0) {
        throw new Error(`第 ${i} 手结束时报错：${handFailures.map((f) => f.text).join(' | ')}`);
      }
      if (lastBodyLen === 0) {
        throw new Error(`第 ${i} 手结束后 body 为空（白屏）`);
      }
      log(`第 ${i}/${HANDS} 手通过（结算面板已出现，body 文本长度 ${lastBodyLen}）`);
      if (i < HANDS) {
        await clickNextHand(page);
        const afterNextLen = await bodyLength(page);
        if (afterNextLen === 0) {
          throw new Error(`第 ${i} 手点「下一手」后 body 为空（白屏）`);
        }
        log(`第 ${i} → ${i + 1} 手切换正常（body 文本长度 ${afterNextLen}）`);
      }
    }

    const bad = failures.filter((f) => f.kind === 'pageerror' || f.kind === 'console.error');
    if (bad.length > 0) {
      throw new Error(`存在 ${bad.length} 条错误日志`);
    }
    log(`✓ ${HANDS} 手全部通过：无 pageerror、无 [showcase] 错误、body 非空`);
  } catch (err) {
    let text = null;
    try {
      // 失败时尽量抓一份 body 文本，便于判断是不是白屏。
      if (page) text = await bodyText(page);
    } catch {
      text = null;
    }
    printFailureReport(text);
    console.error(`[dev-smoke] 原因：${err instanceof Error ? err.message : String(err)}`);
    const stderr = server.getStderr();
    if (stderr) console.error(`[dev-smoke] vite stderr 末尾：\n${stderr}`);
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* 忽略 */
      }
    }
    killServer(server);
    // 给 taskkill 一点时间落地，避免脚本退出后残留 dev server 占用端口。
    await sleep(300);
  }
}

await main();
