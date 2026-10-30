import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER_DIR = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HELPER_DIR, '..', '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '..')

export const PRODUCTION_TOKENS_FILE = resolve(
  REPO_ROOT,
  'frontend/mobile/src/styles/tokens.css',
)
export const DESKTOP_TOKENS_FILE = resolve(
  DESKTOP_ROOT,
  'src/renderer/src/styles/tokens.css',
)

export type ProductionTheme = 'light' | 'dark' | 'glacier'
export type DesktopTheme = 'light' | 'dark'

interface CssBlock {
  readonly selectors: readonly string[]
  readonly declarations: string
  readonly media: string | null
}

export class TokenLookupError extends Error {
  readonly filePath: string
  readonly selector: string
  readonly property: string

  constructor(filePath: string, selector: string, property: string) {
    super(`CSS token ${property} not found for ${selector} in ${filePath}`)
    this.name = 'TokenLookupError'
    this.filePath = filePath
    this.selector = selector
    this.property = property
  }
}

export class TokenColorError extends Error {
  readonly value: string

  constructor(value: string) {
    super(`CSS token is not a hex color: ${value}`)
    this.name = 'TokenColorError'
    this.value = value
  }
}

const PRODUCTION_SELECTORS = {
  light: ':root',
  dark: "[data-theme='dark']",
  glacier: ':root',
} as const satisfies Record<ProductionTheme, string>

const DESKTOP_SELECTORS = {
  light: ':root',
  dark: ":root[data-theme='dark']",
} as const satisfies Record<DesktopTheme, string>

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function normalizeText(value: string): string {
  return value.replace(/["']/g, "'").replace(/\s+/g, ' ').trim()
}

function splitSelectors(value: string): readonly string[] {
  return value.split(',').map(normalizeText).filter((selector) => selector.length > 0)
}

function findBlockEnd(source: string, openIndex: number): number {
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source.charAt(index)
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function parseBlocks(source: string, media: string | null = null): readonly CssBlock[] {
  const blocks: CssBlock[] = []
  let cursor = 0
  while (cursor < source.length) {
    const openIndex = source.indexOf('{', cursor)
    if (openIndex < 0) break
    const prelude = source.slice(cursor, openIndex).trim()
    const closeIndex = findBlockEnd(source, openIndex)
    if (closeIndex < 0) break
    const body = source.slice(openIndex + 1, closeIndex)
    if (prelude.startsWith('@media')) {
      blocks.push(...parseBlocks(body, normalizeText(prelude)))
    } else if (!prelude.startsWith('@')) {
      const declarations = body.trim()
      if (declarations.length > 0) {
        blocks.push({
          selectors: splitSelectors(prelude),
          declarations,
          media,
        })
      }
    }
    cursor = closeIndex + 1
  }
  return blocks
}

function readDeclaration(declarations: string, property: string): string | undefined {
  const pattern = new RegExp(`(?:^|;)\\s*${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+)`, 'i')
  const match = pattern.exec(declarations)
  return match?.[1]?.trim()
}

export function readCssVariable(
  filePath: string,
  selector: string,
  property: string,
  media?: string,
): string {
  const blocks = parseBlocks(stripComments(readFileSync(filePath, 'utf8')))
  const normalizedSelector = normalizeText(selector)
  const candidates = blocks.filter((block) => block.selectors.includes(normalizedSelector))
  const block =
    media === undefined
      ? (candidates.find((candidate) => candidate.media === null) ?? candidates[0])
      : candidates.find(
          (candidate) =>
            candidate.media !== null && normalizeText(candidate.media) === normalizeText(media),
        )
  if (block === undefined) throw new TokenLookupError(filePath, selector, property)
  const value = readDeclaration(block.declarations, property)
  if (value === undefined) throw new TokenLookupError(filePath, selector, property)
  return value
}

export function normalizeHexColor(value: string): string {
  const trimmed = value.trim()
  if (!HEX_PATTERN.test(trimmed)) throw new TokenColorError(trimmed)
  const digits = trimmed.slice(1).toLowerCase()
  if (digits.length === 3) {
    return `#${digits
      .split('')
      .map((digit) => `${digit}${digit}`)
      .join('')}`
  }
  return `#${digits}`
}

export function hexToRgb(value: string): string {
  const digits = normalizeHexColor(value).slice(1)
  const red = Number.parseInt(digits.slice(0, 2), 16)
  const green = Number.parseInt(digits.slice(2, 4), 16)
  const blue = Number.parseInt(digits.slice(4, 6), 16)
  return `rgb(${red}, ${green}, ${blue})`
}

export function productionBackground(theme: ProductionTheme): string {
  return normalizeHexColor(
    readCssVariable(PRODUCTION_TOKENS_FILE, PRODUCTION_SELECTORS[theme], '--bg'),
  )
}

export function desktopBackground(theme: DesktopTheme): string {
  return normalizeHexColor(
    readCssVariable(DESKTOP_TOKENS_FILE, DESKTOP_SELECTORS[theme], '--bg'),
  )
}
