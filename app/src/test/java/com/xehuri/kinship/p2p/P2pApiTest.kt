package com.xehuri.kinship.p2p

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.xehuri.kinship.network.AppHttpClient
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class P2pApiTest {

    private lateinit var server: MockWebServer
    private lateinit var httpClient: AppHttpClient
    private lateinit var api: P2pApi

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
            .edit()
            .putString("auth_token", "token-1")
            .commit()
        server = MockWebServer()
        server.start()
        httpClient = AppHttpClient(context) { "device-1" }
        api = P2pApi(httpClient) { server.url("").toString().trimEnd('/') }
    }

    @After
    fun tearDown() {
        server.shutdown()
        ApplicationProvider.getApplicationContext<Context>()
            .getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
    }

    @Test
    fun `getStatus parses contract fields and endpoint map`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"enabled":true,"signal_connected":true,"room":"room-1",
                   "endpoints":{"frp":"https://frp.example.com:8768","ipv6":"https://[240e::1]:8443"},
                   "device_count":2,"server_id":"home"}"""
            )
        )

        val status = api.getStatus()

        assertThat(status.enabled).isTrue()
        assertThat(status.signalConnected).isTrue()
        assertThat(status.room).isEqualTo("room-1")
        assertThat(status.endpoints).containsEntry("ipv6", "https://[240e::1]:8443")
        assertThat(status.deviceCount).isEqualTo(2)
        assertThat(status.serverId).isEqualTo("home")
        assertThat(status.signalUrl).isNull()
        assertThat(status.webrtcEnabled).isFalse()
        assertThat(status.endpointCandidates().map { it.name }).containsExactly("ipv6", "frp").inOrder()

        val request = server.takeRequest()
        assertThat(request.path).isEqualTo("/api/p2p/status")
        assertThat(request.getHeader("Authorization")).isEqualTo("Bearer token-1")
        assertThat(request.getHeader("X-Device-Id")).isEqualTo("device-1")
    }

    @Test
    fun `getStatus parses optional signal_url`() {
        runBlocking {
            server.enqueue(
                MockResponse().setResponseCode(200).setBody(
                    """{"enabled":true,"room":"room-1","signal_url":"wss://signal.example.com",
                       "webrtc_enabled":true,
                       "endpoints":{"ipv6":"https://[240e::1]:8443"},
                       "device_count":1,"server_id":"home"}"""
                )
            )

            val status = api.getStatus()

            assertThat(status.signalUrl).isEqualTo("wss://signal.example.com")
            assertThat(status.webrtcEnabled).isTrue()
            assertThat(status.endpointCandidates().map { it.name }).containsExactly("ipv6")
        }
    }

    @Test
    fun `requestSignalTicket posts and parses ticket`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"signal_ticket":"ticket-abc","signal_ticket_expires_at":1700000000000}"""
            )
        )

        val ticket = api.requestSignalTicket()

        assertThat(ticket.ticket).isEqualTo("ticket-abc")
        assertThat(ticket.expiresAtMs).isEqualTo(1_700_000_000_000L)

        val request = server.takeRequest()
        assertThat(request.method).isEqualTo("POST")
        assertThat(request.path).isEqualTo("/api/p2p/signal-ticket")
        assertThat(request.getHeader("X-Device-Id")).isEqualTo("device-1")
    }

    @Test
    fun `enroll parses signal url and endpoints`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"device_id":"device-1","user_id":"user-1","device_token":"dt",
                   "signal_url":"wss://signal.example.com","room":"home",
                   "endpoints":{"ipv6":"https://[240e::1]:8443"},
                   "signal_ticket":"ticket-1","signal_ticket_expires_at":123}"""
            )
        )

        val enrollment = api.enroll("pair-1", "device-1", deviceName = "phone")

        assertThat(enrollment.signalUrl).isEqualTo("wss://signal.example.com")
        assertThat(enrollment.room).isEqualTo("home")
        assertThat(enrollment.endpoints).containsEntry("ipv6", "https://[240e::1]:8443")
        assertThat(enrollment.signalTicket).isEqualTo("ticket-1")
        assertThat(server.takeRequest().path).isEqualTo("/api/p2p/enroll")
    }
}
