/**
 * 构建期生成翻牌前胜率查表（169 手牌类 x 各对手数）。
 *
 * 输出：tests/fixtures/preflop-table.json
 * 该文件入库冻结，运行时只读；表中数值为「查表值」，可作断言基准。
 *
 * 用法：node scripts/gen-preflop-table.mjs [--iterations 100000] [--opponents 1,2,5,8]
 *
 * 耗时参考（实测吞吐 6 人桌约 79,365 次迭代/秒）：
 *   169 手 x 4 档 x 100,000 次 约 14 分钟（一次性）
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rank7 } from './lib/rank7.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'tests', 'fixtures', 'preflop-table.json');

const RANK_CHARS = '23456789TJQKA';

function parseArgs() {
  const args = process.argv.slice(2);
  let iterations = 100_000;
  let opponents = [1, 2, 5, 8];
  let seed = 20261012;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations') iterations = Number(args[++i]);
    else if (args[i] === '--opponents') opponents = args[++i].split(',').map(Number);
    else if (args[i] === '--seed') seed = Number(args[++i]);
  }
  return { iterations, opponents, seed };
}

// ---- 求值器来自 scripts/lib/rank7.mjs（与生产实现交叉校验，见
//      tests/unit/script-evaluator.test.ts）----

/**
 * 比较两个打包牌型值。
 *
 * 共享求值器返回**打包整数**（不是数组），直接相减即为牌型大小比较。
 * 此前的数组式 cmp 用在整数上会使 `Math.max(a.length, b.length)` 得到 NaN，
 * 循环一次都不执行、恒返回 0，导致整张表所有手牌胜率恒为 50%
 * （表现为 AA 与 72o 完全相同）——该缺陷已由下面的自检拦住。
 */
function cmp(a, b) {
  return a - b;
}

// 自检：求值器必须能区分强弱牌型；若恒等说明接口用错（数组 vs 整数）
{
  const R = '23456789TJQKA';
  const S = 'shdc';
  const pc = (t) => R.indexOf(t[0].toUpperCase()) * 4 + S.indexOf(t[1].toLowerCase());
  const strong = rank7(['As', 'Ks', 'Qs', 'Js', 'Ts', '2c', '3d'].map(pc));
  const weak = rank7(['2c', '3d', '7h', '9s', 'Jd', '4c', '8h'].map(pc));
  if (!(strong > weak)) {
    throw new Error('求值器自检失败：强牌未大于弱牌，检查 rank7 返回类型（应为打包整数）');
  }
}

const DECK = [];
for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) DECK.push(r * 4 + s);

function mcEquity(hero, opponents, iterations, rng) {
  const known = new Set(hero);
  const remaining = DECK.filter((c) => !known.has(c));
  const needed = opponents * 2 + 5;
  let wins = 0;
  let ties = 0;
  const full = new Array(5);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < needed; i++) {
      const j = i + rng.nextInt(remaining.length - i);
      const t = remaining[i];
      remaining[i] = remaining[j];
      remaining[j] = t;
    }
    for (let k = 0; k < 5; k++) full[k] = remaining[opponents * 2 + k];
    const hv = rank7([hero[0], hero[1], ...full]);
    let best = null;
    for (let o = 0; o < opponents; o++) {
      const v = rank7([remaining[o * 2], remaining[o * 2 + 1], ...full]);
      if (best === null || cmp(v, best) > 0) best = v;
    }
    const c = cmp(hv, best);
    if (c > 0) wins++;
    else if (c === 0) ties++;
  }
  return (wins + ties / 2) / iterations;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return {
    nextInt(maxExclusive) {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const v = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(v * maxExclusive);
    },
  };
}

function allKeys() {
  const keys = [];
  for (let hi = 12; hi >= 0; hi--) keys.push(`${RANK_CHARS[hi]}${RANK_CHARS[hi]}`);
  for (let hi = 12; hi >= 1; hi--) {
    for (let lo = hi - 1; lo >= 0; lo--) {
      keys.push(`${RANK_CHARS[hi]}${RANK_CHARS[lo]}s`);
      keys.push(`${RANK_CHARS[hi]}${RANK_CHARS[lo]}o`);
    }
  }
  return keys;
}

function heroCards(key) {
  if (key.length === 2) {
    const r = RANK_CHARS.indexOf(key[0]);
    return [r * 4 + 0, r * 4 + 1];
  }
  const hi = RANK_CHARS.indexOf(key[0]);
  const lo = RANK_CHARS.indexOf(key[1]);
  const suited = key[2] === 's';
  return [hi * 4 + 0, lo * 4 + (suited ? 0 : 1)];
}

const { iterations, opponents, seed } = parseArgs();
const keys = allKeys();
const tables = {};
const t0 = Date.now();

for (const opp of opponents) {
  const bucket = {};
  const rng = makeRng(seed + opp);
  for (const [i, key] of keys.entries()) {
    bucket[key] = Number(mcEquity(heroCards(key), opp, iterations, rng).toFixed(6));
    if ((i + 1) % 40 === 0) {
      const elapsed = (Date.now() - t0) / 1000;
      process.stdout.write(`  opp=${opp} ${i + 1}/${keys.length}  已用 ${elapsed.toFixed(0)}s\n`);
    }
  }
  tables[String(opp)] = bucket;
  console.log(`对手数 ${opp} 完成，累计 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const out = {
  meta: {
    iterations,
    generatedAt: new Date().toISOString(),
    seed,
    opponentCounts: opponents,
    note: '蒙特卡洛采样值，仅供运行时读取；表中数值为冻结的查表值，可作断言基准',
  },
  tables,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 0), 'utf8');
console.log(`已写入 ${OUT}`);
console.log(`总计 ${((Date.now() - t0) / 1000).toFixed(0)}s，迭代数 ${iterations}，对手档位 ${opponents.join(',')}`);
