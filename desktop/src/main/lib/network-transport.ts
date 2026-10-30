import type { NetworkLayer, NetworkLayerType } from '../../shared/types'
import { probeNetworkLayer, type LayerProbeResult, type ProbeLayerOptions } from './network-probe'

export interface TransportAdapter {
  readonly type: NetworkLayerType
  probe(layer: NetworkLayer, options?: ProbeLayerOptions): Promise<LayerProbeResult>
}

class HttpTransportAdapter implements TransportAdapter {
  constructor(readonly type: 'direct' | 'frp') {}

  probe(layer: NetworkLayer, options?: ProbeLayerOptions): Promise<LayerProbeResult> {
    return probeNetworkLayer(layer, options)
  }
}

class P2PTransportAdapter implements TransportAdapter {
  readonly type = 'p2p' as const

  probe(): Promise<LayerProbeResult> {
    return Promise.resolve({
      ok: false,
      latencyMs: 0,
      error: 'P2P 传输尚未接入，后续统一做',
      code: 'P2P_NOT_AVAILABLE',
    })
  }
}

export function createTransportAdapters(): Readonly<
  Record<NetworkLayerType, TransportAdapter>
> {
  return {
    direct: new HttpTransportAdapter('direct'),
    frp: new HttpTransportAdapter('frp'),
    p2p: new P2PTransportAdapter(),
  }
}
