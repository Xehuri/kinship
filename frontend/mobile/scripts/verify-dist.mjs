#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function fail(message) {
  console.error(`[verify-dist] FAIL: ${message}`)
  process.exit(1)
}

function newestBuildDir() {
  const candidates = readdirSync(projectRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith('dist-') && entry.name !== 'dist-e2e',
    )
    .map((entry) => ({
      name: entry.name,
      mtime: statSync(path.join(projectRoot, entry.name)).mtimeMs,
    }))
    .sort((left, right) => right.mtime - left.mtime)

  if (candidates.length === 0) {
    fail('no dist-* build directory found (run npm run build:atomic first)')
  }
  return candidates[0].name
}

const args = process.argv.slice(2)
if (args.length > 1) {
  fail('usage: node scripts/verify-dist.mjs [dist-dir]')
}

const requestedDir = args[0] ?? newestBuildDir()
const distDir = path.resolve(projectRoot, requestedDir)
const indexPath = path.join(distDir, 'index.html')

if (!existsSync(indexPath)) {
  fail(`missing index.html in ${distDir}`)
}

const html = readFileSync(indexPath, 'utf8')
const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
  .map((match) => match[1])
  .filter((ref) => ref.startsWith('/mobile/'))

if (refs.length === 0) {
  fail('no /mobile/ src/href references found in index.html')
}

const undefinedRefs = refs.filter((ref) => ref.includes('undefined'))
if (undefinedRefs.length > 0) {
  fail(`references contain "undefined": ${undefinedRefs.join(', ')}`)
}

const assetPaths = []
for (const ref of refs) {
  const cleanRef = ref.split(/[?#]/)[0]
  const relativePath = cleanRef.slice('/mobile/'.length)
  const filePath = path.resolve(distDir, relativePath)
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) {
    fail(`reference escapes dist directory: ${ref}`)
  }
  if (!existsSync(filePath)) {
    fail(`missing referenced asset: ${ref}`)
  }
  assetPaths.push({ ref, filePath })
}

const jsAssets = assetPaths.filter((asset) => /\.m?js$/.test(asset.filePath))
const cssAssets = assetPaths.filter((asset) => /\.css$/.test(asset.filePath))

if (jsAssets.length === 0) {
  fail('index.html references no JS asset')
}
if (cssAssets.length === 0) {
  fail('index.html references no CSS asset')
}

console.log(
  `[verify-dist] PASS ${path.basename(distDir)}: index.html + ${refs.length} refs ` +
    `(${jsAssets.length} JS, ${cssAssets.length} CSS), all assets present`,
)
