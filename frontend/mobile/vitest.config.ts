import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    // 仅跑 tests/ 下的单元测试; e2e/ 归 Playwright (npm run test:e2e)
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
  },
})
