import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../../packages/kinship-bridge/src/binding.js'
import { startBridgeServer } from '../../packages/kinship-bridge/src/server.js'
import type { BindingPolicy } from '../../packages/kinship-bridge/src/types.js'
import { FakeBridgeSession, FakeHost, bridgeEvent, sessionInfo } from '../helpers/fake-host.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function binding(path: string, policy: BindingPolicy = 'first', rebindOnMissing = false): BindingStore {
  return new BindingStore({
    path,
    policy,
    sessionId: '',
    rebindOnMissing,
  })
}

function tempPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'kinship-http-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'kinship', 'binding.json')
}

async function serve(
  host: FakeHost,
  store: BindingStore,
  bodyLimitBytes = 64 * 1024,
): Promise<string> {
  const server = await startBridgeServer({
    host,
    binding: store,
    token: 'secret',
    hostname: '127.0.0.1',
    port: 0,
    version: '0.1.0',
    dshVersion: '0.2.2-rc.3-test',
    bodyLimitBytes,
  })
  cleanups.push(() => server.close())
  return `http://127.0.0.1:${String(server.port())}`
}

async function call(
  base: string,
  path: string,
  options: RequestInit & { readonly auth?: boolean } = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const { auth = true, ...init } = options
  const headers = new Headers(init.headers)
  if (auth) headers.set('authorization', 'Bearer secret')
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(`${base}${path}`, { ...init, headers })
  const body: unknown = await response.json()
  return { status: response.status, body }
}

