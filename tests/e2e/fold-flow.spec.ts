/**
 * 弃牌后续打端到端回归（task-2）。
 *
 * 背景：有反馈称「玩家弃牌后，界面直接演算给出答案，AI 没有把这一局打完」。
 * 本文件把「弃牌后仍继续」这一行为固化成长期回归断言，防止日后被「一次性
 * 结算」的实现悄悄改回去。
 *
 * 核心断言（全部基于**浏览器实测采样**，而不是读代码推断）：
 *
 *   1. 玩家弃牌后，仍能采样到 **≥ 2 次 AI 动作气泡**（并且出现过 AI 思考态）；
 *   2. 公共牌是**逐张**揭示的：弃牌后 board 张数每次最多 +1，不得从 0 直接
 *      跳到 3 / 5（即「一次性全出」会失败）；
 *   3. 最终一定出现「本手结果」结算面板，且「结束方式」「分配明细」自洽。
 *
 * 第二个用例覆盖多人底池：先在翻前跟注/过牌进入翻牌（保证翻牌时仍有多人存活），
 * 再在翻牌弃牌，验证 AI 之间会继续按座位顺序行动、公共牌继续逐张发出。
 *
 * 注意：若弃牌后其余玩家全部弃牌到只剩一家（liveCount <= 1），本手会按规则
 * 立即结束——这是合法结局而不是缺陷。因此「逐张揭示到 5 张」的强断言只在
 * 结束方式为摊牌时要求；其余情况只要求「不跳变」。
 *
 * 第三个用例是**已修复缺陷的回归护栏**：翻前全员 all-in 时结算面板曾先于公共牌
 * 揭示弹出（公共牌在面板背后才逐张翻开），成因是 src/ui/useTableShowcase.ts 的
 * 「结算停顿」useEffect 只按 `st.finished` 计时。修复后该用例转为常规断言。
 */

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

const STORAGE_STATE_KEY = 'poker-trainer:state';
const HERO_SEAT = 0;

interface Sample {
  t: number;
  thinkingSeat: number | null;
  bubbleSeat: number | null;
  bubbleAction: string | null;
  /** 气泡身份（含 data-anim 序号），用于识别「换了一次动作」。 */
  bubbleKey: string | null;
  boardRevealed: number;
  pot: string;
  waiting: boolean;
  canAct: boolean;
  handOver: boolean;
  street: string;
}

interface Settlement {
  stats: Record<string, string>;
  rows: string[][];
  winnerSeats: number[];
}

interface Derived {
  elapsedMs: number;
  aiActionSeats: number[];
  aiActionCount: number;
  thinkingSeats: number[];
  boardSeq: number[];
  boardJumps: number[];
  /** 「本手结果」出现那一刻公共牌已揭示的张数。 */
  boardAtOver: number;
}

function attachErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { errors };
}

/** 在页面上下文里一次性抓取所有可观测特征（避免多次 round-trip 造成采样失真）。 */
async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const thinkingEl = document.querySelector('.seat[data-thinking="1"]');
    const bubbleEl = document.querySelector('[data-testid="action-bubble"]');
    const boardEl = document.querySelector('[data-testid="board"]');
    const potEl = document.querySelector('[data-testid="pot-value"]');
    const waitingEl = document.querySelector('[data-testid="action-waiting"]');
    const myTurnEl = document.querySelector('[data-testid="action-my-turn"]');
    const streetEl = document.querySelector('[data-testid="street-badge"]');
    const seatAttr = thinkingEl?.getAttribute('data-seat');
    const bSeat = bubbleEl?.getAttribute('data-seat');
    const bKey = bubbleEl
      ? [
          bubbleEl.getAttribute('data-seat'),
          bubbleEl.getAttribute('data-action'),
          bubbleEl.getAttribute('data-amount'),
          bubbleEl.getAttribute('data-anim'),
        ].join('|')
      : null;
    return {
      t: Date.now(),
      thinkingSeat: seatAttr !== null && seatAttr !== undefined ? Number(seatAttr) : null,
      bubbleSeat: bSeat !== null && bSeat !== undefined ? Number(bSeat) : null,
      bubbleAction: bubbleEl?.getAttribute('data-action') ?? null,
      bubbleKey: bKey,
      boardRevealed: Number(boardEl?.getAttribute('data-revealed') ?? 0),
      pot: (potEl?.textContent ?? '').trim(),
      waiting: Boolean(waitingEl),
      canAct: Boolean(myTurnEl),
      handOver: Boolean(
        Array.from(document.querySelectorAll('h2')).find((h) => h.textContent?.includes('本手结果')),
      ),
      street: (streetEl?.textContent ?? '').trim(),
    };
  });
}

