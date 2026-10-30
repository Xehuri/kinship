#!/usr/bin/env node
/**
 * 视觉截图矩阵单一真源。
 *
 * 供 e2e/visual.spec.ts 与 CLI 共用: 定义页面 surface、主题、视口、
 * ready 标记与截图命名/输出计划。新增页面只需在 SURFACES 追加一条。
 *
 * CLI:
 *   node scripts/shot-matrix.mjs [--only reports,reminders] [--out DIR]
 *
 * 输出计划: 输出目录、可截图数量、逐张目标路径、跳过原因。
 * 不启动浏览器, 不写入文件; 真正的截图由 Playwright spec 执行。
 */
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 主题列表 (顺序即计划顺序) */
export const THEMES = ['light', 'dark']

/** 视口列表; id 同时用于截图文文件名与 checker 尺寸校验 */
export const VIEWPORTS = [
  { id: '1440x900', width: 1440, height: 900 },
  { id: '390x844', width: 390, height: 844 },
]

/**
 * 页面 surface 定义。
 * ready=false 表示页面仍在重构中, spec 会显式 skip, 不产出截图。
 */
export const SURFACES = [
  {
    id: 'reports',
    route: '/reports',
    title: '报告',
    ready: true,
    readySelector: '.ax-list__body .ax-report-row',
  },
  {
    id: 'reminders',
    route: '/reminders',
    title: '提醒',
    ready: true,
    readySelector: '.ax-reminders__line',
  },
  {
    id: 'files',
    route: '/files',
    title: '文件',
    ready: true,
    readySelector: '[data-testid="files-page"] .ax-files__body',
  },
  {
    id: 'settings',
    route: '/settings',
    title: '设置',
    ready: true,
    readySelector: '.settings-section',
  },
  {
    id: 'chat',
    route: '/chat',
    title: '聊天',
    ready: true,
    readySelector: '[data-testid="chat-thread"]',
  },
  {
    id: 'plan',
    route: '/plan',
    title: '计划',
    ready: true,
    readySelector: '[data-testid="plan-page"]',
  },
]

/** 截图输出根目录 (每次运行在其下新建时间戳目录) */
export const OUT_ROOT = process.env.ARTIFACTS_DIR ?? path.join(tmpdir(), 'kinship-ui-qa')

/** 本地时间戳 YYYYMMDD-HHMMSS */
export function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
}

/** 默认输出目录 */
export function defaultOutDir(date = new Date()) {
  return path.join(OUT_ROOT, timestamp(date))
}

/**
 * 解析 --only CSV; 未提供时返回全部 surface。
 * 未知 id 直接抛错, 避免静默漏截。
 */
export function resolveSurfaces(only) {
  if (!only) return [...SURFACES]
  const ids = String(only)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (ids.length === 0) return [...SURFACES]

  const unknown = ids.filter((id) => !SURFACES.some((surface) => surface.id === id))
  if (unknown.length > 0) {
    throw new Error(`unknown surface: ${unknown.join(', ')}; known: ${SURFACES.map((s) => s.id).join(', ')}`)
  }
  const seen = new Set()
  const selected = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    selected.push(SURFACES.find((surface) => surface.id === id))
  }
  return selected
}

/** 截图文件名: <surface>__<theme>__<viewport>.png */
export function shotFileName(surfaceId, theme, viewportId) {
  return `${surfaceId}__${theme}__${viewportId}.png`
}

/**
 * 构建输出计划。
 * @param {{ only?: string, out?: string, themes?: string[], viewports?: typeof VIEWPORTS }} options
 */
export function buildPlan({ only, out, themes = THEMES, viewports = VIEWPORTS } = {}) {
  const outDir = out ? path.resolve(out) : defaultOutDir()
  const surfaces = resolveSurfaces(only)
  const shots = []
  const skipped = []

  for (const surface of surfaces) {
    if (!surface.ready) {
      skipped.push({ id: surface.id, route: surface.route, reason: 'pending (ready=false)' })
      continue
    }
    for (const theme of themes) {
      for (const viewport of viewports) {
        shots.push({
          surface: surface.id,
          route: surface.route,
          theme,
          viewport: viewport.id,
          width: viewport.width,
          height: viewport.height,
          file: shotFileName(surface.id, theme, viewport.id),
          path: path.join(outDir, shotFileName(surface.id, theme, viewport.id)),
        })
      }
    }
  }

  return { outDir, surfaces, shots, skipped }
}

/** 解析 CLI 参数 */
export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--only' || arg === '--out') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`)
      }
      options[arg === '--only' ? 'only' : 'out'] = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function printHelp() {
  console.log('usage: node scripts/shot-matrix.mjs [--only <csv>] [--out <dir>]')
  console.log('')
  console.log('surfaces:')
  for (const surface of SURFACES) {
    console.log(`  ${surface.id.padEnd(12)} ${surface.route.padEnd(12)} ready=${surface.ready}`)
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const plan = buildPlan({ only: options.only, out: options.out })
  console.log(`[shot-matrix] out: ${plan.outDir}`)
  console.log(`[shot-matrix] screenshots: ${plan.shots.length}`)
  for (const shot of plan.shots) {
    console.log(`  ${shot.surface} ${shot.theme} ${shot.viewport} -> ${shot.path}`)
  }
  for (const item of plan.skipped) {
    console.log(`  SKIP ${item.id} (${item.route}): ${item.reason}`)
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectRun) {
  try {
    main()
  } catch (error) {
    console.error(`[shot-matrix] FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
