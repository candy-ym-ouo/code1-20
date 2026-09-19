import { defineConfig } from 'vitest/config';

// 所有测试在同一个 fork 进程内顺序执行，共享一个嵌入式 PostgreSQL 实例
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
