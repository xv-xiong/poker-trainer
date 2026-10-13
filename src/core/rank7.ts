/**
 * 生产用 7 张取最优牌型判定器（single-pass 计数法）。
 *
 * 设计要点：
 * 1. 不做 C(7,5)=21 种组合枚举，而是单次遍历统计点数与花色计数后直接判定，
 *    复杂度 O(n)，n 为 5..7。
 * 2. 结果打包为**单个整数**，可直接用数值比较大小，避免数组比较开销。
 *    打包格式：((((cat*16+v1)*16+v2)*16+v3)*16+v4)*16+v5
 *    其中 cat 为牌型类别（0..8，越大越强），v1..v5 为同类内的比较键（降序重要度），
 *    无意义的低位槽填 0。因 cat 为最高有效位，跨类别比较天然正确。
 * 3. 使用模块级预分配 scratch 数组（Int8Array/Int32Array）消除热路径分配。
 *    本函数为纯函数且完全同步，无重入，故共享 scratch 安全。
 *
 * 正确性保证：本实现是**唯一生产求值器**；`rank5Reference.ts` 是算法完全不同的
 * 独立参照实现（枚举 21 个子集 + 独立 5 张分类器），仅测试使用。
 * 两者在 20 万手随机牌上必须逐手一致（验收闸门 G2），任何不一致即缺陷。
 */

import type { Card } from './cards.js';
import { HAND_CATEGORIES, type HandCategory } from './cards.js';

const _rankCount = new Int8Array(13);
const _suitCount = new Int8Array(4);
const _ranksDesc = new Int32Array(7);
const _flushRanks = new Int32Array(7);
const _uniq = new Int32Array(8); // 最多 7 个不同点数 + 轮子顺的 -1

/** 16^5，用于解包类别。 */
const CAT_SCALE = 1048576;

function pack(cat: number, v1 = 0, v2 = 0, v3 = 0, v4 = 0, v5 = 0): number {
  return ((((cat * 16 + v1) * 16 + v2) * 16 + v3) * 16 + v4) * 16 + v5;
}

/**
 * 从降序点数数组求顺子最大牌点数；无顺子返回 -1。
 * 特殊处理 A-2-3-4-5 轮子顺：A(12) 兼作 1(-1)，此时最大牌为 5(rank 3)。
 */
function straightHighFromDesc(desc: Int32Array, n: number): number {
  let u = 0;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const v = desc[i];
    if (v !== prev) {
      _uniq[u++] = v;
      prev = v;
    }
  }
  if (_uniq[0] === 12) _uniq[u++] = -1;
  let run = 1;
  for (let i = 1; i < u; i++) {
    if (_uniq[i] === _uniq[i - 1] - 1) {
      run++;
      if (run >= 5) return _uniq[i] + 4;
    } else {
      run = 1;
    }
  }
  return -1;
}

/** 降序插入排序（数组很短，最多 7 个元素）。 */
function sortDescInPlace(arr: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const x = arr[i];
    let j = i - 1;
    while (j >= 0 && arr[j] < x) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = x;
  }
}

/**
 * 判定 5..7 张牌的最优牌型，返回可比较的打包整数（越大越强）。
 */
