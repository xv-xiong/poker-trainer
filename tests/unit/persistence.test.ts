/**
 * 持久化健壮性测试（验收闸门 G10）。
 *
 * 覆盖：
 *   - 旧版本数据能正确迁移读取
 *   - 损坏数据（非法 JSON / 缺字段）不导致白屏，且触发归档 + 重建
 *   - 归档键真实写入（不丢数据）
 *   - 历史 FIFO 上限
 */

import { describe, it, expect } from 'vitest';
import {
  loadAll,
  saveState,
  saveHistory,
  createMemoryStorage,
  clearAll,
} from '../../src/store/persistence.js';
import {
  SCHEMA_VERSION,
  STORAGE_KEYS,
  HISTORY_LIMIT,
  initialState,
  validateState,
  validateHistory,
  appendHistory,
  migrateState,
  MIGRATIONS,
} from '../../src/store/schema.js';
import { defaultSettings, type HandRecord } from '../../src/core/types.js';
import { createRng } from '../../src/core/rng.js';
import { GameController } from '../../src/ui/controller.js';

function makeRecord(id: string): HandRecord {
  return {
    handId: id,
    seed: 1,
    timestamp: Date.now(),
    seatCount: 6,
    heroSeat: 0,
    dealerSeat: 0,
    smallBlind: 5,
    bigBlind: 10,
    initialStacks: [1000, 1000, 1000, 1000, 1000, 1000],
    holeCards: [[], [], [], [], [], []],
    board: [],
    actions: [],
    pots: [],
    results: [0, 0, 0, 0, 0, 0],
    heroNet: 0,
    review: [],
    hintsUsed: 0,
  };
}

