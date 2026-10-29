/**
 * 端到端测试（验收闸门 G8）。
 *
 * 断言：
 *   1. 页面可加载且无 console error
 *   2. 能完成一整手对局（发牌 → 动作 → 结算）
 *   3. 复盘面板展示决策数据
 *   4. 历史记录条数 +1
 *   5. 快捷键可用
 *   6. 移动端竖屏布局可用
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/** 收集 console error 与页面异常。 */
function attachErrorCollector(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return { errors };
}

/**
 * 若轮到自己行动则持续过牌/跟注，直到本手结束。
 *
 * 为什么用「截止时间」而不是「固定循环次数」：
 * 分步演出让每个 AI 动作都带约 560ms 的思考停顿，一手牌的墙钟时间比
 * 「一次跑完」的旧实现长得多。此前用 80 次循环，在 CI 或机器繁忙时
 * 会在本手还没结束时就退出循环，导致后续 `本手结果` 断言超时——
 * 实测全量跑 E2E 时每 3 次有 2 次失败（已复现）。
 * 改为 deadline 驱动后，只要手牌仍在推进就会继续等，不再与机器速度耦合。
 */
async function playHandToCompletion(
  page: Page,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 结束标志：结算面板出现，或行动区显示「本手已结束」
    const resultVisible = await page
      .getByRole('heading', { name: '本手结果' })
      .isVisible()
      .catch(() => false);
    if (resultVisible) return;
    const overVisible = await page
      .getByRole('button', { name: '下一手（Next Hand）' })
      .isVisible()
      .catch(() => false);
    if (overVisible) return;

    // 轮到自己时跟注/过牌。
    // 必须扫描**所有**候选按钮而不是取 `.first()`：仪表盘在等待态也会渲染同名
    // 但禁用的按钮，DOM 顺序上它可能排在可点按钮之前，取 first 会一直读到
    // 「不可用」从而空转到超时（曾把一手牌拖到 300s 测试超时）。
    const candidates = page.getByRole('button', { name: /跟注|过牌/ });
    const total = await candidates.count();
    let clicked = false;
    for (let i = 0; i < total; i++) {
      const b = candidates.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      if (!(await b.isEnabled().catch(() => false))) continue;
      await b.click({ timeout: 5000 }).catch(() => {});
      clicked = true;
      break;
    }
    if (clicked) {
      await page.waitForTimeout(180);
      continue;
    }
    await page.waitForTimeout(220);
  }
  // 到点仍未结束必须显式报错。
  // 旧实现这里直接 `return`，于是「本手没打完」被伪装成下游 `本手结果` 断言
  // 超时——排查时只能看到一句无关的 toBeVisible 失败，无法区分「手牌卡住」
  // 与「结算面板没渲染」。
  throw new Error(`playHandToCompletion 超时（${timeoutMs}ms）：本手仍未结束`);
}

/**
 * 从开始界面进入牌桌。
 *
 * 为什么需要这一步：应用新增了开始界面（`StartScreen`），首访不再直接发牌。
 * 既有用例全部是「goto 后立刻开打」的写法，故统一在此处补上「点击进入」，
 * 既保证既有断言不变，也让每条用例都真实覆盖「从入口进桌」这条路径。
 */
async function enterTable(page: Page): Promise<void> {
  const start = page.getByRole('button', { name: '开始练习' });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
  }
  await page.waitForSelector('[role="tab"]', { timeout: 30_000 });
}

