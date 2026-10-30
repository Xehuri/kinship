package com.xehuri.kinship.transport

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class TierModelsTest {

    private fun parsed(raw: String): HttpAddress = HttpAddress.parse(raw).getOrThrow()

    private fun assertRejected(raw: String) {
        val result = HttpAddress.parse(raw)
        assertThat(result.isFailure).isTrue()
        assertThat(result.exceptionOrNull()).isInstanceOf(IllegalArgumentException::class.java)
    }

    private fun networkTier(
        id: String,
        order: Int = 0,
        label: String = id,
        tls: TlsPolicy = TlsPolicy.System,
    ) = Tier(
        id = id,
        order = order,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.DIRECT,
        target = TierTarget.Network(parsed("https://example.com")),
        tls = tls,
        label = label,
    )

    @Test
    fun `parses https domain with explicit port and path prefix`() {
        val address = parsed("https://example.com:8443/api")

        assertThat(address.scheme).isEqualTo("https")
        assertThat(address.host).isEqualTo("example.com")
        assertThat(address.port).isEqualTo(8443)
        assertThat(address.pathPrefix).isEqualTo("/api/")
        assertThat(address.origin.toString()).isEqualTo("https://example.com:8443")
    }

    @Test
    fun `uses effective port 443 when omitted`() {
        val address = parsed("https://example.com")

        assertThat(address.port).isEqualTo(443)
        assertThat(address.pathPrefix).isEqualTo("/")
        assertThat(address.origin.authority).isEqualTo("example.com:443")
    }

    @Test
    fun `parses ipv4 loopback over http`() {
        val address = parsed("http://127.0.0.1:8080/health")

        assertThat(address.host).isEqualTo("127.0.0.1")
        assertThat(address.port).isEqualTo(8080)
        assertThat(address.pathPrefix).isEqualTo("/health/")
    }

    @Test
    fun `parses bracketed ipv6 literal and brackets authority`() {
        val address = parsed("https://[240e::1]:23443/")

        assertThat(address.host).isEqualTo("240e::1")
        assertThat(address.port).isEqualTo(23443)
        assertThat(address.origin.authority).isEqualTo("[240e::1]:23443")
        assertThat(address.origin.toString()).isEqualTo("https://[240e::1]:23443")
    }

    @Test
    fun `rejects http for non loopback hosts`() {
        assertRejected("http://example.com/")
        assertRejected("http://192.168.1.10:8080/")
    }

    @Test
    fun `accepts http for localhost and loopback range`() {
        assertThat(parsed("http://localhost:8769/").host).isEqualTo("localhost")
        assertThat(parsed("http://127.0.0.1/").port).isEqualTo(80)
        assertThat(parsed("http://127.5.6.7:8080/").host).isEqualTo("127.5.6.7")
    }

    @Test
    fun `rejects missing scheme`() {
        assertRejected("example.com:8443")
        assertRejected("//example.com/path")
    }

    @Test
    fun `rejects userinfo`() {
        assertRejected("https://user:pass@example.com/")
    }

    @Test
    fun `rejects query`() {
        assertRejected("https://example.com/api?token=abc")
    }

    @Test
    fun `rejects fragment`() {
        assertRejected("https://example.com/api#section")
    }

    @Test
    fun `rejects invalid port`() {
        assertRejected("https://example.com:99999/")
    }

    @Test
    fun `rejects dot dot path`() {
        assertRejected("https://example.com/a/../b")
        assertRejected("https://example.com/..")
    }

    @Test
    fun `normalizes path prefix`() {
        assertThat(parsed("https://example.com").pathPrefix).isEqualTo("/")
        assertThat(parsed("https://example.com/api").pathPrefix).isEqualTo("/api/")
        assertThat(parsed("https://example.com/api/").pathPrefix).isEqualTo("/api/")
    }

    @Test
    fun `resolves absolute and relative paths without double slash`() {
        val address = parsed("https://example.com:8443/api")

        assertThat(address.resolve("/health"))
            .isEqualTo("https://example.com:8443/api/health")
        assertThat(address.resolve("health"))
            .isEqualTo("https://example.com:8443/api/health")
        assertThat(address.resolve("/v1/items"))
            .isEqualTo("https://example.com:8443/api/v1/items")
        assertThat(address.resolve("").substringAfter("://")).doesNotContain("//")
    }

    @Test
    fun `resolves against root prefix without double slash`() {
        val address = parsed("https://example.com")

        assertThat(address.resolve("/health")).isEqualTo("https://example.com:443/health")
        assertThat(address.resolve("health").substringAfter("://")).doesNotContain("//")
        assertThat(address.resolve("")).isEqualTo("https://example.com:443/")
    }

    @Test
    fun `origin fingerprint is stable lowercase sha256 hex`() {
        val first = originFingerprint(parsed("https://Example.COM:443/api").origin)
        val second = originFingerprint(parsed("https://example.com:443/other").origin)

        assertThat(first).matches("[0-9a-f]{64}")
        assertThat(first).isEqualTo(second)
    }

    @Test
    fun `valid network tier has no errors`() {
        assertThat(networkTier("lan").validate()).isEmpty()
    }

    @Test
    fun `p2p tier without peer id is rejected`() {
        val tier = networkTier("peer").copy(
            kind = TierKind.P2P,
            target = TierTarget.Peer(""),
        )

        assertThat(tier.validate()).contains("peer id is blank")
    }

    @Test
    fun `pinned tls without pins is rejected`() {
        val tier = networkTier("pinned", tls = TlsPolicy.Pinned(emptyList()))

        assertThat(tier.validate()).contains("pinned tls requires at least one pin")
    }

    @Test
    fun `config rejects duplicate tier ids`() {
        val config = TierConfig(tiers = listOf(networkTier("lan"), networkTier("lan", order = 1)))

        assertThat(config.validate()).contains("duplicate tier id: lan")
    }

    @Test
    fun `config rejects pinned selection without active tier`() {
        val config = TierConfig(
            tiers = listOf(networkTier("lan")),
            selection = TierSelection(mode = SelectionMode.PINNED),
        )

        assertThat(config.validate()).contains("pinned selection requires an active tier")
    }

    @Test
    fun `config rejects pinned selection with unknown active tier`() {
        val config = TierConfig(
            tiers = listOf(networkTier("lan")),
            selection = TierSelection(mode = SelectionMode.PINNED, activeTierId = "missing"),
        )

        assertThat(config.validate()).contains("selection references unknown tier: missing")
    }

    @Test
    fun `config rejects pinned selection pointing at a p2p tier`() {
        val peer = networkTier("peer").copy(
            kind = TierKind.P2P,
            target = TierTarget.Peer("peer-1"),
        )
        val config = TierConfig(
            tiers = listOf(networkTier("lan"), peer),
            selection = TierSelection(mode = SelectionMode.PINNED, activeTierId = "peer"),
        )

        assertThat(config.validate())
            .contains("pinned selection requires a network address tier: peer")
    }

    @Test
    fun `config rejects pinned selection pointing at a disabled tier`() {
        val disabled = networkTier("lan").copy(enabled = false)
        val config = TierConfig(
            tiers = listOf(disabled),
            selection = TierSelection(mode = SelectionMode.PINNED, activeTierId = "lan"),
        )

        assertThat(config.validate()).contains("pinned selection requires an enabled tier: lan")
    }

    @Test
    fun `config rejects auto chain with unknown active tier`() {
        val config = TierConfig(
            tiers = listOf(networkTier("lan")),
            selection = TierSelection(
                mode = SelectionMode.AUTO_CHAIN,
                activeTierId = "missing",
            ),
        )

        assertThat(config.validate()).contains("selection references unknown tier: missing")
    }

    @Test
    fun `config includes tier errors prefixed with tier id`() {
        val config = TierConfig(tiers = listOf(networkTier("lan", label = " ")))

        assertThat(config.validate()).contains("lan: tier label is blank")
    }

    @Test
    fun `sorted tiers stable by order then id`() {
        val config = TierConfig(
            tiers = listOf(
                networkTier("b", order = 1),
                networkTier("a", order = 1),
                networkTier("z", order = 2),
                networkTier("first", order = 0),
            ),
        )

        assertThat(config.sortedTiers().map { it.id })
            .containsExactly("first", "a", "b", "z")
            .inOrder()
    }
}
