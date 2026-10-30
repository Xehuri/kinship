package com.xehuri.kinship.p2p

internal object P2pWebRtcPolicy {
    fun shouldStart(status: P2pStatus): Boolean =
        status.enabled && status.webrtcEnabled && !status.signalUrl.isNullOrBlank()
}