test.describe('G8 端到端全链路', () => {
  test('页面加载无 console error 且能完成一整手对局', async ({ page }) => {
    const { errors } = attachErrorCollector(page);

    await page.goto('/poker-trainer/');
    await enterTable(page);
    await expect(page.getByRole('heading', { name: '德州扑克练习台' })).toBeVisible();

    // 牌桌渲染：底池与公共牌区存在
    await expect(page.getByText('底池（Pot）')).toBeVisible();
    await expect(page.getByRole('button', { name: /下一手|跟注|过牌|弃牌/ }).first()).toBeVisible();

    // 完成一整手
    await playHandToCompletion(page);

    // 结算面板出现，说明本手已结束
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 30_000 });

    // 无 console error
    expect(errors).toEqual([]);
  });

  test('复盘面板展示决策数据（含底池赔率与胜率原始数据）', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await enterTable(page);
    await playHandToCompletion(page);

    await page.getByRole('tab', { name: '复盘' }).click();
    await expect(page.getByRole('heading', { name: '决策复盘（Hand Review）' })).toBeVisible();

    // 计划强制要求：必须展示原始数据列
    await expect(page.getByRole('columnheader', { name: '底池赔率' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '估算胜率' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'EV 损失' })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('结算面板展示分配明细：主池 / 边池 / 未跟注退还分行', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await enterTable(page);
    await playHandToCompletion(page);
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 30_000 });

    // 明细区必须出现（只有金额 > 0 的层才会产生行，故断言「表头存在」而非固定行数）
    await expect(page.getByRole('heading', { name: '分配明细（主池 / 边池 / 未跟注退还）' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '类型' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '金额' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '归属' })).toBeVisible();

    // 至少有一行，且每行金额为正整数、已解析出归属名
    const rows = page.locator('.settlement-table tbody tr');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const amountText = await rows.nth(i).locator('td').nth(1).innerText();
      const amount = Number(amountText.trim());
      expect(Number.isInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0);
      const who = (await rows.nth(i).locator('td').nth(2).innerText()).trim();
      expect(who.length).toBeGreaterThan(0);
    }

    expect(errors).toEqual([]);
  });

  test('单挑小盲弃牌时，结算面板出现「未跟注退还」行（确定性场景）', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await enterTable(page);

    // 固定为 2 人桌：这是**必然**产生「未跟注退还」的可控局面。
    // 单挑盲注 5/10 → 我（庄家即小盲）投 5、AI 投 10。我弃牌后：
    //   层 1：level 5  → 2 名投入者 × 5 = 10 → 主池（contested）
    //   层 2：level 10 → 1 名投入者 × 5 = 5  → 未跟注退还（uncalled）
    // 6 人桌全下时 5 个 AI 都会跟注，永远凑不出未注层，故必须用单挑。
    //
    // 注意：首次加载时 localStorage 为空（App 只在动作后才写状态），
    // 因此不能只做「读出来改一下」——必须准备好一份完整状态再 reload，
    // 否则 seatCount 仍是 6，测试会因场景不成立而失败（曾如此踩坑）。
    await page.evaluate(() => {
      const key = 'poker-trainer:state';
      let st: Record<string, unknown> | null = null;
      try {
        const raw = localStorage.getItem(key);
        st = raw ? JSON.parse(raw) : null;
      } catch {
        st = null;
      }
      if (!st || typeof st.settings !== 'object' || st.settings === null) {
        st = {
          schemaVersion: 1,
          bankroll: 1000,
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
          settings: {
            seatCount: 2,
            startingStack: 1000,
            smallBlind: 5,
            bigBlind: 10,
            aiTier: 'medium',
            fourColorDeck: true,
            showShortcuts: true,
            enableFlopExact: false,
          },
          nextDealerSeat: 0,
          handCounter: 0,
        };
      } else {
        (st.settings as Record<string, unknown>).seatCount = 2;
      }
      localStorage.setItem(key, JSON.stringify(st));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await enterTable(page);
    // 不用固定 sleep：等牌桌真正按 2 人桌渲染出来（评估报告 M5 的脆弱模式）
    await page.waitForFunction(() => document.querySelectorAll('.seat').length === 2, null, {
      timeout: 15_000,
    });

    // 轮到我立刻弃牌：显式等待按钮可用，不用固定轮询 + sleep
    const foldBtn = page.getByRole('button', { name: '弃牌（Fold）' }).first();
    await expect(foldBtn).toBeEnabled({ timeout: 40_000 });
    await foldBtn.click({ timeout: 5000 });

    await expect(page.getByRole('heading', { name: '分配明细（主池 / 边池 / 未跟注退还）' })).toBeVisible({
      timeout: 30_000,
    });
    // 必须同时出现主池行与未跟注退还行
    await expect(page.locator('.settlement-table tbody tr', { hasText: '主池' }).first()).toBeVisible();
    const refundRow = page.locator('.settlement-table tbody tr', { hasText: '未跟注退还' }).first();
    await expect(refundRow).toBeVisible();

    // 退还行金额为正，且归属非空
    const amount = Number((await refundRow.locator('td').nth(1).innerText()).trim());
    expect(Number.isInteger(amount)).toBe(true);
    expect(amount).toBeGreaterThan(0);
    expect((await refundRow.locator('td').nth(2).innerText()).trim().length).toBeGreaterThan(0);

    expect(errors).toEqual([]);
  });

  test('历史记录在本手结束后增加一条', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await enterTable(page);

    // 先看初始条数
    await page.getByRole('tab', { name: '历史' }).click();
    await expect(page.getByRole('heading', { name: '手牌历史（Hand History）' })).toBeVisible();
    const before = await page.locator('table tbody tr').count();

    // 打一手
    await page.getByRole('tab', { name: '牌桌' }).click();
    await playHandToCompletion(page);
    await expect(page.getByRole('heading', { name: '本手结果' })).toBeVisible({ timeout: 30_000 });

    // 再看条数
    await page.getByRole('tab', { name: '历史' }).click();
    const after = await page.locator('table tbody tr').count();
    expect(after).toBeGreaterThan(before);

    // 导出按钮可用（数据已落库）
    await expect(page.getByRole('button', { name: '导出 JSON' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '导出 CSV' })).toBeEnabled();

    expect(errors).toEqual([]);
  });

  test('统计面板展示 VPIP 等指标', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await enterTable(page);
    await playHandToCompletion(page);
    await page.getByRole('tab', { name: '统计' }).click();
    await expect(page.getByRole('heading', { name: '统计（Statistics）' })).toBeVisible();
    await expect(page.getByText('入池率 VPIP', { exact: true })).toBeVisible();
    await expect(page.getByText('翻牌前加注率 PFR', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('提示按钮可用且展示胜率与底池赔率', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await enterTable(page);

    // 等到提示按钮真正可点（而不是固定轮询 40 次后可能一次都没点到就静默通过）
    const hintBtn = page.getByRole('button', { name: /查看提示/ });
    await expect(hintBtn).toBeEnabled({ timeout: 40_000 });
    await hintBtn.click();
    await expect(page.getByText('估算胜率')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('底池赔率要求', { exact: true })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('快捷键 F 可弃牌', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await enterTable(page);

    // 等到弃牌按钮真正可用（而不是固定轮询若干次后盲按）
    const foldBtn = page.getByRole('button', { name: '弃牌（Fold）' });
    await expect(foldBtn).toBeEnabled({ timeout: 40_000 });
    const before = await page.locator('.action-panel').innerText();
    await page.keyboard.press('f');
    // 断言按键真的生效：行动区发生变化（进入等待态或本手结束）
    await expect(page.locator('.action-panel')).not.toHaveText(before, { timeout: 15_000 });

    expect(errors).toEqual([]);
  });

  test('设置面板可切换四色牌与桌人数', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await enterTable(page);
    await page.getByRole('tab', { name: '设置' }).click();
    await expect(page.getByRole('heading', { name: '设置（Settings）' })).toBeVisible();

    // 按无障碍名称定位：设置面板里不止一个复选框，用 .first() 会随面板顺序漂移
    const fourColor = page.getByRole('checkbox', { name: '四色牌' });
    await fourColor.uncheck();
    await expect(page.locator('.app')).toHaveClass(/two-color/);
    await fourColor.check();
    await expect(page.locator('.app')).not.toHaveClass(/two-color/);

    // 切到 2 人桌后仍可开局
    await page.locator('select').first().selectOption('2');
    await page.getByRole('tab', { name: '牌桌' }).click();
    await expect(page.getByText('底池（Pot）')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('移动端竖屏（375x667）布局可用', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/poker-trainer/');
    await enterTable(page);
    await expect(page.getByRole('heading', { name: '德州扑克练习台' })).toBeVisible();
    await expect(page.getByText('底池（Pot）')).toBeVisible();
    // 手机端隐藏快捷键提示
    await expect(page.locator('.keyhints').first()).toBeHidden();
    expect(errors).toEqual([]);
  });
});

/**
 * 开始界面（StartScreen）与风格令牌。
 *
 * 断言口径刻意选「用户能看到什么 / 浏览器实际算什么」，而不是「class 名对不对」：
 * 前者能挡住「DOM 在但看不见」的假绿，后者只证明代码写了自己想写的字符串。
 */
test.describe('开始界面与风格令牌', () => {
  test('首访显示开始界面：标题、参数、战绩与进入按钮齐备', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');

    // 首访不直接进牌桌：此时还没有牌桌与标签栏
    await expect(page.locator('.lobby')).toBeVisible();
    // 标题含 <br> 换行，无障碍名会变成「先想清楚， 再上桌。」（换行被读成空格），
    // 故用正则匹配半句，避免被排版细节绑死。
    await expect(page.getByRole('heading', { name: /先想清楚/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始练习' })).toBeVisible();
    expect(await page.locator('[role="tab"]').count()).toBe(0);

    // 建桌参数四项：桌人数 / AI 难度 / 起始筹码 / 盲注（阶段 2-1 起在首屏可编辑，
    // 故断言控件的 value 而不是只读文本——这比旧的 toContainText 更强：
    // 文本对得上但控件没接上受控值时，旧断言会漏过）。
    await expect(page.locator('[data-testid="lobby-setup"]')).toBeVisible();
    await expect(page.locator('.lobby-field')).toHaveCount(4);
    // 无存档时展示默认值：6 人桌 / 中等 / 起始筹码 1000 / 盲注 5 与 10
    await expect(page.getByTestId('lobby-seat-count')).toHaveValue('6');
    await expect(page.getByTestId('lobby-ai-tier')).toHaveValue('medium');
    await expect(page.getByTestId('lobby-starting-stack')).toHaveValue('1000');
    await expect(page.getByTestId('lobby-small-blind')).toHaveValue('5');
    await expect(page.getByTestId('lobby-big-blind')).toHaveValue('10');

    // 战绩区三项
    await expect(page.locator('.lobby-record .rock')).toHaveCount(3);
    // 无存档时明确告知展示的是默认值（不假装读到了战绩）
    await expect(page.locator('.lobby-record-note')).toContainText('本机还没有战绩');

    // 规则要点默认折叠（内容仍在 DOM 里，故断言「不可见」而非「不存在」），
    // 点开后四条要点可见
    const rules = page.locator('details.lobby-rules');
    await expect(rules).toBeVisible();
    await expect(rules.locator('ul li').first()).toBeHidden();
    await rules.locator('summary').click();
    await expect(rules.locator('ul li')).toHaveCount(4);
    await expect(rules.locator('ul li').first()).toBeVisible();
    await expect(rules).toHaveAttribute('open', '');

    expect(errors).toEqual([]);
  });

  test('点击「开始练习」进入牌桌并开始发牌', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await expect(page.locator('.lobby')).toBeVisible();

    await page.getByRole('button', { name: '开始练习' }).click();

    // 开始界面消失、牌桌出现：底池、公共牌区、座位与标签栏都在
    await expect(page.locator('.lobby')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '德州扑克练习台' })).toBeVisible();
    await expect(page.getByText('底池（Pot）')).toBeVisible();
    await expect(page.locator('.felt')).toBeVisible();
    await expect(page.locator('.seat').first()).toBeVisible();
    await expect(page.getByRole('tab', { name: '牌桌' })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('开始界面读出本地存档：已打手数与资金来自 localStorage', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');

    // 写入一份完整存档后再刷新，验证开始界面确实「读了 localStorage」而非写死默认值
    await page.evaluate(() => {
      localStorage.setItem(
        'poker-trainer:state',
        JSON.stringify({
          schemaVersion: 1,
          bankroll: 1480,
          stats: {
            handsPlayed: 42,
            handsWon: 17,
            showdownsSeen: 9,
            showdownsWon: 6,
            totalWagered: 3100,
            netProfit: 480,
            vpipHands: 21,
            pfrHands: 8,
            hintsUsed: 3,
            reviewCounts: { ok: 30, review: 8, major: 4 },
            topUps: 0,
            topUpAmount: 0,
          },
          settings: {
            seatCount: 9,
            startingStack: 2000,
            smallBlind: 10,
            bigBlind: 20,
            aiTier: 'hard',
            fourColorDeck: true,
            showShortcuts: true,
            enableFlopExact: false,
          },
          nextDealerSeat: 0,
          handCounter: 42,
        }),
      );
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('lobby-seat-count')).toHaveValue('9');
    await expect(page.getByTestId('lobby-ai-tier')).toHaveValue('hard');
    await expect(page.getByTestId('lobby-starting-stack')).toHaveValue('2000');
    await expect(page.getByTestId('lobby-small-blind')).toHaveValue('10');
    await expect(page.getByTestId('lobby-big-blind')).toHaveValue('20');

    const rocks = page.locator('.lobby-record .rock');
    await expect(rocks.nth(0).locator('.rv')).toHaveText('42'); // 已打手数
    await expect(rocks.nth(1).locator('.rv')).toHaveText('1480'); // 当前资金
    await expect(rocks.nth(2).locator('.rv')).toHaveText('+480'); // 累计盈亏

    expect(errors).toEqual([]);
  });

  test('风格令牌生效：牌桌为径向渐变绿绒，主按钮为金色', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');

    // 令牌层必须真的加载进来，且主色指向参考站金色
    const tokenGold = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--gold').trim(),
    );
    expect(tokenGold.toLowerCase()).toBe('#e7c183');

    // 大标题用开始界面的 68px 规格（令牌 --fs-display）
    const h1Size = await page
      .getByRole('heading', { name: /先想清楚/ })
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(parseFloat(h1Size)).toBeGreaterThanOrEqual(60);

    // 主按钮：金色底 + 深色字（对比度而非「看着像金色」）
    const startBg = await page
      .getByRole('button', { name: '开始练习' })
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(startBg).toBe('rgb(231, 193, 131)');

    await page.getByRole('button', { name: '开始练习' }).click();
    await expect(page.locator('.felt')).toBeVisible();

    // 牌桌背景必须是 radial-gradient（验收点名要求）
    const feltBg = await page
      .locator('.felt')
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(feltBg).toContain('radial-gradient');
    expect(feltBg).toContain('rgb(33, 99, 74)'); // #21634a 内圈绿

    // 牌面：米白底 + 深墨字；牌背为斜纹
    const cardBg = await page
      .locator('.card:not(.hidden):not(.placeholder)')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(cardBg).toBe('rgb(244, 241, 231)'); // #f4f1e7

    expect(errors).toEqual([]);
  });

  test('四色牌与两色牌切换生效（花色配色收口在 CSS 变量上）', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');
    await enterTable(page);

    // 发牌是随机的，某一种花色不一定会出现在本手牌面上，
    // 故不能靠「牌桌上碰巧有方块」来断言配色。
    // 这里直接往牌桌上挂四张探针牌，走真实的样式层叠（真正的 CSS 级验证），
    // 测量完立刻移除，不会影响其它断言。
    const measure = () =>
      page.evaluate(() => {
        const felt = document.querySelector('.felt') as HTMLElement;
        const made: HTMLElement[] = [];
        const out: Record<string, string> = {};
        for (const suit of ['spade', 'heart', 'diamond', 'club']) {
          const el = document.createElement('div');
          // 类名必须与 CardView 输出的一致（suit-heart 等），否则命中不到花色规则
          el.className = `card suit-${suit}`;
          felt.appendChild(el);
          made.push(el);
          out[suit] = getComputedStyle(el).color;
        }
        for (const el of made) el.remove();
        return out;
      });

    // 默认四色：♠黑 ♥红 ♦蓝 ♣绿（对色觉障碍者更友好）
    const four = await measure();
    expect(four.spade).toBe('rgb(33, 49, 42)'); // #21312a
    expect(four.heart).toBe('rgb(191, 78, 72)'); // #bf4e48
    expect(four.diamond).toBe('rgb(36, 103, 168)'); // #2467a8
    expect(four.club).toBe('rgb(47, 122, 74)'); // #2f7a4a

    // 切到传统两色
    await page.getByRole('tab', { name: '设置' }).click();
    const fourColorSwitch = page.getByRole('checkbox', { name: '四色牌' });
    await fourColorSwitch.uncheck();
    await expect(page.locator('.app')).toHaveClass(/two-color/);
    await page.getByRole('tab', { name: '牌桌' }).click();
    await expect(page.locator('.felt')).toBeVisible();

    // 两色模式：♠/♣ 同为墨色，♥/♦ 同为红（参考站 .playing-card.red 同色）
    const two = await measure();
    expect(two.spade).toBe('rgb(33, 49, 42)');
    expect(two.club).toBe('rgb(33, 49, 42)');
    expect(two.heart).toBe('rgb(191, 78, 72)');
    expect(two.diamond).toBe('rgb(191, 78, 72)');

    // 切回四色，确认可逆
    await page.getByRole('tab', { name: '设置' }).click();
    await fourColorSwitch.check();
    await expect(page.locator('.app')).not.toHaveClass(/two-color/);
    await page.getByRole('tab', { name: '牌桌' }).click();
    await expect(page.locator('.felt')).toBeVisible();
    expect((await measure()).diamond).toBe('rgb(36, 103, 168)');

    expect(errors).toEqual([]);
  });

  test('开始界面在手机竖屏（375x667）可读且按钮可点', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/poker-trainer/');

    await expect(page.getByRole('heading', { name: /先想清楚/ })).toBeVisible();
    await expect(page.locator('.lobby-field')).toHaveCount(4);

    // 按钮必须落在视口内（不能被横向溢出挤到看不见）
    const box = await page.getByRole('button', { name: '开始练习' }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);

    // 装饰牌在小屏隐藏，避免挤占首屏
    await expect(page.locator('.deck-decor')).toBeHidden();

    await page.getByRole('button', { name: '开始练习' }).click();
    await expect(page.getByText('底池（Pot）')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('首访不出牌：开始界面上没有任何对局动作按钮，也没写存档', async ({ page }) => {
    const { errors } = attachErrorCollector(page);
    await page.goto('/poker-trainer/');

    await expect(page.locator('.lobby')).toBeVisible();
    // 未进桌前不应存在牌桌与行动按钮（也就不会自动发牌 / 下盲注）
    await expect(page.locator('.felt')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '弃牌（Fold）' })).toHaveCount(0);
    await expect(page.getByText('底池（Pot）')).toHaveCount(0);

    // 只看一眼不应产生任何存档写入
    const stored = await page.evaluate(() => localStorage.getItem('poker-trainer:state'));
    expect(stored).toBeNull();

    expect(errors).toEqual([]);
  });
});
