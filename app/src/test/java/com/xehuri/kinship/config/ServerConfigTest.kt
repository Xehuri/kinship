package com.xehuri.kinship.config

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ServerConfigTest {

    private lateinit var context: Context
    private lateinit var prefs: SharedPreferences

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        prefs = context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        ServerConfig.init(context)
    }

    @After
    fun tearDown() {
        prefs.edit().clear().commit()
        ServerConfig.init(context)
    }

    @Test
    fun `keeps legacy server url when no candidates exist`() {
        prefs.edit().putString("server_url", "https://legacy.example.com:8768").commit()
        ServerConfig.init(context)

        assertThat(ServerConfig.BASE_URL).isEqualTo("https://legacy.example.com:8768")
        assertThat(ServerConfig.endpointCandidates).isEmpty()
        assertThat(ServerConfig.orderedEndpointCandidates).isEmpty()
        assertThat(ServerConfig.selectedEndpointCandidate()).isNull()
        assertThat(ServerConfig.selectedEndpointType).isNull()
        assertThat(ServerConfig.selectedEndpointPreferIpv4).isTrue()
    }

    @Test
    fun `maps standard endpoint names to ipv6 then frp priority`() {
        ServerConfig.updateEndpointCandidates(
            listOf(
                EndpointCandidate("backup", "https://backup.example.com:8768"),
                EndpointCandidate("frp", "https://frp.example.com:8768"),
                EndpointCandidate("ipv6", "https://[240e::1]:8443")
            )
        )

        assertThat(ServerConfig.orderedEndpointCandidates.map { it.name })
            .containsExactly("ipv6", "frp", "backup").inOrder()
        assertThat(EndpointCandidate.priorityFor("ipv6")).isEqualTo(0)
        assertThat(EndpointCandidate.priorityFor("frp")).isEqualTo(1)
        assertThat(EndpointCandidate.priorityFor("backup")).isEqualTo(2)
    }

    @Test
    fun `persists candidates and reloads them from SharedPreferences`() {
        ServerConfig.updateEndpointCandidates(
            listOf(
                EndpointCandidate("ipv6", "https://[240e::1]:8443"),
                EndpointCandidate("frp", "https://frp.example.com:8768", priority = 1)
            )
        )

        val raw = prefs.getString("endpoint_candidates", null)
        assertThat(raw).isNotNull()
        assertThat(raw).contains("ipv6")
        assertThat(raw).contains("frp")

        ServerConfig.init(context)
        assertThat(ServerConfig.endpointCandidates).hasSize(2)
        assertThat(ServerConfig.endpointCandidates.map { it.url })
            .containsExactly("https://[240e::1]:8443", "https://frp.example.com:8768")
    }

    @Test
    fun `selectBaseUrl persists selected url and resolves endpoint type`() {
        ServerConfig.updateEndpointCandidates(
            listOf(
                EndpointCandidate("ipv6", "https://[240e::1]:8443"),
                EndpointCandidate("frp", "https://frp.example.com:8768")
            )
        )

        ServerConfig.selectBaseUrl("https://[240e::1]:8443")
        assertThat(ServerConfig.BASE_URL).isEqualTo("https://[240e::1]:8443")
        assertThat(prefs.getString("server_url", null)).isEqualTo("https://[240e::1]:8443")
        assertThat(ServerConfig.selectedEndpointType).isEqualTo(EndpointType.IPV6)
        assertThat(ServerConfig.selectedEndpointPreferIpv4).isFalse()

        ServerConfig.selectBaseUrl("https://frp.example.com:8768")
        assertThat(ServerConfig.selectedEndpointType).isEqualTo(EndpointType.FRP)
        assertThat(ServerConfig.selectedEndpointPreferIpv4).isTrue()
    }

    @Test
    fun `custom endpoint uses literal host to decide ipv4 preference`() {
        ServerConfig.updateEndpointCandidates(
            listOf(
                EndpointCandidate("home", "https://[240e::2]:8443"),
                EndpointCandidate("office", "https://office.example.com:8768")
            )
        )

        ServerConfig.selectBaseUrl("https://[240e::2]:8443")
        assertThat(ServerConfig.selectedEndpointType).isEqualTo(EndpointType.CUSTOM)
        assertThat(ServerConfig.selectedEndpointPreferIpv4).isFalse()

        ServerConfig.selectBaseUrl("https://office.example.com:8768")
        assertThat(ServerConfig.selectedEndpointPreferIpv4).isTrue()
    }

    @Test
    fun `malformed candidate json is ignored`() {
        prefs.edit().putString("endpoint_candidates", "not-a-json").commit()
        ServerConfig.init(context)

        assertThat(ServerConfig.endpointCandidates).isEmpty()
        assertThat(ServerConfig.BASE_URL).isEqualTo("https://localhost:8767")
    }

    @Test
    fun `accepts plain string candidates`() {
        val parsed = ServerConfig.parseEndpointCandidates("""["https://[240e::1]:8443","https://frp.example.com:8768"]""")

        assertThat(parsed).hasSize(2)
        assertThat(parsed.map { it.name }).containsExactly("https://[240e::1]:8443", "https://frp.example.com:8768")
        assertThat(parsed.map { it.priority }).containsExactly(2, 2)
    }

    @Test
    fun `transport mode defaults to auto`() {
        assertThat(ServerConfig.transportMode).isEqualTo(TransportMode.AUTO)
        assertThat(prefs.getString("transport_mode", null)).isNull()
    }

    @Test
    fun `persists transport mode and reloads it from SharedPreferences`() {
        ServerConfig.setTransportMode(TransportMode.FORCE_FRP)

        assertThat(prefs.getString("transport_mode", null)).isEqualTo("FORCE_FRP")
        ServerConfig.init(context)
        assertThat(ServerConfig.transportMode).isEqualTo(TransportMode.FORCE_FRP)
    }

    @Test
    fun `unknown persisted transport mode falls back to auto`() {
        prefs.edit().putString("transport_mode", "UDP_ONLY").commit()
        ServerConfig.init(context)

        assertThat(ServerConfig.transportMode).isEqualTo(TransportMode.AUTO)
    }

    @Test
    fun `detects ipv6 literal hosts without dns lookup`() {
        assertThat(ServerConfig.hasIpv6LiteralHost("https://[240e::1]:8443")).isTrue()
        assertThat(ServerConfig.hasIpv6LiteralHost("https://[::1]/health")).isTrue()
        assertThat(ServerConfig.hasIpv6LiteralHost("https://frp.example.com:8768")).isFalse()
        assertThat(ServerConfig.hasIpv6LiteralHost("https://127.0.0.1:8768")).isFalse()
    }

    @Test
    fun `selectBaseUrl keeps legacy server url frozen after migration`() {
        prefs.edit()
            .putString("server_url", "https://legacy.example.com:8768")
            .putString("network_config_v1", "{}")
            .commit()
        ServerConfig.init(context)

        ServerConfig.selectBaseUrl("https://new.example.com:9000")

        assertThat(ServerConfig.BASE_URL).isEqualTo("https://new.example.com:9000")
        assertThat(prefs.getString("server_url", null)).isEqualTo("https://legacy.example.com:8768")
    }

    @Test
    fun `setTransportMode keeps legacy transport mode frozen after migration`() {
        prefs.edit()
            .putString("transport_mode", "AUTO")
            .putString("network_config_v1", "{}")
            .commit()
        ServerConfig.init(context)

        ServerConfig.setTransportMode(TransportMode.FORCE_FRP)

        assertThat(ServerConfig.transportMode).isEqualTo(TransportMode.FORCE_FRP)
        assertThat(prefs.getString("transport_mode", null)).isEqualTo("AUTO")
    }

    @Test
    fun `updateEndpointCandidates keeps legacy candidates frozen after migration`() {
        val legacy = ServerConfig.encodeEndpointCandidates(
            listOf(EndpointCandidate("frp", "https://old.example.com:8768"))
        )
        prefs.edit()
            .putString("endpoint_candidates", legacy)
            .putString("network_config_v1", "{}")
            .commit()
        ServerConfig.init(context)

        ServerConfig.updateEndpointCandidates(
            listOf(EndpointCandidate("ipv6", "https://[240e::1]:8443"))
        )

        assertThat(ServerConfig.endpointCandidates.map { it.name }).containsExactly("ipv6")
        assertThat(prefs.getString("endpoint_candidates", null)).isEqualTo(legacy)
    }
}
