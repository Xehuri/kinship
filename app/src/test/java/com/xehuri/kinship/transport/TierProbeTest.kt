package com.xehuri.kinship.transport

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import okhttp3.Dns
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.InetAddress

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TierProbeTest {

    private lateinit var server: MockWebServer
    private lateinit var probe: HttpTierProbe

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        probe = HttpTierProbe()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun address(pathPrefix: String = "/"): HttpAddress =
        HttpAddress.parse(server.url(pathPrefix).toString()).getOrThrow()

    private fun networkTier(
        id: String = "t1",
        address: HttpAddress = address(),
        enabled: Boolean = true,
        tls: TlsPolicy = TlsPolicy.System,
    ): Tier = Tier(
        id = id,
        order = 0,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.DIRECT,
        target = TierTarget.Network(address),
        tls = tls,
        enabled = enabled,
        label = id,
    )

    @Test
    fun `healthy response probes health path without path prefix`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"status":"healthy"}"""))

        val result = probe.probe(networkTier(address = address("/api/")))

        assertThat(result).isInstanceOf(ProbeResult.Healthy::class.java)
        assertThat((result as ProbeResult.Healthy).latencyMs).isAtLeast(0L)
        val request = server.takeRequest()
        assertThat(request.method).isEqualTo("GET")
        assertThat(request.path).isEqualTo("/health")
    }

    @Test
    fun `probe request carries no credentials or device header`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"status":"healthy"}"""))

        probe.probe(networkTier())

        val request = server.takeRequest()
        assertThat(request.getHeader("Authorization")).isNull()
        assertThat(request.getHeader("X-Device-Id")).isNull()
    }

    @Test
    fun `non json body is an invalid response`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("not json"))

        val result = probe.probe(networkTier())

        assertThat(result).isInstanceOf(ProbeResult.InvalidResponse::class.java)
        assertThat((result as ProbeResult.InvalidResponse).reason).isNotEmpty()
    }

    @Test
    fun `unexpected status value is an invalid response`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"status":"degraded"}"""))

        val result = probe.probe(networkTier())

        assertThat(result).isInstanceOf(ProbeResult.InvalidResponse::class.java)
    }

    @Test
    fun `non 200 response is unreachable with status code`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503).setBody("busy"))

        val result = probe.probe(networkTier())

        assertThat(result).isInstanceOf(ProbeResult.Unreachable::class.java)
        assertThat((result as ProbeResult.Unreachable).reason).contains("503")
    }

    @Test
    fun `disabled tier is skipped without a request`() = runBlocking {
        val result = probe.probe(networkTier(enabled = false))

        assertThat(result).isEqualTo(ProbeResult.Skipped("tier disabled"))
        assertThat(server.requestCount).isEqualTo(0)
    }

    @Test
    fun `p2p tier is skipped without a request`() = runBlocking {
        val tier = Tier(
            id = "p2p",
            order = 0,
            kind = TierKind.P2P,
            transportHint = TransportHint.UNKNOWN,
            target = TierTarget.Peer("peer-1"),
            label = "p2p",
        )

        val result = probe.probe(tier)

        assertThat(result).isEqualTo(ProbeResult.Skipped("p2p not integrated"))
        assertThat(server.requestCount).isEqualTo(0)
    }

    @Test
    fun `network tier without network target is skipped`() = runBlocking {
        val tier = Tier(
            id = "orphan",
            order = 0,
            kind = TierKind.NETWORK_ADDRESS,
            transportHint = TransportHint.UNKNOWN,
            target = TierTarget.Peer("peer-1"),
            label = "orphan",
        )

        val result = probe.probe(tier)

        assertThat(result).isEqualTo(ProbeResult.Skipped("no network target"))
        assertThat(server.requestCount).isEqualTo(0)
    }

    @Test
    fun `pinned tier without pins is skipped`() = runBlocking {
        val tier = networkTier(tls = TlsPolicy.Pinned(emptyList()))

        val result = probe.probe(tier)

        assertThat(result).isEqualTo(ProbeResult.Skipped("no pins"))
        assertThat(server.requestCount).isEqualTo(0)
    }

    @Test
    fun `probe falls back to the next resolved address when the first route is dead`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"status":"healthy"}"""))
        val deadFirstDns = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> =
                if (hostname == "localhost") {
                    listOf(InetAddress.getByName("127.0.0.2"), InetAddress.getByName("127.0.0.1"))
                } else {
                    Dns.SYSTEM.lookup(hostname)
                }
        }
        val routingProbe = HttpTierProbe(dnsFactory = { deadFirstDns })

        val result = routingProbe.probe(
            networkTier(address = HttpAddress("http", "localhost", server.port))
        )

        assertThat(result).isInstanceOf(ProbeResult.Healthy::class.java)
        val request = server.takeRequest()
        assertThat(request.path).isEqualTo("/health")
        assertThat(server.requestCount).isEqualTo(1)
    }

    @Test
    fun `probe client budget survives one dead route plus a live connect and read`() {
        val client = HttpTierProbe.buildProbeClient(TlsPolicy.System)

        assertThat(client.connectTimeoutMillis).isEqualTo(3_000)
        assertThat(client.readTimeoutMillis).isEqualTo(5_000)
        assertThat(client.callTimeoutMillis).isEqualTo(10_000)
        assertThat(client.retryOnConnectionFailure).isTrue()
        assertThat(client.followRedirects).isFalse()
        assertThat(client.followSslRedirects).isFalse()
    }

    @Test
    fun `probe resolves through the factory with the tier address family`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"status":"healthy"}"""))
        val system = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> =
                listOf(InetAddress.getByName("127.0.0.1"))
        }
        val families = mutableListOf<AddressFamily>()
        val familyProbe = HttpTierProbe(
            dnsFactory = { family ->
                families += family
                AddressFamilyDns.forFamily(family, system)
            },
        )
        val tier = networkTier(
            address = HttpAddress("http", "localhost", server.port),
        ).copy(family = AddressFamily.PREFER_V4)

        val result = familyProbe.probe(tier)

        assertThat(result).isInstanceOf(ProbeResult.Healthy::class.java)
        assertThat(families).containsExactly(AddressFamily.PREFER_V4)
        assertThat(server.requestCount).isEqualTo(1)
    }
}
