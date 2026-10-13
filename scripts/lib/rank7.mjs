/**
 * 构建期脚本共用的 7 张牌型判定器（纯 JS，供 .mjs 脚本直接 import）。
 *
 * ⚠️ 为什么不直接复用 src/core/rank7.ts：
 *   本项目的脚本以 `node scripts/*.mjs` 直接运行，Node 的类型剥离无法解析
 *   TS 源码里的 `./cards.js` 导入说明符，因此必须有一份等价的 JS 实现。
 *
 * ⚠️ 但「等价」不能靠假设——必须被测试证明：
 *   `tests/unit/script-evaluator.test.ts` 会在 10 万手随机牌上交叉校验本文件
 *   与生产实现 `src/core/rank7.ts`，错 0 手才算通过。
 *
 * 本文件曾存在的缺陷（已修复，并写入回归测试）：
 *   同花检查写成 `rs.filter((r, i) => su[i] === fs)` —— `rs` 是**降序排序后**的点数，
 *   而 `su` 是**原始发牌顺序**的花色，两者索引不对齐，导致：
 *     1. 同花顺被漏判为同花（例如公共牌 A♠K♠Q♠J♠T♠ 被算成同花而非同花顺）；
 *     2. 取出的同花点数不足 5 张时产生 undefined，比较结果错乱。
 *   该缺陷使翻牌前查表与精确锚点双双失真，由 tests/unit/anchors.test.ts 捕获。
 *   正确做法：直接遍历原始牌数组按花色取点数（如下方实现）。
 */

const _cnt = new Int8Array(13);
const _suit = new Int8Array(4);
const _rs = new Int32Array(7);
const _fr = new Int32Array(7);
const _uniq = new Int32Array(8);

function pack(cat, v1 = 0, v2 = 0, v3 = 0, v4 = 0, v5 = 0) {
  return ((((cat * 16 + v1) * 16 + v2) * 16 + v3) * 16 + v4) * 16 + v5;
}

function straightHigh(desc, n) {
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

function sortDesc(arr, n) {
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

/** 判定 5..7 张牌最优牌型，返回可比较的打包整数。 */
export function rank7(cards) {
  const n = cards.length;
  if (n < 5 || n > 7) throw new Error(`rank7 仅支持 5..7 张牌，收到 ${n} 张`);

  _cnt.fill(0);
  _suit.fill(0);
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    _cnt[c >> 2]++;
    _suit[c & 3]++;
  }

  let k = 0;
  for (let r = 12; r >= 0; r--) {
    const cnt = _cnt[r];
    for (let j = 0; j < cnt; j++) _rs[k++] = r;
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) {
    if (_suit[s] >= 5) {
      flushSuit = s;
      break;
    }
  }

  // 关键：直接遍历原始牌数组取同花点数（不能用「排序后点数」配「原始花色」）
  let flushLen = 0;
  if (flushSuit >= 0) {
    for (let i = 0; i < n; i++) {
      const c = cards[i];
      if ((c & 3) === flushSuit) _fr[flushLen++] = c >> 2;
    }
    sortDesc(_fr, flushLen);
    const sf = straightHigh(_fr, flushLen);
    if (sf >= 0) return pack(8, sf);
  }

  const st = straightHigh(_rs, n);

  let quad = -1;
  let trip1 = -1;
  let trip2 = -1;
  let pair1 = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const c = _cnt[r];
    if (c === 4) quad = r;
    else if (c === 3) {
      if (trip1 < 0) trip1 = r;
      else if (trip2 < 0) trip2 = r;
    } else if (c === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
    }
  }

  if (quad >= 0) {
    let kicker = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== quad && _cnt[r] > 0) {
        kicker = r;
        break;
      }
    }
    return pack(7, quad, kicker);
  }

  if (trip1 >= 0) {
    const cand = trip2 > pair1 ? trip2 : pair1;
    if (cand >= 0) return pack(6, trip1, cand);
  }

  if (flushSuit >= 0) {
    return pack(5, _fr[0], _fr[1], _fr[2], _fr[3], _fr[4]);
  }

  if (st >= 0) return pack(4, st);

  if (trip1 >= 0) {
    let a = -1;
    let b = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== trip1 && _cnt[r] > 0) {
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
    let kicker = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== pair1 && r !== pair2 && _cnt[r] > 0) {
        kicker = r;
        break;
      }
    }
    return pack(2, pair1, pair2, kicker);
  }

  if (pair1 >= 0) {
    let a = -1;
    let b = -1;
    let c2 = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== pair1 && _cnt[r] > 0) {
        if (a < 0) a = r;
        else if (b < 0) b = r;
        else {
          c2 = r;
          break;
        }
      }
    }
    return pack(1, pair1, a, b, c2);
  }

  return pack(0, _rs[0], _rs[1], _rs[2], _rs[3], _rs[4]);
}

/** 牌型类别（0..8）。 */
export function categoryOf(packed) {
  return Math.floor(packed / 1048576);
}
