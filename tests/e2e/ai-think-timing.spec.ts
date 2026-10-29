/**
 * 任务一验收：AI 决策耗时模拟真人（区间内随机波动、下限 > 1 秒）。
 *
 * ── 为什么必须用浏览器测，而不是只看单测 ─────────────────────
 * 单测（tests/unit/think-timing.test.ts）验证的是「抽样函数」本身：区间正确、
 * 分布均匀、不越界。但用户的实际体感取决于**调度链路**是否真的把这个抽样值
 * 用上了：`planShowcaseStep` → `stableStep` → `App.tsx` 的 `setTimeout`。
 * 这条链路上任何一环把 delayMs 丢掉（例如 stepKey 不含 delayMs 导致 memo 命中
 * 旧值、或 effect 依赖写错导致定时器被立刻清掉），单测都会全绿而用户仍然看到
 * 固定 560ms。所以这里用 MutationObserver 直接测**墙钟时间**。
 *
 * ── 为什么不用 `__showcaseTrace` ─────────────────────────────
 * 该 trace 有 `process.env.NODE_ENV === 'production'` 守卫，而 E2E 跑的是
 * `npm run preview`（生产构建），那段代码在打包时就被判死删除了。所以只能从
 * DOM 侧观测。
 *
 * ── 测量方法 ─────────────────────────────────────────────────
 * 在 felt 上挂 MutationObserver，每次 DOM 变动时取一次快照：
 *   - `.seat[data-thinking="1"]` 的 `data-seat` 集合 → 谁在思考
 *   - `[data-testid="action-bubble"]` 的 `data-anim` → 该座位出现了「新动作」
 * 某个座位从「开始思考」到「出现新动作气泡」之间的墙钟差，就是这一步的等待时长。
 *
 * 时间戳取在 MutationObserver 回调里（微任务，紧贴 DOM 提交），因此测量值
 * **只会略大于真实 setTimeout 时长**（多一次渲染提交），不会偏小 —— 这一点
 * 很关键：如果测得 ≥ 1000ms，就说明真实等待确实 > 1 秒。
 */

import { test, expect, type Page } from '@playwright/test';
import { AI_THINK_RANGE } from '../../src/ui/thinkTiming.js';

/**
 * 直接引用产品常量，而不是在这里抄一份数字。
 * 抄一份的话，以后调整区间（例如上限从 2400 收到 1800）测试不会跟着变，
 * 断言就变成「永远成立的空断言」或「莫名其妙的假红」。
 */
const THINK_MIN_MS = AI_THINK_RANGE.minMs;
const THINK_MAX_MS = AI_THINK_RANGE.maxMs;

/**
 * 产品硬要求：不允许 1 秒内出决策。
 *
 * 测量误差只会偏大（见文件头），所以理论下限就是 1100ms；这里取 1000ms
 * 作为断言阈值，正好等价于用户那句「下限必须 > 1 秒」。
 */
const LOWER_BOUND_MS = 1000;

/** 上限容差：真实等待 ≤ THINK_MAX_MS，再给渲染提交与定时器抖动留 500ms。 */
const UPPER_BOUND_MS = THINK_MAX_MS + 500;

interface ThinkSample {
  seat: number;
  ms: number;
  action: string;
}

/**
 * 进入牌桌，并**显式**切到「拟真」档（阶段二 P1-1 之后节奏有三档）。
 *
 * 为什么不用 `?skip-lobby=1`：那条入口会沿用当前存档里的档位。若用户（或某个
 * 之前的用例）把档位改成了「快速 / 瞬时」，这里断言的「每次 ≥ 1000ms」就会假红，
 * 而产品其实没错。所以本用例从首屏进入并主动按下「拟真」，把前置条件写死。
 * 顺带也就覆盖了首屏档位控件本身可用。
 */
async function enterTable(page: Page): Promise<void> {
  await page.goto('/poker-trainer/');
  const realistic = page.locator('[data-testid="pace-realistic"]');
  await realistic.waitFor({ state: 'visible', timeout: 30_000 });
  await realistic.click();
  await expect(realistic).toHaveAttribute('aria-pressed', 'true');
  await page.locator('button.lobby-start').click();
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
}

