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

/**
 * 历史记录上限（FIFO 淘汰）。
 *
 * 体积实测（评估报告 M6，2026-10-19 实测）：单手 `HandRecord` 序列化后
 * **平均约 5.2KB、最大约 8.3KB**（6 人桌、含完整 actions/pots/review）。
 * 因此 500 手约占 **2.5–4.0MB**，已接近 localStorage 常见的 5MB 配额上限
 * ——早期注释写的「500 手 x 约 2KB 约 1MB」把风险低估了约 3–4 倍。
 *
 * 由此带来的两个约束：
 *   1. 写入可能因配额耗尽而失败，调用方**必须**检查 saveState/saveHistory 的返回值
 *      （见 GameController.persistState / reportSaveFailure）；
 *   2. 归档键（archivePrefix）不参与 FIFO，也会占用配额，清理机制见后续版本。
 */
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

/**
 * 运行时校验：结构不合法返回错误列表。
 *
 * 为什么必须做**字段级**校验（而不只是检查 settings 是不是对象）：
 * `settings: {}` 这类「外层是对象、内部字段缺失」的存档能通过「typeof === 'object'」
 * 的浅校验，被 loadAll 接受后交给 GameController；用户点「开始练习」时
 * `createHand` 读 settings.startingStack 得到 undefined，进而抛
 * `TypeError: Cannot read properties of undefined`，表现为整页白屏。
 * 这直接违背「损坏数据不白屏」的承诺（G10），因此逐字段校验是必要的。
 *
 * 校验失败时沿用既有降级路径：归档原始数据 → 用默认值重建 → 界面告知用户，
 * 绝不静默丢数据。
 */
export function validateState(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['状态不是对象'];
  }
  const v = value as Record<string, unknown>;
  if (typeof v.schemaVersion !== 'number') errors.push('schemaVersion 缺失或非数字');
  if (typeof v.bankroll !== 'number' || !Number.isFinite(v.bankroll)) errors.push('bankroll 非法');
  if (typeof v.settings !== 'object' || v.settings === null) {
    errors.push('settings 缺失');
  } else {
    errors.push(...validateSettings(v.settings));
  }
  if (typeof v.stats !== 'object' || v.stats === null) errors.push('stats 缺失');
  return errors;
}

/**
 * 设置对象的字段级校验。
 *
 * 取值约束对齐 `defaultSettings()` 与 SettingsPanel 的输入边界：
 * 桌人数只允许 2 / 6 / 9（引擎与布局均按这三档实现）；筹码与盲注必须是正有限数。
 *
 * 刻意**不**校验 `bigBlind >= smallBlind`：SettingsPanel 的两个输入框是独立的，
 * 用户可以把小盲设得比大盲大。若把这种「UI 能合法产生」的配置判为损坏，
 * 下次启动就会走归档重建、丢掉资金与统计——那是一条原本不存在的数据丢失路径。
 * 这类语义约束应由输入侧拦截，不该由「存档损坏检测」承担。
 */
function validateSettings(raw: unknown): string[] {
  const errors: string[] = [];
  const s = raw as Record<string, unknown>;

  const isPosFinite = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x > 0;

  if (s.seatCount !== 2 && s.seatCount !== 6 && s.seatCount !== 9) {
    errors.push(`settings.seatCount 非法（须为 2 / 6 / 9，实际 ${String(s.seatCount)}）`);
  }
  if (!isPosFinite(s.startingStack)) errors.push('settings.startingStack 非法（须为正数）');
  if (!isPosFinite(s.smallBlind)) errors.push('settings.smallBlind 非法（须为正数）');
  if (!isPosFinite(s.bigBlind)) errors.push('settings.bigBlind 非法（须为正数）');
  if (s.aiTier !== 'easy' && s.aiTier !== 'medium' && s.aiTier !== 'hard') {
    errors.push(`settings.aiTier 非法（实际 ${String(s.aiTier)}）`);
  }
  if (typeof s.fourColorDeck !== 'boolean') errors.push('settings.fourColorDeck 非法（须为布尔值）');
  if (typeof s.showShortcuts !== 'boolean') errors.push('settings.showShortcuts 非法（须为布尔值）');
  if (typeof s.enableFlopExact !== 'boolean') errors.push('settings.enableFlopExact 非法（须为布尔值）');

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
