package com.xehuri.kinship.network

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import timber.log.Timber
import java.net.Inet4Address
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 音频流 WebSocket 客户端 —— 对接后端 `/ws/audio-stream`。
 *
 * ## 职责
 * - 建立并维护到 `wss://{host}/ws/audio-stream?token={auth_token}` 的长连接；
 * - 连接后发送 hello 握手，收到 connected 后发送 audio_start 并持续上行二进制
 *   PCM s16le 帧（16kHz 单声道）；
 * - 30s 心跳 ping，断线后指数退避重连（3s → 30s 封顶）；
 * - 通过 [state] 对外暴露连接状态，供采集端决定「直送」还是「本地缓存」；
 * - 收到服务端 throttle 时回调 [onThrottle] 并断开，交由退避重连，期间采集端转本地缓存。
 *
 * ## 时间戳约定
 * 服务端完全依据客户端上报的 `start_wall_ms` 与样本偏移推算真实时间，从不使用
 * 接收时间。因此重连时若沿用最开始的时间，重连后的音频时间会整体前移。
 * [positionProvider] 由采集端提供「下一帧对应的墙钟毫秒」，每次（重）连时用它
 * 校正 `audio_start.start_wall_ms`，保证时间戳始终对应真实采集时刻。
 *
 * ## 线程
 * OkHttp 的回调运行在其内部读取线程；重连与心跳由独立单线程调度器驱动。
 * 公共方法均为线程安全。
 *
 * @param context 用于读取 SharedPreferences（axeuh_prefs/auth_token）
 * @param httpClient 复用 AppHttpClient 的 OkHttp 与 SSL 策略
 * @param deviceId 设备标识，随 hello 上报，服务端据此区分多设备
 * @param preferIpv4ForEndpoint 当前端点是否应 IPv4 优先（默认读 [ServerConfig] 的端点选择）
 */
