/**
 * Host-level Kinship bridge plugin.
 *
 * One loopback HTTP server over the live dsh agent registry. It binds at most
 * one root Session whose agent preset is `kinship`; binding is persisted under
 * `$DSH_HOME/kinship/binding.json`.
 *
 * The same plugin serves the owner-facing panel API the dsh Web UI's Kinship
 * page reads and writes (see `./ui.ts`), so the adapter's configuration and its
 * bearer token are editable where a user runs the harness rather than by hand.
 *
 * @module kinship-bridge
 */

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { BindingStore, defaultBindingPath } from './binding.js'
import { createCordisHost } from './host.js'
import { startBridgeServer } from './server.js'
import { installUiRoutes, UiError } from './ui.js'
import type { UiConfigView, UiTokenInfo } from './ui.js'
import type { BindingPolicy, BindingSnapshot, BridgeServerHandle } from './types.js'

/** Parsed plugin configuration. */
export interface Config {
  host: string
  port: number
  tokenEnv: string
  tokenFile: string
  policy: BindingPolicy
  sessionId: string
  rebindOnMissing: boolean
  bodyLimitBytes: number
}

/** Config schema shown by `dsh --dump-config-schema`. */
export const Config: z<Config> = z.object({
  host: z.string().default('127.0.0.1').description('Loopback bind address; only 127.0.0.1 or ::1.'),
  port: z.number().step(1).min(0).max(65_535).default(18_765).description('TCP port; 0 selects an ephemeral port.'),
  tokenEnv: z.string().default('KINSHIP_BRIDGE_TOKEN').description('Environment variable holding the bearer token.'),
  tokenFile: z.string().default('').description('Absolute secret-file path; wins over tokenEnv.'),
  policy: z.union([z.const('first' as const), z.const('manual' as const)]).default('first').description('Automatic first-kinship-session binding or manual switching.'),
  sessionId: z.string().default('').description('Optional Session id to bind at startup under manual policy.'),
  rebindOnMissing: z.boolean().default(false).description('Under first policy, bind another live kinship session when the bound one disappears.'),
  bodyLimitBytes: z.number().step(1).min(1).max(1_048_576).default(64 * 1024).description('Maximum JSON request body size.'),
})

/** Stable Cordis plugin name. */
export const name = 'kinship-bridge'

/** The live agent registry is the only required host service. */
export const inject = ['agents']

/** Bridge version reported by `GET /v1/health` and the dsh panel. */
export const BRIDGE_VERSION = '0.1.0'

/** Host service exposed for diagnostics and tests. */
export interface KinshipBridgeService {
  port(): number
  status(): BindingSnapshot
  close(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kinshipBridge: KinshipBridgeService
  }
}

/** The logging surface the token rotation reports through. */
export interface TokenLogger {
  readonly logger: { info(message: string, ...args: unknown[]): void }
}

