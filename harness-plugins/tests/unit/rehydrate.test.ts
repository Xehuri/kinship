import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../../packages/kinship-bridge/src/binding.js'
import { BridgeError } from '../../packages/kinship-bridge/src/errors.js'
import { ensureBoundSession } from '../../packages/kinship-bridge/src/rehydrate.js'
import type { BindingPolicy } from '../../packages/kinship-bridge/src/types.js'
import {
  FakeBridgeSession,
  FakeHost,
  ResumableFakeHost,
  sessionInfo,
} from '../helpers/fake-host.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempBindingPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'kinship-rehydrate-'))
  roots.push(root)
  return join(root, 'kinship', 'binding.json')
}

function storeAt(
  path: string,
  options: { readonly policy?: BindingPolicy; readonly rebindOnMissing?: boolean } = {},
): BindingStore {
  return new BindingStore({
    path,
    policy: options.policy ?? 'first',
    sessionId: '',
    rebindOnMissing: options.rebindOnMissing ?? false,
  })
}

/** Persist a binding to `id` by reconciling a throwaway host that has it. */
function persistBinding(path: string, id: string): void {
  const host = new FakeHost()
  host.add(new FakeBridgeSession(sessionInfo(id)))
  storeAt(path).reconcile(host)
}

async function expectBridgeError(
  action: () => Promise<unknown>,
  code: string,
  messageIncludes?: string,
): Promise<void> {
  try {
    await action()
    expect.fail('expected a BridgeError')
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError)
    if (error instanceof BridgeError) {
      expect(error.status).toBe(409)
      expect(error.code).toBe(code)
      if (messageIncludes !== undefined) expect(error.message).toContain(messageIncludes)
    }
  }
}

describe('ensureBoundSession', () => {
  it('passes a live bound session straight through', async () => {
    const path = tempBindingPath()
    persistBinding(path, 's1')
    const host = new FakeHost()
    host.add(new FakeBridgeSession(sessionInfo('s1')))

    const bound = await ensureBoundSession(storeAt(path), host)

    expect(bound.id).toBe('s1')
    expect(bound.session.info().id).toBe('s1')
  })

  it('clears a stale missing snapshot when the session is live again', async () => {
    const path = tempBindingPath()
    persistBinding(path, 's1')
    const store = storeAt(path)
    const host = new FakeHost()
    expect(store.reconcile(host).status).toBe('bound_session_missing')

    host.add(new FakeBridgeSession(sessionInfo('s1')))
    const bound = await ensureBoundSession(store, host)

    expect(bound.id).toBe('s1')
    expect(store.snapshot().status).toBe('bound')
  })

  it('resumes the bound session and re-reconciles the binding', async () => {
    const path = tempBindingPath()
    persistBinding(path, 's1')
    const store = storeAt(path)
    const host = new ResumableFakeHost()
    const restored = new FakeBridgeSession(sessionInfo('s1'))
    host.resumeHandler = async () => {
      host.add(restored)
      return { status: 'resumed', session: restored }
    }
    expect(store.reconcile(host).status).toBe('bound_session_missing')

    const bound = await ensureBoundSession(store, host)

    expect(bound.id).toBe('s1')
    expect(bound.session).toBe(restored)
    expect(host.resumeRequests).toEqual(['s1'])
    expect(store.snapshot().status).toBe('bound')
  })

  it('rebinds to another live kinship session when resume reports missing', async () => {
    const path = tempBindingPath()
    persistBinding(path, 'old')
    const store = storeAt(path, { rebindOnMissing: true })
    const host = new ResumableFakeHost()
    const replacement = new FakeBridgeSession(sessionInfo('new', { createdAt: 2 }))
    host.add(replacement)
    host.resumeHandler = async () => ({ status: 'missing' })

    const bound = await ensureBoundSession(store, host)

    expect(bound.id).toBe('new')
    expect(bound.session).toBe(replacement)
    expect(host.resumeRequests).toEqual(['old'])
    expect(store.snapshot()).toMatchObject({ status: 'bound', sessionId: 'new' })
  })

  it('reports bound_session_missing when resume reports missing and nothing replaces it', async () => {
    const path = tempBindingPath()
    persistBinding(path, 'gone')
    const store = storeAt(path)
    const host = new ResumableFakeHost()
    host.resumeHandler = async () => ({ status: 'missing' })

    await expectBridgeError(() => ensureBoundSession(store, host), 'bound_session_missing')

    expect(host.resumeRequests).toEqual(['gone'])
    expect(store.snapshot().status).toBe('bound_session_missing')
  })

  it('keeps the missing 409 when the host cannot resume', async () => {
    const path = tempBindingPath()
    persistBinding(path, 'gone')

    await expectBridgeError(
      () => ensureBoundSession(storeAt(path), new FakeHost()),
      'bound_session_missing',
    )
  })

  it('reports no_kinship_session when nothing is bound', async () => {
    const store = storeAt(tempBindingPath(), { policy: 'manual' })

    await expectBridgeError(() => ensureBoundSession(store, new FakeHost()), 'no_kinship_session')
  })

  it('reports bound_session_unavailable with the host reason', async () => {
    const path = tempBindingPath()
    persistBinding(path, 'gone')
    const host = new ResumableFakeHost()
    const reason = 'this harness composition has no sessionController service'
    host.resumeHandler = async () => ({ status: 'unavailable', reason })

    await expectBridgeError(
      () => ensureBoundSession(storeAt(path), host),
      'bound_session_unavailable',
      'no sessionController service',
    )
  })

  it('deduplicates concurrent resumes for the same binding', async () => {
    const path = tempBindingPath()
    persistBinding(path, 's1')
    const store = storeAt(path)
    const host = new ResumableFakeHost()
    const restored = new FakeBridgeSession(sessionInfo('s1'))
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    host.resumeHandler = async () => {
      await gate
      host.add(restored)
      return { status: 'resumed', session: restored }
    }

    const first = ensureBoundSession(store, host)
    const second = ensureBoundSession(store, host)
    release()
    const [left, right] = await Promise.all([first, second])

    expect(host.resumeRequests).toEqual(['s1'])
    expect(left).toBe(right)
    expect(left.session).toBe(restored)
    expect(store.snapshot().status).toBe('bound')
  })
})