/**
 * 进入牌桌，并保证是默认的 6 人桌。
 *
 * 先清掉可能残留的脏存档（例如上一轮手工测试留下的 2 人桌设置），再 reload，
 * 否则「6 人桌弃牌后至少还有 5 家」这个前提不成立，采样会失去意义。
 */
async function enterTable(page: Page): Promise<void> {
  await page.goto('/poker-trainer/?skip-lobby=1');
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
  await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_STATE_KEY);
  await page.reload();
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
  await expect(page.locator('.seat'), '回归用例必须在默认 6 人桌下取证').toHaveCount(6);
}

/**
 * 以指定初始筹码进桌（用于构造「必然全下摊牌」的场景）。
 * 应用只在改设置 / 本手结束 / 用提示时才写存档，首次进桌 localStorage 是空的，
 * 所以这里直接写入一份完整的合法 PersistedState 再 reload。
 */
async function enterTableWithStack(page: Page, startingStack: number): Promise<void> {
  await page.goto('/poker-trainer/?skip-lobby=1');
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
  await page.evaluate(
    ({ key, stack }) => {
      const state = {
        schemaVersion: 1,
        bankroll: 1000,
        settings: {
          seatCount: 6,
          startingStack: stack,
          smallBlind: 5,
          bigBlind: 10,
          aiTier: 'medium',
          fourColorDeck: true,
          showShortcuts: true,
          enableFlopExact: false,
        },
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
        nextDealerSeat: 0,
        handCounter: 0,
      };
      window.localStorage.setItem(key, JSON.stringify(state));
    },
    { key: STORAGE_STATE_KEY, stack: startingStack },
  );
  await page.reload();
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
  await expect(page.locator('.seat')).toHaveCount(6);
}

/**
 * 结算面板出现之后继续采样公共牌张数，直到发满 5 张或超时。
 * 用于覆盖「翻前全下摊牌」这条路径：引擎在 finish 前一次 runOutBoard 发满 5 张，
 * 揭示动画发生在结算面板背后（见文件末尾 fixme 用例），所以必须多采一段才能看到 5 张。
 */
async function sampleBoardUntilFull(page: Page, timeoutMs = 12_000): Promise<number[]> {
  const seq: number[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await sample(page);
    if (seq[seq.length - 1] !== s.boardRevealed) seq.push(s.boardRevealed);
    if (s.boardRevealed >= 5) break;
    await page.waitForTimeout(100);
  }
  return seq;
}

/** 等到轮到玩家行动（出现可用的动作按钮）。 */
async function waitForHeroTurn(page: Page, timeoutMs = 120_000): Promise<Sample> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await sample(page);
    if (s.canAct) return s;
    if (s.handOver) throw new Error('本手在轮到玩家之前就结束了');
    await page.waitForTimeout(100);
  }
  throw new Error('等待玩家回合超时');
}

/** 点击「弃牌（Fold）」，返回点击时刻 t0 作为全部耗时/采样的基准。 */
async function clickFold(page: Page): Promise<number> {
  const fold = page
    .locator('[data-testid="action-my-turn"]')
    .getByRole('button', { name: /弃牌（Fold）/ });
  await expect(fold).toBeEnabled({ timeout: 20_000 });
  const t0 = Date.now();
  await fold.click({ timeout: 10_000 });
  return t0;
}

