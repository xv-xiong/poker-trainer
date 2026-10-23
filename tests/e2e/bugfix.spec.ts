/**
 * 缺陷回归 E2E（在真实浏览器里断言，不依赖单元层的坐标推导）：
 *
 *   1. 六人桌每名 AI 都渲染出 2 张底牌；
 *   2. 座位在屏幕上的顺时针顺序 == 座次顺序（从玩家出发）；
 *   3. 筹码飞行动画播完后不残留可见元素。
 *
 * 为什么必须用浏览器断言：这两个缺陷都只在「渲染结果」上可见——
 * 单元测试能证明坐标与座次的映射关系，但证明不了 DOM 里真的出现了牌节点。
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * 用指定桌人数进入牌桌。
 *
 * 不用「固定 sleep 后读 localStorage」：那假设状态在某个墙钟时间内一定已写入，
 * 机器繁忙时会在写入前就读到 null，导致设置没改成、后续断言假失败
 * （评估报告 M5 记录的脆弱模式）。改为显式等待条件成立。
 */
async function enterWithSeatCount(page: Page, seatCount: number): Promise<void> {
  await page.goto('/poker-trainer/?skip-lobby=1');
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
  // 等状态真正落库（而不是赌 800ms 足够）
  await page
    .waitForFunction(() => localStorage.getItem('poker-trainer:state') !== null, null, { timeout: 15_000 })
    .catch(() => {});
  // 写入设置后重载，确保以目标人数开局
  await page.evaluate((n) => {
    const key = 'poker-trainer:state';
    let st: Record<string, unknown> | null = null;
    try {
      st = JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      st = null;
    }
    if (st && typeof st.settings === 'object' && st.settings !== null) {
      (st.settings as Record<string, unknown>).seatCount = n;
      localStorage.setItem(key, JSON.stringify(st));
    }
  }, seatCount);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="felt"]', { timeout: 30_000 });
  // 等座位真正渲染到目标人数（而不是赌 1500ms 足够）
  await page.waitForFunction(
    (n) => document.querySelectorAll('.seat').length === n,
    seatCount,
    { timeout: 15_000 },
  );
}

