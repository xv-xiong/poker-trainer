/**
 * 离线生成精确枚举锚点（tests/fixtures/equity-exact.json）。
 *
 * 为什么需要它：精确枚举值是**确定性常量**，可作为相等断言基准（计划 §6.2）。
 * 蒙特卡洛采样值含随机误差，禁止用作断言基准。
 *
 * 规模与耗时（实测）：
 *   河牌单挑 990 次摊牌      约 1.7ms
 *   转牌单挑 45,540 次摊牌   约 80ms
 *   翻牌单挑 1,070,190 次摊牌 约 1.8s
 *   翻牌前单挑精确 C(50,5)xC(45,2) = 2,097,572,400 次摊牌
 *     —— 按实测吞吐约 0.48M 次求值/秒估算，单只手牌需数千秒，
 *        故**不生成翻牌前精确锚点**，翻牌前一律以查表值为基准。
 *
 * 用法：node scripts/gen-exact-anchors.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rank7 } from './lib/rank7.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'tests', 'fixtures', 'equity-exact.json');

const RANKS = '23456789TJQKA';
const SUIT_CHARS = 'shdc';

function parseCard(text) {
  const rank = RANKS.indexOf(text[0].toUpperCase());
  const suit = SUIT_CHARS.indexOf(text[1].toLowerCase());
  if (rank < 0 || suit < 0) throw new Error(`非法牌面: ${text}`);
  return rank * 4 + suit;
}
const parseCards = (s) => s.trim().split(/\s+/).filter(Boolean).map(parseCard);

/**
 * 比较两个打包牌型值。
 *
 * 注意：共享求值器 `scripts/lib/rank7.mjs` 返回的是**打包整数**（不是数组），
 * 因此直接相减即为牌型大小比较。此前的数组式 cmp 用在整数上会使
 * `Math.max(a.length, b.length)` 得到 NaN，循环一次都不执行、恒返回 0，
 * 表现为「所有牌面胜率都是 50%」——该缺陷已由下面的断言式自检拦住。
 */
function cmp(a, b) {
  return a - b;
}

// 自检：求值器必须能区分强弱牌型。若返回恒等，说明接口用错（数组 vs 整数）。
{
  const strong = rank7(parseCards('As Ks Qs Js Ts 2c 3d')); // 皇家同花顺
  const weak = rank7(parseCards('2c 3d 7h 9s Jd 4c 8h')); // 高牌
  if (!(strong > weak)) {
    throw new Error('求值器自检失败：强牌未大于弱牌，检查 rank7 的返回类型（应为打包整数）');
  }
}

const DECK = [];
for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) DECK.push(r * 4 + s);

/** 精确枚举：枚举公共牌补牌与对手两张牌的全部角色分配。 */
function exactEquityHU(hero, board) {
  const known = new Set([...hero, ...board]);
  const remaining = DECK.filter((c) => !known.has(c));
  const boardToCome = 5 - board.length;
  let wins = 0;
  let ties = 0;
  let showdowns = 0;
  const boardPick = [];

  const evaluate = () => {
    const used = new Set([...board, ...boardPick]);
    const full = [...board, ...boardPick];
    const heroValue = rank7([...hero, ...full]);
    const rest = remaining.filter((c) => !used.has(c));
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        const oppValue = rank7([rest[i], rest[j], ...full]);
        showdowns++;
        const c = cmp(heroValue, oppValue);
        if (c > 0) wins++;
        else if (c === 0) ties++;
      }
    }
  };

  const rec = (start) => {
    if (boardPick.length === boardToCome) {
      evaluate();
      return;
    }
    for (let i = start; i < remaining.length; i++) {
      boardPick.push(remaining[i]);
      rec(i + 1);
      boardPick.pop();
    }
  };
  rec(0);

  return { equity: (wins + ties / 2) / showdowns, showdowns, wins, ties };
}

/** 锚点用例：覆盖各种牌面与牌型，全部为单挑精确值。 */
const CASES = [
  // 河牌（990 次摊牌，最快）
  { id: 'river-AA-dry', hero: 'As Ah', board: '2c 7d 9h Js 4d' },
  { id: 'river-nuts-flush', hero: 'As Ks', board: 'Qs Js Ts 2d 3c' },
  { id: 'river-board-is-nuts', hero: '2c 3d', board: 'As Ks Qs Js Ts' },
  { id: 'river-set-vs-draw', hero: '9c 9d', board: '9h Ts Js 2c 3d' },
  { id: 'river-wheel', hero: 'Ah 2d', board: '3c 4s 5h Kd Qc' },
  // 转牌（45,540 次摊牌）
  { id: 'turn-AA-dry', hero: 'As Ah', board: '2c 7d 9h Js' },
  { id: 'turn-flush-draw', hero: 'As Ks', board: 'Qs 7s 2h 9d' },
  { id: 'turn-two-pair', hero: 'Kc Qd', board: 'Kh Qs 5c 8d' },
  // 翻牌（1,070,190 次摊牌，约 1.8s/例）
  { id: 'flop-AA-dry', hero: 'As Ah', board: '2c 7d 9h' },
  { id: 'flop-set', hero: '9c 9d', board: '9h Ts 2c' },
  { id: 'flop-flush-draw', hero: 'As Ks', board: 'Qs 7s 2h' },
];

const t0 = Date.now();
const anchors = [];

for (const c of CASES) {
  const hero = parseCards(c.hero);
  const board = parseCards(c.board);
  const tc = Date.now();
  const r = exactEquityHU(hero, board);
  const ms = Date.now() - tc;
  anchors.push({
    id: c.id,
    hero: c.hero,
    board: c.board,
    boardLength: board.length,
    // 必须存**完整精度**，不能 toFixed 截断：
    // 锚点是相等断言的基准，截断会使「精确相等」断言失败
    equity: r.equity,
    showdowns: r.showdowns,
    wins: r.wins,
    ties: r.ties,
    source: 'exact',
  });
  console.log(
    `${c.id.padEnd(22)} 摊牌 ${String(r.showdowns).padStart(9)}  胜率 ${(r.equity * 100).toFixed(3)}%  ${ms}ms`,
  );
}

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: '精确枚举值（确定性常量，可作断言基准）',
    note:
      '翻牌前精确枚举规模为 C(50,5)xC(45,2)=2,097,572,400 次摊牌，单只手牌需数千秒，故不生成；' +
      '翻牌前一律以查表值（preflop-table.json）为断言基准。',
    opponentCount: 1,
  },
  anchors,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(`\n已写入 ${OUT}`);
console.log(`共 ${anchors.length} 个锚点，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
