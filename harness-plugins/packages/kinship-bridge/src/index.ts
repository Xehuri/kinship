/**
 * Host-level Kinship bridge plugin.
 *
 * One loopback HTTP server over the live dsh agent registry. It binds at most
 * one root Session whose agent preset is `kinship`; binding is persisted under
 * `$DSH_HOME/kinship/binding.json`.
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
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BindingStore, defaultBindingPath } from './binding.js'
import { createCordisHost } from './host.js'
import { startBridgeServer } from './server.js'
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

/** Bridge version reported by `GET /v1/health`. */
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

function resolveToken(ctx: Context, config: Config): string {
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
    return value
  }

  const fromEnv = process.env[config.tokenEnv]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv

  const dir = join(harnessHome(), 'kinship')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'bridge-token')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing !== '') return existing
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
  return generated
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

  const token = resolveToken(ctx, config)
  const server: BridgeServerHandle = await startBridgeServer({
    host,
    binding,
    token,
    hostname: config.host,
    port: config.port,
    version: BRIDGE_VERSION,
    dshVersion: resolveDshVersion(),
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
