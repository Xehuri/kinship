package com.xehuri.kinship.transport

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.CancellationException
import javax.net.ssl.SSLException

class TierSelectorTest {

    private class FakeProbe : TierProbe {
        val probed = mutableListOf<String>()
        val results = mutableMapOf<String, ProbeResult>()

        override suspend fun probe(tier: Tier): ProbeResult {
            probed += tier.id
            return results[tier.id] ?: ProbeResult.Unreachable("no fake result")
        }
    }

    private lateinit var probe: FakeProbe
    private lateinit var selector: TierSelector
    private var config: TierConfig = TierConfig()
    private var now: Long = 1_000L

    @Before
    fun setUp() {
        probe = FakeProbe()
        config = TierConfig()
        now = 1_000L
        selector = TierSelector(
            configProvider = { config },
            probe = probe,
            clock = { now },
            failureCooldownMs = 30_000L,
        )
    }

    private fun healthy(): ProbeResult = ProbeResult.Healthy(5L)

    private fun unreachable(): ProbeResult = ProbeResult.Unreachable("boom")

    private fun networkTier(id: String, order: Int, enabled: Boolean = true): Tier = Tier(
        id = id,
        order = order,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.DIRECT,
        target = TierTarget.Network(HttpAddress.parse("https://$id.example:443/").getOrThrow()),
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

    private fun configOf(
        vararg tiers: Tier,
        mode: SelectionMode = SelectionMode.AUTO_CHAIN,
        activeTierId: String? = null,
    ): TierConfig = TierConfig(
        tiers = tiers.toList(),
        selection = TierSelection(mode = mode, activeTierId = activeTierId),
    )

    @Test
    fun `startup picks first healthy tier by order`() = runTest {
        config = configOf(networkTier("second", 1), networkTier("first", 0))
        probe.results["first"] = healthy()
        probe.results["second"] = healthy()

        val selected = selector.selectOnStartup()

        assertThat(selected?.id).isEqualTo("first")
        assertThat(probe.probed).containsExactly("first").inOrder()
        assertThat(selector.state.value.activeTierId).isEqualTo("first")
    }

    @Test
    fun `startup keeps existing active tier when healthy`() = runTest {
        config = configOf(networkTier("t1", 0), networkTier("t2", 1))
        probe.results["t1"] = healthy()
        probe.results["t2"] = healthy()
        selector.selectOnStartup()
        probe.probed.clear()

        val selected = selector.selectOnStartup()

        assertThat(selected?.id).isEqualTo("t1")
        assertThat(probe.probed).containsExactly("t1").inOrder()
    }

    @Test
    fun `startup moves to second tier when first is unhealthy`() = runTest {
        config = configOf(networkTier("t1", 0), networkTier("t2", 1))
        probe.results["t1"] = unreachable()
        probe.results["t2"] = healthy()

        val selected = selector.selectOnStartup()

        assertThat(selected?.id).isEqualTo("t2")
        assertThat(probe.probed).containsExactly("t1", "t2").inOrder()
        assertThat(selector.state.value.activeTierId).isEqualTo("t2")
    }

    @Test
    fun `transport failure moves to next tier and records cooldown`() = runTest {
        config = configOf(networkTier("t1", 0), networkTier("t2", 1))
        probe.results["t1"] = healthy()
        probe.results["t2"] = healthy()
        selector.selectOnStartup()
        now = 5_000L

        val selected = selector.onTransportFailure("t1")

        assertThat(selected?.id).isEqualTo("t2")
        assertThat(selector.state.value.activeTierId).isEqualTo("t2")
        assertThat(selector.state.value.failedUntilMs).containsEntry("t1", 35_000L)
    }

    @Test
    fun `pinned mode always returns the pinned tier after failure`() = runTest {
        config = configOf(
            networkTier("t1", 0),
            networkTier("t2", 1),
            mode = SelectionMode.PINNED,
            activeTierId = "t1",
        )
        probe.results["t1"] = unreachable()
        probe.results["t2"] = healthy()

        assertThat(selector.selectOnStartup()?.id).isEqualTo("t1")
        assertThat(selector.state.value.mode).isEqualTo(SelectionMode.PINNED)

        val selected = selector.onTransportFailure("t1")

        assertThat(selected?.id).isEqualTo("t1")
        assertThat(selector.state.value.activeTierId).isEqualTo("t1")
    }

    @Test
    fun `pinned tier outside candidates yields null`() = runTest {
        config = configOf(
            networkTier("t1", 0),
            mode = SelectionMode.PINNED,
            activeTierId = "missing",
        )

        val selected = selector.selectOnStartup()

        assertThat(selected).isNull()
        assertThat(selector.state.value.activeTierId).isNull()
        assertThat(probe.probed).isEmpty()
    }

    @Test
    fun `all tiers unhealthy yields null and clears active`() = runTest {
        config = configOf(networkTier("t1", 0), networkTier("t2", 1))
        probe.results["t1"] = unreachable()
        probe.results["t2"] = unreachable()

        val selected = selector.selectOnStartup()

        assertThat(selected).isNull()
        assertThat(selector.state.value.activeTierId).isNull()
        assertThat(probe.probed).containsExactly("t1", "t2").inOrder()
    }

    @Test
    fun `disabled tier is skipped`() = runTest {
        config = configOf(networkTier("disabled", 0, enabled = false), networkTier("t2", 1))
        probe.results["t2"] = healthy()

        val selected = selector.selectOnStartup()

        assertThat(selected?.id).isEqualTo("t2")
        assertThat(probe.probed).containsExactly("t2").inOrder()
    }

    @Test
    fun `p2p tier is never probed`() = runTest {
        config = configOf(p2pTier("p2p", 0), networkTier("t1", 1))
        probe.results["t1"] = healthy()

        val selected = selector.selectOnStartup()

        assertThat(selected?.id).isEqualTo("t1")
        assertThat(probe.probed).containsExactly("t1").inOrder()
    }

    @Test
    fun `manual reprobe clears cooldown and retries first tier`() = runTest {
        config = configOf(networkTier("t1", 0), networkTier("t2", 1))
        probe.results["t1"] = unreachable()
        probe.results["t2"] = healthy()
        selector.selectOnStartup()
        assertThat(selector.state.value.failedUntilMs).containsKey("t1")
        probe.results["t1"] = healthy()
        probe.probed.clear()
        now = 2_000L

        val selected = selector.manualReprobe()

        assertThat(selected?.id).isEqualTo("t1")
        assertThat(selector.state.value.failedUntilMs).isEmpty()
        assertThat(selector.state.value.activeTierId).isEqualTo("t1")
        assertThat(probe.probed).containsExactly("t1").inOrder()
    }

    @Test
    fun `cooldown skips failed tier on immediate non forced startup`() = runTest {
        config = configOf(networkTier("t1", 0), networkTier("t2", 1))
        probe.results["t1"] = healthy()
        probe.results["t2"] = healthy()
        selector.selectOnStartup()
        selector.onTransportFailure("t1")
        probe.results["t1"] = healthy()
        probe.probed.clear()
        now += 1

        val selected = selector.selectOnStartup()

        assertThat(selected?.id).isEqualTo("t2")
        assertThat(probe.probed).containsExactly("t2").inOrder()
    }

    @Test
    fun `cooldown expiry makes the first tier eligible again`() = runTest {
        config = configOf(networkTier("t1", 0), networkTier("t2", 1))
        probe.results["t1"] = healthy()
        probe.results["t2"] = healthy()
        selector.selectOnStartup()
        selector.onTransportFailure("t1")
        probe.results["t1"] = healthy()
        probe.results["t2"] = unreachable()
        probe.probed.clear()
        now = 31_001L

        val selected = selector.selectOnStartup()

        assertThat(selected?.id).isEqualTo("t1")
        assertThat(selector.state.value.failedUntilMs).containsKey("t2")
    }

    @Test
    fun `reset clears selection state`() = runTest {
        config = configOf(networkTier("t1", 0))
        probe.results["t1"] = healthy()
        selector.selectOnStartup()

        selector.reset()

        assertThat(selector.state.value).isEqualTo(TierSelectionState())
    }

    @Test
    fun `http status never triggers failover`() {
        for (code in listOf(200, 401, 403, 404, 500, 503)) {
            assertThat(FailoverPolicy.shouldFailoverOnHttpStatus(code)).isFalse()
        }
    }

    @Test
    fun `transport failure recognises io exceptions only`() {
        assertThat(FailoverPolicy.isTransportFailure(IOException("io"))).isTrue()
        assertThat(FailoverPolicy.isTransportFailure(UnknownHostException("dns"))).isTrue()
        assertThat(FailoverPolicy.isTransportFailure(ConnectException("refused"))).isTrue()
        assertThat(FailoverPolicy.isTransportFailure(SocketTimeoutException("timeout"))).isTrue()
        assertThat(FailoverPolicy.isTransportFailure(SSLException("tls"))).isTrue()
        assertThat(FailoverPolicy.isTransportFailure(CancellationException("cancel"))).isFalse()
        assertThat(FailoverPolicy.isTransportFailure(IllegalArgumentException("bad"))).isFalse()
    }
}
