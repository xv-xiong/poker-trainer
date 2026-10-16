import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/property/**/*.test.ts'],
    // 全局默认超时：多数测试远快于此。
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 单项超时（`it(..., ms)`）需要能超过全局默认，故不设上限；
    // G7 的 AI 档位测试按实测成本显式声明 900s（见 tests/property/ai.test.ts）。
    reporters: ['default'],
  },
});
