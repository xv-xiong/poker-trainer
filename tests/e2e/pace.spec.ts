/**
 * 阶段二 P1-1 验收：节奏档位（拟真 / 快速 / 瞬时）与长按 S 跳过等待。
 *
 * ── 为什么要用浏览器测 ───────────────────────────────────────
 * 单测（tests/unit/think-timing.test.ts）只验证「抽样函数 + 三档区间」以及
 * 「档位不改变动作序列」。但档位要真正生效，还得穿过整条链路：
 *   首屏/设置面板 → controller.setPace → persisted.pace → snapshot.pace
 *   → useTableShowcase 的 aiThinkDelay → stableStep.delayMs → App 的 setTimeout
 * 任何一环漏接（例如 useMemo 依赖没加 snap.pace），单测都会全绿而用户切换档位
 * 毫无反应。所以这里测墙钟。
 *
 * ── 测量方法 ─────────────────────────────────────────────────
 * MutationObserver 观察 `.seat[data-thinking="1"]` 与
 * `[data-testid="action-bubble"]`，「某座位开始思考 → 它出现新动作气泡」的
 * 墙钟差即该步等待时长。
 *
 * 观测器必须挂在 `document.body` 而不是 `[data-testid="felt"]` 上：
 * 切到「设置」等其它 tab 时牌桌 DOM 会被卸载，挂在 felt 上的观测器会静默失效
 * （表现为「切完档位回来一个样本都收不到」）。
 */

import { test, expect, type Page } from '@playwright/test';
import { AI_THINK_RANGES } from '../../src/ui/thinkTiming.js';

/** 真实等待 ≤ 区间上限，再给渲染提交与定时器抖动留 500ms 容差。 */
const SLACK_MS = 500;
const FAST_UPPER_MS = AI_THINK_RANGES.fast.maxMs + SLACK_MS;
const REALISTIC_LOWER_MS = 1000;

/** 长按 S 时的上限：等待被压到 0，只剩渲染与状态推进的开销。 */
const SKIP_UPPER_MS = 300;

interface ThinkSample {
  seat: number;
  ms: number;
}

/** 从首屏进入牌桌；`pace` 为 undefined 时保持当前存档档位。 */
async function enterViaLobby(
  page: Page,
  pace?: 'realistic' | 'fast' | 'instant',
): Promise<void> {
  await page.goto('/poker-trainer/');
  const start = page.locator('button.lobby-start');
  await start.waitFor({ state: 'visible', timeout: 30_000 });
  if (pace) {
    const btn = page.locator(`[data-testid="pace-${pace}"]`);
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
  }
  await start.click();
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
}

/** 装「思考时长」记录器（挂 body，可跨 tab 存活）。 */
async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const startBySeat = new Map<number, number>();
    const lastAnim = new Map<number, string | null>();
    const samples: ThinkSample[] = [];
    let prevThinking = new Set<number>();

    const snapshot = (): void => {
      const t = performance.now();
      document.querySelectorAll('[data-testid="action-bubble"]').forEach((el) => {
        const seat = Number(el.getAttribute('data-seat'));
        if (!Number.isFinite(seat)) return;
        const anim = el.getAttribute('data-anim');
        if (lastAnim.get(seat) === anim) return;
        lastAnim.set(seat, anim);
        const started = startBySeat.get(seat);
        if (started === undefined) return;
        startBySeat.delete(seat);
        samples.push({ seat, ms: Math.round(t - started) });
      });
      const thinking = new Set<number>();
      document.querySelectorAll('.seat[data-thinking="1"]').forEach((el) => {
        const s = Number(el.getAttribute('data-seat'));
        if (Number.isFinite(s)) thinking.add(s);
      });
      for (const s of thinking) if (!prevThinking.has(s)) startBySeat.set(s, t);
      for (const s of prevThinking) if (!thinking.has(s)) startBySeat.delete(s);
      prevThinking = thinking;
    };

    const mo = new MutationObserver(snapshot);
    mo.observe(document.body, {
      attributes: true,
      subtree: true,
      childList: true,
      attributeFilter: ['data-thinking', 'data-anim', 'data-seat'],
    });
    snapshot();
    w.__think = { samples, stop: () => mo.disconnect() };
  });
}

