/**
 * 全量 5 张牌型直方图校验（验收闸门 G1）。
 *
 * 枚举 C(52,5) = 2,598,960 种组合，用**参照实现**的 classify5 分类，
 * 断言各类别计数精确等于组合数学真值。
 *
 * 该真值已由独立的 Python 全量枚举脚本产出并校验合计：
 *   同花顺 40、四条 624、葫芦 3744、同花 5108、顺子 10200、
 *   三条 54912、两对 123552、一对 1098240、高牌 1302540
 *   合计 = 2,598,960 = C(52,5)
 *
 * 用法：node --experimental-strip-types scripts/verify-hand-histogram.mjs
 * 说明：本脚本用 mjs + 内联实现，避免依赖 TS 运行时。
 */

import { classify5 } from '../src/core/rank5Reference.ts';

export const EXPECTED_HISTOGRAM = {
  straight_flush: 40,
  four_kind: 624,
  full_house: 3744,
  flush: 5108,
  straight: 10200,
  three_kind: 54912,
  two_pair: 123552,
  one_pair: 1098240,
  high_card: 1302540,
};

const CATEGORY_BY_INDEX = [
  'high_card',
  'one_pair',
  'two_pair',
  'three_kind',
  'straight',
  'flush',
  'full_house',
  'four_kind',
  'straight_flush',
];

export function runHistogramCheck() {
  const counts = Object.fromEntries(Object.keys(EXPECTED_HISTOGRAM).map((k) => [k, 0]));
  let total = 0;
  const hand = new Array(5);

  for (let a = 0; a < 48; a++) {
    hand[0] = a;
    for (let b = a + 1; b < 49; b++) {
      hand[1] = b;
      for (let c = b + 1; c < 50; c++) {
        hand[2] = c;
        for (let d = c + 1; d < 51; d++) {
          hand[3] = d;
          for (let e = d + 1; e < 52; e++) {
            hand[4] = e;
            const cat = classify5(hand)[0];
            counts[CATEGORY_BY_INDEX[cat]]++;
            total++;
          }
        }
      }
    }
  }

  const mismatches = [];
  for (const [k, expected] of Object.entries(EXPECTED_HISTOGRAM)) {
    if (counts[k] !== expected) {
      mismatches.push(`${k}: 实际 ${counts[k]} != 期望 ${expected}`);
    }
  }
  const totalOk = total === 2598960;
  return { counts, total, mismatches, totalOk, pass: mismatches.length === 0 && totalOk };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('verify-hand-histogram.mjs')) {
  const t0 = Date.now();
  const r = runHistogramCheck();
  for (const [k, v] of Object.entries(r.counts)) {
    console.log(`${k.padEnd(16)} ${String(v).padStart(9)}  期望 ${String(EXPECTED_HISTOGRAM[k]).padStart(9)}  ${v === EXPECTED_HISTOGRAM[k] ? 'OK' : 'FAIL'}`);
  }
  console.log(`${'TOTAL'.padEnd(16)} ${String(r.total).padStart(9)}  期望   2598960  ${r.totalOk ? 'OK' : 'FAIL'}`);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.pass) {
    console.log('G1 直方图校验：通过');
    process.exit(0);
  } else {
    console.error('G1 直方图校验：失败');
    for (const m of r.mismatches) console.error('  ' + m);
    process.exit(1);
  }
}
