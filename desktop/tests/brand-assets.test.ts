// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('brand assets', () => {
  it(
    'committed assets match the pinned master SVG',
    () => {
      const result = spawnSync(process.execPath, ['scripts/make-brand-assets.mjs', '--check'], {
        cwd: desktopDir,
        encoding: 'utf8',
      })
      const stderr = (result.stderr ?? '').trim()
      const failure = stderr || result.error?.message || 'no stderr output'
      expect(result.status, `brand asset check failed: ${failure}`).toBe(0)
    },
    30_000,
  )
})
