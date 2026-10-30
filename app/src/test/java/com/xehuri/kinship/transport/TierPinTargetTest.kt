package com.xehuri.kinship.transport

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class TierPinTargetTest {

    private fun networkTier(
        id: String,
        order: Int,
        enabled: Boolean = true,
        host: String = "$id.example",
    ): Tier = Tier(
        id = id,
        order = order,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.DIRECT,
        target = TierTarget.Network(HttpAddress.parse("https://$host:8768/").getOrThrow()),
        enabled = enabled,
        label = id,
    )

    private fun p2pTier(id: String, order: Int): Tier = Tier(
        id = id,
        order = order,
        kind = TierKind.P2P,
        transportHint = TransportHint.UNKNOWN,
        target = TierTarget.Peer("peer-$id"),
        label = id,
    )

    private fun config(vararg tiers: Tier): TierConfig = TierConfig(tiers = tiers.toList())

    @Test
    fun `keeps a preferred enabled network tier`() {
        val tier = networkTier("net-a", order = 0)

        val resolved = resolvePinnedTierId(config(tier, networkTier("net-b", order = 1)), "net-a")

        assertThat(resolved).isEqualTo("net-a")
    }

    @Test
    fun `falls back when the preferred tier is disabled`() {
        val disabled = networkTier("net-a", order = 0, enabled = false)
        val enabled = networkTier("net-b", order = 1)

        val resolved = resolvePinnedTierId(config(disabled, enabled), "net-a")

        assertThat(resolved).isEqualTo("net-b")
    }

    @Test
    fun `ignores a preferred p2p tier`() {
        val p2p = p2pTier("p2p-a", order = 0)
        val network = networkTier("net-a", order = 1)

        val resolved = resolvePinnedTierId(config(p2p, network), "p2p-a")

        assertThat(resolved).isEqualTo("net-a")
    }

    @Test
    fun `falls back when the preferred tier is missing`() {
        val resolved = resolvePinnedTierId(config(networkTier("net-a", order = 0)), "gone")

        assertThat(resolved).isEqualTo("net-a")
    }

    @Test
    fun `null preferred selects the first enabled network tier`() {
        val resolved = resolvePinnedTierId(
            config(
                networkTier("net-a", order = 0, enabled = false),
                networkTier("net-b", order = 1),
            ),
            null,
        )

        assertThat(resolved).isEqualTo("net-b")
    }

    @Test
    fun `returns null when no tier is pinnable`() {
        assertThat(resolvePinnedTierId(config(), null)).isNull()
        assertThat(
            resolvePinnedTierId(
                config(
                    networkTier("net-a", order = 0, enabled = false),
                    p2pTier("p2p-a", order = 1),
                ),
                null,
            )
        ).isNull()
    }

    @Test
    fun `respects sorted order instead of insertion order`() {
        val resolved = resolvePinnedTierId(
            config(
                networkTier("late", order = 2),
                networkTier("early", order = 0),
                networkTier("middle", order = 1),
            ),
            null,
        )

        assertThat(resolved).isEqualTo("early")
    }

    @Test
    fun `hasPinnableTier reports enabled network tiers only`() {
        assertThat(hasPinnableTier(config())).isFalse()
        assertThat(hasPinnableTier(config(networkTier("off", order = 0, enabled = false)))).isFalse()
        assertThat(hasPinnableTier(config(p2pTier("p2p", order = 0)))).isFalse()
        assertThat(hasPinnableTier(config(networkTier("on", order = 0)))).isTrue()
    }
}
