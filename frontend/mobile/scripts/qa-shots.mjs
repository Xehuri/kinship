#!/usr/bin/env node
/**
 * 视觉截图矩阵 CLI 包装: 把 --only/--out 转成 spec 读取的环境变量。
 *
 * usage: node scripts/qa-shots.mjs [--only <csv>] [--out <dir>] [-- <playwright 参数>]
 *
 * 其余参数原样透传给 playwright test; 默认固定 reporter=line。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function fail(message) {
  console.error(`[qa-shots] ${message}`)
  process.exit(1)
}

const passthrough = []
const env = { ...process.env }
const argv = process.argv.slice(2)

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--') {
    passthrough.push(...argv.slice(index + 1))
    break
  }
  if (arg === '--only' || arg === '--out') {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`${arg} requires a value`)
    env[arg === '--only' ? 'VISUAL_ONLY' : 'VISUAL_OUT'] = value
    index += 1
    continue
  }
  passthrough.push(arg)
}

const executable = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
)
if (!existsSync(executable)) {
  fail(`missing local binary: ${executable} (run npm install first)`)
}

const result = spawnSync(
  executable,
  ['test', 'e2e/visual.spec.ts', '--reporter=line', ...passthrough],
  {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
)

if (result.error) {
  fail(`playwright failed to start: ${result.error.message}`)
}
process.exit(result.status ?? 1)
