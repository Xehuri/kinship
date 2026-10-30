package com.xehuri.kinship.p2p

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.xehuri.kinship.network.AppHttpClient
import com.google.common.truth.Truth.assertThat
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SignalingClientTest {

    private var client: SignalingClient? = null

    @After
    fun tearDown() {
        client?.close()
    }

    @Test
    fun `builds client websocket url from signal url`() {
        val url = SignalingClient.buildSignalUrl(
            signalUrl = "https://signal.example.com",
            room = "room-1",
            deviceId = "device-1",
            ticket = "ticket-1"
        )

        assertThat(url).isEqualTo(
            "wss://signal.example.com/ws?role=client&room=room-1&device_id=device-1&token=ticket-1"
        )
    }

    @Test
    fun `does not duplicate ws path and converts http to ws`() {
        val url = SignalingClient.buildSignalUrl(
            signalUrl = "http://127.0.0.1:1234/ws",
            room = "r",
            deviceId = "d",
            ticket = "t"
        )

        assertThat(url).startsWith("ws://127.0.0.1:1234/ws?")
        assertThat(url).doesNotContain("/ws/ws")
    }

    @Test
    fun `registers and sends heartbeat ping`() {
        val registered = CountDownLatch(1)
        val pinged = CountDownLatch(1)
        val sockets = CopyOnWriteArrayList<FakeWebSocket>()
        client = newClient(
            heartbeatMs = 25L,
            reconnectMs = 25L,
            factory = { request, listener ->
                FakeWebSocket(request, listener).also { socket ->
                    sockets.add(socket)
                    socket.onText = { text -> if (text.contains("\"ping\"")) pinged.countDown() }
                    listener.onOpen(socket, upgradeResponse(request))
                    listener.onMessage(socket, """{"type":"registered"}""")
                }
            }
        ).also {
            it.onRegistered = { registered.countDown() }
            it.start()
        }

        assertThat(registered.await(5, TimeUnit.SECONDS)).isTrue()
        assertThat(pinged.await(5, TimeUnit.SECONDS)).isTrue()
        assertThat(client!!.state.value).isEqualTo(SignalingClient.State.REGISTERED)
        assertThat(sockets.first().request().url.toString()).contains("role=client")
        assertThat(sockets.first().request().url.toString()).contains("room=room-1")
    }

    @Test
    fun `reconnects after failure and returns to registered`() {
        val registered = CountDownLatch(1)
        val sockets = CopyOnWriteArrayList<FakeWebSocket>()
        client = newClient(
            heartbeatMs = 10_000L,
            reconnectMs = 25L,
            factory = { request, listener ->
                FakeWebSocket(request, listener).also { socket ->
                    sockets.add(socket)
                    listener.onOpen(socket, upgradeResponse(request))
                    if (sockets.size >= 2) {
                        listener.onMessage(socket, """{"type":"registered"}""")
                    }
                }
            }
        ).also {
            it.onRegistered = { registered.countDown() }
            it.start()
        }

        assertThat(client!!.state.value).isEqualTo(SignalingClient.State.CONNECTED)
        sockets.first().fail(IOException("dropped"))

        assertThat(registered.await(5, TimeUnit.SECONDS)).isTrue()
        assertThat(client!!.state.value).isEqualTo(SignalingClient.State.REGISTERED)
        assertThat(sockets).hasSize(2)
    }

    @Test
    fun `sendSignal returns false before websocket opens`() {
        val sockets = CopyOnWriteArrayList<FakeWebSocket>()
        client = newClient(
            heartbeatMs = 10_000L,
            reconnectMs = 10_000L,
            factory = { request, listener ->
                FakeWebSocket(request, listener).also { sockets.add(it) }
            }
        ).also { it.start() }

        assertThat(client!!.sendSignal("offer", "home", JSONObject().put("type", "offer")))
            .isFalse()
        assertThat(sockets).hasSize(1)
    }

    @Test
    fun `sendSignal writes target and payload after registration`() {
        val sent = AtomicReference<String>()
        val registered = CountDownLatch(1)
        client = newClient(
            heartbeatMs = 10_000L,
            reconnectMs = 10_000L,
            factory = { request, listener ->
                FakeWebSocket(request, listener).also { socket ->
                    socket.onText = { text ->
                        if (text.contains("\"offer\"")) sent.set(text)
                    }
                    listener.onOpen(socket, upgradeResponse(request))
                    listener.onMessage(socket, """{"type":"registered"}""")
                }
            }
        ).also {
            it.onRegistered = { registered.countDown() }
            it.start()
        }

        assertThat(registered.await(5, TimeUnit.SECONDS)).isTrue()
        val payload = JSONObject().put("type", "offer").put("sdp", "v=0")
        assertThat(client!!.sendSignal("offer", "home", payload)).isTrue()

        val json = JSONObject(sent.get())
        assertThat(json.getString("type")).isEqualTo("offer")
        assertThat(json.getString("to")).isEqualTo("home")
        assertThat(json.getJSONObject("payload").getString("sdp")).isEqualTo("v=0")
        assertThat(sent.get()).doesNotContain("ticket-1")
    }

    @Test
    fun `sendSignal omits empty payload`() {
        val sent = AtomicReference<String>()
        client = newClient(
            heartbeatMs = 10_000L,
            reconnectMs = 10_000L,
            factory = { request, listener ->
                FakeWebSocket(request, listener).also { socket ->
                    socket.onText = { text -> sent.set(text) }
                    listener.onOpen(socket, upgradeResponse(request))
                    listener.onMessage(socket, """{"type":"registered"}""")
                }
            }
        ).also { it.start() }

        assertThat(client!!.sendSignal("bye", "home")).isTrue()

        val json = JSONObject(sent.get())
        assertThat(json.getString("type")).isEqualTo("bye")
        assertThat(json.has("payload")).isFalse()
    }

    @Test
    fun `ticket provider is called before first connect and refreshed on reconnect`() {
        val providerCalls = AtomicInteger()
        val requests = CopyOnWriteArrayList<String>()
        val sockets = CopyOnWriteArrayList<FakeWebSocket>()
        val secondRegistered = CountDownLatch(1)
        client = newClient(
            heartbeatMs = 10_000L,
            reconnectMs = 25L,
            ticket = "fixed-ticket",
            ticketProvider = {
                SignalTicket(
                    ticket = "provider-ticket-${providerCalls.incrementAndGet()}",
                    expiresAtMs = Long.MAX_VALUE
                )
            },
            factory = { request, listener ->
                requests += request.url.toString()
                FakeWebSocket(request, listener).also { socket ->
                    sockets += socket
                    listener.onOpen(socket, upgradeResponse(request))
                    if (sockets.size == 2) {
                        listener.onMessage(socket, """{"type":"registered"}""")
                    }
                }
            }
        ).also {
            it.onRegistered = {
                if (sockets.size >= 2) secondRegistered.countDown()
            }
            it.start()
        }

        assertThat(providerCalls.get()).isEqualTo(1)
        assertThat(requests.single()).contains("token=provider-ticket-1")
        assertThat(requests.single()).doesNotContain("fixed-ticket")

        sockets.first().fail(IOException("dropped"))

        assertThat(secondRegistered.await(5, TimeUnit.SECONDS)).isTrue()
        assertThat(providerCalls.get()).isEqualTo(2)
        assertThat(requests).hasSize(2)
        assertThat(requests[1]).contains("token=provider-ticket-2")
        assertThat(requests[1]).doesNotContain("provider-ticket-1")
        assertThat(client!!.state.value).isEqualTo(SignalingClient.State.REGISTERED)
    }

    @Test
    fun `ticket provider failure retries three times then closes signaling without connecting`() {
        val providerCalls = AtomicInteger()
        val sockets = CopyOnWriteArrayList<FakeWebSocket>()
        val expired = CountDownLatch(1)
        val errored = CountDownLatch(1)
        client = newClient(
            heartbeatMs = 10_000L,
            reconnectMs = 25L,
            ticketProvider = {
                providerCalls.incrementAndGet()
                null
            },
            factory = { request, listener ->
                FakeWebSocket(request, listener).also { sockets += it }
            }
        ).also {
            it.onTicketExpired = { expired.countDown() }
            it.onError = { errored.countDown() }
            it.start()
        }

        assertThat(expired.await(5, TimeUnit.SECONDS)).isTrue()
        assertThat(errored.await(5, TimeUnit.SECONDS)).isTrue()
        assertThat(providerCalls.get()).isEqualTo(3)
        assertThat(client!!.state.value).isEqualTo(SignalingClient.State.CLOSED)
        assertThat(sockets).isEmpty()
    }

    @Test
    fun `ticket provider transient failure retries and connects with refreshed ticket`() {
        val providerCalls = AtomicInteger()
        val expiredCalls = AtomicInteger()
        val registered = CountDownLatch(1)
        val requests = CopyOnWriteArrayList<String>()
        val sockets = CopyOnWriteArrayList<FakeWebSocket>()
        client = newClient(
            heartbeatMs = 10_000L,
            reconnectMs = 25L,
            ticketProvider = {
                if (providerCalls.incrementAndGet() == 1) {
                    null
                } else {
                    SignalTicket(ticket = "recovered-ticket", expiresAtMs = Long.MAX_VALUE)
                }
            },
            factory = { request, listener ->
                requests += request.url.toString()
                FakeWebSocket(request, listener).also { socket ->
                    sockets += socket
                    listener.onOpen(socket, upgradeResponse(request))
                    listener.onMessage(socket, """{"type":"registered"}""")
                }
            }
        ).also {
            it.onRegistered = { registered.countDown() }
            it.onTicketExpired = { expiredCalls.incrementAndGet() }
            it.start()
        }

        assertThat(registered.await(5, TimeUnit.SECONDS)).isTrue()
        assertThat(providerCalls.get()).isEqualTo(2)
        assertThat(sockets).hasSize(1)
        assertThat(requests.single()).contains("token=recovered-ticket")
        assertThat(expiredCalls.get()).isEqualTo(0)
        assertThat(client!!.state.value).isEqualTo(SignalingClient.State.REGISTERED)
    }

    @Test
    fun `ticket expiry is derived from the absolute deadline`() {
        client = newClient(
            heartbeatMs = 10_000L,
            reconnectMs = 10_000L,
            ticketExpiresAtMs = 5_000L,
            factory = { request, listener -> FakeWebSocket(request, listener) }
        )

        assertThat(client!!.isTicketExpired(4_999L)).isFalse()
        assertThat(client!!.isTicketExpired(5_000L)).isTrue()
        assertThat(client!!.isTicketExpired(9_999L)).isTrue()
    }

    private fun newClient(
        heartbeatMs: Long,
        reconnectMs: Long,
        ticketExpiresAtMs: Long = 0L,
        ticket: String = "ticket-1",
        ticketProvider: (suspend () -> SignalTicket?)? = null,
        factory: (Request, WebSocketListener) -> WebSocket
    ): SignalingClient {
        val context = ApplicationProvider.getApplicationContext<Context>()
        return SignalingClient(
            httpClient = AppHttpClient(context),
            signalUrl = "https://signal.example.com",
            room = "room-1",
            deviceId = "device-1",
            ticket = ticket,
            ticketExpiresAtMs = ticketExpiresAtMs,
            ticketProvider = ticketProvider,
            heartbeatMs = heartbeatMs,
            initialReconnectMs = reconnectMs,
            maxReconnectMs = reconnectMs,
            webSocketFactory = factory
        )
    }

    private fun upgradeResponse(request: Request): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(101)
        .message("Switching Protocols")
        .build()

    private class FakeWebSocket(
        private val requestValue: Request,
        private val listener: WebSocketListener
    ) : WebSocket {

        override fun request(): Request = requestValue

        var onText: ((String) -> Unit)? = null

        @Volatile
        private var closed = false

        override fun queueSize(): Long = 0L

        override fun send(text: String): Boolean {
            if (closed) return false
            onText?.invoke(text)
            return true
        }

        override fun send(bytes: ByteString): Boolean = !closed

        override fun close(code: Int, reason: String?): Boolean {
            if (closed) return false
            closed = true
            listener.onClosed(this, code, reason ?: "")
            return true
        }

        override fun cancel() {
            if (closed) return
            closed = true
            listener.onFailure(this, IOException("cancelled"), null)
        }

        fun fail(error: Throwable) {
            if (closed) return
            closed = true
            listener.onFailure(this, error, null)
        }
    }
}
