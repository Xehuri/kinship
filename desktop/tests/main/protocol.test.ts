// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveBundlePath } from '../../src/main/shell/app-protocol'

let bundleRoot = ''

beforeAll(() => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'axeuh-desktop-bundle-'))
  mkdirSync(join(bundleRoot, 'assets'), { recursive: true })
  writeFileSync(join(bundleRoot, 'index.html'), '<!doctype html><title>Axeuh</title>')
  writeFileSync(join(bundleRoot, 'assets', 'app.js'), 'console.log("axeuh")')
  writeFileSync(join(bundleRoot, 'assets', 'app.css'), 'body{}')
  writeFileSync(join(bundleRoot, 'assets', 'data.bin'), 'binary')
})

afterAll(() => {
  if (bundleRoot.length > 0) rmSync(bundleRoot, { recursive: true, force: true })
})

describe('resolveBundlePath', () => {
  it('serves index.html for the bundle root', () => {
    const resolved = resolveBundlePath('axeuh://bundle/', bundleRoot)

    expect(resolved).toEqual({
      filePath: resolve(bundleRoot, 'index.html'),
      contentType: 'text/html',
    })
  })

  it('serves index.html when the URL has no path at all', () => {
    const resolved = resolveBundlePath('axeuh://bundle', bundleRoot)

    expect(resolved?.filePath).toBe(resolve(bundleRoot, 'index.html'))
  })

  it('serves the entry for query strings and fragments', () => {
    const resolved = resolveBundlePath('axeuh://bundle/index.html?x=1#/setup', bundleRoot)

    expect(resolved?.filePath).toBe(resolve(bundleRoot, 'index.html'))
  })

  it('does not mistake a query value for a path', () => {
    const resolved = resolveBundlePath('axeuh://bundle?x=/../../etc/passwd', bundleRoot)

    expect(resolved?.filePath).toBe(resolve(bundleRoot, 'index.html'))
  })

  it('serves assets with the correct MIME type', () => {
    expect(resolveBundlePath('axeuh://bundle/assets/app.js', bundleRoot)).toEqual({
      filePath: resolve(bundleRoot, 'assets', 'app.js'),
      contentType: 'text/javascript',
    })
    expect(resolveBundlePath('axeuh://bundle/assets/app.css', bundleRoot)?.contentType).toBe(
      'text/css',
    )
    expect(resolveBundlePath('axeuh://bundle/assets/data.bin', bundleRoot)?.contentType).toBe(
      'application/octet-stream',
    )
  })

  it('falls back to index.html for extension-less SPA routes', () => {
    const resolved = resolveBundlePath('axeuh://bundle/settings', bundleRoot)

    expect(resolved?.filePath).toBe(resolve(bundleRoot, 'index.html'))
  })

  it('returns null for a missing asset instead of serving the entry', () => {
    expect(resolveBundlePath('axeuh://bundle/assets/missing.js', bundleRoot)).toBeNull()
  })

  it('rejects raw path traversal', () => {
    expect(resolveBundlePath('axeuh://bundle/../../etc/passwd', bundleRoot)).toBeNull()
    expect(resolveBundlePath('axeuh://bundle/a/../b', bundleRoot)).toBeNull()
  })

  it('rejects encoded path traversal', () => {
    expect(
      resolveBundlePath('axeuh://bundle/%2e%2e/%2e%2e/etc/passwd', bundleRoot),
    ).toBeNull()
  })

  it('rejects backslashes and NUL bytes', () => {
    expect(resolveBundlePath('axeuh://bundle/..%5C..%5Cetc%5Cpasswd', bundleRoot)).toBeNull()
    expect(resolveBundlePath('axeuh://bundle/index%00.html', bundleRoot)).toBeNull()
  })

  it('rejects protocol-relative and absolute-looking paths', () => {
    expect(resolveBundlePath('axeuh://bundle//etc/passwd', bundleRoot)).toBeNull()
  })

  it('rejects other hosts and protocols', () => {
    expect(resolveBundlePath('axeuh://other/index.html', bundleRoot)).toBeNull()
    expect(resolveBundlePath('https://bundle/index.html', bundleRoot)).toBeNull()
    expect(resolveBundlePath('not-a-url', bundleRoot)).toBeNull()
  })
})
