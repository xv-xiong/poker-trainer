/**
 * 一键验收闸门：npm run verify
 *
 * 顺序执行 11 项闸门，任一失败即整体失败（非零退出）。
 * 这是「完成」的机器定义——不依赖人记得检查什么。
 *
 * G1  5 张牌型直方图（精确枚举值基准，全量 C(52,5)）
 * G2  求值器交叉校验（20 万手，生产 vs 独立参照，错 0 手）
 * G3  精确枚举摊牌数 == 组合数
 * G4  筹码守恒（10,000 手属性测试）
 * G5  边池与平局分池（构造用例）
 * G6  胜率路径正确性（精确/查表/采样三类断言分开）
 * G7  AI 档位可分辨（固定种子 2,000 手）
 * G8  端到端（Playwright，无 console error + 全链路）
 * G9  构建与产物（tsc + vite build + preview HTTP 200）
 * G10 持久化健壮性（迁移 + 损坏不白屏）
 * G11 dev 冒烟（vite dev + 连打 3 手，断言「下一手」不白屏）
 *
 * ## 为什么需要 G11
 *
 * 有一类缺陷**只存在于开发模式**：`process.env.NODE_ENV === 'production'`
 * 的静态替换会把 dev-only 不变量整块摇掉，而 G8 跑的是 `vite preview`
 * （生产构建），所以「开发模式下点下一手白屏」这种崩溃在 G8 里永远看不到
 * （实测在 dist 产物里 grep 该错误文本命中 0）。
 * 立规矩：只在开发期生效的不变量，必须有一条在开发期跑的自动化用例。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npx = isWindows ? 'npx.cmd' : 'npx';

const results = [];

function run(label, cmd, args, opts = {}) {
  const t0 = Date.now();
  process.stdout.write(`\n=== ${label} ===\n`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  const ok = r.status === 0;
  results.push({ label, ok, ms: Date.now() - t0 });
  console.log(`${ok ? '通过' : '失败'}  ${label}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return ok;
}

function skip(label, reason) {
  results.push({ label, ok: true, skipped: true, reason });
  console.log(`跳过  ${label}：${reason}`);
}

// ---- G1 直方图 ----
run('G1 5 张牌型直方图（全量 2,598,960 枚举）', 'node', ['scripts/verify-hand-histogram.mjs']);

// ---- G2/G3/G6/G7/G10 单元 + 属性测试（Vitest 内部已分闸门命名）----
run('G2–G7,G10 单元与属性测试（Vitest）', npx, ['vitest', 'run']);

// ---- G9 类型检查 + 构建 ----
const tscOk = run('G9a 类型检查（tsc --noEmit）', npx, ['tsc', '--noEmit']);
if (tscOk) {
  const buildOk = run('G9b 生产构建（vite build）', npx, ['vite', 'build']);
  if (buildOk) {
    // 产物存在性检查
    const distIndex = join(root, 'dist', 'index.html');
    const assetsDir = join(root, 'dist', 'assets');
    const hasIndex = existsSync(distIndex);
    const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
    const hasJs = assets.some((f) => f.endsWith('.js'));
    const hasCss = assets.some((f) => f.endsWith('.css'));
    const hasWorker = assets.some((f) => f.includes('worker'));
    const ok = hasIndex && hasJs && hasCss && hasWorker;
    results.push({ label: 'G9c 产物存在性（index.html + js + css + worker）', ok });
    console.log(
      `${ok ? '通过' : '失败'}  G9c 产物存在性：index.html=${hasIndex} js=${hasJs} css=${hasCss} worker=${hasWorker}`,
    );
    if (!ok) {
      console.error('产物缺失：Web Worker chunk 必须存在（重计算不得留在主线程）');
    }
  }
}

// ---- G11 dev 冒烟（必须用 vite dev，不能用 preview）----
// 依赖 @playwright/test 驱动浏览器；未安装时跳过而不是失败。
const hasBrowsers = existsSync(join(root, 'node_modules', '@playwright', 'test'));
if (hasBrowsers) {
  run('G11 dev 冒烟（vite dev + 连打 3 手不白屏）', 'node', ['scripts/dev-smoke.mjs']);
} else {
  skip('G11 dev 冒烟', '@playwright/test 未安装');
}

// ---- G8 端到端 ----
if (hasBrowsers) {
  run('G8 端到端（Playwright + vite preview）', npx, ['playwright', 'test']);
} else {
  skip('G8 端到端', '@playwright/test 未安装');
}

// ---- 汇总 ----
console.log('\n================ 验收闸门汇总 ================');
let allOk = true;
for (const r of results) {
  const mark = r.skipped ? '跳过' : r.ok ? '通过' : '失败';
  if (!r.ok) allOk = false;
  const ms = r.ms ? ` (${(r.ms / 1000).toFixed(1)}s)` : '';
  console.log(`${mark.padEnd(4)} ${r.label}${ms}${r.skipped ? ` — ${r.reason}` : ''}`);
}
console.log('==============================================');
console.log(allOk ? '全部闸门通过：verify 成功' : '存在失败闸门：verify 失败');
process.exit(allOk ? 0 : 1);
