/**
 * 牌桌几何不变量回归测试（座位布局缺陷的长期看门测试）。
 *
 * 已报告并被本文件钉住的缺陷：
 *   1. 九人桌只画出 8 名玩家：`.seat` 有 9 个节点，但 data-seat 序列是
 *      2,3,4,5,6,7,1,7,0 —— 座位 7 出现两次、座位 8 从未渲染。
 *      根因是渲染侧**用坐标阈值反推槽位**（y<30 判顶排、x<25 判左、x>75 判右），
 *      n>=7 时顶排 x 落到 14.3%…85.7%，首尾越过阈值，于是顶排座位被当成
 *      左/右座位又渲染一次，真正的右座位永远轮不到。
 *      现在 computePlacements 直接给出 slot，渲染侧只按 slot 分区，
 *      本文件从 DOM 侧断言「座位号双射」把这个不变量钉住。
 *   2. 手机 390x844 六人桌：座位出屏（left=-6）、顶排横向重叠、**所有底牌
 *      可见尺寸为 0（含玩家自己）**、documentElement.scrollWidth=396>390。
 *      根因是 `@media (max-width:560px){ .seat .seat-cards{display:none} }`
 *      把底牌整块隐藏，且座位用固定 min-width:150px 在 366px 宽的牌桌上必然
 *      互相挤压。现在座位宽度随牌桌内容宽度（容器查询 cqw）收敛，底牌始终渲染。
 *   3. 结算态：玩家座位压住公共牌、同屏两个「下一手」按钮。
 *
 * 断言口径：全部基于**浏览器实际算出的矩形**（getBoundingClientRect），
 * 而不是 class 名或样式声明——后者只能证明「代码写了想写的字符串」，
 * 挡不住「DOM 在但看不见」的假绿。
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'tablet-1024x768', width: 1024, height: 768 },
  { name: 'desktop-1440x900', width: 1440, height: 900 },
] as const;

const SEAT_COUNTS = [2, 6, 9] as const;

/** 允许的像素误差：亚像素布局与 transform(-50%,-50%) 会带来 0.x 的偏差。 */
const EPS = 0.5;
/** 底牌「可见」的判定阈值（缺陷里是 0×0；这里要求真的能被看见）。 */
const MIN_CARD_PX = 4;

interface Rect {
  l: number;
  t: number;
  w: number;
  h: number;
}

interface SeatSnapshot {
  seat: number;
  hero: boolean;
  rect: Rect;
  cards: { w: number; h: number }[];
  /** 座位内部是否溢出（名字/筹码/徽章把座位撑破） */
  overflowX: number;
}

interface Snapshot {
  innerWidth: number;
  innerHeight: number;
  scrollWidth: number;
  seats: SeatSnapshot[];
  board: Rect | null;
  felt: Rect | null;
  nextHandButtons: number;
  resultVisible: boolean;
}

/** 采集当前页面的几何快照（一次 evaluate，避免多次往返造成的时序错位）。 */
async function measure(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const rectOf = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, w: r.width, h: r.height };
    };
    const seats = Array.from(document.querySelectorAll('.seat')).map((el) => ({
      seat: Number(el.getAttribute('data-seat')),
      hero: el.classList.contains('hero'),
      rect: rectOf(el),
      cards: Array.from(el.querySelectorAll('.card')).map((c) => {
        const r = c.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }),
      overflowX: el.scrollWidth - el.clientWidth,
    }));
    const boardEl = document.querySelector('[data-testid="board"]');
    const feltEl = document.querySelector('[data-testid="felt"]');
    const nextHandButtons = Array.from(document.querySelectorAll('button')).filter((b) => {
      const visible = b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0;
      return visible && /下一手/.test(b.textContent ?? '');
    }).length;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      seats,
      board: boardEl ? rectOf(boardEl) : null,
      felt: feltEl ? rectOf(feltEl) : null,
      nextHandButtons,
      resultVisible: Array.from(document.querySelectorAll('h2')).some(
        (h) => (h.textContent ?? '').includes('本手结果'),
      ),
    };
  });
}

