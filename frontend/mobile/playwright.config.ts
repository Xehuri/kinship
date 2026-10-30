import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// 视觉截图运行级输出目录: 主进程计算一次, worker 继承同一目录,
// 避免每个 worker 各生成一个时间戳目录导致产物分散。
if (!process.env.VISUAL_OUT) {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const root = process.env.ARTIFACTS_DIR ?? tmpdir()
  process.env.VISUAL_OUT = join(root, `kinship-ui-qa-${stamp}`)
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run build:e2e && npm run preview:e2e',
    url: 'http://127.0.0.1:4173/mobile/',
    timeout: 180000,
    reuseExistingServer: !process.env.CI,
  },
})
