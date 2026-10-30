package com.xehuri.kinship.transport

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class TierLabelsTest {

    private fun networkTier(
        id: String = "net-1",
        label: String = "FRP",
        url: String = "https://health.example:8768/",
    ): Tier = Tier(
        id = id,
        order = 0,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.FRP,
        target = TierTarget.Network(HttpAddress.parse(url).getOrThrow()),
        label = label,
    )

    private fun peerTier(id: String = "peer-1", label: String = "P2P", peerId: String = "home"): Tier =
        Tier(
            id = id,
            order = 1,
            kind = TierKind.P2P,
            transportHint = TransportHint.UNKNOWN,
            target = TierTarget.Peer(peerId),
            label = label,
        )

    @Test
    fun `network tier uses configured label and origin subtitle`() {
        val tier = networkTier()

        assertThat(tier.displayLabel()).isEqualTo("FRP")
        assertThat(tier.displaySubtitle()).isEqualTo("https://health.example:8768")
    }

    @Test
    fun `blank network label falls back to host and port`() {
        val tier = networkTier(label = "")

        assertThat(tier.displayLabel()).isEqualTo("health.example:8768")
        assertThat(tier.displaySubtitle()).isEqualTo("https://health.example:8768")
    }

    @Test
    fun `label equal to id falls back to host and port`() {
        val tier = networkTier(id = "3f1a5b6c-0000-4000-8000-000000000000", label = "3f1a5b6c-0000-4000-8000-000000000000")

        assertThat(tier.displayLabel()).isEqualTo("health.example:8768")
    }

    @Test
    fun `ipv4 address renders unbracketed host and port`() {
        val tier = networkTier(label = "", url = "https://192.168.1.10:8768/")

        assertThat(tier.displayLabel()).isEqualTo("192.168.1.10:8768")
        assertThat(tier.displaySubtitle()).isEqualTo("https://192.168.1.10:8768")
    }

    @Test
    fun `ipv6 address renders bracketed host and port`() {
        val tier = networkTier(label = "", url = "https://[fd00::1]:8768/")

        assertThat(tier.displayLabel()).isEqualTo("[fd00::1]:8768")
        assertThat(tier.displaySubtitle()).isEqualTo("https://[fd00::1]:8768")
    }

    @Test
    fun `p2p tier keeps label and shows peer id subtitle`() {
        val tier = peerTier()

        assertThat(tier.displayLabel()).isEqualTo("P2P")
        assertThat(tier.displaySubtitle()).isEqualTo("home")
    }

    @Test
    fun `p2p blank or id label falls back to human placeholder`() {
        assertThat(peerTier(label = "").displayLabel()).isEqualTo("P2P 对端（未接入）")
        assertThat(peerTier(id = "peer-1", label = "peer-1").displayLabel()).isEqualTo("P2P 对端（未接入）")
    }

    @Test
    fun `p2p blank peer id shows unconfigured subtitle`() {
        assertThat(peerTier(peerId = "").displaySubtitle()).isEqualTo("未配置对端")
    }

    @Test
    fun `validate still rejects blank labels`() {
        assertThat(networkTier(label = "").validate()).contains("tier label is blank")
        assertThat(peerTier(label = "").validate()).contains("tier label is blank")
    }
}
