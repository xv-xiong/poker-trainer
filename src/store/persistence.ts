/**
 * localStorage 读写 + schemaVersion 迁移。
 *
 * 迁移策略（已定案）：
 *   1. 版本一致 → 直接使用
 *   2. 版本较旧 → 执行迁移函数链；成功则写回
 *   3. 迁移失败或数据损坏 → 归档到 poker-trainer:archive:<version>，然后用默认值重建
 *      **绝不静默丢数据**，并在界面上明确告知已归档
 *
 * 本模块对 storage 做依赖注入，使其可在 Node 环境（jsdom / 假 storage）下单测（G10）。
 */

import type { HandRecord } from '../core/types.js';
import {
  HISTORY_LIMIT,
  SCHEMA_VERSION,
  STORAGE_KEYS,
  initialState,
  migrateState,
  validateHistory,
  validateState,
  type PersistedState,
} from './schema.js';

/** 最小存储接口（localStorage 兼容）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LoadResult {
  state: PersistedState;
  history: HandRecord[];
  /** 加载过程中发生的问题（界面需告知用户）。 */
  notices: string[];
  /** 是否执行了归档重建。 */
  archived: boolean;
}

/** 内存版 storage（Node 测试与降级用）。 */
export function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function safeParse<T>(raw: string | null): { ok: true; value: T } | { ok: false; error: string } {
  if (raw === null) return { ok: false, error: '不存在' };
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (e) {
    return { ok: false, error: `JSON 解析失败: ${(e as Error).message}` };
  }
}

/** 归档原始字符串（不丢数据）。 */
function archive(storage: StorageLike, label: string, raw: string): void {
  try {
    storage.setItem(`${STORAGE_KEYS.archivePrefix}${label}`, raw);
  } catch {
    // 归档失败（例如配额耗尽）不阻断启动；调用方通过 notices 得知
  }
}

/**
 * 读取状态与历史。任何损坏都降级为「可用状态」，绝不抛出导致白屏。
 */
export function loadAll(storage: StorageLike): LoadResult {
  const notices: string[] = [];
  let archived = false;

  // ---- 状态 ----
  let state: PersistedState;
  const rawState = storage.getItem(STORAGE_KEYS.state);
  const parsedState = safeParse<Record<string, unknown>>(rawState);

  if (!parsedState.ok) {
    if (rawState !== null) {
      archive(storage, `state-broken-${Date.now()}`, rawState);
      notices.push(`状态数据损坏（${parsedState.error}），已归档并重置为默认值`);
      archived = true;
    }
    state = initialState();
  } else {
    const incomingVersion = parsedState.value.schemaVersion;
    // 高版本数据：当前代码无法安全读取（可能含未知字段语义），必须归档而非静默使用
    if (typeof incomingVersion === 'number' && incomingVersion > SCHEMA_VERSION) {
      archive(storage, `state-v${incomingVersion}`, rawState!);
      notices.push(
        `状态数据版本 v${incomingVersion} 高于当前支持的 v${SCHEMA_VERSION}，已归档并重置（请升级页面）`,
      );
      archived = true;
      state = initialState();
    } else {
      const migrated = migrateState(parsedState.value);
      if (migrated === null) {
        archive(storage, `state-v${String(incomingVersion ?? 'unknown')}`, rawState!);
        notices.push(
          `状态数据结构版本 ${String(incomingVersion ?? '未知')} 无法迁移到 v${SCHEMA_VERSION}，已归档并重置`,
        );
        archived = true;
        state = initialState();
      } else {
        const errs = validateState(migrated);
        if (errs.length > 0) {
          archive(storage, `state-invalid-${Date.now()}`, rawState!);
          notices.push(`状态数据结构不合法（${errs.join('；')}），已归档并重置`);
          archived = true;
          state = initialState();
        } else {
          // 迁移提示以「读入时的版本」为准，而非迁移后的版本
          if (typeof incomingVersion === 'number' && incomingVersion !== SCHEMA_VERSION) {
            notices.push(`状态已从 v${incomingVersion} 迁移到 v${SCHEMA_VERSION}`);
          }
          migrated.schemaVersion = SCHEMA_VERSION;
          state = migrated as unknown as PersistedState;
        }
      }
    }
  }

  // ---- 历史 ----
  let history: HandRecord[] = [];
  const rawHistory = storage.getItem(STORAGE_KEYS.history);
  if (rawHistory !== null) {
    const parsedHistory = safeParse<unknown>(rawHistory);
    if (!parsedHistory.ok) {
      archive(storage, `history-broken-${Date.now()}`, rawHistory);
      notices.push(`历史记录损坏（${parsedHistory.error}），已归档并清空`);
      archived = true;
    } else {
      const errs = validateHistory(parsedHistory.value);
      if (errs.length > 0) {
        archive(storage, `history-invalid-${Date.now()}`, rawHistory);
        notices.push(`历史记录结构不合法（${errs.slice(0, 3).join('；')}），已归档并清空`);
        archived = true;
      } else {
        history = parsedHistory.value as HandRecord[];
        if (history.length > HISTORY_LIMIT) {
          history = history.slice(history.length - HISTORY_LIMIT);
          notices.push(`历史记录超出 ${HISTORY_LIMIT} 手上限，已按 FIFO 截断`);
        }
      }
    }
  }

  return { state, history, notices, archived };
}

/** 写入状态（失败不抛出，返回是否成功）。 */
export function saveState(storage: StorageLike, state: PersistedState): boolean {
  try {
    storage.setItem(STORAGE_KEYS.state, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** 写入历史（失败不抛出，返回是否成功）。 */
export function saveHistory(storage: StorageLike, history: HandRecord[]): boolean {
  try {
    const trimmed = history.length > HISTORY_LIMIT ? history.slice(history.length - HISTORY_LIMIT) : history;
    storage.setItem(STORAGE_KEYS.history, JSON.stringify(trimmed));
    return true;
  } catch {
    return false;
  }
}

/** 清空全部数据（含归档）。 */
export function clearAll(storage: StorageLike, keys: string[]): void {
  for (const k of keys) storage.removeItem(k);
}
