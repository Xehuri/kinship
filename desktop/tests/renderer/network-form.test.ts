import { describe, expect, it } from 'vitest'
import {
  createNetworkForm,
  selectMode,
} from '../../src/renderer/src/lib/network-form'

describe('network form mode selection', () => {
  it('switches from an IPv6 selection to the FRP candidate', () => {
    const form = createNetworkForm({
      mode: 'auto',
      endpointCandidates: [
        { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
        { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
      ],
      currentEndpoint: 'ipv6',
    })

    selectMode(form, 'frp')

    expect(form.mode).toBe('frp')
    expect(form.currentEndpointIndex).toBe(1)
  })

  it('keeps the current selection when no FRP candidate exists', () => {
    const form = createNetworkForm({
      mode: 'auto',
      endpointCandidates: [
        { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
      ],
      currentEndpoint: 'ipv6',
    })

    selectMode(form, 'frp')

    expect(form.mode).toBe('frp')
    expect(form.currentEndpointIndex).toBe(0)
  })

  it('selects the first candidate when switching to auto without a selection', () => {
    const form = createNetworkForm({
      mode: 'frp',
      endpointCandidates: [
        { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
      ],
    })

    selectMode(form, 'auto')

    expect(form.mode).toBe('auto')
    expect(form.currentEndpointIndex).toBe(0)
  })
})