/** 两个矩形是否真的相交（忽略 ≤1px 的贴边，那是 1px 边框造成的视觉粘连）。 */
function intersects(a: Rect, b: Rect): boolean {
  const ox = Math.min(a.l + a.w, b.l + b.w) - Math.max(a.l, b.l);
  const oy = Math.min(a.t + a.h, b.t + b.h) - Math.max(a.t, b.t);
  return ox > 1 && oy > 1;
}

function describeRect(r: Rect): string {
  return `l=${r.l.toFixed(1)} t=${r.t.toFixed(1)} w=${r.w.toFixed(1)} h=${r.h.toFixed(1)}`;
}

/** 进桌（跳过开始界面）。 */
async function enterTable(page: Page): Promise<void> {
  await page.goto('/poker-trainer/?skip-lobby=1');
  await expect(page.locator('[data-testid="felt"]')).toBeVisible({ timeout: 30_000 });
}

/**
 * 用「设置」页把桌人数切到 n，然后重载页面——设置会持久化，重载后新的一手
 * 按新人数开局。走真实的设置页（而不是直接写 localStorage），因为玩家就是
 * 这么切的；顺带覆盖「切人数后仍能正常开局」。
 */
async function setSeatCount(page: Page, n: number): Promise<void> {
  await page.getByRole('tab', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '设置（Settings）' })).toBeVisible();
  await page.locator('select').first().selectOption(String(n));
  await page.getByRole('tab', { name: '牌桌' }).click();
  await page.reload();
  await expect(page.locator('[data-testid="felt"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.seat')).toHaveCount(n, { timeout: 15_000 });
}

/** 等玩家真正可以行动（此时座位布局稳定，没有入场动画）。 */
async function waitForHeroTurn(page: Page): Promise<void> {
  const fold = page.locator('[data-testid="action-my-turn"] button.danger');
  await expect(fold).toBeEnabled({ timeout: 60_000 });
}

/** 弃牌，等本手结算面板出现（AI 会把剩下的牌打完，最长约 20s）。 */
async function foldAndWaitForResult(page: Page): Promise<void> {
  const fold = page.locator('[data-testid="action-my-turn"] button.danger');
  await expect(fold).toBeEnabled({ timeout: 60_000 });
  await fold.click();
  await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 180_000 });
}

/**
 * 核心不变量：三视口 × 三人数的布局都必须满足这些条件。
 * @param phase 'play' 进行中 / 'result' 结算态
 */