export function rank7(cards: readonly Card[]): number {
  const n = cards.length;
  if (n < 5 || n > 7) throw new Error(`rank7 仅支持 5..7 张牌，收到 ${n} 张`);

  _rankCount.fill(0);
  _suitCount.fill(0);
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    _rankCount[c >> 2]++;
    _suitCount[c & 3]++;
  }

  // 点数降序展开
  let k = 0;
  for (let r = 12; r >= 0; r--) {
    const cnt = _rankCount[r];
    for (let j = 0; j < cnt; j++) _ranksDesc[k++] = r;
  }

  // 同花：某花色张数 >= 5
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) {
    if (_suitCount[s] >= 5) {
      flushSuit = s;
      break;
    }
  }

  let flushLen = 0;
  if (flushSuit >= 0) {
    for (let i = 0; i < n; i++) {
      const c = cards[i];
      if ((c & 3) === flushSuit) _flushRanks[flushLen++] = c >> 2;
    }
    sortDescInPlace(_flushRanks, flushLen);
    const sf = straightHighFromDesc(_flushRanks, flushLen);
    if (sf >= 0) return pack(8, sf); // 同花顺
  }

  const st = straightHighFromDesc(_ranksDesc, n);

  // 按点数计数收集：四条 / 三条 / 对子（各取最高的至多两个）
  let quad = -1;
  let trip1 = -1;
  let trip2 = -1;
  let pair1 = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const c = _rankCount[r];
    if (c === 4) {
      quad = r;
    } else if (c === 3) {
      if (trip1 < 0) trip1 = r;
      else if (trip2 < 0) trip2 = r;
    } else if (c === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
    }
  }

  if (quad >= 0) {
    // 四条：踢脚为除四条外最大的牌
    let kicker = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== quad && _rankCount[r] > 0) {
        kicker = r;
        break;
      }
    }
    return pack(7, quad, kicker);
  }

  if (trip1 >= 0) {
    // 葫芦：另一组三条（3+3+1 的 7 张情形）或最大对子
    const cand = trip2 > pair1 ? trip2 : pair1;
    if (cand >= 0) return pack(6, trip1, cand);
  }

  if (flushSuit >= 0) {
    return pack(5, _flushRanks[0], _flushRanks[1], _flushRanks[2], _flushRanks[3], _flushRanks[4]);
  }

  if (st >= 0) return pack(4, st);

  if (trip1 >= 0) {
    // 三条：两个最大踢脚
    let a = -1;
    let b = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== trip1 && _rankCount[r] > 0) {
        if (a < 0) a = r;
        else {
          b = r;
          break;
        }
      }
    }
    return pack(3, trip1, a, b);
  }

  if (pair1 >= 0 && pair2 >= 0) {
    // 两对：最大踢脚（排除两个对子点数）
    let kicker = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== pair1 && r !== pair2 && _rankCount[r] > 0) {
        kicker = r;
        break;
      }
    }
    return pack(2, pair1, pair2, kicker);
  }

  if (pair1 >= 0) {
    // 一对：三个最大踢脚
    let a = -1;
    let b = -1;
    let c = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== pair1 && _rankCount[r] > 0) {
        if (a < 0) a = r;
        else if (b < 0) b = r;
        else {
          c = r;
          break;
        }
      }
    }
    return pack(1, pair1, a, b, c);
  }

  // 高牌：最大 5 张
  return pack(0, _ranksDesc[0], _ranksDesc[1], _ranksDesc[2], _ranksDesc[3], _ranksDesc[4]);
}

/** 从打包值取出牌型类别索引（0..8）。 */
export function categoryOf(packed: number): number {
  return Math.floor(packed / CAT_SCALE);
}

/** 从打包值取出牌型类别名。 */
export function categoryNameOf(packed: number): HandCategory {
  return HAND_CATEGORIES[categoryOf(packed)];
}

/** 从打包值取出 5 个比较键（高位在前）。 */
export function valuesOf(packed: number): number[] {
  const out: number[] = [];
  let rest = packed % CAT_SCALE;
  for (let i = 0; i < 5; i++) {
    const div = Math.pow(16, 4 - i);
    out.push(Math.floor(rest / div));
    rest %= div;
  }
  return out;
}

/**
 * 取出手牌 + 公共牌中构成最优牌型的那 5 张实际牌（界面复盘展示用）。
 * 实现方式：枚举 C(n,5) 个子集，取 rank7 打包值最大者。n<=7 时最多 21 次判定，开销可忽略。
 */
export function bestFive(cards: readonly Card[]): Card[] {
  const n = cards.length;
  if (n === 5) return [...cards];
  let bestVal = -1;
  let bestSet: Card[] = [];
  const idx = [0, 1, 2, 3, 4];
  const pick: Card[] = new Array(5);
  const rec = (start: number, depth: number): void => {
    if (depth === 5) {
      for (let i = 0; i < 5; i++) pick[i] = cards[idx[i]];
      const v = rank7(pick);
      if (v > bestVal) {
        bestVal = v;
        bestSet = [...pick];
      }
      return;
    }
    for (let i = start; i < n; i++) {
      idx[depth] = i;
      rec(i + 1, depth + 1);
    }
  };
  rec(0, 0);
  return bestSet;
}
