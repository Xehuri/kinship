#!/usr/bin/env node
/**
 * Fetch the CircuitJS1 static plugin into public/circuitjs1.
 *
 * CircuitJS1 is GPL-2.0 and lives in the independent repository
 * Xehuri/kinship-circuitjs. The public tree does not vendor it.
 *
 * Resolution order:
 *   1. public/circuitjs1/circuitjs.html already exists -> nothing to do
 *      (unless --force is passed).
 *   2. CIRCUITJS_LOCAL_DIR points at a checkout (repo root or runtime root)
 *      -> verify MANIFEST.sha256, then copy from there.
 *   3. Otherwise clone the tagged repository into a temporary directory and
 *      copy circuitjs1/ into public/circuitjs1/.
 *
 * The remote repository is published at
 * https://github.com/Xehuri/kinship-circuitjs. Builds clone the pinned v0.1.1
 * tag; offline builds can set CIRCUITJS_LOCAL_DIR to a local checkout.
 *
 * Environment:
 *   CIRCUITJS_LOCAL_DIR  local checkout or runtime directory (offline builds)
 *   CIRCUITJS_REPO_URL   override the pinned repository URL
 *   CIRCUITJS_REF        override the pinned tag (default v0.1.1)
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY = 'https://github.com/Xehuri/kinship-circuitjs.git'
export const REF = 'v0.1.1'

function resolveMobileRoot() {
  const url = import.meta.url
  if (typeof url === 'string' && url.startsWith('file:')) {
    return fileURLToPath(new URL('..', url))
  }
  // Vitest rewrites import.meta.url to a non-file URL; tests always pass an
  // explicit target directory, so the working directory is a safe fallback.
  return process.cwd()
}

export const MOBILE_ROOT = resolveMobileRoot()
export const TARGET_DIR = path.join(MOBILE_ROOT, 'public', 'circuitjs1')

const NOTICE_FILES = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']

function log(message) {
  console.log(`[fetch-circuitjs] ${message}`)
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Return the directory that contains circuitjs.html. Accepts either a
 * kinship-circuitjs checkout (runtime under circuitjs1/) or a runtime root.
 */
export function runtimeRoot(candidate) {
  const resolved = path.resolve(candidate)
  if (fs.existsSync(path.join(resolved, 'circuitjs.html'))) {
    return resolved
  }
  const nested = path.join(resolved, 'circuitjs1')
  if (fs.existsSync(path.join(nested, 'circuitjs.html'))) {
    return nested
  }
  throw new Error(
    `no circuitjs.html under ${resolved} or ${nested}; ` +
      'set CIRCUITJS_LOCAL_DIR to a kinship-circuitjs checkout or runtime directory',
  )
}

export function readManifest(manifestPath) {
  const entries = []
  const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line)
    if (!match) {
      throw new Error(`${manifestPath}:${index + 1}: invalid sha256 manifest line`)
    }
    entries.push({ sha256: match[1], path: match[2] })
  })
  if (entries.length === 0) {
    throw new Error(`${manifestPath}: manifest is empty`)
  }
  return entries
}