describe('bridge HTTP contract', () => {
  it('requires the bearer token', async () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('s1')))
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const result = await call(base, '/v1/health', { auth: false })
    expect(result.status).toBe(401)
    expect(result.body).toMatchObject({ error: 'unauthorized' })
  })

  it('reports health and the bound session', async () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('s1', { status: 'running' })))
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const health = await call(base, '/v1/health')
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({
      ok: true,
      version: '0.1.0',
      dsh: '0.2.2-rc.3-test',
      session_id: 's1',
      preset: 'kinship',
      status: 'bound',
    })

    const session = await call(base, '/v1/session')
    expect(session.status).toBe(200)
    expect(session.body).toMatchObject({
      session_id: 's1',
      preset: 'kinship',
      status: 'bound',
      policy: 'first',
    })
  })

  it('returns the two 409 binding errors', async () => {
    const emptyHost = new FakeHost()
    const manual = binding(tempPath(), 'manual')
    manual.reconcile(emptyHost)
    const emptyBase = await serve(emptyHost, manual)
    expect((await call(emptyBase, '/v1/session')).body).toMatchObject({ error: 'no_kinship_session' })
    expect((await call(emptyBase, '/v1/session/messages', {
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    })).body).toMatchObject({ error: 'no_kinship_session' })

    const missingHost = new FakeHost()
    missingHost.add(new FakeBridgeSession(sessionInfo('gone')))
    const store = binding(tempPath())
    store.reconcile(missingHost)
    missingHost.remove('gone')
    store.reconcile(missingHost)
    const missingBase = await serve(missingHost, store)
    expect((await call(missingBase, '/v1/session')).body).toMatchObject({ error: 'bound_session_missing' })
  })

  it('switches the binding atomically and rejects non-kinship sessions', async () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('s1', { createdAt: 1 })))
    host.add(new FakeBridgeSession(sessionInfo('s2', { createdAt: 2 })))
    host.add(new FakeBridgeSession(sessionInfo('standard', { preset: 'standard' })))
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const switched = await call(base, '/v1/session/bind', {
      method: 'POST',
      body: JSON.stringify({ session_id: 's2' }),
    })
    expect(switched.status).toBe(200)
    expect(switched.body).toMatchObject({ ok: true, session_id: 's2', status: 'bound' })
    expect((await call(base, '/v1/session')).body).toMatchObject({ session_id: 's2' })

    const rejected = await call(base, '/v1/session/bind', {
      method: 'POST',
      body: JSON.stringify({ session_id: 'standard' }),
    })
    expect(rejected.status).toBe(409)
    expect(rejected.body).toMatchObject({ error: 'not_kinship_session' })
  })

  it('delivers messages, aborts, and reports status', async () => {
    const host = new FakeHost()
    const session = new FakeBridgeSession(sessionInfo('s1', { status: 'running' }), [
      bridgeEvent(0, 'turn/start', { turn: 1 }, 1_234),
    ])
    host.add(session)
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const accepted = await call(base, '/v1/session/messages', {
      method: 'POST',
      body: JSON.stringify({ text: 'hello', source: 'qq' }),
    })
    expect(accepted.status).toBe(202)
    expect(accepted.body).toMatchObject({ accepted: true, session_id: 's1', message_id: 'message-1' })
    expect(session.sent[0]).toMatchObject({
      text: 'hello',
      source: { kind: 'bridge', source: 'qq' },
      target: 'next-turn',
    })

    const status = await call(base, '/v1/session/status')
    expect(status.body).toMatchObject({ status: 'running', running: true, last_turn_at: 1_234 })

    const aborted = await call(base, '/v1/session/abort', { method: 'POST' })
    expect(aborted.status).toBe(202)
    expect(aborted.body).toMatchObject({ ok: true, was_running: true })
    expect(session.aborted).toBe(1)
    expect((await call(base, '/v1/session/status')).body).toMatchObject({ status: 'idle', running: false })
  })

  it('projects messages with limit/before and children', async () => {
    const host = new FakeHost()
    const events = [
      bridgeEvent(0, 'turn/start', { turn: 1 }),
      bridgeEvent(1, 'user/message', { id: 'u1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      bridgeEvent(2, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { id: 'a1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'p', model: 'm' } },
        stream: [],
      }),
      bridgeEvent(3, 'tool/result', {
        turn: 1,
        step: 2,
        message: { id: 't1', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', isError: false },
      }),
    ]
    const session = new FakeBridgeSession(
      sessionInfo('s1'),
      events,
      [{ id: 'child', parent_id: 's1', depth: 1, kind: 'child', mode: 'continuable', activity: 'inactive', has_children: false }],
    )
    host.add(session)
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const page = await call(base, '/v1/session/messages?limit=2')
    expect(page.status).toBe(200)
    expect(page.body).toMatchObject({ has_more: true, next_before: 2 })
    expect(page.body).toMatchObject({
      messages: [
        { id: 'a1', role: 'assistant', text: 'hello', seq: 2 },
        { id: 't1', role: 'tool', text: 'ok', seq: 3, tool_call_id: 'c1', is_error: false },
      ],
    })

    const earlier = await call(base, '/v1/session/messages?before=2')
    expect(earlier.body).toMatchObject({ has_more: false, messages: [{ id: 'u1', role: 'user', text: 'hi' }] })

    const children = await call(base, '/v1/session/children')
    expect(children.status).toBe(200)
    expect(children.body).toMatchObject({
      session_id: 's1',
      children: [{ id: 'child', parent_id: 's1', depth: 1, kind: 'child', mode: 'continuable' }],
    })
  })

  it('accepts inbox classes and chooses the interrupt boundary', async () => {
    const host = new FakeHost()
    const session = new FakeBridgeSession(sessionInfo('s1', { status: 'running' }))
    host.add(session)
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const accepted = await call(base, '/v1/inbox', {
      method: 'POST',
      body: JSON.stringify({ class: 'interrupt', text: 'wake up', thread_id: 't1' }),
    })
    expect(accepted.status).toBe(202)
    expect(accepted.body).toMatchObject({ accepted: true, class: 'interrupt', target: 'next-step' })
    expect(session.sent[0]).toMatchObject({
      text: '[interrupt] wake up',
      source: { kind: 'inbox', class: 'interrupt', threadId: 't1' },
      target: 'next-step',
    })

    const invalid = await call(base, '/v1/inbox', {
      method: 'POST',
      body: JSON.stringify({ class: 'Bad Class', text: 'x' }),
    })
    expect(invalid.status).toBe(422)
    expect(invalid.body).toMatchObject({ error: 'invalid_class' })
  })

  it('emits exact SSE frames after the connected comment', async () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('s1')))
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const response = await fetch(`${base}/v1/session/events`, {
      headers: { authorization: 'Bearer secret' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing SSE body')
    cleanups.push(() => reader.cancel())

    const sse = new SseReader(reader)
    await sse.waitFor(': connected\n\n')
    host.emit('s1', bridgeEvent(7, 'user/message', { id: 'u7', content: [{ type: 'text', text: 'live' }] }))
    const data = await sse.nextData()
    const frame: unknown = JSON.parse(data)
    expect(frame).toEqual({
      seq: 7,
      payload: {
        type: 'user/message',
        properties: { id: 'u7', content: [{ type: 'text', text: 'live' }] },
      },
    })
  })

  it('forwards live assistant stream frames between durable sequences', async () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('s1')))
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const response = await fetch(`${base}/v1/session/events`, {
      headers: { authorization: 'Bearer secret' },
    })
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing SSE body')
    cleanups.push(() => reader.cancel())

    const sse = new SseReader(reader)
    await sse.waitFor(': connected\n\n')
    host.emit('s1', bridgeEvent(7, 'turn/start', { turn: 1 }))
    expect(JSON.parse(await sse.nextData())).toMatchObject({ seq: 7 })

    host.emitLive('s1', {
      type: 'kinship/assistant-stream',
      data: {
        session_id: 's1',
        frame: { type: 'chunk', turn: 1, step: 1, index: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } },
      },
    })
    const live = JSON.parse(await sse.nextData()) as { seq: number, payload: { type: string, properties: { session_id: string } } }
    expect(live.payload.type).toBe('kinship/assistant-stream')
    expect(live.payload.properties.session_id).toBe('s1')
    expect(live.seq).toBeGreaterThan(7)
    expect(live.seq).toBeLessThan(8)

    host.emit('s1', bridgeEvent(8, 'turn/end', { turn: 1, reason: { kind: 'commit' } }))
    expect(JSON.parse(await sse.nextData())).toMatchObject({ seq: 8 })
  })

  it('serves the model catalog and session context', async () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('s1')))
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const models = await call(base, '/v1/models')
    expect(models.status).toBe(200)
    expect(models.body).toMatchObject({
      providers: [{ id: 'test', name: 'Test Provider', models: [{ id: 'm1', name: 'Model One' }] }],
    })

    const context = await call(base, '/v1/session/context')
    expect(context.status).toBe(200)
    expect(context.body).toMatchObject({
      session_id: 's1', provider: 'test', model: 'm1',
      contextWindow: 128_000, usedTokens: 1_024, projectedTokens: 1_100,
    })
  })

  it('accepts manual compaction and reports its snapshot', async () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('s1')))
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    const started = await call(base, '/v1/session/compact', { method: 'POST' })
    expect(started.status).toBe(202)
    expect(started.body).toMatchObject({ accepted: true, session_id: 's1', status: 'compacting' })

    host.compactStatus = 'busy'
    const busy = await call(base, '/v1/session/compact', { method: 'POST' })
    expect(busy.status).toBe(409)
    expect(busy.body).toMatchObject({ error: 'compaction_busy' })

    host.compactStatus = 'unavailable'
    const unavailable = await call(base, '/v1/session/compact', { method: 'POST' })
    expect(unavailable.status).toBe(500)
    expect(unavailable.body).toMatchObject({ error: 'compaction_unavailable' })

    host.compactionRow = {
      status: 'none', covered_count: 12, summary_text: 'summary body',
      anchor_message_id: 'msg_sum', anchor_timestamp_ms: 1_790_000_000_000,
    }
    const snapshot = await call(base, '/v1/session/compaction')
    expect(snapshot.status).toBe(200)
    expect(snapshot.body).toMatchObject({
      session_id: 's1', status: 'none', covered_count: 12, summary_text: 'summary body',
      anchor_message_id: 'msg_sum', anchor_timestamp_ms: 1_790_000_000_000,
    })
  })

  it('requires a binding for catalog and compaction routes', async () => {
    const host = new FakeHost()
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store)

    for (const path of ['/v1/models', '/v1/session/context', '/v1/session/compaction']) {
      const response = await call(base, path)
      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({ error: 'no_kinship_session' })
    }
    const compact = await call(base, '/v1/session/compact', { method: 'POST' })
    expect(compact.status).toBe(409)
  })

  it('caps bodies and routes method/not-found errors', async () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('s1')))
    const store = binding(tempPath())
    store.reconcile(host)
    const base = await serve(host, store, 1_024)

    const tooLarge = await call(base, '/v1/session/messages', {
      method: 'POST',
      body: JSON.stringify({ text: 'x'.repeat(2_048) }),
    })
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body).toMatchObject({ error: 'body_too_large' })

    const wrongMethod = await call(base, '/v1/health', { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.body).toMatchObject({ error: 'method_not_allowed' })

    const missing = await call(base, '/v1/nope')
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ error: 'not_found' })
  })
})

class SseReader {
  private buffer = ''
  private readonly decoder = new TextDecoder()

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async waitFor(marker: string): Promise<void> {
    while (!this.buffer.includes(marker)) await this.pull()
    const at = this.buffer.indexOf(marker)
    this.buffer = this.buffer.slice(at + marker.length)
  }

  async nextData(): Promise<string> {
    while (true) {
      const at = this.buffer.indexOf('\n\n')
      if (at >= 0) {
        const frame = this.buffer.slice(0, at)
        this.buffer = this.buffer.slice(at + 2)
        const line = frame.split('\n').find(item => item.startsWith('data: '))
        if (line !== undefined) return line.slice('data: '.length)
        continue
      }
      await this.pull()
    }
  }

  private async pull(): Promise<void> {
    const { value, done } = await this.reader.read()
    if (done) throw new Error('SSE stream closed before the expected frame')
    if (value === undefined) throw new Error('SSE stream yielded no bytes')
    this.buffer += this.decoder.decode(value, { stream: true })
  }
}
