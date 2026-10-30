package com.xehuri.kinship.p2p

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class P2pWebRtcPolicyTest {

    private fun status(
        enabled: Boolean = true,
        webrtcEnabled: Boolean = true,
        signalUrl: String? = "wss://signal.example.com"
    ): P2pStatus = P2pStatus(
        enabled = enabled,
        signalConnected = true,
        room = "home",
        endpoints = mapOf("frp" to "https://frp.example.com:8768"),
        deviceCount = 1,
        serverId = "home",
        signalUrl = signalUrl,
        webrtcEnabled = webrtcEnabled
    )

    @Test
    fun `starts only when p2p webrtc and signal url are all present`() {
        assertThat(P2pWebRtcPolicy.shouldStart(status())).isTrue()
        assertThat(P2pWebRtcPolicy.shouldStart(status(enabled = false))).isFalse()
        assertThat(P2pWebRtcPolicy.shouldStart(status(webrtcEnabled = false))).isFalse()
        assertThat(P2pWebRtcPolicy.shouldStart(status(signalUrl = null))).isFalse()
        assertThat(P2pWebRtcPolicy.shouldStart(status(signalUrl = "   "))).isFalse()
    }
}
