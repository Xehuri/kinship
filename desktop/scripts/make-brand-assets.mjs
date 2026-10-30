#!/usr/bin/env node
// 从唯一品牌主源 SVG 派生圆角卡片 SVG，并生成 Electron / Android / PC 采集端图标。
// 生成结果确定性可复现；--check 只读校验，不写文件。

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(scriptDir, '..')
const repoRoot = resolve(desktopDir, '..')

const masterPath = resolve(repoRoot, 'assets/brand/kinship-mascot-rose.svg')
const masterSha = '667f4d38d9a2abfb4c6a7e405ec8c5e8509df8ad41472a9ed1dcd24a911c90d8'
const baseSize = 2048
const icoSizes = [16, 24, 32, 48, 64, 128, 256]

const sourceRootLine =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1536 1536">'
// 22.5% rounded card (rx 316 of 1404). The white ring inside the clip hides the source's
// thin frame; the rose frame outside the clip follows the same contour, flush to the edge.
const roundedRootLines = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="64 64 1408 1408">
<defs><clipPath id="card"><rect x="66" y="66" width="1404" height="1404" rx="316" ry="316"/></clipPath></defs>
<rect x="66" y="66" width="1404" height="1404" rx="316" ry="316" fill="#ffffff"/>
<g clip-path="url(#card)">`
const roundedTailLines = `<rect x="74" y="74" width="1388" height="1388" rx="39" ry="39" fill="none" stroke="#ffffff" stroke-width="14"/>
</g>
<rect x="73" y="73" width="1390" height="1390" rx="309" ry="309" fill="none" stroke="#d67d99" stroke-width="14"/>
</svg>`
const requiredMarkers = [
  'viewBox="64 64 1408 1408"',
  'clipPath id="card"',
  'clip-path="url(#card)"',
  'rx="316"',
  'stroke="#d67d99"',
  'stroke-width="14"',
]

const faviconOutput = {
  path: 'frontend/mobile/public/favicon.svg',
  absolute: resolve(repoRoot, 'frontend/mobile/public/favicon.svg'),
}

const pngOutputs = [
  { path: 'desktop/resources/icon.png', size: 512 },
  { path: 'app/src/main/res/mipmap-mdpi/ic_launcher.png', size: 48 },
  { path: 'app/src/main/res/mipmap-hdpi/ic_launcher.png', size: 72 },
  { path: 'app/src/main/res/mipmap-xhdpi/ic_launcher.png', size: 96 },
  { path: 'app/src/main/res/mipmap-xxhdpi/ic_launcher.png', size: 144 },
  { path: 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', size: 192 },
  { path: 'desktop/pc-sensor/assets/tray-icon-32.png', size: 32 },
  { path: 'desktop/pc-sensor/assets/tray-icon-64.png', size: 64 },
].map((entry) => ({ ...entry, absolute: resolve(repoRoot, entry.path) }))

const icoOutputs = [
  { path: 'desktop/resources/icon.ico' },
  { path: 'desktop/pc-sensor/assets/kinship-pc-sensor.ico' },
].map((entry) => ({ ...entry, absolute: resolve(repoRoot, entry.path) }))

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function buildRoundedSvg(source) {
  const text = source.toString('utf8')
  const rootIndex = text.indexOf(sourceRootLine)
  if (rootIndex === -1) throw new Error(`master SVG is missing the expected root line: ${sourceRootLine}`)
  if (text.indexOf(sourceRootLine, rootIndex + sourceRootLine.length) !== -1) throw new Error('master SVG contains more than one expected root line')
  const closingTag = '</svg>'
  const closingIndex = text.lastIndexOf(closingTag)
  if (closingIndex === -1) throw new Error('master SVG is missing the closing </svg>')
  if (text.indexOf(closingTag) !== closingIndex) throw new Error('master SVG contains more than one closing </svg>')
  const sourceContent = text.slice(rootIndex + sourceRootLine.length, closingIndex)
  if (sourceContent.trim().length === 0) throw new Error('master SVG has no content between the root line and </svg>')
  const content = sourceContent.endsWith('\n') ? sourceContent : `${sourceContent}\n`
  const derived = `${text.slice(0, rootIndex)}${roundedRootLines}${content}${roundedTailLines}${text.slice(closingIndex + closingTag.length)}`
  for (const marker of requiredMarkers) if (!derived.includes(marker)) throw new Error(`derived SVG is missing expected marker: ${marker}`)
  if (!derived.trimEnd().endsWith(roundedTailLines)) throw new Error('derived SVG does not close the card clip group and rose frame')
  return Buffer.from(derived, 'utf8')
}

async function assertRenderableSvg(svg, label) {
  let meta
  try {
    meta = await sharp(svg).metadata()
  } catch (error) {
    throw new Error(`${label} is not renderable: ${error.message}`)
  }
  if (meta.format !== 'svg' || !meta.width || !meta.height) throw new Error(`${label} is not a valid SVG`)
}

async function loadMasterSvg() {
  let svg
  try {
    svg = await readFile(masterPath)
  } catch (error) {
    throw new Error(`master SVG is unreadable: ${masterPath} (${error.message})`)
  }
  const actual = sha256(svg)
  if (actual !== masterSha) {
    throw new Error(
      `master SVG SHA-256 mismatch\n  file:     ${masterPath}\n  expected: ${masterSha}\n  actual:   ${actual}`,
    )
  }
  const roundedSvg = buildRoundedSvg(svg)
  await assertRenderableSvg(roundedSvg, 'derived rounded SVG')
  return roundedSvg
}

async function renderBasePng(svg) {
  const buffer = await sharp(svg, { density: 144 })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer()
  const meta = await sharp(buffer).metadata()
  if (meta.width !== baseSize || meta.height !== baseSize) {
    throw new Error(`base render must be ${baseSize}x${baseSize}, got ${meta.width}x${meta.height}`)
  }
  return buffer
}

async function renderPng(basePng, size) {
  // lanczos2 avoids the 1/255 alpha ringing lanczos3 leaves at the 192px card corners.
  return sharp(basePng)
    .resize(size, size, { fit: 'fill', kernel: 'lanczos2' })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

async function buildAssets(roundedSvg) {
  const basePng = await renderBasePng(roundedSvg)
  const sizes = [...new Set([...pngOutputs.map((entry) => entry.size), ...icoSizes])]
  const pngBySize = new Map()
  for (const size of sizes) {
    pngBySize.set(size, await renderPng(basePng, size))
  }
  const icoBuffer = await pngToIco(icoSizes.map((size) => pngBySize.get(size)))
  return { pngBySize, icoBuffer, faviconSvg: roundedSvg }
}

async function generate({ pngBySize, icoBuffer, faviconSvg }) {
  await mkdir(dirname(faviconOutput.absolute), { recursive: true })
  await writeFile(faviconOutput.absolute, faviconSvg)
  console.log(`wrote ${faviconOutput.path} (rounded card SVG)`)
  for (const output of pngOutputs) {
    await mkdir(dirname(output.absolute), { recursive: true })
    await writeFile(output.absolute, pngBySize.get(output.size))
    console.log(`wrote ${output.path} (${output.size}x${output.size})`)
  }
  for (const output of icoOutputs) {
    await mkdir(dirname(output.absolute), { recursive: true })
    await writeFile(output.absolute, icoBuffer)
    console.log(`wrote ${output.path} (${icoSizes.join('/')})`)
  }
}

async function readIfExists(path) {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

function icoEntrySizes(buffer) {
  if (buffer.length < 6) throw new Error('truncated ICO header')
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error('not an ICO file')
  }
  const count = buffer.readUInt16LE(4)
  const sizes = []
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16
    if (offset + 16 > buffer.length) throw new Error('truncated ICO directory')
    const width = buffer.readUInt8(offset) || 256
    const height = buffer.readUInt8(offset + 1) || 256
    if (width !== height) throw new Error(`ICO entry ${index} is not square`)
    sizes.push(width)
  }
  return sizes
}

async function verify({ pngBySize, icoBuffer, faviconSvg }) {
  const problems = []
  const committedSvg = await readIfExists(faviconOutput.absolute)
  if (!committedSvg) {
    problems.push(`${faviconOutput.path}: missing`)
  } else if (!committedSvg.equals(faviconSvg)) {
    problems.push(
      `${faviconOutput.path}: SVG bytes differ from derived rounded card (committed sha256=${sha256(committedSvg)}, derived sha256=${sha256(faviconSvg)})`,
    )
  }
  for (const output of pngOutputs) {
    const committed = await readIfExists(output.absolute)
    if (!committed) {
      problems.push(`${output.path}: missing`)
      continue
    }
    let meta
    try {
      meta = await sharp(committed).metadata()
    } catch (error) {
      problems.push(`${output.path}: unreadable PNG (${error.message})`)
      continue
    }
    if (meta.format !== 'png') {
      problems.push(`${output.path}: expected PNG, got ${meta.format}`)
    }
    if (meta.width !== output.size || meta.height !== output.size) {
      problems.push(
        `${output.path}: expected ${output.size}x${output.size}, got ${meta.width}x${meta.height}`,
      )
      continue
    }
    const committedRaw = await sharp(committed).ensureAlpha().raw().toBuffer()
    const expectedRaw = await sharp(pngBySize.get(output.size)).ensureAlpha().raw().toBuffer()
    if (!committedRaw.equals(expectedRaw)) {
      problems.push(`${output.path}: pixel data differs from deterministic render`)
    }
  }
  for (const output of icoOutputs) {
    const committed = await readIfExists(output.absolute)
    if (!committed) {
      problems.push(`${output.path}: missing`)
      continue
    }
    if (!committed.equals(icoBuffer)) {
      problems.push(
        `${output.path}: ICO bytes differ (committed sha256=${sha256(committed)}, generated sha256=${sha256(icoBuffer)})`,
      )
    }
    let sizes
    try {
      sizes = icoEntrySizes(committed)
    } catch (error) {
      problems.push(`${output.path}: ${error.message}`)
      continue
    }
    if (sizes.join('/') !== icoSizes.join('/')) {
      problems.push(
        `${output.path}: expected entries ${icoSizes.join('/')}, got ${sizes.join('/') || 'none'}`,
      )
    }
  }
  return problems
}

async function main() {
  const args = process.argv.slice(2)
  const unknown = args.filter((arg) => arg !== '--check')
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(' ')}`)
  const checkOnly = args.includes('--check')
  const roundedSvg = await loadMasterSvg()
  const assets = await buildAssets(roundedSvg)
  if (!checkOnly) {
    await generate(assets)
    console.log(
      `brand assets: OK (1 SVG + ${pngOutputs.length} PNG + ${icoOutputs.length} ICO, master ${masterSha.slice(0, 12)}...)`,
    )
    return
  }
  const problems = await verify(assets)
  if (problems.length > 0) {
    console.error(`brand assets: check FAILED (${problems.length} mismatch(es))`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(
    `brand assets: check OK (1 SVG + ${pngOutputs.length} PNG + ${icoOutputs.length} ICO, master ${masterSha.slice(0, 12)}...)`,
  )
}

try {
  await main()
} catch (error) {
  console.error(`brand assets: ${error.message}`)
  process.exitCode = 1
}