/** Where the bridge bearer token comes from, plus its current value. */
export interface TokenState {
  readonly token: string
  readonly source: 'env' | 'file' | 'generated'
  readonly env: string | null
  readonly path: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveDshVersion(): string {
  const fromEnv = process.env['DSH_VERSION']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  try {
    const manifest: unknown = createRequire(import.meta.url)('@deepseek-ai/dsh/package.json')
    if (isRecord(manifest) && typeof manifest['version'] === 'string') return manifest['version']
  } catch {
    // A non-CLI embedder may not expose the dsh manifest; health still works.
  }
  return 'unknown'
}

function harnessHome(): string {
  const home = process.env['DSH_HOME']
  return home !== undefined && home.trim() !== '' ? home : join(homedir(), '.dsh')
}

/**
 * Resolve the bearer token and remember where it lives.
 *
 * The precedence matches the documented contract: an absolute secret file wins,
 * then the named environment variable, then a generated harness-home file.
 *
 * @param ctx - plugin context, used for the one generation warning.
 * @param config - validated token source fields.
 * @returns the current token and its source metadata.
 */
function resolveToken(ctx: Context, config: Config): TokenState {
  const configuredFile = config.tokenFile.trim()
  if (configuredFile !== '') {
    if (!isAbsolute(configuredFile)) {
      throw new Error(`kinship-bridge: tokenFile must be absolute: ${configuredFile}`)
    }
    let value: string
    try {
      value = readFileSync(configuredFile, 'utf8').trim()
    } catch (error) {
      throw new Error(
        `kinship-bridge: cannot read tokenFile ${configuredFile}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (value === '') throw new Error(`kinship-bridge: tokenFile ${configuredFile} is empty`)
    return { token: value, source: 'file', env: null, path: configuredFile }
  }

  const fromEnv = process.env[config.tokenEnv]
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return { token: fromEnv, source: 'env', env: config.tokenEnv, path: null }
  }

  const dir = join(harnessHome(), 'kinship')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'bridge-token')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing !== '') return { token: existing, source: 'generated', env: null, path: file }
  }
  const generated = randomBytes(32).toString('hex')
  writeFileSync(file, `${generated}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch (error) {
    ctx.logger.warn(
      'kinship-bridge: could not set mode 0600 on %s: %s',
      file,
      error instanceof Error ? error.message : String(error),
    )
  }
  ctx.logger.info('kinship-bridge: generated bearer token at %s', file)
  return { token: generated, source: 'generated', env: null, path: file }
}

/**
 * Replace the token wherever the running bridge reads it from.
 *
 * An environment-sourced token belongs to the deployment, so rotating it from
 * the panel is refused instead of appearing to succeed until the next restart.
 *
 * @param ctx - plugin context, used for the rotation log line.
 * @param current - the token state the bridge is running with.
 * @returns the replacement token state.
 * @throws {UiError} `409 token_env_managed` or `500 token_write_failed`.
 */
export function rotateToken(ctx: TokenLogger, current: TokenState): TokenState {
  if (current.source === 'env') {
    throw new UiError(
      409,
      'token_env_managed',
      `The bearer token comes from ${current.env ?? 'the environment'}; change that variable and restart dsh to replace it.`,
    )
  }
  const path = current.path
  if (path === null) throw new UiError(500, 'token_unavailable', 'The bridge has no token file to rewrite.')
  const next = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${next}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  } catch (error) {
    throw new UiError(
      500,
      'token_write_failed',
      `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  ctx.logger.info('kinship-bridge: rotated the bearer token at %s', path)
  return { token: next, source: current.source, env: null, path }
}

/** Panel projection of one token state; the value itself needs `reveal`. */
function tokenInfoOf(state: TokenState): UiTokenInfo {
  return { source: state.source, env: state.env, path: state.path, length: state.token.length }
}

/**
 * Mount the bridge HTTP server and its durable binding.
 *
 * @param ctx - host context carrying `agents`.
 * @param config - validated bind address, token source, and binding policy.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const binding = new BindingStore({
    path: defaultBindingPath(),
    policy: config.policy,
    sessionId: config.sessionId,
    rebindOnMissing: config.rebindOnMissing,
    logger: ctx.logger,
  })
  const host = createCordisHost(ctx)
  const reconcile = (): void => {
    try {
      binding.reconcile(host)
    } catch (error) {
      ctx.logger.warn(
        'kinship-bridge: binding reconcile failed: %s',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  reconcile()

  let tokenState = resolveToken(ctx, config)
  const dshVersion = resolveDshVersion()
  const server: BridgeServerHandle = await startBridgeServer({
    host,
    binding,
    token: tokenState.token,
    hostname: config.host,
    port: config.port,
    version: BRIDGE_VERSION,
    dshVersion,
    bodyLimitBytes: config.bodyLimitBytes,
    logger: ctx.logger,
  })

  ctx.effect(() => () => server.close(), 'kinship-bridge server')
  ctx.effect(() => ctx.provide('kinshipBridge', {
    port: () => server.port(),
    status: () => binding.snapshot(),
    close: () => server.close(),
  }), 'kinship-bridge service')

  const offCreated = ctx.on('agent/created', () => {
    reconcile()
    return undefined
  })
  const offDisposed = ctx.on('agent/disposed', () => {
    reconcile()
    return undefined
  })
  ctx.effect(() => () => {
    offCreated()
    offDisposed()
  }, 'kinship-bridge agent listeners')

  const configView = (): UiConfigView => ({
    host: config.host,
    port: config.port,
    tokenEnv: config.tokenEnv,
    tokenFile: config.tokenFile,
    policy: config.policy,
    sessionId: config.sessionId,
    rebindOnMissing: config.rebindOnMissing,
    bodyLimitBytes: config.bodyLimitBytes,
  })

  /**
   * The dsh Web panel talks to this plugin over the Connection's authenticated
   * Fetch channel, so it exists only in compositions that serve the web client.
   * Saving configuration needs `configEditor`; without it the page stays
   * read-only instead of pretending to save.
   */
  ctx.inject(['connection'], (scope) => {
    installUiRoutes(scope, {
      host,
      binding,
      bridge: () => ({ host: config.host, port: server.port(), version: BRIDGE_VERSION, dsh: dshVersion }),
      config: configView,
      editable: () => {
        const editor = scope.get('configEditor')
        const entry = ctx.fiber.entry
        if (editor === undefined || entry === undefined) return false
        try {
          return editor.entries().includes(entry)
        } catch {
          return false
        }
      },
      tokenInfo: () => tokenInfoOf(tokenState),
      token: (action) => {
        if (action === 'reveal') return { token: tokenState.token, info: tokenInfoOf(tokenState) }
        const rotated = rotateToken(ctx, tokenState)
        server.setToken(rotated.token)
        tokenState = rotated
        return { token: rotated.token, info: tokenInfoOf(rotated) }
      },
      saveConfig: async (next) => {
        const editor = scope.get('configEditor')
        const entry = ctx.fiber.entry
        if (editor === undefined || entry === undefined) {
          throw new UiError(409, 'config_read_only', 'This deployment has no configuration editor for the bridge row.')
        }
        const candidate: Record<string, unknown> = { ...next }
        try {
          await editor.edit(entry, () => candidate)
        } catch (error) {
          throw new UiError(
            400,
            'save_failed',
            error instanceof Error ? error.message : String(error),
          )
        }
      },
      bind: (sessionId) => binding.bind(sessionId, host),
    })
    ctx.logger.info('kinship-bridge: panel API registered on /api/kinship/ui')
  })

  ctx.logger.info(
    'kinship-bridge: listening on http://%s:%s (policy=%s)',
    config.host,
    String(server.port()),
    config.policy,
  )
  if (binding.snapshot().status === 'unbound') {
    ctx.logger.info('kinship-bridge: no kinship session bound yet')
  }
}