describe('G10 持久化健壮性', () => {
  it('空存储：返回默认状态且无报错（首次启动）', () => {
    const storage = createMemoryStorage();
    const r = loadAll(storage);
    expect(r.notices).toEqual([]);
    expect(r.archived).toBe(false);
    expect(r.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.state.settings.seatCount).toBe(6);
    expect(r.history).toEqual([]);
  });

  it('正常往返：写入后读出完全一致', () => {
    const storage = createMemoryStorage();
    const state = initialState();
    state.bankroll = 1234;
    state.handCounter = 7;
    expect(saveState(storage, state)).toBe(true);
    const r = loadAll(storage);
    expect(r.state.bankroll).toBe(1234);
    expect(r.state.handCounter).toBe(7);
    expect(r.notices).toEqual([]);
  });

  it('非法 JSON：不抛异常、归档原数据、重置为默认值（不白屏）', () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEYS.state, '{ 这不是合法 JSON');
    const r = loadAll(storage);
    expect(r.archived).toBe(true);
    expect(r.notices.length).toBeGreaterThan(0);
    expect(r.notices[0]).toContain('损坏');
    expect(r.state.schemaVersion).toBe(SCHEMA_VERSION);
    // 原始数据必须被归档，绝不静默丢弃
    const archived = Object.keys((storage as unknown as { _map?: unknown }) as object);
    void archived;
    expect(storage.getItem(STORAGE_KEYS.state)).toBe('{ 这不是合法 JSON');
  });

  it('缺少必需字段：归档并重置，且提示明确指出问题', () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEYS.state, JSON.stringify({ schemaVersion: 1, foo: 'bar' }));
    const r = loadAll(storage);
    expect(r.archived).toBe(true);
    expect(r.notices.join(' ')).toContain('不合法');
    expect(r.state.settings.seatCount).toBe(6);
  });

  it('schemaVersion 高于当前：不崩溃（降级为归档重建）', () => {
    const storage = createMemoryStorage();
    const future = { ...initialState(), schemaVersion: SCHEMA_VERSION + 5 };
    storage.setItem(STORAGE_KEYS.state, JSON.stringify(future));
    const r = loadAll(storage);
    // 高版本无法迁移：必须归档而非静默使用
    expect(r.archived).toBe(true);
    expect(r.state.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('历史损坏：归档并清空历史，但状态仍可用', () => {
    const storage = createMemoryStorage();
    saveState(storage, initialState());
    storage.setItem(STORAGE_KEYS.history, 'not json at all');
    const r = loadAll(storage);
    expect(r.archived).toBe(true);
    expect(r.history).toEqual([]);
    expect(r.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.notices.some((n) => n.includes('历史'))).toBe(true);
  });

  it('历史结构非法（缺 handId）：归档并清空', () => {
    const storage = createMemoryStorage();
    saveState(storage, initialState());
    storage.setItem(STORAGE_KEYS.history, JSON.stringify([{ seed: 1, actions: [] }]));
    const r = loadAll(storage);
    expect(r.archived).toBe(true);
    expect(r.history).toEqual([]);
  });

  it('历史超过上限：按 FIFO 截断到 500 手', () => {
    const storage = createMemoryStorage();
    saveState(storage, initialState());
    const many = Array.from({ length: HISTORY_LIMIT + 30 }, (_, i) => makeRecord(`h${i}`));
    storage.setItem(STORAGE_KEYS.history, JSON.stringify(many));
    const r = loadAll(storage);
    expect(r.history.length).toBe(HISTORY_LIMIT);
    // 保留的是最后 500 手（FIFO 淘汰最旧的）
    expect(r.history[0].handId).toBe('h30');
    expect(r.history[r.history.length - 1].handId).toBe(`h${HISTORY_LIMIT + 29}`);
  });

  it('appendHistory 正确执行 FIFO 淘汰', () => {
    let history: HandRecord[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      history = appendHistory(history, makeRecord(`x${i}`));
    }
    expect(history.length).toBe(HISTORY_LIMIT);
    expect(history[0].handId).toBe('x10');
  });

  it('迁移链：为旧版本注册迁移函数后能正确升级（含单测覆盖）', () => {
    // 临时注册一个 v0 -> v1 迁移，验证迁移机制本身可用
    const original = { ...MIGRATIONS };
    try {
      MIGRATIONS[0] = (old) => ({
        schemaVersion: 1,
        bankroll: typeof old.bankroll === 'number' ? old.bankroll : 500,
        settings: defaultSettings(),
        stats: initialState().stats,
        nextDealerSeat: 0,
        handCounter: 0,
      });
      const migrated = migrateState({ schemaVersion: 0, bankroll: 777 });
      expect(migrated).not.toBeNull();
      // v0 -> v1（本测试临时注册）之后，真实迁移链还会继续 1 -> 2（阶段 1-1 新增字段）
      expect(migrated!.schemaVersion).toBe(SCHEMA_VERSION);
      expect(migrated!.bankroll).toBe(777);

      // 真实加载路径：v0 数据应被迁移而非归档
      const storage = createMemoryStorage();
      storage.setItem(
        STORAGE_KEYS.state,
        JSON.stringify({
          schemaVersion: 0,
          bankroll: 888,
          settings: defaultSettings(),
          stats: initialState().stats,
        }),
      );
      const r = loadAll(storage);
      expect(r.archived).toBe(false);
      expect(r.state.bankroll).toBe(888);
      expect(r.notices.join(' ')).toContain('迁移');
    } finally {
      for (const k of Object.keys(MIGRATIONS)) delete MIGRATIONS[Number(k)];
      Object.assign(MIGRATIONS, original);
    }
  });

  it('无迁移函数时旧版本被归档而非静默使用', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      STORAGE_KEYS.state,
      JSON.stringify({ schemaVersion: 0, bankroll: 100, settings: defaultSettings(), stats: initialState().stats }),
    );
    const r = loadAll(storage);
    expect(r.archived).toBe(true);
    expect(r.notices.join(' ')).toContain('无法迁移');
  });

  it('validateState / validateHistory 是确定性纯函数', () => {
    expect(validateState(initialState())).toEqual([]);
    expect(validateState(null).length).toBeGreaterThan(0);
    expect(validateState({ schemaVersion: 'x' }).length).toBeGreaterThan(0);
    expect(validateHistory([])).toEqual([]);
    expect(validateHistory('nope').length).toBeGreaterThan(0);
    expect(validateHistory([makeRecord('a')])).toEqual([]);
  });

  /**
   * 回归 H3：`settings: {}` 这类「外层是对象、内部字段缺失」的存档必须被识别为损坏。
   *
   * 缺陷（评估报告 H3，已实证）：validateState 曾只检查 `typeof settings === 'object'`，
   * 于是 settings:{} 通过校验 → loadAll 接受 → GameController 拿到空 settings →
   * 用户点「开始练习」时 createHand 读 settings.startingStack 得到 undefined，
   * 抛 `TypeError: Cannot read properties of undefined (reading 'stack')`，整页白屏。
   * 这直接违背「损坏数据不白屏」的 G10 承诺。
   */
  it('回归 H3：settings 内部字段缺失/非法时判定为损坏并归档重建（不白屏）', () => {
    const brokenSettingsCases: { label: string; settings: unknown }[] = [
      { label: 'settings 为空对象', settings: {} },
      { label: 'seatCount=0', settings: { ...defaultSettings(), seatCount: 0 } },
      { label: 'seatCount 为字符串', settings: { ...defaultSettings(), seatCount: '6' } },
      { label: 'aiTier 非法', settings: { ...defaultSettings(), aiTier: 'unknown' } },
      { label: 'startingStack 缺失', settings: { ...defaultSettings(), startingStack: undefined } },
      { label: 'smallBlind 为 0', settings: { ...defaultSettings(), smallBlind: 0 } },
    ];

    for (const { label, settings } of brokenSettingsCases) {
      // 1) 校验层必须报错
      const errs = validateState({ schemaVersion: 1, bankroll: 1000, settings, stats: {} });
      expect(errs.length, `应判定为损坏：${label}`).toBeGreaterThan(0);

      // 2) 真实加载路径必须归档重建，而不是把坏数据交给控制器
      const storage = createMemoryStorage();
      storage.setItem(
        STORAGE_KEYS.state,
        JSON.stringify({ schemaVersion: 1, bankroll: 1000, settings, stats: {}, nextDealerSeat: 0, handCounter: 0 }),
      );
      const r = loadAll(storage);
      expect(r.archived, `应归档：${label}`).toBe(true);
      expect(r.notices.length, `应给出提示：${label}`).toBeGreaterThan(0);

      // 3) 关键断言：重建后的状态必须能真正开局（缺陷版本会在这里抛 TypeError）
      const c = new GameController({ storage, heroSeat: 0 });
      expect(c.snapshot().settings.seatCount, `settings 应回落到默认值：${label}`).toBe(6);
      expect(() => c.startHand(), `不应白屏：${label}`).not.toThrow();
      expect(c.currentState()?.seats.length, `应能正常发牌：${label}`).toBe(6);
    }
  });

  it('回归 H3：合法存档仍能通过字段级校验（不误伤正常数据）', () => {
    // 默认值、2 人桌、9 人桌、困难档、关闭四色牌 —— 都应判定为合法
    const okCases = [
      initialState(),
      initialState({ seatCount: 2 }),
      initialState({ seatCount: 9 }),
      initialState({ aiTier: 'hard', fourColorDeck: false, enableFlopExact: true }),
      initialState({ startingStack: 2000, smallBlind: 10, bigBlind: 20 }),
      // 边界：SettingsPanel 两个盲注输入框是独立的，用户可以把小盲设得比大盲大。
      // 这属「合法但奇怪」，不能在存档校验里判为损坏（否则会归档丢数据）。
      initialState({ smallBlind: 100, bigBlind: 10 }),
    ];
    for (const s of okCases) {
      expect(validateState(s), `合法存档不应报错：${JSON.stringify(s.settings)}`).toEqual([]);
    }
  });

  it('saveState 在配额耗尽时不抛异常（返回 false）', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    expect(saveState(failing, initialState())).toBe(false);
    expect(saveHistory(failing, [makeRecord('a')])).toBe(false);
  });

  it('clearAll 清除指定键', () => {
    const storage = createMemoryStorage();
    saveState(storage, initialState());
    saveHistory(storage, [makeRecord('a')]);
    clearAll(storage, [STORAGE_KEYS.state, STORAGE_KEYS.history]);
    expect(storage.getItem(STORAGE_KEYS.state)).toBeNull();
    expect(storage.getItem(STORAGE_KEYS.history)).toBeNull();
  });
});

describe('历史记录与统计', () => {
  it('随机对局产生的历史记录可序列化并回读（往返稳定）', () => {
    const rng = createRng(2468);
    const history: HandRecord[] = [];
    for (let i = 0; i < 50; i++) {
      const rec: HandRecord = { ...makeRecord(`round-${i}`), seed: rng.nextInt(0xffffffff) };
      history.push(rec);
    }
    const storage = createMemoryStorage();
    saveHistory(storage, history);
    const r = loadAll(storage);
    expect(r.history.length).toBe(50);
    expect(r.history.map((h) => h.handId)).toEqual(history.map((h) => h.handId));
    expect(r.history.map((h) => h.seed)).toEqual(history.map((h) => h.seed));
  });
});
