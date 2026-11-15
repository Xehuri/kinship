import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Integration tests spawn dsh and bind loopback ports; one file at a time
    // keeps the temporary DSH_HOME evidence deterministic.
    fileParallelism: false,
  },
})
