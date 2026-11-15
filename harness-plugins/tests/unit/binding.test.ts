import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../../packages/kinship-bridge/src/binding.js'
import { BridgeError } from '../../packages/kinship-bridge/src/errors.js'
import { FakeBridgeSession, FakeHost, sessionInfo } from '../helpers/fake-host.js'

const roots: string[] = []

function tempBindingPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'kinship-binding-'))
  roots.push(root)
  return join(root, 'kinship', 'binding.json')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function expectBridgeError(action: () => unknown, code: string): void {
  try {
    action()
    expect.fail('expected a BridgeError')
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError)
    if (error instanceof BridgeError) expect(error.code).toBe(code)
  }
}

describe('binding policy', () => {
  it('first binds the earliest-created root kinship session', () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('other', { preset: 'standard', createdAt: 1 })))
    host.add(new FakeBridgeSession(sessionInfo('child', { createdAt: 2, isRoot: false })))
    host.add(new FakeBridgeSession(sessionInfo('late', { createdAt: 300 })))
    host.add(new FakeBridgeSession(sessionInfo('early', { createdAt: 100 })))

    const store = new BindingStore({
      path: tempBindingPath(),
      policy: 'first',
      sessionId: '',
      rebindOnMissing: false,
      now: () => 5_000,
    })
    expect(store.reconcile(host)).toEqual({
      status: 'bound',
      sessionId: 'early',
      boundAt: 5_000,
      policy: 'first',
    })
  })

  it('persists and reloads the binding', () => {
    const path = tempBindingPath()
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('session-a', { createdAt: 10 })))

    const first = new BindingStore({ path, policy: 'first', sessionId: '', rebindOnMissing: false, now: () => 7 })
    first.reconcile(host)
    const persisted: unknown = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted).toMatchObject({ session_id: 'session-a', preset: 'kinship', policy: 'first' })

    const second = new BindingStore({ path, policy: 'first', sessionId: '', rebindOnMissing: false })
    expect(second.reconcile(host)).toMatchObject({ status: 'bound', sessionId: 'session-a', boundAt: 7 })
  })

  it('reports a missing bound session and does not rebind by default', () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('old', { createdAt: 1 })))
    host.add(new FakeBridgeSession(sessionInfo('new', { createdAt: 2 })))
    const store = new BindingStore({
      path: tempBindingPath(),
      policy: 'first',
      sessionId: '',
      rebindOnMissing: false,
    })
    store.reconcile(host)
    host.remove('old')

    expect(store.reconcile(host)).toMatchObject({
      status: 'bound_session_missing',
      sessionId: 'old',
    })
    expect(store.currentSessionId()).toBe('old')
  })

  it('rebinds when rebindOnMissing is enabled under first policy', () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('old', { createdAt: 1 })))
    host.add(new FakeBridgeSession(sessionInfo('new', { createdAt: 2 })))
    const store = new BindingStore({
      path: tempBindingPath(),
      policy: 'first',
      sessionId: '',
      rebindOnMissing: true,
    })
    store.reconcile(host)
    host.remove('old')

    expect(store.reconcile(host)).toMatchObject({ status: 'bound', sessionId: 'new' })
  })

  it('manual policy waits for an explicit bind and validates root/preset', () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('kinship', { createdAt: 1 })))
    host.add(new FakeBridgeSession(sessionInfo('other', { preset: 'standard' })))
    host.add(new FakeBridgeSession(sessionInfo('child', { isRoot: false })))
    const store = new BindingStore({
      path: tempBindingPath(),
      policy: 'manual',
      sessionId: '',
      rebindOnMissing: false,
    })

    expect(store.reconcile(host).status).toBe('unbound')
    expectBridgeError(() => store.bind('missing', host), 'session_not_found')
    expectBridgeError(() => store.bind('other', host), 'not_kinship_session')
    expectBridgeError(() => store.bind('child', host), 'not_root_session')
    expect(store.bind('kinship', host)).toMatchObject({ status: 'bound', sessionId: 'kinship' })
    expect(store.reconcile(host)).toMatchObject({ status: 'bound', sessionId: 'kinship' })
  })

  it('manual startup binds a configured session id', () => {
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('configured', { createdAt: 1 })))
    const store = new BindingStore({
      path: tempBindingPath(),
      policy: 'manual',
      sessionId: 'configured',
      rebindOnMissing: false,
    })
    expect(store.reconcile(host)).toMatchObject({ status: 'bound', sessionId: 'configured' })
  })

  it('treats a corrupt persisted file as unbound without deleting it', () => {
    const path = tempBindingPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{not-json', 'utf8')
    const store = new BindingStore({ path, policy: 'first', sessionId: '', rebindOnMissing: false })
    expect(store.snapshot().status).toBe('unbound')
    expect(readFileSync(path, 'utf8')).toBe('{not-json')
  })
})