function expectLayoutSane(snap: Snapshot, seatCount: number, phase: 'play' | 'result'): void {
  const tag = `${seatCount} 人桌（${phase}）`;

  // ---- 0. 渲染双射：座位节点数 = 人数，且座位号恰好覆盖 0..n-1 ----
  // 这是「九人桌漏画一名玩家」的直接回归断言。
  expect(snap.seats, `${tag} 座位节点数`).toHaveLength(seatCount);
  const seatNumbers = snap.seats.map((s) => s.seat).sort((a, b) => a - b);
  expect(seatNumbers, `${tag} data-seat 必须恰好覆盖 0..${seatCount - 1}（重复/缺失都是缺陷）`).toEqual(
    Array.from({ length: seatCount }, (_, i) => i),
  );

  // ---- 1. 座位两两不相交 ----
  for (let i = 0; i < snap.seats.length; i++) {
    for (let j = i + 1; j < snap.seats.length; j++) {
      const a = snap.seats[i]!;
      const b = snap.seats[j]!;
      expect(
        intersects(a.rect, b.rect),
        `${tag} 座位 ${a.seat} ${describeRect(a.rect)} 与座位 ${b.seat} ${describeRect(b.rect)} 重叠`,
      ).toBe(false);
    }
  }

  // ---- 2. 座位必须完整落在视口内（不出屏、不横向溢出）----
  for (const s of snap.seats) {
    expect(s.rect.l, `${tag} 座位 ${s.seat} 左边缘出屏`).toBeGreaterThanOrEqual(-EPS);
    expect(s.rect.t, `${tag} 座位 ${s.seat} 上边缘出屏`).toBeGreaterThanOrEqual(-EPS);
    expect(s.rect.l + s.rect.w, `${tag} 座位 ${s.seat} 右边缘出屏`).toBeLessThanOrEqual(
      snap.innerWidth + EPS,
    );
    expect(s.rect.t + s.rect.h, `${tag} 座位 ${s.seat} 下边缘出屏`).toBeLessThanOrEqual(
      snap.innerHeight + EPS,
    );
  }

  // ---- 3. 页面不得出现横向滚动 ----
  expect(snap.scrollWidth, `${tag} 出现横向滚动（scrollWidth > innerWidth）`).toBeLessThanOrEqual(
    snap.innerWidth,
  );

  // ---- 4. 公共牌区与任何座位都不相交（结算态尤其容易压住）----
  expect(snap.board, `${tag} 找不到公共牌区`).not.toBeNull();
  for (const s of snap.seats) {
    expect(
      intersects(s.rect, snap.board!),
      `${tag} 座位 ${s.seat} ${describeRect(s.rect)} 压住公共牌 ${describeRect(snap.board!)}`,
    ).toBe(false);
  }

  // ---- 5. 公共牌区必须完整在牌桌内 ----
  expect(snap.felt, `${tag} 找不到牌桌`).not.toBeNull();
  expect(snap.board!.l, `${tag} 公共牌区超出牌桌左边界`).toBeGreaterThanOrEqual(snap.felt!.l - EPS);
  expect(snap.board!.t, `${tag} 公共牌区超出牌桌上边界`).toBeGreaterThanOrEqual(snap.felt!.t - EPS);
  expect(snap.board!.l + snap.board!.w, `${tag} 公共牌区超出牌桌右边界`).toBeLessThanOrEqual(
    snap.felt!.l + snap.felt!.w + EPS,
  );

  // ---- 6. 底牌必须真的可见（缺陷里所有人的底牌都是 0×0）----
  for (const s of snap.seats) {
    expect(s.cards.length, `${tag} 座位 ${s.seat} 没有渲染底牌节点`).toBe(2);
    for (const [k, c] of s.cards.entries()) {
      expect(c.w, `${tag} 座位 ${s.seat} 第 ${k + 1} 张底牌宽度 ${c.w}px 不可见`).toBeGreaterThan(
        MIN_CARD_PX,
      );
      expect(c.h, `${tag} 座位 ${s.seat} 第 ${k + 1} 张底牌高度 ${c.h}px 不可见`).toBeGreaterThan(
        MIN_CARD_PX,
      );
    }
  }
  const hero = snap.seats.find((s) => s.hero);
  expect(hero, `${tag} 找不到玩家自己的座位（.seat.hero）`).toBeTruthy();

  // ---- 7. 座位内部不得被内容撑破 ----
  for (const s of snap.seats) {
    expect(
      s.overflowX,
      `${tag} 座位 ${s.seat} 内容横向溢出 ${s.overflowX}px（名字/筹码/徽章撑破座位）`,
    ).toBeLessThanOrEqual(1);
  }

  // ---- 8. 结算态：同屏只能有一个「下一手」入口 ----
  if (phase === 'result') {
    expect(snap.resultVisible, `${tag} 结算面板未出现`).toBe(true);
    expect(
      snap.nextHandButtons,
      `${tag} 同屏出现 ${snap.nextHandButtons} 个「下一手」按钮（操作面板与结算面板重复）`,
    ).toBe(1);
  }
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const n of SEAT_COUNTS) {
      test(`${n} 人桌：座位不重叠、不出屏、不压公共牌、底牌可见、无横向滚动`, async ({ page }) => {
        const errors: string[] = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') errors.push(msg.text());
        });
        page.on('pageerror', (err) => errors.push(String(err)));

        await enterTable(page);
        await setSeatCount(page, n);
        await waitForHeroTurn(page);

        // 进行中
        const playing = await measure(page);
        expectLayoutSane(playing, n, 'play');

        // 结算态（弃牌 → AI 把剩下的牌打完 → 结算面板）
        await foldAndWaitForResult(page);
        const settled = await measure(page);
        expectLayoutSane(settled, n, 'result');

        expect(errors, `${n} 人桌控制台不应有错误`).toEqual([]);
      });
    }
  });
}