async function readSamples(page: Page): Promise<ThinkSample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __think?: { samples: ThinkSample[]; stop: () => void } };
    if (!w.__think) return [];
    w.__think.stop();
    return w.__think.samples;
  });
}

/** 轮到玩家就点「过牌 / 跟注」，直到出现「本手结果」。 */
async function playOneHand(page: Page, timeoutMs = 180_000): Promise<number> {
  const began = Date.now();
  const deadline = began + timeoutMs;
  while (Date.now() < deadline) {
    const finished = await page
      .locator('h2', { hasText: '本手结果' })
      .first()
      .isVisible()
      .catch(() => false);
    if (finished) return Date.now() - began;

    const myTurn = page.locator('[data-testid="action-my-turn"]');
    if (await myTurn.isVisible().catch(() => false)) {
      const btn = myTurn
        .locator('button')
        .filter({ hasText: /过牌|跟注|Check|Call/i })
        .first();
      if ((await btn.count()) > 0 && (await btn.isEnabled().catch(() => false))) {
        await btn.click({ timeout: 5_000 }).catch(() => {});
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`playOneHand 超时：${timeoutMs}ms 内未出现「本手结果」`);
}

/**
 * 点「下一手」开新手。
 *
 * 必须限定 `:visible`：结算态下 DOM 里同时存在两个「下一手」按钮
 * （操作条里一个、结算面板里一个），`.first()` 会命中不可见的那个，
 * Playwright 随后一直等它可见直到超时。
 */
async function nextHand(page: Page): Promise<void> {
  await page.locator('button:visible', { hasText: '下一手' }).first().click();
  await page.waitForSelector('[data-testid="felt"]', { timeout: 20_000 });
}

test.describe('阶段二 节奏档位', () => {
  test('首屏默认拟真，三档按钮互斥可切换', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/poker-trainer/');
    const realistic = page.locator('[data-testid="pace-realistic"]');
    await realistic.waitFor({ state: 'visible', timeout: 30_000 });

    // 默认档必须是拟真（用户拍板的选项 C：默认不改成「快速」）
    await expect(realistic).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="pace-fast"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await page.locator('[data-testid="pace-instant"]').click();
    await expect(page.locator('[data-testid="pace-instant"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(realistic).toHaveAttribute('aria-pressed', 'false');
  });

  test('快速档：每步等待都短于拟真下限，且确实比拟真快', async ({ page }) => {
    test.setTimeout(240_000);
    await enterViaLobby(page, 'fast');
    await installRecorder(page);
    await playOneHand(page);

    const samples = await readSamples(page);
    // eslint-disable-next-line no-console
    console.log(
      `[pace=fast] ${samples.length} 次决策：` +
        samples.map((s) => `${s.seat}号位 ${s.ms}ms`).join(', '),
    );
    expect(samples.length, '样本数太少，无法验证快速档').toBeGreaterThanOrEqual(5);

    // ① 上限：没有任何一步超出「快速档上限 + 容差」
    const tooSlow = samples.filter((s) => s.ms > FAST_UPPER_MS);
    expect(tooSlow, `快速档出现 > ${FAST_UPPER_MS}ms 的等待：${JSON.stringify(tooSlow)}`).toEqual(
      [],
    );

    // ② 关键判据：至少一步快于拟真档的下限——否则说明档位根本没生效
    //    （仍然是拟真节奏，只是碰巧没超过上限）
    const fasterThanRealistic = samples.filter((s) => s.ms < REALISTIC_LOWER_MS);
    expect(
      fasterThanRealistic.length,
      `没有任何一步快于 ${REALISTIC_LOWER_MS}ms，档位可能未生效`,
    ).toBeGreaterThan(0);
  });

  test('瞬时档：一手牌在 15 秒内打完（拟真档通常要 20–30 秒）', async ({ page }) => {
    test.setTimeout(180_000);
    await enterViaLobby(page, 'instant');
    const elapsed = await playOneHand(page);
    // eslint-disable-next-line no-console
    console.log(`[pace=instant] 单手墙钟 ${elapsed}ms`);
    expect(elapsed, `瞬时档单手仍耗时 ${elapsed}ms，说明等待没有被压掉`).toBeLessThan(15_000);
  });

  test('设置面板可切档，且不带「下一手生效」标签（立即生效）', async ({ page }) => {
    test.setTimeout(300_000);
    await enterViaLobby(page, 'realistic');

    // 进设置面板：档位行的「立即生效」语义靠两点验证——
    //   ① 该行没有「下一手生效」标记（同面板其它行有，形成对照）
    //   ② 切档后回到牌桌，后续决策确实快于拟真下限
    await page.locator('#tab-settings').click();
    const select = page.locator('[data-testid="pace-select"]');
    await select.waitFor({ state: 'visible', timeout: 15_000 });

    const paceRow = page.locator('.settings-row', {
      has: page.locator('[data-testid="pace-select"]'),
    });
    await expect(paceRow).toBeVisible();
    await expect(
      paceRow.locator('.tag.next-hand'),
      '档位是立即生效项，不应挂「下一手生效」标签',
    ).toHaveCount(0);

    await select.selectOption('fast');
    await page.locator('#tab-table').click();
    await page.waitForSelector('[data-testid="felt"]', { timeout: 15_000 });

    // 切档时那一手可能还在进行中：先把它打完（不计量），再从下一手开始量，
    // 这样样本覆盖完整一手，且完全落在「快速档」下。
    await playOneHand(page);
    await nextHand(page);

    await installRecorder(page);
    await playOneHand(page);
    const samples = await readSamples(page);
    // eslint-disable-next-line no-console
    console.log(
      `[pace via settings] ${samples.length} 次决策：` +
        samples.map((s) => `${s.seat} ${s.ms}ms`).join(', '),
    );
    expect(samples.length, '样本数太少').toBeGreaterThanOrEqual(5);

    const tooSlow = samples.filter((s) => s.ms > FAST_UPPER_MS);
    expect(tooSlow, `设置面板切到快速档后仍有慢步骤：${JSON.stringify(tooSlow)}`).toEqual([]);
    const fast = samples.filter((s) => s.ms < REALISTIC_LOWER_MS);
    expect(fast.length, `切档后没有任何一步 < ${REALISTIC_LOWER_MS}ms`).toBeGreaterThan(0);
  });

  test('长按 S 跳过等待，松开后恢复正常节奏', async ({ page }) => {
    test.setTimeout(300_000);
    await enterViaLobby(page, 'realistic');
    await installRecorder(page);

    // 按住 S：此后每一步都用 0 延迟排期
    await page.keyboard.down('s');
    const fastElapsed = await playOneHand(page);
    const heldSamples = await readSamples(page);
    await page.keyboard.up('s');

    // eslint-disable-next-line no-console
    console.log(
      `[hold-S] 单手 ${fastElapsed}ms，${heldSamples.length} 次决策：` +
        heldSamples.map((s) => `${s.seat} ${s.ms}ms`).join(', '),
    );
    expect(heldSamples.length, '按住 S 时样本数太少').toBeGreaterThanOrEqual(3);
    const notSkipped = heldSamples.filter((s) => s.ms > SKIP_UPPER_MS);
    expect(
      notSkipped,
      `按住 S 仍有 ${notSkipped.length} 步等待超过 ${SKIP_UPPER_MS}ms：${JSON.stringify(notSkipped)}`,
    ).toEqual([]);

    // 松开后开下一手：必须回到拟真节奏（≥ 1 秒），否则说明 skipWaitRef 卡住了
    await nextHand(page);
    await installRecorder(page);
    await playOneHand(page);
    const resumed = await readSamples(page);
    // eslint-disable-next-line no-console
    console.log(
      `[after-release] ${resumed.length} 次决策：` +
        resumed.map((s) => `${s.seat} ${s.ms}ms`).join(', '),
    );
    expect(resumed.length, '松开后样本数太少').toBeGreaterThanOrEqual(3);
    const slow = resumed.filter((s) => s.ms >= REALISTIC_LOWER_MS);
    expect(
      slow.length,
      `松开 S 后没有任何一步 ≥ ${REALISTIC_LOWER_MS}ms，跳过等待没有被解除`,
    ).toBeGreaterThan(0);
  });
});