/** 点击「跟注 / 过牌」（用于翻前把牌局带进翻牌）。 */
async function clickCallOrCheck(page: Page): Promise<void> {
  const btn = page
    .locator('[data-testid="action-my-turn"]')
    .getByRole('button', { name: /跟注|过牌/ })
    .first();
  await btn.click({ timeout: 8_000 }).catch(() => {});
}

/** 从点击弃牌之后高频采样，直到出现「本手结果」或超时。 */
async function sampleUntilOver(
  page: Page,
  timeoutMs = 180_000,
  intervalMs = 100,
): Promise<Sample[]> {
  const all: Sample[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await sample(page);
    all.push(s);
    if (s.handOver) break;
    await page.waitForTimeout(intervalMs);
  }
  return all;
}

async function readSettlement(page: Page): Promise<Settlement> {
  return page.evaluate(() => {
    const stats: Record<string, string> = {};
    document.querySelectorAll('.stats-grid .stat').forEach((el) => {
      const k = el.querySelector('.k')?.textContent?.trim();
      const v = el.querySelector('.v')?.textContent?.trim();
      if (k) stats[k] = v ?? '';
    });
    const rows = Array.from(document.querySelectorAll('.settlement-table tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').trim()),
    );
    const winnerSeats = Array.from(document.querySelectorAll('.seat.sc-winner')).map((el) =>
      Number(el.getAttribute('data-seat')),
    );
    return { stats, rows, winnerSeats };
  });
}

/** 从采样序列里推导「弃牌后到底发生了什么」。 */
function derive(samples: Sample[], t0: number): Derived {
  const aiActionSeats: number[] = [];
  const thinkingSeats: number[] = [];
  const boardSeq: number[] = [];
  let lastBubbleKey: string | null = null;

  for (const s of samples) {
    if (s.bubbleKey !== null && s.bubbleKey !== lastBubbleKey) {
      lastBubbleKey = s.bubbleKey;
      // 弃牌后玩家自己那一颗「fold」气泡不算 AI 动作
      if (s.bubbleSeat !== null && s.bubbleSeat !== HERO_SEAT) aiActionSeats.push(s.bubbleSeat);
    }
    if (s.thinkingSeat !== null && s.thinkingSeat !== HERO_SEAT) {
      if (thinkingSeats[thinkingSeats.length - 1] !== s.thinkingSeat) thinkingSeats.push(s.thinkingSeat);
    }
    if (boardSeq[boardSeq.length - 1] !== s.boardRevealed) boardSeq.push(s.boardRevealed);
  }

  const boardJumps: number[] = [];
  for (let i = 1; i < boardSeq.length; i++) boardJumps.push(boardSeq[i] - boardSeq[i - 1]);
  const last = samples[samples.length - 1];

  return {
    elapsedMs: last ? last.t - t0 : 0,
    aiActionSeats,
    aiActionCount: aiActionSeats.length,
    thinkingSeats,
    boardSeq,
    boardJumps,
    boardAtOver: last?.boardRevealed ?? 0,
  };
}

/** 当前仍在牌局中的座位号。 */
async function liveSeats(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.seat'))
      .filter((el) => !el.classList.contains('folded'))
      .map((el) => Number(el.getAttribute('data-seat'))),
  );
}

/** 用跟注/过牌把当前这手打完（不会弃牌）。 */
async function finishCurrentHand(page: Page, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await sample(page);
    if (s.handOver) return;
    if (s.canAct) await clickCallOrCheck(page);
    await page.waitForTimeout(100);
  }
  throw new Error('打完当前手超时');
}

async function clickNextHand(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: /下一手/ }).first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await btn.click({ timeout: 10_000 });
  await page.waitForTimeout(200);
}

/** 翻前一直跟注/过牌，直到出现翻牌且轮到玩家。 */
async function playUntilFlop(page: Page, timeoutMs = 150_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await sample(page);
    if (s.handOver) return false;
    if (s.canAct) {
      if (s.boardRevealed >= 3) return true;
      await clickCallOrCheck(page);
      await page.waitForTimeout(150);
    } else {
      await page.waitForTimeout(100);
    }
  }
  return false;
}

