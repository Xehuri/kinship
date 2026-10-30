package com.xehuri.kinship.network

import android.content.Context
import com.xehuri.kinship.util.DeviceId
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import timber.log.Timber
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 通知下行 WebSocket 客户端 —— 对接后端 `/ws` 主端点（通知推送复用组件注册表）。
 *
 * ## 职责
 * - 建立并维护到 `wss://{host}/ws?token={auth_token}` 的长连接；
 * - 收到 `{"type":"notification","data":{id,title,content,ts}}` 时回调
 *   [onNotification]，由服务弹出系统通知；
 * - 30s 应用层心跳（`{"type":"ping"}`），断线后指数退避重连（3s → 30s 封顶）；
 * - 通过 [state] 暴露连接状态；[close] 后不再重连。
 *
 * ## 线程
 * OkHttp 回调在其内部读取线程；重连与心跳由独立单线程守护调度器驱动。
 * 公共方法均为线程安全。此客户端仅接收，无二进制上行。
 *
 * @param context 用于读取 SharedPreferences（axeuh_prefs/auth_token）
 * @param httpClient 复用 AppHttpClient 的 OkHttp 与 SSL 策略
 */
class NotificationStreamClient(
    context: Context,
    private val httpClient: AppHttpClient
) {

    /** 应用上下文（用于读取持久化设备标识） */
    private val appContext: Context = context.applicationContext

    /** 连接状态 */
    enum class ConnectionState {
        /** 正在建立连接（TCP / WebSocket 握手阶段） */
        CONNECTING,
        /** 已连接（收到服务端 connected 回执） */
        CONNECTED,
        /** 离线：尚未连接或已断开 */
        OFFLINE
    }

    /** 通知下行载荷（tsSec 为后端 created_at 的 epoch 秒，帧缺 ts 时为 0） */
    data class NotificationPayload(val id: Int, val title: String, val content: String, val tsSec: Long)

    companion object {
        /** 初始重连延迟 */
        private const val INITIAL_RECONNECT_MS = 3000L

        /** 重连延迟上限 */
        private const val MAX_RECONNECT_MS = 30000L

        /** 心跳间隔 */
        private const val HEARTBEAT_MS = 30000L

        /** WebSocket 端点路径（与后端主注册表一致） */
        private const val WS_PATH = "/ws"
    }

    private val prefs = context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)

    private val _state = MutableStateFlow(ConnectionState.OFFLINE)

    /** 连接状态流：CONNECTING / CONNECTED / OFFLINE */
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    /** 收到通知推送时的回调：(id, title, content, tsSec)；tsSec 为帧内 epoch 秒（缺 ts=0，消费方兜底毫秒） */
    @Volatile
    var onNotification: ((Int, String, String, Long) -> Unit)? = null

    /** 服务端 connected 回执到达时的回调（每次连接/重连各触发一次，供消费方做联网后动作） */
    @Volatile
    var onConnected: (() -> Unit)? = null

    /**
     * 专用 OkHttp 客户端：复用 [AppHttpClient] 主客户端的 SSL 策略与拦截器，
     * 但关闭读超时（WebSocket 长连接不应因长时间无数据被判超时）。
     */
    private val wsClient: OkHttpClient by lazy {
        httpClient.getClient().newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    /** 重连 / 心跳调度器（单线程守护线程） */
    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "NotifyStreamWS").apply { isDaemon = true }
        }

    /** 当前活跃的 WebSocket */
    @Volatile
    private var webSocket: WebSocket? = null

    /** 心跳任务句柄 */
    private var pingTask: ScheduledFuture<*>? = null

    /** 连续重连次数（握手成功后清零） */
    private var reconnectAttempt = 0

    /** 是否已主动关闭（置位后禁止一切新连接与重连） */
    @Volatile
    private var closed = false

    /** 是否处于运行态（start 后置位，close 后清除） */
    @Volatile
    private var active = false

    // ==================== 对外接口 ====================

    /** 启动连接并保持。重复调用安全。 */
    @Synchronized
    fun start() {
        closed = false
        active = true
        if (_state.value != ConnectionState.CONNECTED) connect()
    }

    /** 彻底关闭客户端并释放调度线程；关闭后不可再复用。 */
    @Synchronized
    fun close() {
        closed = true
        active = false
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
        if (closed || !active) return
        if (webSocket != null) return

        val url = buildUrl()
        if (url == null) {
            Timber.w("缺少 auth_token，无法建立通知流连接")
            _state.value = ConnectionState.OFFLINE
            scheduleReconnect()
            return
        }

        _state.value = ConnectionState.CONNECTING
        try {
            val request = Request.Builder().url(url).build()
            webSocket = wsClient.newWebSocket(request, listener)
            Timber.i("通知流连接中: ${url.substringBefore("?")}")
        } catch (e: Exception) {
            Timber.w("通知流连接创建失败: ${e.message}")
            webSocket = null
            _state.value = ConnectionState.OFFLINE
            scheduleReconnect()
        }
    }

    /**
     * 依据 [com.xehuri.kinship.config.ServerConfig.BASE_URL] 推导 WebSocket 地址。
     * https → wss、http → ws，并附带 token / client=native / device_id 查询参数；无 token 时返回 null。
     *
     * 关键：必须显式声明 `client=native`，否则 App 长连接会被后端缺省当成 web，
     * 导致 ① TTS 无法定向到手机（native 注册表无连接 → 回退广播）；
     * ② 回退广播"排除 native"排除不掉 App，手机与 PC 仍会同时出声。
     * `internal`（包可见）以便测试。
     */
    internal fun buildUrl(): String? {
        val token = prefs.getString("auth_token", "") ?: ""
        if (token.isEmpty()) return null
        val base = com.xehuri.kinship.config.ServerConfig.BASE_URL
        val wsBase = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> base
        }.trimEnd('/')
        val encoded = java.net.URLEncoder.encode(token, Charsets.UTF_8.name())
        val deviceId = java.net.URLEncoder.encode(DeviceId.get(appContext), Charsets.UTF_8.name())
        return "$wsBase$WS_PATH?token=$encoded&client=native&device_id=$deviceId"
    }

    /** 安排一次指数退避重连（3s → 6s → ... → 30s 封顶）。 */
    private fun scheduleReconnect() {
        if (closed || !active) return
        val delay = (INITIAL_RECONNECT_MS * (1L shl reconnectAttempt.coerceAtMost(4)))
            .coerceAtMost(MAX_RECONNECT_MS)
        reconnectAttempt++
        Timber.i("通知流将在 ${delay}ms 后重连（第 $reconnectAttempt 次）")
        try {
            scheduler.schedule({
                if (!closed && active) connect()
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
        if (closed || !active) return
        scheduleReconnect()
    }

    /** 启动 30s 应用层心跳（定时发送 JSON ping）。 */
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
     * 解析通知下行文本。
     * 仅当 `type=="notification"` 且存在 `data` 时返回载荷，否则返回 null。
     * `internal`（包可见）以便测试。
     */
    internal fun parseNotificationMessage(text: String): NotificationPayload? {
        val json = try {
            JSONObject(text)
        } catch (_: Exception) {
            return null
        }
        if (json.optString("type", "") != "notification") return null
        val data = json.optJSONObject("data") ?: return null
        // epoch 秒：id/ts 字段与 Int32 兼容至 2038（optInt 口径）；ts 用 optLong 解析，
        // 缺失/非数值 ⇒ 0，消费方回落当前毫秒（宁失去重、不吞推送）
        return NotificationPayload(
            id = data.optInt("id", 0),
            title = data.optString("title", ""),
            content = data.optString("content", ""),
            tsSec = data.optLong("ts", 0L)
        )
    }

    // ==================== WebSocket 回调 ====================

    private val listener = object : WebSocketListener() {

        override fun onOpen(webSocket: WebSocket, response: Response) {
            // 连接建立后等待服务端 connected 回执，再置为 CONNECTED 并启动心跳
            Timber.i("通知流已连接，等待握手回执")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            // 优先按通知下行解析
            val payload = parseNotificationMessage(text)
            if (payload != null) {
                try {
                    onNotification?.invoke(payload.id, payload.title, payload.content, payload.tsSec)
                } catch (e: Exception) {
                    Timber.w(e, "onNotification 回调异常")
                }
                return
            }
            val json = try {
                JSONObject(text)
            } catch (_: Exception) {
                Timber.d("通知流收到非 JSON 文本: $text")
                return
            }
            when (json.optString("type", "")) {
                "connected" -> {
                    reconnectAttempt = 0
                    _state.value = ConnectionState.CONNECTED
                    Timber.i("通知流握手完成")
                    startHeartbeat()
                    // 联网回执即触发消费方动作（回调异常绝不影响连接维护协程）
                    runCatching { onConnected?.invoke() }
                }
                "pong", "initial_state" -> {
                    // 正常回执，无需处理
                }
                "error" -> Timber.w("通知流服务端错误: ${json.optString("message", "")}")
                else -> Timber.d("通知流未知消息: $text")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Timber.w("通知流连接失败: ${t.message}")
            handleDisconnect(webSocket)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Timber.i("通知流已关闭 code=$code reason=$reason")
            handleDisconnect(webSocket)
        }
    }
}