/** 在页面里装一个「思考时长」记录器，结果通过 window.__think.samples 取回。 */
async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const felt = document.querySelector('[data-testid="felt"]');
    if (!felt) throw new Error('felt 未渲染，无法挂观测器');

    /** seat → 该座位「开始思考」的时刻。 */
    const startBySeat = new Map<number, number>();
    /** seat → 上一次观测到的 data-anim（用于识别「新动作」）。 */
    const lastAnim = new Map<number, string | null>();
    const samples: ThinkSample[] = [];
    let prevThinking = new Set<number>();

    const snapshot = (): void => {
      const t = performance.now();

      // 1) 先处理气泡：消费 startBySeat 里的起点。
      //    必须排在「思考集合变化」之前 —— 一次 React 提交里可能同时发生
      //    「A 停止思考并出气泡」+「B 开始思考」，先算 A 的时长才不会丢样本。
      document.querySelectorAll('[data-testid="action-bubble"]').forEach((el) => {
        const seat = Number(el.getAttribute('data-seat'));
        if (!Number.isFinite(seat)) return;
        const anim = el.getAttribute('data-anim');
        if (lastAnim.get(seat) === anim) return; // 同一个动作的重渲染，不算新动作
        lastAnim.set(seat, anim);
        const started = startBySeat.get(seat);
        if (started === undefined) return; // 玩家座位（从不进入思考态）或首次观测
        startBySeat.delete(seat);
        samples.push({
          seat,
          ms: Math.round(t - started),
          action: el.getAttribute('data-action') ?? '',
        });
      });

      // 2) 再更新思考集合。
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
    mo.observe(felt, {
      attributes: true,
      subtree: true,
      childList: true,
      attributeFilter: ['data-thinking', 'data-anim', 'data-seat', 'data-action'],
    });
    snapshot(); // 立即取一次初值，避免漏掉「装载瞬间就已在思考」的样本

    w.__think = {
      samples,
      stop: () => mo.disconnect(),
    };
  });
}

/** 读回记录到的样本。 */
async function readSamples(page: Page): Promise<ThinkSample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __think?: { samples: ThinkSample[]; stop: () => void } };
    if (!w.__think) return [];
    w.__think.stop();
    return w.__think.samples;
  });
}

/**
 * 打完一手牌：轮到玩家就点「过牌 / 跟注」，直到出现「本手结果」。
 *
 * 刻意不用 `waitForTimeout` 固定节拍去点按钮，而是「看到自己的回合才点」，
 * 这样玩家侧不会成为瓶颈（AI 现在每步要 1.1–2.4 秒，固定节拍容易点空）。
 */
async function playOneHand(page: Page, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const finished = await page
      .locator('h2', { hasText: '本手结果' })
      .first()
      .isVisible()
      .catch(() => false);
    if (finished) return;

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
    await page.waitForTimeout(120);
  }
  throw new Error(`playOneHand 超时：${timeoutMs}ms 内未出现「本手结果」`);
}

test.describe('任务一 AI 思考时长', () => {
  test('连续多次 AI 决策耗时都在 1 秒以上、区间内波动，且确实在变化', async ({ page }) => {
    test.setTimeout(240_000);
    await enterTable(page);
    await installRecorder(page);
    await playOneHand(page);

    const samples = await readSamples(page);
    // 证据留档：CI 失败时能从报告里直接看到每次的实测值
    // eslint-disable-next-line no-console
    console.log(
      `[think-timing] ${samples.length} 次 AI 决策：` +
        samples.map((s) => `${s.seat}号位 ${s.ms}ms(${s.action})`).join(', '),
    );

    // 样本数太少说明记录器没挂上或这手牌异常
    expect(samples.length, '样本数太少，无法验证波动').toBeGreaterThanOrEqual(5);

    // ⓪ 区间常量与产品要求自洽：真实下限 1100ms 必须高于「1 秒」这条红线
    expect(THINK_MIN_MS).toBeGreaterThan(LOWER_BOUND_MS);

    // ① 产品硬要求：没有任何一次决策快于 1 秒
    const tooFast = samples.filter((s) => s.ms < LOWER_BOUND_MS);
    expect(tooFast, `存在 < ${LOWER_BOUND_MS}ms 的决策：${JSON.stringify(tooFast)}`).toEqual([]);

    // ② 上限不能太长
    const tooSlow = samples.filter((s) => s.ms > UPPER_BOUND_MS);
    expect(tooSlow, `存在 > ${UPPER_BOUND_MS}ms 的决策：${JSON.stringify(tooSlow)}`).toEqual([]);

    // ③ 确实在随机波动，而不是固定值
    const values = samples.map((s) => s.ms);
    const spread = Math.max(...values) - Math.min(...values);
    expect(spread, `耗时几乎不变（极差 ${spread}ms），说明随机化没生效`).toBeGreaterThan(300);
    // 至少出现 3 种不同取值（避免「两个值来回跳」的伪随机）
    expect(new Set(values).size).toBeGreaterThanOrEqual(3);

    // ④ 同一个座位多次决策的耗时不全相同 —— 若随机数被每帧重抽并取最后一次，
    //    同座位会高度趋同（这正是「stepKey 不含 delayMs」最容易踩的坑）。
    const bySeat = new Map<number, number[]>();
    for (const s of samples) {
      const arr = bySeat.get(s.seat) ?? [];
      arr.push(s.ms);
      bySeat.set(s.seat, arr);
    }
    const repeated = [...bySeat.values()].filter((a) => a.length >= 2);
    if (repeated.length > 0) {
      const allSame = repeated.every((a) => a.every((v) => v === a[0]));
      expect(allSame, '同座位多次决策耗时完全相同，随机化可疑').toBe(false);
    }
  });
});
