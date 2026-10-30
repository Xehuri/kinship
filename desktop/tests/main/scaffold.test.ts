// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/ipc'

describe('IPC contract', () => {
  it('uses unique channel names', () => {
    const channels = Object.values(IPC)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('namespaces every channel under axeuh:', () => {
    for (const channel of Object.values(IPC)) {
      expect(channel).toMatch(/^axeuh:[a-z0-9:-]+$/)
    }
  })

  it('exposes BOOTSTRAP_GET as a string', () => {
    expect(typeof IPC.BOOTSTRAP_GET).toBe('string')
  })
})
