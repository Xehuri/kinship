import type {
  EndpointCandidate,
  TransportConfig,
  TransportMode,
} from '../../../shared/types'
import { validateTransportConfig } from '../../../shared/validation'

export interface NetworkEndpointForm {
  name: string
  url: string
  priority: number
}

export interface NetworkFormState {
  mode: TransportMode
  endpointCandidates: NetworkEndpointForm[]
  currentEndpointIndex: number | null
}

export interface NetworkFormValidation {
  ok: boolean
  message?: string
}

export interface TransportConfigSnapshot {
  readonly mode: TransportMode
  readonly endpointCandidates: readonly {
    readonly name: string
    readonly url: string
    readonly priority: number
  }[]
  readonly currentEndpoint?: string
}

function cloneCandidate(candidate: TransportConfigSnapshot['endpointCandidates'][number]): NetworkEndpointForm {
  return {
    name: candidate.name,
    url: candidate.url,
    priority: candidate.priority,
  }
}

export function cloneTransportConfig(transport: TransportConfigSnapshot): TransportConfig {
  const clone: TransportConfig = {
    mode: transport.mode,
    endpointCandidates: transport.endpointCandidates.map(cloneCandidate),
  }
  if (transport.currentEndpoint !== undefined) clone.currentEndpoint = transport.currentEndpoint
  return clone
}

export function createNetworkForm(transport?: TransportConfigSnapshot): NetworkFormState {
  const candidates = (transport?.endpointCandidates ?? []).map(cloneCandidate)
  const currentIndex =
    transport?.currentEndpoint === undefined
      ? -1
      : candidates.findIndex((candidate) => candidate.name === transport.currentEndpoint)
  return {
    mode: transport?.mode ?? 'auto',
    endpointCandidates: candidates,
    currentEndpointIndex: currentIndex >= 0 ? currentIndex : null,
  }
}

export function buildTransportConfig(form: NetworkFormState): TransportConfig {
  const endpointCandidates: EndpointCandidate[] = form.endpointCandidates.map((candidate) => {
    const rawPriority = Number(candidate.priority)
    return {
      name: candidate.name.trim(),
      url: candidate.url.trim(),
      priority: Number.isFinite(rawPriority) ? Math.round(rawPriority) : Number.NaN,
    }
  })

  const transport: TransportConfig = {
    mode: form.mode,
    endpointCandidates,
  }
  const index = form.currentEndpointIndex
  if (index !== null) {
    const selected = endpointCandidates[index]
    const name = selected?.name ?? ''
    if (name.length > 0) transport.currentEndpoint = name
  }
  return transport
}

export function validateNetworkForm(form: NetworkFormState): NetworkFormValidation {
  const result = validateTransportConfig(buildTransportConfig(form))
  return result.ok ? { ok: true } : { ok: false, message: result.message }
}

export function selectedEndpoint(form: NetworkFormState): NetworkEndpointForm | undefined {
  const index = form.currentEndpointIndex
  return index === null ? undefined : form.endpointCandidates[index]
}

export function selectedEndpointUrl(form: NetworkFormState): string {
  return selectedEndpoint(form)?.url.trim() ?? ''
}

export function defaultEndpointIndex(
  mode: TransportMode,
  candidates: readonly NetworkEndpointForm[],
): number | null {
  if (candidates.length === 0) return null
  if (mode === 'frp') {
    const index = candidates.findIndex((candidate) =>
      /frp/i.test(`${candidate.name} ${candidate.url}`),
    )
    if (index >= 0) return index
  }
  return 0
}

export function selectMode(form: NetworkFormState, mode: TransportMode): void {
  form.mode = mode
  const current = form.currentEndpointIndex
  const currentCandidate = current === null ? undefined : form.endpointCandidates[current]
  const currentIsFrp =
    currentCandidate !== undefined && /frp/i.test(`${currentCandidate.name} ${currentCandidate.url}`)

  if (mode === 'frp') {
    if (!currentIsFrp) {
      const frpIndex = form.endpointCandidates.findIndex((candidate) =>
        /frp/i.test(`${candidate.name} ${candidate.url}`),
      )
      if (frpIndex >= 0) form.currentEndpointIndex = frpIndex
    }
    return
  }

  if (current === null) {
    form.currentEndpointIndex = defaultEndpointIndex(mode, form.endpointCandidates)
  }
}

export function addEndpoint(form: NetworkFormState): number {
  const index = form.endpointCandidates.length
  const usedNames = new Set(
    form.endpointCandidates
      .map((candidate) => candidate.name.trim())
      .filter((name) => name.length > 0),
  )
  let suffix = form.endpointCandidates.length + 1
  while (usedNames.has(`endpoint${String(suffix)}`)) suffix += 1

  form.endpointCandidates.push({
    name: `endpoint${String(suffix)}`,
    url: '',
    priority: 50,
  })
  if (form.currentEndpointIndex === null) form.currentEndpointIndex = index
  return index
}

export function removeEndpoint(form: NetworkFormState, index: number): void {
  if (index < 0 || index >= form.endpointCandidates.length) return
  form.endpointCandidates.splice(index, 1)

  const current = form.currentEndpointIndex
  if (current === index) {
    form.currentEndpointIndex = null
  } else if (current !== null && current > index) {
    form.currentEndpointIndex = current - 1
  }
}
