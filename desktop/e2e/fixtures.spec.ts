import { test, expect } from '@playwright/test'
import type { IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { startFakeSensor } from './fixtures/fake-sensor.mjs'
import { startFixtureServer } from './fixtures/server.mjs'

interface RawResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

interface HttpsRequestInit {
  readonly method?: string
  readonly body?: string
}

function requestHttps(url: string, init: HttpsRequestInit = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: init.method ?? 'GET', rejectUnauthorized: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.on('error', reject)
    request.end(init.body)
  })
}

test('serves health and the fake SPA over https', async () => {
  const fixture = await startFixtureServer()
  try {
    const health = await requestHttps(`${fixture.url}/health`)
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok', server: 'fixture' })

    const mobile = await requestHttps(`${fixture.url}/mobile/?token=fixture-token`)
    expect(mobile.status).toBe(200)
    expect(mobile.headers['content-type']).toContain('text/html')
    expect(mobile.body).toContain('Fixture SPA')
    expect(mobile.body).toContain('id="echo"')
    expect(mobile.body).toContain('id="result"')
    expect(mobile.body).toContain('id="external" href="https://example.com/"')
    expect(mobile.body).toContain('id="download" href="/api/download"')
    expect(mobile.body).toContain("localStorage.setItem('mobile_token', token)")

    expect(fixture.requests.map((entry: { url: string }) => entry.url)).toContain('/health')
    expect(fixture.requests.some((entry: { url: string }) => entry.url === '/mobile/?token=fixture-token')).toBe(true)
  } finally {
    await fixture.close()
  }
})

test('echoes the authorization header for the fake SPA', async () => {
  const fixture = await startFixtureServer()
  try {
    const echo = await requestHttps(`${fixture.url}/api/echo`)
    expect(echo.status).toBe(200)
    expect(JSON.parse(echo.body)).toEqual({ ok: true, token: null })
  } finally {
    await fixture.close()
  }
})

test('serves the download payload and an ndjson file line', async () => {
  const fixture = await startFixtureServer()
  try {
    const download = await requestHttps(`${fixture.url}/api/download`)
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toBe('application/octet-stream')
    expect(download.body).toBe('FIXTURE_DOWNLOAD_PAYLOAD')

    const files = await requestHttps(`${fixture.url}/api/mobile/files/content`)
    expect(files.status).toBe(200)
    expect(files.headers['content-type']).toBe('application/x-ndjson')
    const lines = files.body.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ path: 'fixture/notes.txt' })
  } finally {
    await fixture.close()
  }
})

test('accepts desktop login and pc sync posts', async () => {
  const fixture = await startFixtureServer()
  try {
    const loginResponse = await requestHttps(`${fixture.url}/login`, { method: 'POST' })
    expect(loginResponse.status).toBe(200)
    expect(JSON.parse(loginResponse.body)).toMatchObject({
      success: true,
      token: 'fixture-token',
      user_id: 'fixture',
      display_name: 'Fixture',
    })

    const syncResponse = await requestHttps(`${fixture.url}/api/pc/sync`, { method: 'POST' })
    expect(syncResponse.status).toBe(200)
    expect(JSON.parse(syncResponse.body)).toEqual({ success: true })
  } finally {
    await fixture.close()
  }
})

test('fake sensor guards routes with bearer auth and shuts down', async () => {
  const sensor = await startFakeSensor()
  try {
    const health = await fetch(`${sensor.baseUrl}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: 'ok',
      agent_id: 'fixture-agent',
      agent_name: 'Fixture PC',
      version: '2.1.0',
    })

    const unauthorized = await fetch(`${sensor.baseUrl}/pc-sensor/status`)
    expect(unauthorized.status).toBe(401)

    const status = await fetch(`${sensor.baseUrl}/pc-sensor/status`, {
      headers: { Authorization: `Bearer ${sensor.token}` },
    })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      running: true,
      enabled: true,
      logged_in: true,
      instance_id: 'fixture-instance',
      version: '2.1.0',
    })

    const shutdown = await fetch(`${sensor.baseUrl}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sensor.token}` },
    })
    expect(shutdown.status).toBe(200)
    expect(await shutdown.json()).toEqual({ success: true })
    expect(sensor.stopped).toBe(true)
  } finally {
    await sensor.close()
  }
})

test('fake sensor merges config patches and masks its token', async () => {
  const sensor = await startFakeSensor()
  try {
    const config = await fetch(`${sensor.baseUrl}/pc-sensor/config`, {
      headers: { Authorization: `Bearer ${sensor.token}` },
    })
    expect(config.status).toBe(200)
    expect(await config.json()).toMatchObject({ enabled: true, backend_token: '******' })

    const patched = await fetch(`${sensor.baseUrl}/pc-sensor/config`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sensor.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, idle_threshold: 600, backend_token: 'updated-token' }),
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({
      enabled: false,
      idle_threshold: 600,
      backend_token: '******',
    })
    expect(sensor.config.idle_threshold).toBe(600)
    expect(sensor.requests.at(-1).body).toContain('updated-token')
  } finally {
    await sensor.close()
  }
})
