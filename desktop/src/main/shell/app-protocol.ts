import { promises as fs, statSync } from 'node:fs'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import type { Session } from 'electron'

const BUNDLE_PROTOCOL = 'axeuh'
const BUNDLE_HOST = 'bundle'
const INDEX_FILE = 'index.html'

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
})

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
].join('; ')

export interface BundleResolution {
  readonly filePath: string
  readonly contentType: string
}

export interface RegisterBundleProtocolOptions {
  readonly bundleRoot: string
  readonly log?: (message: string) => void
  /** Partition sessions do not inherit the global protocol handler. */
  readonly sessions?: readonly Session[]
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * Extracts the path exactly as it appears in the request. The WHATWG URL parser
 * removes `..` segments before we can inspect them, so traversal checks must use
 * the raw input.
 */
function rawPathname(requestUrl: string): string | null {
  const schemeEnd = requestUrl.indexOf('://')
  if (schemeEnd < 0) return null
  const rest = requestUrl.slice(schemeEnd + 3)
  const authorityEnd = rest.search(/[/?#]/)
  if (authorityEnd < 0) return ''
  if (rest[authorityEnd] !== '/') return ''

  const pathAndQuery = rest.slice(authorityEnd)
  const end = pathAndQuery.search(/[?#]/)
  return end < 0 ? pathAndQuery : pathAndQuery.slice(0, end)
}

function resolveIndex(root: string): BundleResolution | null {
  const filePath = resolve(root, INDEX_FILE)
  if (!isFile(filePath)) return null
  return { filePath, contentType: CONTENT_TYPES['.html'] }
}

export function resolveBundlePath(
  requestUrl: string,
  bundleRoot: string,
): BundleResolution | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${BUNDLE_PROTOCOL}:` || url.host !== BUNDLE_HOST) return null

  const root = resolve(bundleRoot)
  const rawPath = rawPathname(requestUrl)
  if (rawPath === null) return null
  if (rawPath.length === 0) return resolveIndex(root)

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    return null
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\')) return null
  if (!decodedPath.startsWith('/') || decodedPath.startsWith('//')) return null

  const segments = decodedPath.split('/')
  if (segments.some((segment) => segment === '..')) return null

  const relativePath = decodedPath.replace(/^\/+/, '')
  if (relativePath.length === 0) return resolveIndex(root)
  if (isAbsolute(relativePath) || /^[a-zA-Z]:\//.test(relativePath)) return null

  const candidate = resolve(root, relativePath)
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  if (isFile(candidate)) {
    return { filePath: candidate, contentType: contentTypeFor(candidate) }
  }

  // Hash routes are handled client-side; unknown extension-less paths fall back
  // to the SPA entry. Missing assets stay 404 so a broken build is visible.
  if (extname(relativePath).length === 0) return resolveIndex(root)
  return null
}

async function handleBundleRequest(
  requestUrl: string,
  root: string,
  log?: (message: string) => void,
): Promise<Response> {
  const resolved = resolveBundlePath(requestUrl, root)
  if (resolved === null) {
    log?.(`bundle 请求被拒绝：${requestUrl}`)
    return new Response('Not Found', { status: 404 })
  }

  try {
    const buffer = await fs.readFile(resolved.filePath)
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'content-type': resolved.contentType,
        'content-security-policy': CONTENT_SECURITY_POLICY,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    log?.(`bundle 文件读取失败：${resolved.filePath} (${reason})`)
    return new Response('Not Found', { status: 404 })
  }
}

export function registerBundleProtocol(options: RegisterBundleProtocolOptions): void {
  const root = resolve(options.bundleRoot)
  const { protocol } = require('electron') as typeof import('electron')
  const targets = [protocol, ...(options.sessions ?? []).map((target) => target.protocol)]

  for (const target of targets) {
    if (target.isProtocolHandled(BUNDLE_PROTOCOL)) {
      options.log?.(`bundle 协议已存在：${root}`)
      continue
    }
    target.handle(BUNDLE_PROTOCOL, (request) =>
      handleBundleRequest(request.url, root, options.log),
    )
  }

  options.log?.(`bundle 协议已注册：${root}`)
}