class AudioStreamClient(
    context: Context,
    private val httpClient: AppHttpClient,
    private val deviceId: String,
    private val preferIpv4ForEndpoint: () -> Boolean = {
        com.xehuri.kinship.config.ServerConfig.selectedEndpointPreferIpv4
    }
) {

    /** 连接状态 */
    enum class ConnectionState {
        /** 正在建立连接（TCP / WebSocket 握手阶段） */
        CONNECTING,
        /** 已连接且完成 hello 握手，可发送音频帧 */
        CONNECTED,
        /** 离线：尚未连接或已断开，采集端应转本地缓存 */
        OFFLINE
    }

    companion object {
        /** 初始重连延迟 */
        private const val INITIAL_RECONNECT_MS = 3000L

        /** 重连延迟上限 */
        private const val MAX_RECONNECT_MS = 30000L

        /** 心跳间隔 */
        private const val HEARTBEAT_MS = 30000L

        /** WebSocket 端点路径 */
        private const val WS_PATH = "/ws/audio-stream"

        /**
         * 把解析结果中的 IPv4 地址排到最前（保持组内原有顺序），IPv6 保留为回退。
         *
         * 纯函数，便于单元测试；排序使用稳定排序，地址不可用时仅调整顺序不丢地址。
         */
        internal fun preferIpv4First(addrs: List<InetAddress>): List<InetAddress> {
            if (addrs.size <= 1) return addrs
            return addrs.sortedBy { if (it is Inet4Address) 0 else 1 }
        }

        /**
         * 按端点类型选择 DNS 解析顺序。
         *
         * `frp` / IPv4 端点用 IPv4 优先；`ipv6` 端点沿用系统顺序（不强制 IPv4）。
         * 纯函数（system 可注入），便于单元测试。
         */
        internal fun dnsFor(preferIpv4: Boolean, system: Dns = Dns.SYSTEM): Dns {
            if (!preferIpv4) return system
            return object : Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    preferIpv4First(system.lookup(hostname))
            }
        }
    }

    private val prefs = context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)

    private val _state = MutableStateFlow(ConnectionState.OFFLINE)

    /** 连接状态流：CONNECTING / CONNECTED / OFFLINE */
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    /** 收到服务端 throttle（过载）时的回调，采集端据此转本地缓存 */
    @Volatile
    var onThrottle: (() -> Unit)? = null

    /** 每次（含自动重连）握手成功后的回调，采集端据此触发缓存落盘与补传 */
    @Volatile
    var onConnected: (() -> Unit)? = null

    /**
     * 收到服务端唤醒事件时的回调（stage = start / end）。
     *
     * 服务端通过 `{"type":"wake","stage":"start|end","reason":...}` 文本帧下发：
     * - `start` 表示唤醒确认、可以开始说话；`end` 表示本段录制结束。
     * 回调在 OkHttp 读取线程触发，采集端据此播放提示音（见 `HintTonePlayer`）。
     */
    @Volatile
    var onWakeEvent: ((stage: String, reason: String?) -> Unit)? = null

    /**
     * 云端 KWS 测试结果回调。
     *
     * 测试模式下服务端通过 `{"type":"kws_test_result", ...}` 文本帧回推，含命中词、
     * 声纹滑窗分数序列、时长、ASR 文本、终止原因与参数快照（不投递 AI、不落盘）。
     */
    var onKwsTestResult: ((org.json.JSONObject) -> Unit)? = null

    /** 测试模式：随 audio_start 上报 `test: true`，服务端据此只回推结果 */
    @Volatile
    var testMode: Boolean = false

    /**
     * 端侧 KWS 命中标记：随 audio_start 上报 `local_hit: true`。
     *
     * 服务端据此跳过自身的 KWS 解码，直接进入声纹进门验证 -> 录制流程。
     * 常驻流式模式（由服务端自己跑 KWS）必须保持 false，否则服务端不会自行命中。
     */
    @Volatile
    var localHit: Boolean = false

    /**
     * 端侧命中的唤醒词文本：随 `local_hit: true` 一并作为 `keyword` 上报。
     *
     * 支持配置多个唤醒词时，服务端据此把 `wake_start` 回推为**实际命中的那个词**
     * （为空时服务端回退到目标词表首项），而不是固定回显主唤醒词。
     */
    @Volatile
    var localHitKeyword: String = ""

    /** 提供「下一个待发送采样对应的墙钟毫秒」，重连时用于纠正时间基准 */
    @Volatile
    var positionProvider: (() -> Long)? = null

    /**
     * 端点感知的 DNS 解析器。
     *
     * 仅当当前端点应 IPv4 优先（frp / IPv4）时才把 IPv4 排到最前；`ipv6` 端点沿用
     * 系统顺序。首次建连前求值，避免对所有 Endpoint 硬编码 IPv4 优先。
     */
    private val endpointDns: Dns by lazy { dnsFor(preferIpv4ForEndpoint()) }

    /**
     * 专用 OkHttp 客户端：复用 [AppHttpClient] 主客户端的 SSL 策略与拦截器，
     * 但将读超时关闭（WebSocket 长连接不应因长时间无数据被判超时），
     * 并使用端点感知的 DNS（见 [endpointDns]）。
     */
    private val wsClient: OkHttpClient by lazy {
        httpClient.getClient().newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .dns(endpointDns)
            .build()
    }

    /** 重连 / 心跳调度器（单线程守护线程） */
    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "AudioStreamWS").apply { isDaemon = true }
        }

    /** 当前活跃的 WebSocket（volatile：跨 OkHttp 线程与采集线程读写） */
    @Volatile
    private var webSocket: WebSocket? = null

    /** 心跳任务句柄 */
    private var pingTask: ScheduledFuture<*>? = null

    /** 连续重连次数（握手成功后清零） */
    private var reconnectAttempt = 0

    /** 是否已主动关闭（置位后禁止一切新连接与重连） */
    @Volatile
    private var closed = false

    /** 是否存在活跃推流会话 */
    @Volatile
    private var streamActive = false

    /** 客户端生成的会话 ID（随 audio_start 上报，离线碎片元数据复用） */
    @Volatile
    private var sessionId: String = ""

    /** 会话首次开始时的墙钟毫秒（[positionProvider] 缺省时的兜底） */
    @Volatile
    private var initialStartWallMs: Long = 0L

    // ==================== 对外接口 ====================

    /** 当前会话 ID，供离线碎片元数据使用 */
    fun currentSessionId(): String = sessionId

    /**
     * 开始一路推流。
     *
     * 若尚未连接则发起连接；已连接则立即发送 audio_start。
     * 会话 ID 在客户端生成，重连时保持不变。
     *
     * @param startWallMs 采集起始的真实墙钟毫秒（由调用方传入）
     */
    @Synchronized
    fun startStream(startWallMs: Long) {
        closed = false
        streamActive = true
        // 每次开始推流生成新会话 ID；自动重连不经过此处，故会话 ID 在重连间保持不变
        sessionId = UUID.randomUUID().toString().replace("-", "")
        initialStartWallMs = startWallMs
        if (_state.value == ConnectionState.CONNECTED) {
            sendAudioStart()
        } else {
            connect()
        }
    }

    /**
     * 发送一帧 PCM s16le 数据。
     *
     * @return true 表示已写入发送队列；false 表示未连接或已关闭（调用方应转本地缓存）
     */
    fun send(pcm: ByteArray): Boolean {
        if (closed || !streamActive) return false
        if (_state.value != ConnectionState.CONNECTED) return false
        val ws = webSocket ?: return false
        return try {
            ws.send(ByteString.of(*pcm))
        } catch (e: Exception) {
            Timber.w("音频帧发送异常: ${e.message}")
            false
        }
    }

    /** 主动停止推流：通知服务端冲刷尾段并关闭连接（不再重连）。 */
    @Synchronized
    fun stopStream() {
        streamActive = false
        val ws = webSocket
        if (ws != null) {
            try { ws.send(JSONObject().put("type", "audio_stop").toString()) } catch (_: Exception) {}
            try { ws.close(1000, "audio_stop") } catch (_: Exception) {}
        }
    }

    /** 彻底关闭客户端并释放调度线程；关闭后不可再复用。 */
    @Synchronized
    fun close() {
        closed = true
        streamActive = false
        pingTask?.cancel(false)
        pingTask = null
        val ws = webSocket
        webSocket = null
        try { ws?.close(1000, "close") } catch (_: Exception) {}
        _state.value = ConnectionState.OFFLINE
        try { scheduler.shutdownNow() } catch (_: Exception) {}
    }

    // ==================== 连接管理 ====================

    /** 建立连接；已存在活跃连接或已关闭时直接返回。 */
    @Synchronized
    private fun connect() {
        if (closed || !streamActive) return
        if (webSocket != null) return

        val url = buildUrl()
        if (url == null) {
            Timber.w("缺少 auth_token，无法建立音频流连接")
            _state.value = ConnectionState.OFFLINE
            scheduleReconnect()
            return
        }

        _state.value = ConnectionState.CONNECTING
        try {
            val request = Request.Builder().url(url).build()
            webSocket = wsClient.newWebSocket(request, listener)
            Timber.i("音频流连接中: ${url.substringBefore("?")}")
        } catch (e: Exception) {
            Timber.w("音频流连接创建失败: ${e.message}")
            webSocket = null
            _state.value = ConnectionState.OFFLINE
            scheduleReconnect()
        }
    }

    /**
     * 依据 [com.xehuri.kinship.config.ServerConfig.BASE_URL] 推导 WebSocket 地址。
     * https → wss、http → ws，并附带 token 查询参数；无 token 时返回 null。
     */
    private fun buildUrl(): String? {
        val token = prefs.getString("auth_token", "") ?: ""
        if (token.isEmpty()) return null
        val base = com.xehuri.kinship.config.ServerConfig.BASE_URL
        val wsBase = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> base
        }.trimEnd('/')
        val encoded = java.net.URLEncoder.encode(token, Charsets.UTF_8.name())
        return "$wsBase$WS_PATH?token=$encoded"
    }

    /** 安排一次指数退避重连（3s → 6s → ... → 30s 封顶）。 */
    private fun scheduleReconnect() {
        if (closed || !streamActive) return
        val delay = (INITIAL_RECONNECT_MS * (1L shl reconnectAttempt.coerceAtMost(4)))
            .coerceAtMost(MAX_RECONNECT_MS)
        reconnectAttempt++
        Timber.i("音频流将在 ${delay}ms 后重连（第 $reconnectAttempt 次）")
        try {
            scheduler.schedule({
                if (!closed && streamActive) connect()
            }, delay, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            // 调度器已关闭（正常关闭流程），忽略
        }
    }

    /** 统一处理断线：更新状态并按需安排重连。 */
    @Synchronized
    private fun handleDisconnect(ws: WebSocket) {
        // 若已建立新连接，忽略旧连接的回调，避免误伤
        if (webSocket !== ws) return
        webSocket = null
        pingTask?.cancel(false)
        pingTask = null
        _state.value = ConnectionState.OFFLINE
        if (closed || !streamActive) return
        scheduleReconnect()
    }

    /** 启动 30s 心跳（定时发送 JSON ping）。 */
    @Synchronized
    private fun startHeartbeat() {
        pingTask?.cancel(false)
        try {
            pingTask = scheduler.scheduleWithFixedDelay({
                if (_state.value == ConnectionState.CONNECTED) {
                    try {
                        webSocket?.send(JSONObject().put("type", "ping").toString())
                    } catch (_: Exception) {}
                }
            }, HEARTBEAT_MS, HEARTBEAT_MS, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            // 调度器已关闭，忽略
        }
    }

    /**
     * 发送 audio_start。
     *
     * `start_wall_ms` 取 [positionProvider] 返回的当前采集位置（首次连接即调用方
     * 传入的采集起始时间，重连时按已采集样本数前移），确保服务端推算的时间正确。
     */
    private fun sendAudioStart() {
        if (!streamActive) return
        val startWall = try {
            positionProvider?.invoke()
        } catch (_: Exception) {
            null
        } ?: initialStartWallMs

        val payload = JSONObject().apply {
            put("type", "audio_start")
            put("session_id", sessionId)
            put("seq", 0)
            put("start_wall_ms", startWall)
            if (testMode) put("test", true)
            if (localHit) {
                put("local_hit", true)
                // 多唤醒词：上报实际命中词，服务端 wake_start 据此回显
                if (localHitKeyword.isNotBlank()) put("keyword", localHitKeyword)
            }
        }
        try {
            webSocket?.send(payload.toString())
            Timber.i("audio_start 已发送 session=$sessionId start_wall_ms=$startWall")
        } catch (e: Exception) {
            Timber.w("audio_start 发送失败: ${e.message}")
        }
    }

    // ==================== WebSocket 回调 ====================

    private val listener = object : WebSocketListener() {

        override fun onOpen(webSocket: WebSocket, response: Response) {
            Timber.i("音频流已连接，发送 hello")
            try {
                val hello = JSONObject().apply {
                    put("type", "hello")
                    put("device_id", deviceId)
                    put("sample_rate", 16000)
                    put("channels", 1)
                    put("format", "pcm_s16le")
                }
                webSocket.send(hello.toString())
            } catch (e: Exception) {
                Timber.w("hello 发送失败: ${e.message}")
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val json = try {
                JSONObject(text)
            } catch (_: Exception) {
                Timber.d("音频流收到非 JSON 文本: $text")
                return
            }
            when (json.optString("type", "")) {
                "connected" -> {
                    reconnectAttempt = 0
                    _state.value = ConnectionState.CONNECTED
                    Timber.i("音频流握手完成，开始推流")
                    sendAudioStart()
                    startHeartbeat()
                    try { onConnected?.invoke() } catch (e: Exception) {
                        Timber.w(e, "onConnected 回调异常")
                    }
                }
                "throttle" -> {
                    Timber.w("服务端 throttle：转本地缓存")
                    try { onThrottle?.invoke() } catch (e: Exception) {
                        Timber.w(e, "onThrottle 回调异常")
                    }
                    // 关闭当前连接，交由退避重连（期间采集端本地缓存）
                    try { webSocket.close(1001, "throttle") } catch (_: Exception) {}
                    handleDisconnect(webSocket)
                }
                "wake" -> {
                    // 唤醒事件：stage=start（唤醒确认）/ end（录制结束）；reason 仅 end 携带
                    val stage = json.optString("stage", "")
                    val reason = json.optString("reason", "").ifEmpty { null }
                    try {
                        onWakeEvent?.invoke(stage, reason)
                    } catch (e: Exception) {
                        // 提示音 / UI 失败绝不能打断 WebSocket 读取循环
                        Timber.w(e, "onWakeEvent 回调异常")
                    }
                }
                "kws_test_result" -> {
                    try { onKwsTestResult?.invoke(json) } catch (e: Exception) {
                        Timber.w(e, "onKwsTestResult 回调异常")
                    }
                }
                "pong", "audio_stopped", "ack", "segment_done" -> {
                    // 正常回执，无需处理
                }
                "error" -> Timber.w("音频流服务端错误: ${json.optString("message", "")}")
                else -> Timber.d("音频流未知消息: $text")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Timber.w("音频流连接失败: ${t.message}")
            handleDisconnect(webSocket)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Timber.i("音频流已关闭 code=$code reason=$reason")
            handleDisconnect(webSocket)
        }
    }
}
