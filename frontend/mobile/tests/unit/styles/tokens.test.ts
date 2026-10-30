import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function sourcePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url))
}

function readSource(relativePath: string): string {
  return readFileSync(sourcePath(relativePath), 'utf8')
}

const tokens = readSource('../../../src/styles/tokens.css')
const aliases = readSource('../../../src/styles/aliases.css')
const main = readSource('../../../src/main.ts')

describe('tokens.css', () => {
  it('defines the light and dark palettes', () => {
    expect(tokens).toContain(':root {')
    expect(tokens).toContain('[data-theme="dark"]')
    expect(tokens).toMatch(/--bg:\s*#f7f2e8/)
    expect(tokens).toMatch(/--bg:\s*#171512/)
  })

  it('defines four accent blocks', () => {
    const accentSelectors = tokens.match(/:root\[data-accent="[a-z]+"\]/g) ?? []
    expect(accentSelectors).toHaveLength(4)
    for (const accent of ['ochre', 'jade', 'indigo', 'rose']) {
      expect(tokens).toContain(`:root[data-accent="${accent}"]`)
    }
  })

  it('defines the layout tokens the migration depends on', () => {
    expect(tokens).toContain('--space-1: 4px;')
    expect(tokens).toContain('--chat-column: 748px;')
    expect(tokens).toContain('--radius: 8px;')
  })
})

describe('aliases.css', () => {
  it('maps the legacy names to demo tokens', () => {
    expect(aliases).toMatch(/--text:\s*var\(--ink\)/)
    expect(aliases).toMatch(/--primary:\s*var\(--accent\)/)
    expect(aliases).toMatch(/--border:\s*var\(--hairline\)/)
  })

  it('does not redefine demo-owned names', () => {
    expect(aliases).not.toMatch(/^\s*--bg\s*:/m)
    expect(aliases).not.toMatch(/^\s*--accent\s*:/m)
    expect(aliases).not.toMatch(/^\s*--surface\s*:/m)
    expect(aliases).not.toMatch(/^\s*--radius\s*:/m)
    expect(aliases).not.toMatch(/^\s*--danger\s*:/m)
  })
})

describe('foundation files', () => {
  it('are not imported from main.ts', () => {
    expect(main).not.toContain('tokens.css')
    expect(main).not.toContain('aliases.css')
    expect(main).not.toContain('legacy.css')
  })
})
