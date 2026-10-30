package com.xehuri.kinship.service.collectors

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.ComponentName
import android.content.Context
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import timber.log.Timber
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.DataCollectorService
import com.xehuri.kinship.service.NotificationListenerService
import com.xehuri.kinship.service.state.SensorStateHolder
import com.xehuri.kinship.service.uploader.PerceptionCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * 系统状态采集器 —— 从 [com.xehuri.kinship.service.DataCollectorService]
 * 提取的 5 类短时效系统状态采集。
 *
 * 采集内容（5s 间隔）：
 * 1. 前台应用（UsageStatsManager）
 * 2. 媒体播放状态（MediaSessionManager）
 * 3. WiFi 连接信息（WifiManager）
 * 4. 网络类型（ConnectivityManager）
 * 5. 蓝牙已连接设备（BluetoothManager）
 * 6. 屏幕锁定状态（PowerManager）
 *
 * 数据格式与原始 DataCollectorService 完全一致，不修改 JSON 字段名。
 * 使用 [AppHttpClient] 向感知事件端点发送设备环境事件。
 */
class SystemStateCollector(
    context: Context,
    stateHolder: SensorStateHolder,
    httpClient: AppHttpClient
) : BaseCollector(context, stateHolder, httpClient) {

    // ── 系统服务（by lazy 避免构造时立即获取，便于测试） ──

    private val wifiManager: WifiManager? by lazy {
        context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    }

    private val connectivityManager: ConnectivityManager? by lazy {
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    }

    private val bluetoothManager: BluetoothManager? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        else null
    }

    private val powerManager: PowerManager? by lazy {
        context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    }

    private val usageStatsManager: UsageStatsManager? by lazy {
        context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
    }

    private val mediaSessionManager: MediaSessionManager? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP)
            context.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager
        else null
    }

    private val packageManager = context.packageManager

    // ── 协程生命周期 ──

    private var scope: CoroutineScope? = null

    override val isEnabled: Boolean
        get() = DataCollectorService.isWifiEnabled(context) ||
                DataCollectorService.isBluetoothEnabled(context) ||
                DataCollectorService.isScreenStateEnabled(context) ||
                DataCollectorService.isForegroundEnabled(context)

    override val isRunning: Boolean
        get() = scope != null

    override fun start() {
        if (scope != null) return
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope!!.launch {
            while (isActive) {
                try {
                    // 逐轮复查总开关与四类子开关（子开关由 collectSystemState 内部判定）
                    if (isEnabled) collectSystemState()
                } catch (e: Exception) {
                    Timber.w("系统状态采集异常: ${e.message}")
                }
                // 每轮重读间隔键（默认 1s），使设置页改动即时生效
                delay(DataCollectorService.getSystemStateIntervalMs(context))
            }
        }
        Timber.i("系统状态采集已启动")
    }

    override fun stop() {
        scope?.cancel()
        scope = null
        Timber.i("系统状态采集已停止")
    }

    // ── 主采集循环 ──

    private suspend fun collectSystemState() {
        if (DataCollectorService.isForegroundEnabled(context)) {
            collectForegroundApp()
            collectMediaInfo()
        }
        if (DataCollectorService.isWifiEnabled(context)) {
            collectWifiInfo()
            collectNetworkType()
        }
        if (DataCollectorService.isBluetoothEnabled(context)) {
            collectBluetoothDevices()
        }
        if (DataCollectorService.isScreenStateEnabled(context)) {
            collectScreenState()
        }
    }

    // ── 去重缓存 ──

    // @Volatile：主循环心跳线程会读取最后已知前台应用（写入在本采集器 IO 协程）
    @Volatile private var lastSentApp: String? = null
    private var lastSentMediaStr: String? = null
    private var lastWifiJson: String? = null
    private var lastNetworkJson: String? = null
    private var lastBtJson: String? = null
    private var lastScreenJson: String? = null

    /** 心跳复用的「最后已知前台应用」显示名；未授权/未启用前台采集/尚无采集结果时为 null */
    val currentForegroundAppState: String? get() = lastSentApp

    // ======================== 前台应用 ========================

    /**
     * 通过 UsageStatsManager 最近5分钟的 RESUME 事件获取当前前台应用名称。
     * 去重：包名不变不重复发送。
     * 发送事件类型: "app" payload: {"app": "AppName"}
     */
    private suspend fun collectForegroundApp() {
        try {
            val appName = getCurrentForegroundApp()
            if (appName != null && appName != lastSentApp) {
                lastSentApp = appName
                val payload = JSONObject().apply { put("app", appName) }
                sendEvent("app", payload)
                Timber.i("前台应用: $appName")
            }
        } catch (_: Exception) {}
    }

    /**
     * 获取当前前台应用名称。
     * 从 UsageStatsManager 读取最近5分钟的 ACTIVITY_RESUMED 事件，取最新的。
     */
    private fun getCurrentForegroundApp(): String? {
        try {
            val usm = usageStatsManager ?: return null
            val now = System.currentTimeMillis()
            val events = usm.queryEvents(now - 300_000L, now) ?: return null
            var currentPkg: String? = null
            var latestTs: Long = 0
            val ev = UsageEvents.Event()
            while (events.getNextEvent(ev)) {
                if (ev.packageName == null) continue
                if (ev.eventType == UsageEvents.Event.ACTIVITY_RESUMED && ev.timeStamp > latestTs) {
                    latestTs = ev.timeStamp
                    currentPkg = ev.packageName
                }
            }
            if (currentPkg != null) {
                return try {
                    val info = packageManager.getApplicationInfo(currentPkg!!, 0)
                    packageManager.getApplicationLabel(info).toString()
                } catch (_: Exception) { currentPkg }
            }
        } catch (_: Exception) {}
        return null
    }

    // ======================== 媒体播放 ========================

    /**
     * 读取当前活跃的媒体会话（歌曲名/歌手/App/播放状态）。
     * 去重：JSON 内容不变不重复发送。
     * 发送事件类型: "media"
     * 同时更新 SensorStateHolder 的 lastMediaText（供设置页显示）。
     */
    private suspend fun collectMediaInfo() {
        try {
            val mediaJson = readMediaSession()
            if (mediaJson != null) {
                val cur = mediaJson.toString()
                val title = mediaJson.optString("media_title", "")
                val artist = mediaJson.optString("media_artist", "")
                val playing = mediaJson.optString("media_state", "") == "playing"
                val displayText = if (title.isNotEmpty()) {
                    "${if (playing) "[playing] " else "[paused] "}$title - $artist"
                } else ""
                stateHolder.updateLastMediaText(displayText)
                if (cur != lastSentMediaStr) {
                    lastSentMediaStr = cur
                    sendEvent("media", mediaJson)
                    Timber.i("媒体变更: $displayText")
                }
            }
        } catch (_: Exception) {}
    }

    /**
     * 读取当前活跃媒体会话信息。
     * 使用 MediaSessionManager.getActiveSessions 获取所有活跃控制器，
     * 返回第一个有有效状态/元数据的媒体会话。
     *
     * @return JSONObject 含 media_app, media_title, media_artist, media_duration, media_state
     */
    private fun readMediaSession(): JSONObject? {
        try {
            val msm = mediaSessionManager ?: return null
            val cn = ComponentName(context, NotificationListenerService::class.java)
            val controllers = msm.getActiveSessions(cn) ?: return null
            for (c in controllers) {
                val state = c.playbackState
                val meta = c.metadata
                val pkgName = c.packageName
                if (state == null && meta == null) continue
                val stateCode = state?.state ?: -1
                val title = meta?.getString("android.media.metadata.TITLE") ?: ""
                val artist = meta?.getString("android.media.metadata.ARTIST") ?: ""
                val duration = meta?.getLong("android.media.metadata.DURATION") ?: 0L
                val playState = when (stateCode) {
                    PlaybackState.STATE_PLAYING -> "playing"
                    PlaybackState.STATE_PAUSED -> "paused"
                    PlaybackState.STATE_BUFFERING -> "buffering"
                    PlaybackState.STATE_STOPPED -> "stopped"
                    PlaybackState.STATE_SKIPPING_TO_NEXT -> "skipping"
                    else -> null
                }
                if (title.isEmpty() && playState == null) continue
                val appName = try {
                    val info = packageManager.getApplicationInfo(pkgName, 0)
                    packageManager.getApplicationLabel(info).toString()
                } catch (_: Exception) { pkgName }
                return JSONObject().apply {
                    put("media_app", appName)
                    if (title.isNotEmpty()) put("media_title", title)
                    if (artist.isNotEmpty()) put("media_artist", artist)
                    if (duration > 0) put("media_duration", duration)
                    if (playState != null) put("media_state", playState)
                }
            }
        } catch (_: Exception) {}
        return null
    }

    // ======================== WiFi 连接信息 ========================

    /**
     * 读取当前 WiFi 连接信息（SSID、RSSI、链路速度）。
     * 去重：JSON 内容不变不重复发送。
     * 发送事件类型: "device_env" payload: {"wifi": {"ssid":..., "rssi":..., "linkSpeed":..., "connected":...}}
     */
    private suspend fun collectWifiInfo() {
        try {
            val wm = wifiManager ?: return
            val info = wm.connectionInfo ?: return
            val ssid = info.ssid?.removeSurrounding("\"") ?: ""
            val json = JSONObject().apply {
                put("wifi", JSONObject().apply {
                    put("ssid", ssid)
                    put("rssi", info.rssi)
                    put("linkSpeed", info.linkSpeed)
                    put("connected", info.networkId != 0 || ssid.isNotEmpty())
                })
            }
            val cur = json.toString()
            if (cur != lastWifiJson) {
                lastWifiJson = cur
                pushDeviceEnv(json)
                Timber.i("WiFi: $ssid (${info.rssi}dBm)")
            }
        } catch (_: Exception) {}
    }

    // ======================== 网络类型 ========================

    /**
     * 读取当前网络类型（wifi/cellular/ethernet/none）。
     * 与 WiFi 信息一起构成设备网络状态。
     * 去重：JSON 内容不变不重复发送。
     * 发送事件类型: "device_env" payload: {"network": {"type":..., "mobileData":...}}
     */
    private suspend fun collectNetworkType() {
        try {
            val cm = connectivityManager ?: return
            val activeNet = cm.activeNetwork
            val caps = cm.getNetworkCapabilities(activeNet)
            var type = "none"
            var mobileData = false
            if (caps != null) {
                when {
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> type = "wifi"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> {
                        type = "cellular"; mobileData = true
                    }
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> type = "ethernet"
                }
            }
            val json = JSONObject().apply {
                put("network", JSONObject().apply {
                    put("type", type)
                    put("mobileData", mobileData)
                })
            }
            val cur = json.toString()
            if (cur != lastNetworkJson) {
                lastNetworkJson = cur
                pushDeviceEnv(json)
                Timber.i("网络: $type mobileData=$mobileData")
            }
        } catch (_: Exception) {}
    }

    // ======================== 蓝牙已连接设备 ========================

    /**
     * 扫描所有已连接的蓝牙设备（GATT/BLE、A2DP耳机、HSP耳机）。
     * Android 12+ 需要 BLUETOOTH_CONNECT 权限。
     * 去重：JSON 内容不变不重复发送。
     * 发送事件类型: "device_env" payload: {"bluetooth": [{name, address, profile}, ...]}
     */
    private suspend fun collectBluetoothDevices() {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
            val btMgr = bluetoothManager ?: return
            val btAdapt = btMgr.adapter ?: return
            if (!btAdapt.isEnabled) return
            // Android 12+ 权限检查
            if (Build.VERSION.SDK_INT >= 31) {
                if (context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED
                ) {
                    Timber.w("蓝牙: 无 BLUETOOTH_CONNECT 权限")
                    return
                }
            }
            val allDevices = mutableSetOf<String>()
            val arr = JSONArray()
            val profiles = listOf(
                BluetoothProfile.GATT,
                BluetoothProfile.GATT_SERVER,
                BluetoothProfile.A2DP,
                BluetoothProfile.HEADSET
            )
            for (profile in profiles) {
                try {
                    val devs = btMgr.getConnectedDevices(profile)
                    for (dev in devs) {
                        val addr = dev.address ?: continue
                        if (addr !in allDevices) {
                            allDevices.add(addr)
                            arr.put(JSONObject().apply {
                                put("name", dev.name ?: "未知")
                                put("address", addr)
                                put("profile", profile)
                            })
                        }
                    }
                } catch (_: Exception) {}
            }
            val json = JSONObject().apply { put("bluetooth", arr) }
            val cur = json.toString()
            if (cur != lastBtJson) {
                lastBtJson = cur
                pushDeviceEnv(json)
                Timber.i("蓝牙: ${arr.length()} 个设备已连接")
            }
        } catch (_: Exception) {}
    }

    // ======================== 屏幕锁定状态 ========================

    /**
     * 读取当前屏幕锁定状态（通过 PowerManager.isInteractive）。
     * 去重：JSON 内容不变不重复发送。
     * 发送事件类型: "device_env" payload: {"screen": {"locked": true/false}}
     */
    private suspend fun collectScreenState() {
        try {
            val pm = powerManager ?: return
            val isScreenOn = pm.isInteractive
            val json = JSONObject().apply {
                put("screen", JSONObject().apply { put("locked", !isScreenOn) })
            }
            val cur = json.toString()
            if (cur != lastScreenJson) {
                lastScreenJson = cur
                pushDeviceEnv(json)
                Timber.i("屏幕锁定=${!isScreenOn}")
            }
        } catch (_: Exception) {}
    }

    // ======================== 上传 ========================

    /**
     * 投递一条通用感知事件。
     *
     * **统一上传（2026-09-16）**：不再自行 POST，只调用 [DataCollectorService.enqueueEvent]
     * 入队（设备名注入与时间戳在服务侧统一处理），由主循环按 `loop_ms` 统一发出。
     * 事件结构与 `/api/screen/stt/perception-event` 的 `{"type","payload","ts"}` 一致。
     */
    private fun sendEvent(type: String, payload: JSONObject) {
        DataCollectorService.enqueueEvent(type, payload)
    }

    /** 推送设备环境事件（类型恒为 "device_env"） */
    private fun pushDeviceEnv(json: JSONObject) = sendEvent("device_env", json)
}
