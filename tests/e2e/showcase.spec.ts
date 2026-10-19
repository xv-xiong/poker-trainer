/**
 * 分步演出端到端验收（task-4）。
 *
 * 本文件的核心是**采样证据**：断言「分步」不能只看终局，必须证明画面上
 * 真的出现过中间态。做法是高频轮询页面（每 ~80ms 一次），把每次采样到的
 * 可观测特征记录下来，最后断言：
 *
 *   1. 至少出现过两个**不同**的中间态（思考态 → 动作气泡 / 状态文本）；
 *   2. 存在「思考中且该座位高亮」的采样点**先于**「出现动作气泡」的采样点；
 *   3. 公共牌是逐张出现的（flop 观察点依次为 1、2、3 张）。
 *
 * 这些断言在「一次性跑完」的旧实现下必然失败：旧实现里 AI 的动作在同一帧
 * 内全部落定，采样永远只看到终局。
 */

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/** 采样点：一次页面观测的全部可观测特征。 */
interface Sample {
  t: number;
  /** 是否有座位处于思考态。 */
  thinking: boolean;
  /** 思考中的座位号。 */
  thinkingSeat: number | null;
  /** 是否出现动作气泡。 */
  bubble: boolean;
  /** 气泡所在座位 / 动作类型。 */
  bubbleSeat: number | null;
  bubbleAction: string | null;
  /** 已亮相的公共牌张数。 */
  boardRevealed: number;
  /** 底池数值文本。 */
  pot: string;
  /** 行动区是否处于「等待中」。 */
  waiting: boolean;
  /** 动作按钮是否可用。 */
  canAct: boolean;
  /** 本街动作记录条数（从气泡累计不到，用底池 + 气泡粗判）。 */
  handOver: boolean;
}

function attachErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { errors };
}

/** 在页面上下文里一次性抓取所有可观测特征（避免多次 round-trip 造成的采样失真）。 */
async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const thinkingEl = document.querySelector('.seat[data-thinking="1"]');
    const bubbleEl = document.querySelector('[data-testid="action-bubble"]');
    const boardEl = document.querySelector('[data-testid="board"]');
    const potEl = document.querySelector('[data-testid="pot-value"]');
    const waitingEl = document.querySelector('[data-testid="action-waiting"]');
    const myTurnEl = document.querySelector('[data-testid="action-my-turn"]');
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      /跟注|过牌/.test(b.textContent ?? ''),
    );
    const seatAttr = thinkingEl?.getAttribute('data-seat');
    const bSeat = bubbleEl?.getAttribute('data-seat');
    return {
      t: Date.now(),
      thinking: Boolean(thinkingEl),
      thinkingSeat: seatAttr !== null && seatAttr !== undefined ? Number(seatAttr) : null,
      bubble: Boolean(bubbleEl),
      bubbleSeat: bSeat !== null && bSeat !== undefined ? Number(bSeat) : null,
      bubbleAction: bubbleEl?.getAttribute('data-action') ?? null,
      boardRevealed: Number(boardEl?.getAttribute('data-revealed') ?? 0),
      pot: (potEl?.textContent ?? '').trim(),
      waiting: Boolean(waitingEl),
      canAct: Boolean(myTurnEl) && Boolean(btn) && !(btn as HTMLButtonElement | undefined)?.disabled,
      handOver: Boolean(
        Array.from(document.querySelectorAll('h2')).find((h) => h.textContent?.includes('本手结果')),
      ),
    };
  });
}