test.describe('缺陷回归：六人桌底牌显示与座次顺序', () => {
  test('六人桌每个座位都渲染出 2 张底牌（曾有两名 AI 完全不显示）', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await enterWithSeatCount(page, 6);

    const seats = await page.evaluate(() =>
      [...document.querySelectorAll('.seat')].map((s) => ({
        seat: Number(s.getAttribute('data-seat')),
        cards: s.querySelectorAll('.seat-cards .card').length,
      })),
    );

    expect(seats.length, '六人桌应渲染 6 个座位').toBe(6);
    for (const s of seats) {
      expect(s.cards, `座位 ${s.seat} 的底牌节点数`).toBe(2);
    }
    expect(errors).toEqual([]);
  });

  test('座位的屏幕顺时针顺序等于座次顺序（从玩家座位出发）', async ({ page }) => {
    await enterWithSeatCount(page, 6);

    const result = await page.evaluate(() => {
      const seats = [...document.querySelectorAll('.seat')].map((s) => {
        const r = s.getBoundingClientRect();
        return {
          seat: Number(s.getAttribute('data-seat')),
          hero: s.classList.contains('hero'),
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
        };
      });
      if (seats.length === 0) return null;
      const ox = seats.reduce((a, s) => a + s.cx, 0) / seats.length;
      const oy = seats.reduce((a, s) => a + s.cy, 0) / seats.length;
      const sorted = seats
        .map((s) => ({ seat: s.seat, ang: (Math.atan2(s.cx - ox, oy - s.cy) + 2 * Math.PI) % (2 * Math.PI) }))
        .sort((a, b) => a.ang - b.ang)
        .map((x) => x.seat);
      const heroSeat = seats.find((s) => s.hero)?.seat ?? 0;
      const at = sorted.indexOf(heroSeat);
      return { order: [...sorted.slice(at), ...sorted.slice(0, at)], heroSeat, n: seats.length };
    });

    expect(result).not.toBeNull();
    const { order, heroSeat, n } = result!;
    const expected = Array.from({ length: n }, (_, i) => (heroSeat + i) % n);
    expect(order, `从玩家座位 ${heroSeat} 出发的屏幕顺时针顺序`).toEqual(expected);
  });

  test('行动光晕在同一街内按顺时针推进，不出现「跳回」', async ({ page }) => {
    await enterWithSeatCount(page, 6);

    /**
     * 采样「当前行动座位」「已亮相公共牌数」与「当前不能行动的座位」。
     *
     * 为什么必须带上公共牌数：跨街时行动权会**重置**为「庄家左侧第一个可行动者」，
     * 该座位完全可能在上一条街最后行动者的**后方**（例如翻前最后由庄家/按钮行动，
     * 翻后却从庄家左侧开始）。因此「全局单调递增」不是正确的不变量——
     * 正确的不变量是「**同一街内**严格顺时针前进」。早前本测试漏了这一层，
     * 把合法的跨街重置误判为缺陷（已修正）。
     *
     * 为什么不能直接断言「步进距离 <= 3」：行动权只跳过**不能行动**的座位——
     * 已弃牌、已全下、以及玩家自己（玩家的座位不出现思考光晕，其动作对本采样不可见）。
     * 弃牌率提高后，同一街内出现 `3 -> 1`（中间 4、5 已弃牌）是完全合法的，
     * 距离最大可达 n-1，用距离阈值会把它误判成「跳回」。
     * 因此判据改为「跳过的每一个中间座位都必须不能行动」——这比距离阈值更强也更准确。
     */
    const steps: Array<{
      seat: number;
      street: number;
      folded: number[];
      allIn: number[];
      hero: number;
    }> = [];
    for (let i = 0; i < 220; i++) {
      const snap = await page.evaluate(() => {
        const a = document.querySelector('.seat.active');
        const revealed = document.querySelector('[data-testid="board"]')?.getAttribute('data-revealed');
        const folded: number[] = [];
        const allIn: number[] = [];
        let hero = -1;
        for (const el of Array.from(document.querySelectorAll('.seat'))) {
          const idx = Number(el.getAttribute('data-seat'));
          if (el.classList.contains('folded')) folded.push(idx);
          if (el.classList.contains('hero')) hero = idx;
          if (el.querySelector('.badge.allin')) allIn.push(idx);
        }
        return {
          seat: a ? Number(a.getAttribute('data-seat')) : null,
          street: Number(revealed ?? 0),
          folded,
          allIn,
          hero,
        };
      });
      if (snap.seat !== null) {
        const last = steps[steps.length - 1];
        if (!last || last.seat !== snap.seat || last.street !== snap.street) {
          steps.push({
            seat: snap.seat,
            street: snap.street,
            folded: snap.folded,
            allIn: snap.allIn,
            hero: snap.hero,
          });
        }
      }
      if (await page.getByRole('heading', { name: '本手结果' }).isVisible().catch(() => false)) break;
      const btn = page.getByRole('button', { name: /跟注|过牌/ }).first();
      if ((await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false))) {
        await btn.click({ timeout: 4000 }).catch(() => {});
      }
      await page.waitForTimeout(110);
    }

    expect(steps.length, '应观察到若干次行动').toBeGreaterThan(2);

    // 仅在同一街内断言顺时针：行动权只能顺时针前进，且跳过的座位必须不能行动
    const N = 6;
    let sameStreetChecks = 0;
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const cur = steps[i];
      if (cur.street !== prev.street) continue; // 跨街重置，跳过
      sameStreetChecks++;
      const d = (cur.seat - prev.seat + N) % N;
      expect(d, `同街内行动 ${prev.seat} -> ${cur.seat} 不应原地重复`).not.toBe(0);
      // 中间被跳过的座位必须「不能行动」：已弃牌 / 已全下 / 玩家自己（玩家动作不显示思考光晕）
      for (let k = 1; k < d; k++) {
        const s = (prev.seat + k) % N;
        const cannotAct = cur.folded.includes(s) || cur.allIn.includes(s) || s === cur.hero;
        expect(
          cannotAct,
          `同街内 ${prev.seat} -> ${cur.seat} 跳过了仍可行动的座位 ${s}` +
            `（folded=${cur.folded.join(',')} allIn=${cur.allIn.join(',')} hero=${cur.hero}）`,
        ).toBe(true);
      }
    }
    expect(sameStreetChecks, '应至少观察到一次同街内的连续行动').toBeGreaterThan(0);
  });

  test('筹码飞行动画的终态必须完全透明（用样式表断言，避免与「新动作刚开始」竞争）', async ({
    page,
  }) => {
    await enterWithSeatCount(page, 6);

    /**
     * 为什么读样式表而不是读某个元素的瞬时 opacity：
     * `.chip-fly` 每次动作都会重新挂载并从头播放动画，若在固定延时后采样
     * 「当前所有 .chip-fly 的 opacity」，很可能正好撞上一个**刚开始**的新动画，
     * 于是拿到 opacity≈1 而误报残留（早前本测试即因此偶发失败）。
     *
     * 真正要锁的不变量是「动画终态（100% 关键帧）为 opacity: 0」——
     * 因为 `.chip-fly` 使用 `animation-fill-mode: both`，终态会被永久保留。
     * 这条断言与时机无关，完全确定。
     */
    const keyframe = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRule[];
        try {
          rules = Array.from(sheet.cssRules ?? []);
        } catch {
          continue;
        }
        for (const rule of rules) {
          const r = rule as CSSKeyframesRule;
          if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'sc-chip-fly') {
            const frames = Array.from(r.cssRules).map((k) => {
              const kf = k as CSSKeyframeRule;
              return { key: kf.keyText, css: kf.style.cssText };
            });
            return frames;
          }
        }
      }
      return null;
    });

    expect(keyframe, '应能在样式表中找到 @keyframes sc-chip-fly').not.toBeNull();
    const last = keyframe!.find((f) => f.key === '100%');
    expect(last, 'sc-chip-fly 必须显式定义 100% 关键帧').toBeTruthy();
    expect(
      /opacity:\s*0(\.0+)?\s*;?/.test(last!.css),
      `sc-chip-fly 的 100% 关键帧必须为 opacity: 0（实际：${last!.css}）。` +
        '若终态保留不透明度，因 fill-mode: both，筹码会永久停在底池上。',
    ).toBe(true);
  });
});
