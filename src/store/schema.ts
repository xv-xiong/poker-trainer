/**
 * 存储结构定义与校验。
 *
 * 顶层带 schemaVersion 字段。启动时若版本不匹配则尝试迁移；
 * 迁移失败或数据损坏则归档旧数据后重建，绝不静默丢数据。
 */

import type { HandRecord, Settings, Stats } from '../core/types.js';
import { defaultSettings, emptyStats } from '../core/types.js';

/**
 * 当前存储结构版本。任何破坏性字段变更都必须递增此值并补迁移函数。
 *
 * v1 → v2（阶段 1-1「筹码继承」）：新增三个字段
 * `carryOverStacks` / `roster` / `heroOut`。它们都是**增量**字段，
 * 旧数据补默认值即可，不改变任何既有字段的语义，因此迁移函数只做填充。
 *
 * 阶段二（节奏档位）又新增了 `pace`，但**刻意不递增版本号**：它是可选字段 +
 * 读盘时缺省（`migrateState` 尾部统一规整），不构成破坏性变更，
 * 旧存档无需迁移、新代码读旧档也不会失败。递增版本号反而会让所有旧存档
 * 走一次没有必要的迁移提示。
 */
export const SCHEMA_VERSION = 2;

/**
 * 节奏档位：AI 每步思考多久（阶段二 P1-1）。
 *
 * 为什么这个类型定义在 store 而不是 ui：它是**用户设置**，要落盘、要跨会话保留，
 * 属于持久化层的形状。`src/ui/thinkTiming.ts` 只 `import type` 它来决定时长区间，
 * 反向依赖（store 依赖 ui）会破坏分层。
 *
 * 三个取值只影响「等多久」，不影响 AI 决策：决策只读 `HandState` 与 RNG，
 * 从不读这个字段（有单测用「同一 seed 三档跑出的动作序列逐条相同」守着）。
 */
export type Pace = 'realistic' | 'fast' | 'instant';

/** 默认档位。见 docs/优化路线图.md 阶段二的「开工前拍板」：默认保留拟真。 */
export const DEFAULT_PACE: Pace = 'realistic';

/**
 * 把任意值规整成合法档位。
 *
 * 为什么**不**把非法 pace 判成「存档损坏」：pace 是纯展示字段，判损坏会走
 * 「归档 + 重置」，把用户的资金、统计、历史一起丢掉——为一个小字段毁掉真数据，
 * 正是当初拒绝给 `bigBlind >= smallBlind` 加校验的同一个理由。
 * 因此读盘时静默回退到默认档（见 migrateState 的尾部规整）。
 */
export function normalizePace(raw: unknown): Pace {
  return raw === 'realistic' || raw === 'fast' || raw === 'instant' ? raw : DEFAULT_PACE;
}

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

/**
 * 继承模式下的一个 AI 座位。
 *
 * 为什么筹码要逐座位存在这里、而不是靠 `settings.startingStack` 重算：
 * 继承模式下每一手的起始筹码是**上一手的余额**，而 `settings` 属于冻结的
 * `src/core/`，不能加字段。因此 AI 的筹码账本落在持久化层，由
 * `GameController` 通过 `createHand({ stacks })` 注入给引擎（引擎原生支持）。
 */
export interface RosterSeat {
  /** 稳定标识（React key 与「下桌」展示用）。 */
  id: number;
  name: string;
  /** 当前筹码；<= 0 表示已输光、等待补码决策。 */
  stack: number;
  /** 已下桌（输光且选择不补码）。下桌的座位不再参与后续牌局。 */
  out: boolean;
}

/** 会话结束的两种结局（继承模式下才可能出现）。 */
export type SessionEndKind = 'hero-bust' | 'victory';

