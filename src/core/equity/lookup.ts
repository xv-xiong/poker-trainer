/**
 * 翻牌前查表读取。
 *
 * 表由 `scripts/gen-preflop-table.mjs` 在构建期生成并冻结入库，
 * 运行时只读。表中数值是**查表值**，属确定性常量，可作为断言基准（G6）。
 *
 * 键格式（169 个起手牌类）：
 *   对子    -> 'AA'、'KK'、...、'22'
 *   同花    -> 'AKs'（大牌在前）
 *   非同花  -> 'AKo'（大牌在前）
 */

import { cardRank, type Card } from '../cards.js';
import tableData from '../../../tests/fixtures/preflop-table.json' with { type: 'json' };

interface PreflopTable {
  /** 生成参数，便于追溯来源。 */
  meta: {
    iterations: number;
    generatedAt: string;
    seed: number;
    /** 各对手数对应的键。 */
    opponentCounts: number[];
  };
  /** 对手数 -> { 手牌类 -> 胜率 }。 */
  tables: Record<string, Record<string, number>>;
}

const TABLE = tableData as unknown as PreflopTable;

const RANK_CHARS = '23456789TJQKA';

/** 把两张底牌规范化为 169 类键。 */
export function handClassKey(hero: readonly Card[]): string {
  if (hero.length !== 2) throw new Error('需要恰好 2 张底牌');
  const r1 = cardRank(hero[0]);
  const r2 = cardRank(hero[1]);
  const s1 = hero[0] & 3;
  const s2 = hero[1] & 3;
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  if (hi === lo) return `${RANK_CHARS[hi]}${RANK_CHARS[lo]}`;
  const suffix = s1 === s2 ? 's' : 'o';
  return `${RANK_CHARS[hi]}${RANK_CHARS[lo]}${suffix}`;
}

/**
 * 查询翻牌前胜率。
 * @returns 命中返回 0..1 的胜率；未命中（该对手数无表）返回 null。
 */
export function lookupPreflop(hero: readonly Card[], opponents: number): number | null {
  const bucket = TABLE.tables[String(opponents)];
  if (!bucket) return null;
  const key = handClassKey(hero);
  const v = bucket[key];
  return typeof v === 'number' ? v : null;
}

/** 表元信息（用于测试断言与界面展示来源）。 */
export function preflopTableMeta(): PreflopTable['meta'] {
  return TABLE.meta;
}

/** 该对手数是否已有表。 */
export function hasPreflopTable(opponents: number): boolean {
  return Boolean(TABLE.tables[String(opponents)]);
}

/** 全部 169 个手牌类键（顺序固定，用于遍历与断言）。 */
export function allHandClassKeys(): string[] {
  const keys: string[] = [];
  for (let hi = 12; hi >= 0; hi--) {
    keys.push(`${RANK_CHARS[hi]}${RANK_CHARS[hi]}`);
  }
  for (let hi = 12; hi >= 1; hi--) {
    for (let lo = hi - 1; lo >= 0; lo--) {
      keys.push(`${RANK_CHARS[hi]}${RANK_CHARS[lo]}s`);
      keys.push(`${RANK_CHARS[hi]}${RANK_CHARS[lo]}o`);
    }
  }
  return keys;
}

export { TABLE as rawPreflopTable };