/** 高频采样直到条件满足或超时；返回完整采样序列。 */
async function sampleUntil(
  page: Page,
  opts: { until: (s: Sample, all: Sample[]) => boolean; timeoutMs?: number; intervalMs?: number },
): Promise<Sample[]> {
  const all: Sample[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const interval = opts.intervalMs ?? 80;
  while (Date.now() < deadline) {
    const s = await sample(page);
    all.push(s);
    if (opts.until(s, all)) break;
    await page.waitForTimeout(interval);
  }
  return all;
}

/** 打印采样证据（供验收留痕）。 */
function dump(label: string, samples: Sample[]): void {
  console.log(`\n===== 采样证据：${label}（${samples.length} 个采样点，间隔 80ms）=====`);
  const t0 = samples[0]?.t ?? 0;
  for (const s of samples) {
    const marks: string[] = [];
    if (s.thinking) marks.push(`思考@${s.thinkingSeat}`);
    if (s.bubble) marks.push(`气泡[${s.bubbleSeat}:${s.bubbleAction}]`);
    if (s.waiting) marks.push('等待区');
    if (s.canAct) marks.push('可行动');
    if (s.handOver) marks.push('已结算');
    console.log(
      `  +${String(s.t - t0).padStart(5)}ms  board=${s.boardRevealed}  pot=${s.pot.padStart(5)}  ${marks.join(' ') || '（静止）'}`,
    );
  }
  const distinct = new Set(
    samples.map((s) => `${s.thinking}/${s.thinkingSeat}/${s.bubble}/${s.boardRevealed}/${s.canAct}`),
  );
  console.log(`  → 不同中间态数量：${distinct.size}`);
  console.log('===== 采样证据结束 =====\n');
}

/**
 * 进入牌桌。
 *
 * 用 `?skip-lobby=1` 直达牌桌：开始界面（task-5）与分步演出是两件事，
 * 本文件只验证演出，不应依赖开始界面按钮的文案与结构（那属于另一个任务，
 * 文案一改这里就会假失败）。`skip-lobby` 是 App 明确支持的入口。
 */
async function enterTable(page: Page): Promise<void> {
  await page.goto('/poker-trainer/?skip-lobby=1');
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
}

test.describe('task-4 分步演出', () => {
  test('AI 动作分步呈现：先出现思考态且该座位高亮，之后才出现动作气泡', async ({ page }) => {
    const { errors } = attachErrors(page);
    await enterTable(page);

    // 从「轮到 AI」开始采样，直到出现动作气泡（证明思考态在前）
    const samples = await sampleUntil(page, {
      until: (s, all) => all.some((x) => x.thinking) && s.bubble,
      timeoutMs: 40_000,
      intervalMs: 80,
    });
    dump('AI 动作：思考 → 气泡', samples);

    const firstThinking = samples.findIndex((s) => s.thinking);
    const firstBubble = samples.findIndex((s) => s.bubble);

    // 1) 必须出现过「思考中且座位高亮」的中间态
    expect(firstThinking, '应观察到「思考中」中间态（座位高亮）').toBeGreaterThanOrEqual(0);
    // 2) 必须出现过动作气泡
    expect(firstBubble, '应观察到动作气泡').toBeGreaterThanOrEqual(0);
    // 3) 思考态必须**先于**气泡出现（而不是同一步跳过去）
    expect(firstThinking, '「思考」必须早于「动作气泡」出现').toBeLessThan(firstBubble);
    // 4) 至少两个不同的中间态（分步的定义）
    const distinctStates = new Set(
      samples.map((s) => `${s.thinking}/${s.thinkingSeat}/${s.bubble}/${s.boardRevealed}`),
    );
    expect(distinctStates.size, '至少观察到两个不同的中间态').toBeGreaterThanOrEqual(2);

    // 5) 思考座位必然不是玩家（玩家是 0 号位）
    const thinkingSeats = samples.filter((s) => s.thinking).map((s) => s.thinkingSeat);
    expect(thinkingSeats.every((x) => x !== null && x !== 0)).toBe(true);

    expect(errors).toEqual([]);
  });

  test('公共牌逐张亮相：flop 的观测张数依次为 1 → 2 → 3（不是一次性 3 张）', async ({ page }) => {
    const { errors } = attachErrors(page);
    await enterTable(page);

    // 打到翻牌：持续过牌/跟注，同时全程采样公共牌张数
    const seenBoards: number[] = [];
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const s = await sample(page);
      if (seenBoards[seenBoards.length - 1] !== s.boardRevealed) seenBoards.push(s.boardRevealed);
      if (s.boardRevealed >= 3 || s.handOver) break;
      if (s.canAct) {
        const btn = page.getByRole('button', { name: /跟注|过牌/ }).first();
        await btn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(60);
      } else {
        await page.waitForTimeout(60);
      }
    }

    console.log(`\n===== 公共牌亮相序列 =====\n  ${seenBoards.join(' → ')}\n=========================\n`);

    // 必须逐张递增，且出现过中间值 1、2（证明不是一次性发 3 张）
    expect(seenBoards).toContain(0);
    if (seenBoards.includes(3)) {
      expect(seenBoards, 'flop 必须逐张出现（应包含 1 与 2）').toContain(1);
      expect(seenBoards, 'flop 必须逐张出现（应包含 1 与 2）').toContain(2);
    }
    // 递增序列中不得出现跳变（例如 0 → 3）
    for (let i = 1; i < seenBoards.length; i++) {
      expect(seenBoards[i] - seenBoards[i - 1], '公共牌张数不得跳变').toBeLessThanOrEqual(1);
    }

    expect(errors).toEqual([]);
  });

  test('演出期间玩家误操作被忽略：等待态下无可用动作按钮', async ({ page }) => {
    const { errors } = attachErrors(page);
    await enterTable(page);

    // 采样若干轮，断言「等待态」与「可行动」从不同时成立
    for (let i = 0; i < 30; i++) {
      const s = await sample(page);
      if (s.waiting) {
        expect(s.canAct, '等待态（演出中）不得有可用动作按钮').toBe(false);
      }
      if (s.canAct) {
        expect(s.waiting, '可行动时不应同时处于等待态').toBe(false);
      }
      if (s.handOver) break;
      await page.waitForTimeout(100);
    }
    expect(errors).toEqual([]);
  });

  test('回合交回玩家后仍能正常行动（不会因动画丢回合）', async ({ page }) => {
    const { errors } = attachErrors(page);
    await enterTable(page);

    // 等到轮到自己
    let acted = false;
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const s = await sample(page);
      if (s.canAct) {
        const before = s.pot;
        const btn = page.getByRole('button', { name: /跟注|过牌/ }).first();
        await btn.click({ timeout: 5000 });
        // 不用固定 sleep 后直接断言：改为显式等待「点击真的生效」这一条件
        // （底池变化 / 本手结束 / 不再轮到我），超时即失败并给出明确信息。
        await page
          .waitForFunction(
            (prevPot) => {
              const potEl = document.querySelector('[data-testid="pot-value"]');
              const pot = (potEl?.textContent ?? '').trim();
              const myTurn = Boolean(document.querySelector('[data-testid="action-my-turn"]'));
              const over = Boolean(
                Array.from(document.querySelectorAll('h2')).find((h) =>
                  h.textContent?.includes('本手结果'),
                ),
              );
              return pot !== prevPot || over || !myTurn;
            },
            before,
            { timeout: 15_000 },
          )
          .catch(() => {});
        const after = await sample(page);
        // 点击后必须真的生效：底池变化，或本手结束，或轮到 AI
        const changed = after.pot !== before || after.handOver || !after.canAct;
        expect(changed, '玩家点击必须真的生效（回合未被动画吞掉）').toBe(true);
        acted = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    expect(acted, '应能在演出结束后正常行动').toBe(true);
    expect(errors).toEqual([]);
  });

  test('打完整一手：无卡死、无 console error，且结算金额自洽', async ({ page }) => {
    const { errors } = attachErrors(page);
    await enterTable(page);

    const all: Sample[] = [];
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline) {
      const s = await sample(page);
      all.push(s);
      if (s.handOver) break;
      if (s.canAct) {
        const btn = page.getByRole('button', { name: /跟注|过牌/ }).first();
        await btn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(80);
      } else {
        await page.waitForTimeout(80);
      }
    }
    dump('整手对局', all);

    // 本手必须结束（无卡死）
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 30_000 });

    // 结算金额自洽：底池总额 > 0，且各层金额为正整数
    const rows = page.locator('.settlement-table tbody tr');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const amount = Number((await rows.nth(i).locator('td').nth(1).innerText()).trim());
      expect(Number.isInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0);
      sum += amount;
    }
    expect(sum, '分配明细合计必须大于 0').toBeGreaterThan(0);

    expect(errors).toEqual([]);
  });

  test('prefers-reduced-motion 下跳过等待立即呈现，且状态推进不坏', async ({ page }) => {
    const { errors } = attachErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await enterTable(page);

    // 缩减动效下，AI 动作不应有可感知的长时间停顿：
    // 从「轮到 AI」到「本手推进」应在很短时间内完成。
    const t0 = Date.now();
    const samples = await sampleUntil(page, {
      until: (s) => s.handOver || s.canAct,
      timeoutMs: 30_000,
      intervalMs: 50,
    });
    const elapsed = Date.now() - t0;
    dump('reduced-motion', samples);
    console.log(`首次到达「可行动 / 已结算」用时：${elapsed}ms`);

    // 缩减动效下不应出现「思考」中间态（等待被压成 0）
    const thinkingSeen = samples.some((s) => s.thinking);
    expect(thinkingSeen, 'reduced-motion 下不应停留在思考态等待').toBe(false);

    // 且状态推进正常：最终要么轮到玩家、要么本手结束
    const last = samples[samples.length - 1];
    expect(last.canAct || last.handOver, 'reduced-motion 下推进不能被破坏').toBe(true);

    // 仍然可以正常打完整手
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const s = await sample(page);
      if (s.handOver) break;
      if (s.canAct) {
        await page
          .getByRole('button', { name: /跟注|过牌/ })
          .first()
          .click({ timeout: 5000 })
          .catch(() => {});
      }
      await page.waitForTimeout(70);
    }
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 30_000 });

    expect(errors).toEqual([]);
  });
});
