// @vitest-environment node
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeNetworkLayer } from '../../src/main/lib/network-probe'
import { normalizeFingerprint } from '../../src/main/lib/tls'
import type { NetworkLayer, NetworkLayerTlsMode } from '../../src/shared/types'

const servers: Array<{ close: () => Promise<void> }> = []

function layer(address: string, tlsMode: NetworkLayerTlsMode = 'system', extra: Partial<NetworkLayer> = {}): NetworkLayer {
  return {
    id: 'probe',
    type: 'direct',
    name: 'probe',
    address,
    enabled: true,
    tlsMode,
    ...extra,
  }
}

async function startHttp(status: number, delayMs = 0): Promise<{ address: string }> {
  const server = createHttpServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status }))
    }, delayMs)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  servers.push({
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  })
  const address = server.address() as AddressInfo
  return { address: `http://127.0.0.1:${String(address.port)}` }
}

interface FixtureModule {
  readonly startFixtureServer: () => Promise<{
    readonly url: string
    readonly certPath: string
    close: () => Promise<void>
  }>
}

async function startTlsFixture(): Promise<{
  readonly url: string
  readonly fingerprint: string
  close: () => Promise<void>
}> {
  const module: unknown = await import('../../e2e/fixtures/server.mjs')
  const fixture = await (module as FixtureModule).startFixtureServer()
  servers.push({ close: fixture.close })
  const certificate = new X509Certificate(readFileSync(fixture.certPath))
  return {
    url: fixture.url,
    fingerprint: normalizeFingerprint(certificate.fingerprint256),
    close: fixture.close,
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('probeNetworkLayer', () => {
  it('accepts a healthy HTTP loopback layer', async () => {
    const { address } = await startHttp(200)
    const result = await probeNetworkLayer(layer(address))
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('rejects unhealthy status codes and timeouts', async () => {
    const unhealthy = await startHttp(503)
    expect(await probeNetworkLayer(layer(unhealthy.address))).toMatchObject({
      ok: false,
      code: 'HEALTH_STATUS',
    })

    const slow = await startHttp(200, 200)
    expect(
      await probeNetworkLayer(layer(slow.address), { timeoutMs: 30 }),
    ).toMatchObject({ ok: false, code: 'TIMEOUT' })
  })

  it('rejects a self-signed certificate in system mode but accepts insecure mode', async () => {
    const fixture = await startTlsFixture()
    expect(await probeNetworkLayer(layer(fixture.url, 'system'))).toMatchObject({
      ok: false,
      code: 'TLS_ERROR',
    })
    expect(await probeNetworkLayer(layer(fixture.url, 'insecure'))).toMatchObject({
      ok: true,
    })
  })

  it('accepts the pinned leaf fingerprint and rejects a mismatched pin', async () => {
    const fixture = await startTlsFixture()
    expect(
      await probeNetworkLayer(
        layer(fixture.url, 'pinned', { fingerprint256: fixture.fingerprint }),
      ),
    ).toMatchObject({ ok: true })
    expect(
      await probeNetworkLayer(
        layer(fixture.url, 'pinned', { fingerprint256: '0'.repeat(64) }),
      ),
    ).toMatchObject({ ok: false, code: 'TLS_PIN_MISMATCH' })
  })

  it('accepts a literal IPv6 loopback origin', async (context) => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '::1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
    } catch {
      context.skip()
      return
    }
    servers.push({
      close: () =>
        new Promise((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    })
    const address = server.address() as AddressInfo
    const result = await probeNetworkLayer(
      layer(`http://[::1]:${String(address.port)}`),
    )
    expect(result.ok).toBe(true)
  })

  it('fails closed when a pinned CA file is missing', async () => {
    const fixture = await startTlsFixture()
    const result = await probeNetworkLayer(
      layer(fixture.url, 'pinned', {
        fingerprint256: fixture.fingerprint,
        caPemPath: '/nonexistent/ca.pem',
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'TLS_CA_UNAVAILABLE' })
  })
})

describe('TLS probe isolation', () => {
  it('does not leak insecure trust outside the probed layer', async () => {
    const fixture = await startTlsFixture()
    expect(await probeNetworkLayer(layer(fixture.url, 'insecure'))).toMatchObject({
      ok: true,
    })
    expect(await probeNetworkLayer(layer(fixture.url, 'system'))).toMatchObject({
      ok: false,
      code: 'TLS_ERROR',
    })
  })
})
