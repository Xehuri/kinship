/// <reference types="vitest/globals" />

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkCachePayloads,
  install,
  main,
  parseStrongNames,
  readManifest,
  runtimeRoot,
  verifyRuntime,
} from '../../../scripts/fetch-circuitjs.mjs'

const STRONG_NAME = '0123456789ABCDEF0123456789ABCDEF'
const temporaryRoots: string[] = []

function temporaryDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(dir)
  return dir
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(dir, entry.name)
    return entry.isDirectory() ? listFiles(child) : [child]
  })
}

function makeFixture(): string {
  const root = temporaryDir('circuitjs-fixture-')
  const runtime = path.join(root, 'circuitjs1')
  fs.mkdirSync(path.join(runtime, 'circuitjs1'), { recursive: true })
  fs.writeFileSync(path.join(runtime, 'circuitjs.html'), '<html>circuitjs</html>\n')
  fs.writeFileSync(path.join(runtime, 'circuitjs1', 'app.js'), 'console.log(1)\n')
  fs.writeFileSync(
    path.join(runtime, 'circuitjs1', 'circuitjs1.nocache.js'),
    `unflattenKeylistIntoAnswers(['safari'], '${STRONG_NAME}');\n`,
  )
  fs.writeFileSync(path.join(runtime, 'circuitjs1', `${STRONG_NAME}.cache.js`), 'gwt payload\n')
  fs.writeFileSync(path.join(root, 'LICENSE'), 'GPL-2.0 test fixture\n')

  const files = [
    'circuitjs.html',
    'circuitjs1/app.js',
    'circuitjs1/circuitjs1.nocache.js',
    `circuitjs1/${STRONG_NAME}.cache.js`,
  ]
  const lines = files.map(
    (relative) => `${sha256(path.join(runtime, relative))}  circuitjs1/${relative}`,
  )
  fs.writeFileSync(path.join(root, 'MANIFEST.sha256'), `${lines.join('\n')}\n`)
  return root
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop() as string, { recursive: true, force: true })
  }
})

describe('fetch-circuitjs', () => {
  it('resolves a checkout root and a runtime root', () => {
    const root = makeFixture()
    expect(runtimeRoot(root)).toBe(path.join(root, 'circuitjs1'))
    expect(runtimeRoot(path.join(root, 'circuitjs1'))).toBe(path.join(root, 'circuitjs1'))
  })

  it('rejects a directory without circuitjs.html', () => {
    const empty = temporaryDir('circuitjs-empty-')
    expect(() => runtimeRoot(empty)).toThrow(/CIRCUITJS_LOCAL_DIR/)
  })

  it('verifies every manifest entry and reports corruption', () => {
    const root = makeFixture()
    const runtime = path.join(root, 'circuitjs1')
    const manifest = path.join(root, 'MANIFEST.sha256')

    expect(verifyRuntime(runtime, manifest)).toEqual({ count: 4, problems: [] })

    fs.writeFileSync(path.join(runtime, 'circuitjs1', 'app.js'), 'tampered\n')
    const result = verifyRuntime(runtime, manifest)
    expect(result.count).toBe(4)
    expect(result.problems).toEqual(['sha256 mismatch circuitjs1/app.js'])
  })

  it('parses a strong name and accepts its cache payload', () => {
    const root = makeFixture()
    const runtime = path.join(root, 'circuitjs1')

    expect(parseStrongNames(`unflattenKeylistIntoAnswers(['safari'], '${STRONG_NAME}');`)).toEqual([
      STRONG_NAME,
    ])
    expect(checkCachePayloads(runtime)).toEqual({ strongNames: [STRONG_NAME], missing: [] })
  })

  it('fails when a parsed strong name has no cache payload', () => {
    const root = makeFixture()
    const target = path.join(temporaryDir('circuitjs-target-'), 'circuitjs1')
    fs.rmSync(path.join(root, 'circuitjs1', 'circuitjs1', `${STRONG_NAME}.cache.js`))

    expect(() => install(root, target)).toThrow(
      new RegExp(`missing GWT cache payload.*${STRONG_NAME}\\.cache\\.js`),
    )
    expect(fs.existsSync(target)).toBe(false)
  })

  it('copies a verified local snapshot, its cache payload, and its notices', () => {
    const root = makeFixture()
    const target = path.join(temporaryDir('circuitjs-target-'), 'circuitjs1')

    install(root, target)

    expect(fs.readFileSync(path.join(target, 'circuitjs.html'), 'utf8')).toContain('circuitjs')
    expect(fs.readFileSync(path.join(target, 'circuitjs1', 'app.js'), 'utf8')).toBe('console.log(1)\n')
    expect(fs.existsSync(path.join(target, 'circuitjs1', `${STRONG_NAME}.cache.js`))).toBe(true)
    expect(fs.existsSync(path.join(target, 'LICENSE'))).toBe(true)
  })

  it('uses CIRCUITJS_LOCAL_DIR when target is absent', () => {
    const root = makeFixture()
    const target = path.join(temporaryDir('circuitjs-target-'), 'circuitjs1')

    main({ env: { CIRCUITJS_LOCAL_DIR: root }, argv: [], targetDir: target })

    expect(fs.existsSync(path.join(target, 'circuitjs.html'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'circuitjs1', `${STRONG_NAME}.cache.js`))).toBe(true)
  })

  it('reports an unpublished repository instead of faking a download', () => {
    const target = path.join(temporaryDir('circuitjs-target-'), 'circuitjs1')
    const missingRepo = path.join(temporaryDir('circuitjs-remote-'), 'missing.git')

    expect(() =>
      main({
        env: { CIRCUITJS_REPO_URL: missingRepo },
        argv: [],
        targetDir: target,
      }),
    ).toThrow(/CIRCUITJS_LOCAL_DIR/)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('rejects malformed manifest lines', () => {
    const root = temporaryDir('circuitjs-manifest-')
    const manifest = path.join(root, 'MANIFEST.sha256')
    fs.writeFileSync(manifest, 'not-a-digest  circuitjs1/circuitjs.html\n')
    expect(() => readManifest(manifest)).toThrow(/invalid sha256 manifest line/)
  })

  const realSnapshotDir = process.env.CIRCUITJS_LOCAL_DIR?.trim() ?? ''
  it.skipIf(realSnapshotDir === '')(
    'matches the production snapshot counts when CIRCUITJS_LOCAL_DIR is set',
    () => {
      const runtime = runtimeRoot(realSnapshotDir)
      expect(listFiles(runtime)).toHaveLength(351)
      const { strongNames, missing } = checkCachePayloads(runtime)
      expect(strongNames).toHaveLength(5)
      expect(missing).toEqual([])
      expect(readManifest(path.join(path.dirname(runtime), 'MANIFEST.sha256'))).toHaveLength(351)
    },
  )
})