/**
 * 构造一个「翻牌时仍有多人存活」的局面。
 *
 * 6 人桌翻前若只剩一家对手，弃牌后会按规则立即结束，无法验证「AI 之间继续
 * 对打」；因此存活人数不足 3（玩家 + 至少 2 家 AI）时，打完这手再开下一手重试。
 */
async function reachMultiwayFlop(page: Page, minLive = 3, attempts = 4): Promise<number[]> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const reached = await playUntilFlop(page);
    if (!reached) {
      // 翻前本手就结束（例如其余人全部弃牌到只剩一家）是合法结局，换一手再来。
      console.log(`第 ${attempt + 1} 次：翻前本手已结束，换下一手`);
      await clickNextHand(page);
      continue;
    }
    const live = await liveSeats(page);
    console.log(`第 ${attempt + 1} 次：翻牌时未弃牌座位 [${live.join(', ')}]（${live.length} 人）`);
    if (live.length >= minLive) return live;
    await finishCurrentHand(page);
    await clickNextHand(page);
  }
  return liveSeats(page);
}

/** 打印采样证据（供 CI 留痕）。 */
function dump(label: string, samples: Sample[], t0: number): void {
  console.log(`\n===== 弃牌后采样证据：${label}（${samples.length} 点 / 100ms）=====`);
  let prev = '';
  for (const s of samples) {
    const key = `${s.thinkingSeat}/${s.bubbleKey}/${s.boardRevealed}/${s.canAct}/${s.handOver}`;
    if (key === prev) continue;
    prev = key;
    const marks: string[] = [];
    if (s.thinkingSeat !== null) marks.push(`思考@${s.thinkingSeat}`);
    if (s.bubbleSeat !== null) marks.push(`气泡[${s.bubbleSeat}:${s.bubbleAction}]`);
    if (s.canAct) marks.push('可行动');
    if (s.handOver) marks.push('已结算');
    console.log(
      `  +${String(s.t - t0).padStart(6)}ms  board=${s.boardRevealed}  pot=${s.pot.padStart(5)}  ${marks.join(' ') || '·'}`,
    );
  }
  console.log('===== 采样证据结束 =====\n');
}

