/**
 * 存储结构定义与校验。
 *
 * 顶层带 schemaVersion 字段。启动时若版本不匹配则尝试迁移；
 * 迁移失败或数据损坏则归档旧数据后重建，绝不静默丢数据。
 */

import type { HandRecord, Settings, Stats } from '../core/types.js';
import { defaultSettings, emptyStats } from '../core/types.js';

/** 当前存储结构版本。任何破坏性字段变更都必须递增此值并补迁移函数。 */
export const SCHEMA_VERSION = 1;

export const STORAGE_KEYS = {
  state: 'poker-trainer:state',
  history: 'poker-trainer:history',
  archivePrefix: 'poker-trainer:archive:',
} as const;

/** 历史记录上限（FIFO 淘汰）。500 手 x 约 2KB 约 1MB，远低于 localStorage 约 5MB 配额。 */
export const HISTORY_LIMIT = 500;

export interface PersistedState {
  schemaVersion: number;
  bankroll: number;
  settings: Settings;
  stats: Stats;
  /** 下一手的庄家位。 */
  nextDealerSeat: number;
  /** 手牌序号（用于生成 handId）。 */
  handCounter: number;
}

export function initialState(settings?: Partial<Settings>): PersistedState {
  const s = { ...defaultSettings(), ...settings };
  return {
    schemaVersion: SCHEMA_VERSION,
    bankroll: s.startingStack,
    settings: s,
    stats: emptyStats(),
    nextDealerSeat: 0,
    handCounter: 0,
  };
}

/** 运行时校验：结构不合法返回错误列表。 */
export function validateState(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['状态不是对象'];
  }
  const v = value as Record<string, unknown>;
  if (typeof v.schemaVersion !== 'number') errors.push('schemaVersion 缺失或非数字');
  if (typeof v.bankroll !== 'number' || !Number.isFinite(v.bankroll)) errors.push('bankroll 非法');
  if (typeof v.settings !== 'object' || v.settings === null) errors.push('settings 缺失');
  if (typeof v.stats !== 'object' || v.stats === null) errors.push('stats 缺失');
  return errors;
}

/** 运行时校验历史记录数组。 */
export function validateHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return ['历史记录不是数组'];
  const errors: string[] = [];
  for (const [i, rec] of value.entries()) {
    if (typeof rec !== 'object' || rec === null) {
      errors.push(`第 ${i} 条不是对象`);
      continue;
    }
    const r = rec as Record<string, unknown>;
    if (typeof r.handId !== 'string') errors.push(`第 ${i} 条 handId 非法`);
    if (typeof r.seed !== 'number') errors.push(`第 ${i} 条 seed 非法`);
    if (!Array.isArray(r.actions)) errors.push(`第 ${i} 条 actions 非法`);
  }
  return errors;
}

/** 迁移函数签名：把旧版本数据升到下一版本；返回 null 表示无法迁移。 */
export type Migration = (old: Record<string, unknown>) => Record<string, unknown> | null;

/**
 * 版本迁移链。键为「源版本」，值为迁移到「源版本 + 1」的函数。
 * 当前只有 v1，故链为空；新增版本时在此追加，并补单测（G10）。
 */
export const MIGRATIONS: Record<number, Migration> = {};

/** 把任意版本的状态迁移到当前版本。失败返回 null。 */
export function migrateState(raw: Record<string, unknown>): Record<string, unknown> | null {
  let cur = raw;
  let guard = 0;
  while (typeof cur.schemaVersion === 'number' && cur.schemaVersion < SCHEMA_VERSION) {
    if (guard++ > 50) return null;
    const m = MIGRATIONS[cur.schemaVersion];
    if (!m) return null;
    const next = m(cur);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** 构造一条历史记录。 */
export function makeHandRecord(rec: Omit<HandRecord, 'timestamp'> & { timestamp?: number }): HandRecord {
  return { ...rec, timestamp: rec.timestamp ?? Date.now() };
}

/** 按 FIFO 追加历史并截断到上限。 */
export function appendHistory(history: HandRecord[], rec: HandRecord, limit = HISTORY_LIMIT): HandRecord[] {
  const next = [...history, rec];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