export interface PersistedState {
  schemaVersion: number;
  bankroll: number;
  settings: Settings;
  stats: Stats;
  /** 下一手的庄家位。 */
  nextDealerSeat: number;
  /** 手牌序号（用于生成 handId）。 */
  handCounter: number;
  /**
   * 是否继承上一手筹码。
   * false（默认）= 每手重置为 startingStack 的单局练习；
   * true = 现金局式的连续牌局，输光需补码决策。
   */
  carryOverStacks: boolean;
  /** 继承模式下的 AI 座位账本；非继承模式恒为空数组。 */
  roster: RosterSeat[];
  /** 玩家已输光且选择「不补码」→ 本局以玩家出局告终。 */
  heroOut: boolean;
  /**
   * 节奏档位（只影响 AI 每步等待多久，不影响决策）。
   *
   * 类型上非可选，但**读盘时可能缺失**：旧存档没有这个字段，由 `migrateState`
   * 尾部统一补默认值，因此 `loadAll` 之后它必然合法。
   */
  pace: Pace;
}

/** 构造一副全新的 AI 座位账本（全部为满筹码、未下桌）。 */
export function buildRoster(count: number, startingStack: number): RosterSeat[] {
  const seats: RosterSeat[] = [];
  for (let i = 0; i < Math.max(0, Math.floor(count)); i++) {
    seats.push({ id: i + 1, name: `AI-${i + 1}`, stack: startingStack, out: false });
  }
  return seats;
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
    carryOverStacks: false,
    roster: [],
    heroOut: false,
    pace: DEFAULT_PACE,
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
  errors.push(...validateCarryOver(v));
  return errors;
}

/**
 * 继承模式三个新增字段的校验。
 *
 * 这里刻意把「字段缺失」判为不合法：`migrateState` 一定会为 v1 数据补齐默认值，
 * 因此走到校验时字段必然存在。缺失只可能来自被手工篡改的存档，
 * 交给归档重建路径处理比「悄悄用默认值」更符合「绝不静默」的承诺。
 */
function validateCarryOver(v: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (typeof v.carryOverStacks !== 'boolean') {
    errors.push('carryOverStacks 非法（须为布尔值）');
  }
  if (typeof v.heroOut !== 'boolean') {
    errors.push('heroOut 非法（须为布尔值）');
  }
  if (!Array.isArray(v.roster)) {
    errors.push('roster 非法（须为数组）');
    return errors;
  }
  for (const [i, seat] of v.roster.entries()) {
    if (typeof seat !== 'object' || seat === null) {
      errors.push(`roster[${i}] 不是对象`);
      continue;
    }
    const s = seat as Record<string, unknown>;
    if (typeof s.id !== 'number' || !Number.isInteger(s.id)) errors.push(`roster[${i}].id 非法`);
    if (typeof s.name !== 'string') errors.push(`roster[${i}].name 非法`);
    if (typeof s.stack !== 'number' || !Number.isFinite(s.stack)) errors.push(`roster[${i}].stack 非法`);
    if (typeof s.out !== 'boolean') errors.push(`roster[${i}].out 非法`);
  }
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
 *
 * v1 → v2：补齐筹码继承模式的三个字段。旧版本没有「继承」概念，
 * 语义上等价于「每手重置」的单局练习，故默认 false / 空账本 / 未出局。
 */
export const MIGRATIONS: Record<number, Migration> = {
  1: (old) => ({
    ...old,
    schemaVersion: 2,
    carryOverStacks: typeof old.carryOverStacks === 'boolean' ? old.carryOverStacks : false,
    roster: Array.isArray(old.roster) ? old.roster : [],
    heroOut: typeof old.heroOut === 'boolean' ? old.heroOut : false,
  }),
};

/**
 * 把任意版本的状态迁移到当前版本。失败返回 null。
 *
 * 尾部对 `pace` 做**无条件规整**（不是迁移步骤）：`pace` 是阶段二新增的可选字段，
 * 既可能出现在「v1 迁移上来」的数据里，也可能出现在「手工改过 / 更早期 v2 存档」
 * 里。放在这里的好处是**只有一个收敛点**——`loadAll` 无论走哪条分支都要经过
 * `migrateState`，因此下游（controller / snapshot）拿到的 `pace` 必然合法，
 * 不需要每个读取点各自兜底。
 */
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
  return { ...cur, pace: normalizePace(cur.pace) };
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
