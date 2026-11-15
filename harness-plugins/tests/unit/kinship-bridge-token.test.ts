import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rotateToken } from '../../packages/kinship-bridge/src/index.js'
import type { TokenState } from '../../packages/kinship-bridge/src/index.js'
import { UiError } from '../../packages/kinship-bridge/src/ui.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinship-token-'))
  dirs.push(dir)
  return dir
}

function logger(): { readonly lines: string[], readonly logger: { info(message: string, ...args: unknown[]): void } } {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: (message: string, ...args: unknown[]) => { lines.push([message, ...args].join(' ')) },
    },
  }
}

function failureOf(run: () => unknown): UiError | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error as UiError
  }
}

describe('bridge token rotation', () => {
  it('refuses to rotate a token the deployment supplies through the environment', () => {
    const sink = logger()
    const current: TokenState = { token: 'env-token', source: 'env', env: 'KINSHIP_BRIDGE_TOKEN', path: null }
    const failure = failureOf(() => rotateToken(sink, current))
    expect(failure).toBeInstanceOf(UiError)
    expect(failure?.status).toBe(409)
    expect(failure?.code).toBe('token_env_managed')
    expect(sink.lines).toHaveLength(0)
  })

  it('rewrites a configured secret file with a fresh 0600 token', () => {
    const dir = tempDir()
    const path = join(dir, 'nested', 'bridge-token')
    const sink = logger()
    const next = rotateToken(sink, { token: 'old-token', source: 'file', env: null, path })

    expect(next.source).toBe('file')
    expect(next.path).toBe(path)
    expect(next.token).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(path, 'utf8').trim()).toBe(next.token)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(sink.lines).toHaveLength(1)
  })

  it('keeps the generated-file source when it rotates its own file', () => {
    const dir = tempDir()
    const path = join(dir, 'bridge-token')
    const sink = logger()
    const next = rotateToken(sink, { token: 'generated-token', source: 'generated', env: null, path })
    expect(next.source).toBe('generated')
    expect(readFileSync(path, 'utf8').trim()).toBe(next.token)
  })

  it('reports a write failure as a 500 instead of claiming success', () => {
    const dir = tempDir()
    const path = join(dir, 'bridge-token')
    // A directory where the secret file belongs makes the atomic write fail.
    mkdirSync(path, { recursive: true })
    const sink = logger()
    const failure = failureOf(() => rotateToken(sink, { token: 'old', source: 'file', env: null, path }))
    expect(failure).toBeInstanceOf(UiError)
    expect(failure?.status).toBe(500)
    expect(failure?.code).toBe('token_write_failed')
    expect(sink.lines).toHaveLength(0)
  })
})
