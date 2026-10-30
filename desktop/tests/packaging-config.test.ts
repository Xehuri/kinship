// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fallbackConfigPath = resolve(desktopDir, 'electron-builder.fallback.yml')

interface ExtraResource {
  from?: string
  to?: string
  filter?: string[]
}

interface BuilderConfig {
  extraResources?: Array<ExtraResource | string>
}

function readFallbackConfig(): BuilderConfig {
  return load(readFileSync(fallbackConfigPath, 'utf8')) as BuilderConfig
}

describe('fallback packaging config', () => {
  it('bundles the tray icon at resources/icon.png', () => {
    const entries = readFallbackConfig().extraResources ?? []
    const iconEntry = entries.find(
      (entry) => typeof entry === 'object' && entry.from === 'resources/icon.png',
    )
    expect(iconEntry).toMatchObject({ from: 'resources/icon.png', to: 'icon.png' })
  })

  it('keeps the bundled PC sensor resources', () => {
    const entries = readFallbackConfig().extraResources ?? []
    expect(entries).toContainEqual({ from: 'resources/pc-sensor', to: 'pc-sensor' })
  })
})