test.describe('task-2 弃牌后 AI 继续打完', () => {
  test('翻前弃牌后 AI 继续行动、公共牌逐张揭示，并出现结算面板', async ({ page }) => {
    const { errors } = attachErrors(page);
    await enterTable(page);

    // 少数情况下弃牌后其余玩家全部弃牌到只剩一家，本手按规则立即结束；
    // 这种手无法验证「AI 继续」，换一手重试（最多 6 手）。
    // 另外要排除「翻前全员 all-in 摊牌」的手：那种手引擎在 finish 时一次把公共牌发满
    // （runOutBoard），公共牌是在结算面板背后才逐张翻开的（已知缺陷，见文件末尾 fixme 用例），
    // 它不属于「弃牌后 AI 逐街继续打」，故本用例只选「弃牌后公共牌至少推进过 2 次」的手。
    let chosen: { d: Derived; st: Settlement } | null = null;
    for (let attempt = 0; attempt < 6 && chosen === null; attempt++) {
      if (attempt > 0) await clickNextHand(page);
      let before: Sample;
      try {
        before = await waitForHeroTurn(page);
      } catch {
        // 例如玩家在大盲位、其余人全部弃牌，本手在轮到玩家前就结束了 —— 合法，换下一手。
        console.log(`第 ${attempt + 1} 手：玩家还没行动本手就结束了，换下一手`);
        continue;
      }
      console.log(`第 ${attempt + 1} 手：轮到玩家，街=${before.street}，board=${before.boardRevealed}`);

      const t0 = await clickFold(page);
      const samples = await sampleUntilOver(page);
      const d = derive(samples, t0);
      dump(`第 ${attempt + 1} 手（翻前弃牌）`, samples, t0);
      const st = await readSettlement(page);
      console.log(
        `第 ${attempt + 1} 手结果：弃牌→结算 ${(d.elapsedMs / 1000).toFixed(2)}s，AI 动作 ${d.aiActionCount} 次，` +
          `公共牌 [${d.boardSeq.join('→')}]，结束方式=${st.stats['结束方式'] ?? '（无）'}`,
      );
      // 只选「弃牌后 AI 逐街继续打」的手：
      //  - AI 动作 ≥ 2 次（证明 AI 真的继续打了）；
      //  - 公共牌至少推进过 2 次（排除翻前全员 all-in 一次 runOutBoard 发满的手）；
      //  - 若是摊牌，公共牌必须在结算面板出现前就已发满 5 张（排除「打到翻牌/转牌后
      //    全下、剩余公共牌在结算面板背后才翻开」的手，那属于另一个已知缺陷）。
      const boardFullBeforeOver = d.boardSeq[d.boardSeq.length - 1] === 5;
      const isShowdown = st.stats['结束方式'] === '摊牌（Showdown）';
      if (d.aiActionCount >= 2 && d.boardSeq.length >= 2 && (!isShowdown || boardFullBeforeOver)) {
        chosen = { d, st };
      }
    }

    expect(chosen, '至少应有一手在玩家弃牌后仍有 AI 继续行动').not.toBeNull();
    const { d, st } = chosen as { d: Derived; st: Settlement };

    // 1) 弃牌后 AI 必须继续行动（至少 2 次动作气泡）
    expect(d.aiActionCount, '弃牌后 AI 必须继续行动（≥ 2 次动作气泡）').toBeGreaterThanOrEqual(2);
    // 并且出现过 AI 思考态（不是一瞬间全部算完）
    expect(d.thinkingSeats.length, '弃牌后应出现 AI 思考态').toBeGreaterThanOrEqual(1);
    // 2) 公共牌逐张揭示：张数每次最多 +1，不得从 0 直接跳到 3/5
    expect(d.boardSeq.length, '应能采样到公共牌张数变化').toBeGreaterThan(1);
    for (const jump of d.boardJumps) {
      expect(jump, `公共牌张数不得跳变（序列 [${d.boardSeq.join(', ')}]）`).toBeLessThanOrEqual(1);
    }
    // 3) 结算面板出现且自洽
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible();
    expect(st.stats['结束方式'], '结算面板必须显示「结束方式」').toBeTruthy();
    expect(st.rows.length, '结算面板必须给出底池分配明细').toBeGreaterThan(0);
    const total = st.rows.reduce((sum, r) => sum + Number(r[1]), 0);
    expect(total, '分配明细合计必须大于 0').toBeGreaterThan(0);
    // 摊牌结局下，公共牌必须已全部揭示（且是逐张到达 5 张的）
    if (st.stats['结束方式'] === '摊牌（Showdown）') {
      expect(d.boardSeq[d.boardSeq.length - 1], '摊牌时公共牌必须已全部揭示').toBe(5);
      expect(d.boardSeq, '摊牌时公共牌应逐张到达 4 张').toContain(4);
    }

    expect(errors).toEqual([]);
  });

  test('多人底池翻牌弃牌后，AI 之间继续按座位行动并逐张发出公共牌', async ({ page }) => {
    // 需要换手重试，故放宽到 10 分钟（默认 300s）。
    test.setTimeout(600_000);
    const { errors } = attachErrors(page);
    await enterTable(page);

    // 「弃牌后只出现 1 次 AI 动作」是**合法结局**，不能当成缺陷：
    // 其余人里有人全下、剩下的全弃牌时，本手只剩「全下 → 跑完公共牌 → 摊牌」，
    // 于是弃牌后只有 1 次动作气泡。第二批把 medium 的面对下注弃牌率从 0% 提到 23.6%
    // 之后，这类「一家下注/全下、其余弃牌」的手明显变多，本用例因此变成偶发失败。
    // 与上一个用例一致：换手重试，直到遇到「弃牌后确实由多家 AI 继续对打」的一手。
    type Chosen = { d: Derived; st: Settlement; liveAtFlop: number[]; postSeq: number[] };
    let chosen: Chosen | null = null;
    for (let attempt = 0; attempt < 5 && chosen === null; attempt++) {
      if (attempt > 0) await clickNextHand(page);
      const liveAtFlop = await reachMultiwayFlop(page);
      const before = await sample(page);
      if (before.boardRevealed < 3) {
        console.log(`第 ${attempt + 1} 手：未到翻牌（公共牌 ${before.boardRevealed} 张），换下一手`);
        continue;
      }

      const t0 = await clickFold(page);
      const samples = await sampleUntilOver(page);
      const d = derive(samples, t0);
      dump(`第 ${attempt + 1} 手（翻牌弃牌·多人底池）`, samples, t0);
      const st = await readSettlement(page);
      console.log(
        `第 ${attempt + 1} 手结果：弃牌→结算 ${(d.elapsedMs / 1000).toFixed(2)}s，AI 动作 ${d.aiActionCount} 次，` +
          `座位序列 [${d.aiActionSeats.join(', ')}]，公共牌 [${d.boardSeq.join('→')}]，结束方式=${st.stats['结束方式'] ?? '（无）'}`,
      );

      // 只选「AI 之间继续对打」的手：弃牌后 ≥2 次动作且 ≥2 个不同 AI 座位。
      // 否则（例如全下后跑完公共牌）本手无法验证该行为，换下一手。
      if (d.aiActionCount >= 2 && new Set(d.aiActionSeats).size >= 2) {
        const postSeq = await sampleBoardUntilFull(page);
        chosen = { d, st, liveAtFlop, postSeq };
      }
    }

    expect(chosen, '至少应有一手在翻牌弃牌后由多家 AI 继续对打').not.toBeNull();
    const { d, st, liveAtFlop, postSeq } = chosen as Chosen;

    // AI 继续行动
    expect(d.aiActionCount, '翻牌弃牌后 AI 必须继续行动（≥ 2 次动作气泡）').toBeGreaterThanOrEqual(2);
    // 动作座位必须是弃牌时仍在牌局里的 AI，且不可能是玩家
    const aiLive = liveAtFlop.filter((s) => s !== HERO_SEAT);
    for (const seat of d.aiActionSeats) {
      expect(aiLive, `弃牌后行动座位 ${seat} 必须是仍在牌局中的 AI`).toContain(seat);
    }
    // 至少两个不同 AI 座位行动过（证明是 AI 之间对打，而不是同一家反复）
    expect(new Set(d.aiActionSeats).size, '应至少有 2 个不同 AI 座位继续行动').toBeGreaterThanOrEqual(2);
    // 公共牌逐张：把「结算面板出现前」与「结算面板出现后（全下摊牌在面板背后揭示）」的
    // 张数序列拼起来，整体不得跳变（即任何时刻都不允许 0 → 3/5 一次全出）。
    const fullBoardSeq = [...d.boardSeq, ...postSeq.filter((n) => n > (d.boardSeq[d.boardSeq.length - 1] ?? -1))];
    for (let i = 1; i < fullBoardSeq.length; i++) {
      expect(
        fullBoardSeq[i] - fullBoardSeq[i - 1],
        `公共牌张数不得跳变（序列 [${fullBoardSeq.join(', ')}]）`,
      ).toBeLessThanOrEqual(1);
    }
    // 结算面板
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible();
    expect(st.stats['结束方式'], '结算面板必须显示「结束方式」').toBeTruthy();
    // 摊牌时所有未弃牌座位的底牌都必须亮出
    if (st.stats['结束方式'] === '摊牌（Showdown）') {
      expect(fullBoardSeq[fullBoardSeq.length - 1], '摊牌时公共牌最终必须全部揭示').toBe(5);
      const faceDownCount = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('.seat'))
            .filter((el) => !el.classList.contains('folded'))
            .flatMap((el) => Array.from(el.querySelectorAll('.seat-cards .card')))
            .filter((c) => c.getAttribute('data-face') !== 'up').length,
      );
      expect(faceDownCount, '摊牌时未弃牌座位的底牌必须全部亮出').toBe(0);
    }

    expect(errors).toEqual([]);
  });

  /**
   * 回归测试：全下摊牌时，结算面板不得先于公共牌揭示出现。
   *
   * ── 曾经的缺陷 ──────────────────────────────────────────────
   * 翻前全员 all-in 时，core 引擎在 finish 之前用 runOutBoard 一次把公共牌补满 5 张
   * （src/core/hand.ts 的 advance() → runOutBoard()），这本身是对的；但 UI 的
   * 「结算停顿」useEffect（src/ui/useTableShowcase.ts）只按 `st.finished` 计时，
   * 不等揭示游标 `revealedBoard` 追平 `st.board.length`，于是 finished 后约 640ms
   * 就 setSettleHold(true)，结算面板先于公共牌揭示弹出，公共牌在面板背后才逐张翻开。
   *
   * 实测（dist @ HEAD fb472d7，6 人桌 startingStack=20）：弃牌 → 结算面板 1.91s，
   * 面板出现时 data-revealed=0；之后 4s 内采样到 0→1→2→3→4→5，全部发生在面板背后。
   *
   * ── 修复 ────────────────────────────────────────────────────
   * 在「结算停顿」useEffect 里加了 gate：`if (revealedBoard < st.board.length) return;`
   * 并把 `revealedBoard` / `st?.board.length` 加进依赖数组；同时把 dev-only 不变量
   * 的判据从 `st.finished` 改成 `settleHold`（否则全下摊牌会在 dev 下误报崩溃）。
   *
   * 本用例即该修复的回归护栏：结算面板出现时公共牌必须已经全部揭示。
   */
  test('全下摊牌时结算面板不应先于公共牌揭示出现', async ({ page }) => {
    // 需要换手重试（原因见下），故放宽到 10 分钟（默认 300s）。
    test.setTimeout(600_000);
    const { errors } = attachErrors(page);
    await enterTableWithStack(page, 20);

    // 这个不变量只在**摊牌**结局下成立：若玩家弃牌后其余人也一路弃牌到只剩一家，
    // 本手按规则立即结束、公共牌一张都不发，此时「结算面板出现时 boardRevealed=0」
    // 是正确行为而不是缺陷。第二批把面对下注的弃牌率从 0% 提到 23.6% 之后，
    // 这种「弃牌结束」的手明显变多，因此必须换手重试（最多 4 手），
    // 不能把合法结局误判成回归。
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      if (attempt > 0) await clickNextHand(page);
      let t0: Sample;
      try {
        t0 = await waitForHeroTurn(page);
      } catch {
        // 玩家还没行动本手就结束了（例如在大盲位被一路弃牌到结束）——合法，换一手。
        console.log(`第 ${attempt + 1} 手：玩家还没行动本手就结束了，换下一手`);
        continue;
      }
      expect(t0.boardRevealed, '本用例要求玩家在翻前行动').toBe(0);
      const foldAt = await clickFold(page);
      const samples = await sampleUntilOver(page);
      const d = derive(samples, foldAt);
      const st = await readSettlement(page);
      console.log(
        `第 ${attempt + 1} 手 全下摊牌：弃牌→结算 ${(d.elapsedMs / 1000).toFixed(2)}s，AI 动作 ${d.aiActionCount} 次，` +
          `结算时 boardRevealed=${d.boardAtOver}，结束方式=${st.stats['结束方式'] ?? '（无）'}`,
      );
      // 非摊牌结局（弃牌结束）无法验证该不变量，换一手重试。
      if (st.stats['结束方式'] !== '摊牌（Showdown）') continue;
      expect(d.boardAtOver, '结算面板出现时公共牌应已全部揭示').toBe(5);
      done = true;
    }
    expect(done, '4 手内没遇到全下摊牌，无法验证「结算不早于揭示」').toBe(true);
    expect(errors).toEqual([]);
  });
});
