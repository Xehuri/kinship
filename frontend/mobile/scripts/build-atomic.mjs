#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const productionDist = path.resolve(projectRoot, 'dist')

function fail(message) {
  console.error(`[build-atomic] ${message}`)
  process.exit(1)
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

function parseArgs(argv) {
  let outDir = null
  let allowDist = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out-dir') {
      outDir = argv[index + 1]
      index += 1
      if (!outDir) fail('--out-dir requires a directory value')
    } else if (arg.startsWith('--out-dir=')) {
      outDir = arg.slice('--out-dir='.length)
      if (!outDir) fail('--out-dir requires a directory value')
    } else if (arg === '--allow-dist') {
      allowDist = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/build-atomic.mjs [--out-dir <dir>] [--allow-dist]')
      process.exit(0)
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }

  return { outDir: outDir ?? `dist-${timestamp()}`, allowDist }
}

const { outDir, allowDist } = parseArgs(process.argv.slice(2))
const resolvedOutDir = path.resolve(projectRoot, outDir)

if (resolvedOutDir === productionDist && !allowDist) {
  fail('refusing to build into production "dist" (pass --allow-dist to override)')
}

function localBin(name) {
  const binDir = path.join(projectRoot, 'node_modules', '.bin')
  const executable = path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name)
  if (!existsSync(executable)) {
    fail(`missing local binary: ${executable} (run npm install first)`)
  }
  return executable
}

function run(label, executable, args) {
  console.log(`[build-atomic] ${label}`)
  const result = spawnSync(executable, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) {
    fail(`${label} failed to start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`${label} exited with code ${result.status ?? 'unknown'}`)
  }
}

run('typecheck: vue-tsc -b', localBin('vue-tsc'), ['-b'])
run(`build: vite build --outDir ${outDir}`, localBin('vite'), [
  'build',
  '--outDir',
  outDir,
  '--emptyOutDir',
])

console.log(`[build-atomic] output dir: ${resolvedOutDir}`)