function locateManifest(runtimeDir) {
  const candidates = [
    path.join(path.dirname(runtimeDir), 'MANIFEST.sha256'),
    path.join(runtimeDir, 'MANIFEST.sha256'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

/**
 * Verify a runtime tree against a repository MANIFEST.sha256. The manifest is
 * repo-relative (circuitjs1/...); the runtime directory is the prefix root.
 */
export function verifyRuntime(runtimeDir, manifestPath) {
  const entries = readManifest(manifestPath)
  const repoRelative = entries.every((entry) => entry.path.startsWith('circuitjs1/'))
  const base = runtimeDir
  const prefix = repoRelative ? 'circuitjs1/' : ''
  const problems = []

  for (const entry of entries) {
    const relative = prefix ? entry.path.slice(prefix.length) : entry.path
    const file = path.join(base, relative)
    if (!fs.existsSync(file)) {
      problems.push(`missing ${relative}`)
      continue
    }
    if (sha256(file) !== entry.sha256) {
      problems.push(`sha256 mismatch ${relative}`)
    }
  }

  return { count: entries.length, problems }
}

function verifyOrThrow(runtimeDir, manifestPath) {
  const result = verifyRuntime(runtimeDir, manifestPath)
  if (result.problems.length > 0) {
    const preview = result.problems.slice(0, 5).join('; ')
    const suffix = result.problems.length > 5 ? ` (${result.problems.length} total)` : ''
    throw new Error(`snapshot verification failed: ${preview}${suffix}`)
  }
  log(`verified ${result.count} files against ${manifestPath}`)
}

const GWT_STRONG_NAME = /unflattenKeylistIntoAnswers\(\s*\[[^\]]*\]\s*,\s*['"]([0-9A-Fa-f]{32})['"]\s*\)/g
const QUOTED_STRONG_NAME = /['"]([0-9A-Fa-f]{32})['"]/g

/**
 * Extract the GWT permutation strong names from circuitjs1.nocache.js. The
 * canonical form is unflattenKeylistIntoAnswers([...], '<strongName>'); the
 * quoted-32-hex fallback tolerates minor GWT output changes.
 */
export function parseStrongNames(nocacheSource, label = 'circuitjs1.nocache.js') {
  const names = new Set()
  for (const pattern of [GWT_STRONG_NAME, QUOTED_STRONG_NAME]) {
    pattern.lastIndex = 0
    for (const match of nocacheSource.matchAll(pattern)) {
      names.add(match[1])
    }
    if (names.size > 0) break
  }
  if (names.size === 0) {
    throw new Error(`could not parse any GWT strong names from ${label}`)
  }
  return [...names]
}

/**
 * Check that every strong name in the GWT bootstrap script has its compiled
 * permutation payload. Returns the parsed names and any missing file names.
 */
export function checkCachePayloads(runtimeDir) {
  const gwtDir = path.join(runtimeDir, 'circuitjs1')
  const nocache = path.join(gwtDir, 'circuitjs1.nocache.js')
  if (!fs.existsSync(nocache)) {
    return { strongNames: [], missing: ['circuitjs1.nocache.js'] }
  }
  const strongNames = parseStrongNames(fs.readFileSync(nocache, 'utf8'), nocache)
  const missing = strongNames
    .map((name) => `${name}.cache.js`)
    .filter((payload) => !fs.existsSync(path.join(gwtDir, payload)))
  return { strongNames, missing }
}

function assertCachePayloads(runtimeDir) {
  const { strongNames, missing } = checkCachePayloads(runtimeDir)
  if (missing.includes('circuitjs1.nocache.js')) {
    throw new Error(
      `missing GWT bootstrap script: ${path.join(runtimeDir, 'circuitjs1', 'circuitjs1.nocache.js')}`,
    )
  }
  if (missing.length > 0) {
    throw new Error(
      `missing GWT cache payload(s) for ${strongNames.length} strong name(s): ${missing.join(', ')}`,
    )
  }
  log(`verified ${strongNames.length} GWT cache payloads in ${runtimeDir}`)
}

function copyNotices(repoRoot, targetDir) {
  for (const name of NOTICE_FILES) {
    const source = path.join(repoRoot, name)
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(targetDir, name))
    }
  }
}

/**
 * Copy one runtime tree into targetDir and verify it. Exported for tests.
 */
export function install(sourceDir, targetDir) {
  const runtimeDir = runtimeRoot(sourceDir)
  assertCachePayloads(runtimeDir)
  const manifestPath = locateManifest(runtimeDir)
  if (manifestPath) {
    verifyOrThrow(runtimeDir, manifestPath)
  } else {
    log(`warning: no MANIFEST.sha256 found for ${runtimeDir}; skipping hash check`)
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.cpSync(runtimeDir, targetDir, { recursive: true })

  const entry = path.join(targetDir, 'circuitjs.html')
  if (!fs.existsSync(entry)) {
    throw new Error(`copy finished without ${entry}`)
  }
  assertCachePayloads(targetDir)

  if (manifestPath) {
    const copied = verifyRuntime(targetDir, manifestPath)
    if (copied.problems.length > 0) {
      throw new Error(`copied snapshot failed verification: ${copied.problems.slice(0, 5).join('; ')}`)
    }
  }

  if (manifestPath) {
    copyNotices(path.dirname(runtimeDir), targetDir)
  }
  log(`installed ${targetDir}`)
}

function installFromRepository(targetDir, repoUrl, ref) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinship-circuitjs-'))
  const checkout = path.join(tempRoot, 'checkout')
  try {
    log(`cloning ${repoUrl} (${ref})`)
    const clone = spawnSync(
      'git',
      ['clone', '--depth', '1', '--branch', ref, repoUrl, checkout],
      { stdio: 'inherit' },
    )
    if (clone.error) {
      throw new Error(`git clone failed to start: ${clone.error.message}`)
    }
    if (clone.status !== 0) {
      throw new Error(
        `git clone failed (exit ${clone.status ?? 'unknown'}). ` +
          `${repoUrl} may not be published at tag ${ref} yet; ` +
          'set CIRCUITJS_LOCAL_DIR to a local kinship-circuitjs checkout for offline builds.',
      )
    }
    install(checkout, targetDir)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

/**
 * CLI entry point. Exported so tests can inject env/argv/targetDir.
 */
export function main({ env = process.env, argv = process.argv.slice(2), targetDir = TARGET_DIR } = {}) {
  const force = argv.includes('--force')
  const targetEntry = path.join(targetDir, 'circuitjs.html')
  const localDir = env.CIRCUITJS_LOCAL_DIR?.trim()

  if (fs.existsSync(targetEntry) && !localDir && !force) {
    log(`already present: ${targetEntry}`)
    return
  }

  if (localDir) {
    const runtimeDir = runtimeRoot(localDir)
    log(`copying from CIRCUITJS_LOCAL_DIR=${runtimeDir}`)
    install(runtimeDir, targetDir)
    return
  }

  installFromRepository(
    targetDir,
    env.CIRCUITJS_REPO_URL?.trim() || REPOSITORY,
    env.CIRCUITJS_REF?.trim() || REF,
  )
}

const invokedDirectly =
  typeof import.meta.url === 'string' &&
  import.meta.url.startsWith('file:') &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`[fetch-circuitjs] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
