#!/usr/bin/env node
/**
 * 截图产物校验器。
 *
 * usage: node scripts/check-shots.mjs <screenshot-dir> <expected-count>
 *
 * 校验:
 * - 目录存在, PNG 数量等于 expected-count;
 * - 文件非空, PNG 签名正确;
 * - 文件名符合 <surface>__<theme>__<viewport>.png;
 * - IHDR 宽高与矩阵视口一致 (1440x900 / 390x844)。
 *
 * 全部通过输出 PASS 并以 0 退出; 任一失败输出 FAIL 并以 1 退出。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { SURFACES, THEMES, VIEWPORTS } from './shot-matrix.mjs'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FILE_PATTERN = /^([a-z0-9-]+)__([a-z0-9-]+)__(\d{3,4}x\d{3,4})\.png$/
const KNOWN_SURFACES = new Set(SURFACES.map((surface) => surface.id))
const KNOWN_VIEWPORTS = new Map(VIEWPORTS.map((viewport) => [viewport.id, viewport]))
const KNOWN_THEMES = new Set(THEMES)

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function parsePng(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    return null
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

const args = process.argv.slice(2)
if (args.length !== 2) {
  fail('usage: node scripts/check-shots.mjs <screenshot-dir> <expected-count>')
}

const [rawDir, rawCount] = args
const dir = path.resolve(rawDir)
const expected = Number(rawCount)

if (!Number.isInteger(expected) || expected <= 0) {
  fail(`expected-count must be a positive integer, got: ${rawCount}`)
}
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  fail(`screenshot directory not found: ${dir}`)
}

const files = readdirSync(dir)
  .filter((name) => name.toLowerCase().endsWith('.png'))
  .sort()

const problems = []
if (files.length !== expected) {
  problems.push(`expected ${expected} PNG files, found ${files.length} in ${dir}`)
}

for (const file of files) {
  const fullPath = path.join(dir, file)
  const match = FILE_PATTERN.exec(file)
  if (!match) {
    problems.push(`${file}: filename does not match <surface>__<theme>__<viewport>.png`)
    continue
  }

  const [, surfaceId, theme, viewportId] = match
  if (!KNOWN_SURFACES.has(surfaceId)) {
    problems.push(`${file}: unknown surface '${surfaceId}'`)
  }
  if (!KNOWN_THEMES.has(theme)) {
    problems.push(`${file}: unknown theme '${theme}'`)
  }
  const viewport = KNOWN_VIEWPORTS.get(viewportId)
  if (!viewport) {
    problems.push(`${file}: unknown viewport '${viewportId}'`)
    continue
  }

  const size = statSync(fullPath).size
  if (size === 0) {
    problems.push(`${file}: file is empty`)
    continue
  }

  const dimensions = parsePng(readFileSync(fullPath))
  if (!dimensions) {
    problems.push(`${file}: not a valid PNG (signature or IHDR missing)`)
    continue
  }
  if (dimensions.width !== viewport.width || dimensions.height !== viewport.height) {
    problems.push(
      `${file}: dimensions ${dimensions.width}x${dimensions.height} != expected ${viewport.width}x${viewport.height}`,
    )
    continue
  }

  console.log(`PASS ${file} ${dimensions.width}x${dimensions.height} ${size} bytes`)
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`FAIL: ${problem}`)
  }
  process.exit(1)
}

console.log(`PASS: ${files.length}/${expected} screenshots verified in ${dir}`)
