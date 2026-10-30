package com.xehuri.kinship.p2p

import com.xehuri.kinship.network.AppHttpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import timber.log.Timber
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

// allow: SIZE_OK — single WebSocket connection + ticket lifecycle state machine
/**
 * P2P 信令 WebSocket 客户端（Phase 1 骨架，不含 WebRTC/SDP/ICE）。
 *
 * 连接 `signal_url` + `/ws?role=client&room=<room>&device_id=<deviceId>&token=<ticket>`，
 * 等待服务端 `{"type":"registered"}` 后启动 30s JSON 心跳；断线按 3s -> 30s 退避重连。
 * 不记录票据、配对码或任何信令载荷内容。
 */
class SignalingClient(
    private val httpClient: AppHttpClient,
    private val signalUrl: String,
    private val room: String,
    private val deviceId: String,
    private val ticket: String,
    @field:Volatile
    private var ticketExpiresAtMs: Long = 0L,
    private val ticketProvider: (suspend () -> SignalTicket?)? = null,
    private val heartbeatMs: Long = HEARTBEAT_MS,
    initialReconnectMs: Long = INITIAL_RECONNECT_MS,
    maxReconnectMs: Long = MAX_RECONNECT_MS,
    private val scheduler: ScheduledExecutorService = newScheduler(),
    private val webSocketFactory: ((Request, WebSocketListener) -> WebSocket)? = null
) {

    enum class State {
        IDLE,
        CONNECTING,
        CONNECTED,
        REGISTERED,
        RECONNECTING,
        CLOSED
    }

    companion object {
        const val HEARTBEAT_MS = 30_000L
        const val INITIAL_RECONNECT_MS = 3_000L
        const val MAX_RECONNECT_MS = 30_000L
        private const val WS_PATH = "/ws"
        private const val TICKET_PROVIDER_TIMEOUT_MS = 10_000L
        private const val MAX_TICKET_REFRESH_FAILURES = 3

        private fun newScheduler(): ScheduledExecutorService =
            Executors.newSingleThreadScheduledExecutor { runnable ->
                Thread(runnable, "P2pSignalWS").apply { isDaemon = true }
            }

        internal fun buildSignalUrl(
            signalUrl: String,
            room: String,
            deviceId: String,
            ticket: String
        ): String {
            val raw = signalUrl.trim()
            val wsBase = when {
                raw.startsWith("https://") -> "wss://" + raw.removePrefix("https://")
                raw.startsWith("http://") -> "ws://" + raw.removePrefix("http://")
                else -> raw
            }.trimEnd('/')
            val endpoint = if (wsBase.endsWith(WS_PATH)) wsBase else "$wsBase$WS_PATH"
            val encodedRoom = URLEncoder.encode(room, Charsets.UTF_8.name())
            val encodedDevice = URLEncoder.encode(deviceId, Charsets.UTF_8.name())
            val encodedTicket = URLEncoder.encode(ticket, Charsets.UTF_8.name())
            return "$endpoint?role=client&room=$encodedRoom&device_id=$encodedDevice&token=$encodedTicket"
        }
    }

    private val initialReconnectDelayMs = initialReconnectMs
    private val maxReconnectDelayMs = maxReconnectMs

    @Volatile
    private var activeTicket: String = ticket

    @Volatile
    private var ticketRefreshFailures = 0

    private val _state = MutableStateFlow(State.IDLE)
    val state: StateFlow<State> = _state.asStateFlow()

    @Volatile
    var onRegistered: (() -> Unit)? = null

    /** 收到非管理类信令文本时的回调（内容不落日志）。 */
    @Volatile
    var onSignalMessage: ((String) -> Unit)? = null

    @Volatile
    var onError: ((Throwable) -> Unit)? = null

    @Volatile
    var onTicketExpired: (() -> Unit)? = null

    private val wsClient: OkHttpClient by lazy {
        httpClient.getClient().newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    @Volatile
    private var webSocket: WebSocket? = null

    private var pingTask: ScheduledFuture<*>? = null

    private var reconnectAttempt = 0

    @Volatile
    private var active = false

    @Volatile
    private var closed = false

    @Volatile
    private var connectInFlight = false

    fun start() {
        synchronized(this) {
            if (active || closed) return
            active = true
        }
        connect()
    }

    /** 主动关闭并释放调度线程；关闭后不可复用。 */
    @Synchronized
    fun close() {
        active = false
        closed = true
        pingTask?.cancel(false)
        pingTask = null
        val ws = webSocket
        webSocket = null
        try { ws?.close(1000, "close") } catch (_: Exception) {}
        _state.value = State.CLOSED
        try { scheduler.shutdownNow() } catch (_: Exception) {}
    }

    fun stop() = close()

    val isOpen: Boolean
        get() = _state.value == State.CONNECTED || _state.value == State.REGISTERED

    fun sendText(text: String): Boolean {
        if (!isOpen) return false
        return try {
            webSocket?.send(text) == true
        } catch (_: Exception) {
            false
        }
    }

    fun sendSignal(type: String, to: String, payload: JSONObject = JSONObject()): Boolean {
        val message = JSONObject().apply {
            put("type", type)
            put("to", to)
            if (payload.length() > 0) put("payload", payload)
        }
        return sendText(message.toString())
    }

    internal fun isTicketExpired(nowMs: Long = System.currentTimeMillis()): Boolean =
        ticketExpiresAtMs > 0L && nowMs >= ticketExpiresAtMs

    internal fun currentUrl(): String = buildSignalUrl(signalUrl, room, deviceId, activeTicket)

    private fun connect() {
        synchronized(this) {
            if (!active || webSocket != null || connectInFlight) return
            connectInFlight = true
        }
        try {
            if (!refreshActiveTicket()) return
            synchronized(this) {
                if (!active || webSocket != null) return
                if (isTicketExpired()) {
                    stopForExpiredTicket()
                    return
                }
                _state.value = if (reconnectAttempt > 0) State.RECONNECTING else State.CONNECTING
                try {
                    val request = Request.Builder().url(currentUrl()).build()
                    webSocket = webSocketFactory?.invoke(request, listener)
                        ?: wsClient.newWebSocket(request, listener)
                } catch (e: Exception) {
                    Timber.w("信令连接创建失败: ${e.javaClass.simpleName}")
                    webSocket = null
                    scheduleReconnect()
                }
            }
        } finally {
            synchronized(this) { connectInFlight = false }
        }
    }

    private fun refreshActiveTicket(): Boolean {
        val provider = ticketProvider ?: return true
        val refreshed = try {
            runBlocking {
                withTimeoutOrNull(TICKET_PROVIDER_TIMEOUT_MS) { provider() }
            }
        } catch (_: CancellationException) {
            null
        } catch (e: Exception) {
            Timber.w("信令票据刷新失败: ${e.javaClass.simpleName}")
            null
        }
        if (refreshed == null || refreshed.ticket.isBlank()) {
            val failures = ++ticketRefreshFailures
            if (failures < MAX_TICKET_REFRESH_FAILURES) {
                Timber.w("信令票据刷新失败（%d/%d），稍后重试", failures, MAX_TICKET_REFRESH_FAILURES)
                scheduleReconnect()
                return false
            }
            failTicketRefresh()
            return false
        }
        ticketRefreshFailures = 0
        activeTicket = refreshed.ticket
        ticketExpiresAtMs = refreshed.expiresAtMs
        return true
    }

    private fun failTicketRefresh() {
        close()
        Timber.w("信令票据不可用，停止重连")
        runCatching { onTicketExpired?.invoke() }
        runCatching { onError?.invoke(IllegalStateException("signal ticket unavailable")) }
    }

    private fun scheduleReconnect() {
        if (!active) return
        if (ticketProvider == null && isTicketExpired()) {
            stopForExpiredTicket()
            return
        }
        val exponent = reconnectAttempt.coerceAtMost(4)
        val delay = (initialReconnectDelayMs * (1L shl exponent)).coerceAtMost(maxReconnectDelayMs)
        reconnectAttempt++
        _state.value = State.RECONNECTING
        try {
            scheduler.schedule({ connect() }, delay, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            // 调度器已关闭（正常关闭流程）
        }
    }

    private fun stopForExpiredTicket() {
        close()
        Timber.w("信令票据已过期，停止重连")
        runCatching { onTicketExpired?.invoke() }
    }

    @Synchronized
    private fun handleDisconnect(ws: WebSocket) {
        if (webSocket !== ws) return
        webSocket = null
        pingTask?.cancel(false)
        pingTask = null
        if (!active) {
            _state.value = State.CLOSED
            return
        }
        scheduleReconnect()
    }

    @Synchronized
    private fun startHeartbeat() {
        pingTask?.cancel(false)
        try {
            pingTask = scheduler.scheduleWithFixedDelay({
                if (_state.value == State.REGISTERED) {
                    try {
                        webSocket?.send(JSONObject().put("type", "ping").toString())
                    } catch (_: Exception) {}
                }
            }, heartbeatMs, heartbeatMs, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            // 调度器已关闭
        }
    }

    private val listener = object : WebSocketListener() {

        override fun onOpen(webSocket: WebSocket, response: Response) {
            _state.value = State.CONNECTED
            Timber.i("信令连接已建立，等待 registered")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val type = try {
                JSONObject(text).optString("type", "")
            } catch (_: Exception) {
                ""
            }
            when (type) {
                "registered" -> {
                    reconnectAttempt = 0
                    _state.value = State.REGISTERED
                    startHeartbeat()
                    runCatching { onRegistered?.invoke() }
                }
                "ping", "pong" -> {}
                "error" -> {
                    Timber.w("信令服务端返回 error")
                }
                else -> runCatching { onSignalMessage?.invoke(text) }
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Timber.w("信令连接失败: ${t.javaClass.simpleName}")
            runCatching { onError?.invoke(t) }
            handleDisconnect(webSocket)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Timber.i("信令连接已关闭 code=$code")
            handleDisconnect(webSocket)
        }
    }
}
