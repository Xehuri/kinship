package com.xehuri.kinship.service
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.Manifest
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import timber.log.Timber
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.glance.appwidget.updateAll
import com.xehuri.kinship.MainActivity
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.p2p.P2pWebRtcManager
import com.xehuri.kinship.service.collectors.*
import com.xehuri.kinship.service.state.MicStatus
import com.xehuri.kinship.service.state.SensorStateHolder
import com.xehuri.kinship.service.uploader.PerceptionCache
import com.xehuri.kinship.transport.HttpTierProbe
import com.xehuri.kinship.transport.TierRuntime
import com.xehuri.kinship.transport.TierRuntimeHolder
import com.xehuri.kinship.transport.TierSelector
import com.xehuri.kinship.transport.TierStore
import com.xehuri.kinship.widget.AiNotifyWidget
import com.xehuri.kinship.widget.HealthSummaryWidget
import com.xehuri.kinship.widget.HeartRateMiniWidget
import com.xehuri.kinship.widget.NotificationHistoryBackfill
import com.xehuri.kinship.widget.NotificationStore
import com.xehuri.kinship.widget.ReminderBoardFingerprint
import com.xehuri.kinship.widget.ReminderStore
import com.xehuri.kinship.widget.ReminderWidget
import com.xehuri.kinship.widget.WidgetSnapshot
import com.xehuri.kinship.widget.WidgetSyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

class DataCollectorService : Service() {
    companion object {
        private const val TAG = "DataCollector"; private const val NID = 9003
        private const val PD = "data_collector"; private const val PS = "sensor_toggles"

        /** 常驻状态通知通道（低优先级，重要性创建后不可变，故与中断通知分通道） */
        private const val CH_ONGOING = "axeuh_datacollector"

        /** 录音中断通知通道（高优先级，可点击恢复） */
        private const val CH_AUDIO_ALERT = "axeuh_audio_alert"

        /** 录音中断通知的固定 ID（更新而非刷屏） */
        private const val NID_AUDIO_ALERT = 9005

        /** 录音中断通知的 PendingIntent 请求码（固定以便更新） */
        private const val REQ_AUDIO_ALERT = 9005

        /** 通知点击「恢复」时携带的 extra：请求重启音频采集链路 */
        const val EXTRA_RESTART_AUDIO = "restart_audio"

        /** AI 推送通知的 ID 基址（避开常驻 9003 / 中断 9005 等固定 ID，防止相撞） */
        private const val NID_PUSH_BASE = 9100

        /** 提醒子节拍周期（ms）：独立协程定频，与「上传与调度间隔」（loop_ms）解耦互不影响 */
        private const val REMINDER_BEAT_MS = 5_000L

        /** 健康调度模式的取值：定时时段 */
        const val HEALTH_MODE_SCHEDULE = "schedule"

        /** 健康调度模式的取值：固定间隔 */
        const val HEALTH_MODE_INTERVAL = "interval"

        /** 时钟回拨判定阈值：锚点比当前时间超前该值即视为时钟跳变（ms） */
        private const val CLOCK_ROLLBACK_GUARD_MS = 60_000L
        // WakeLock 超时与续期间隔：带超时获取，周期内释放后重新获取以续期（防 Doze 冻结且不永久持锁）
        private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L
        private const val WAKE_LOCK_RENEW_INTERVAL_MS = 5 * 60 * 1000L
        private var appContext: Context? = null

        /**
         * 采集服务是否真正在运行（主循环已启动、采集器已拉起）。
         *
         * 设置页「运行状态」卡片的唯一真源：只在 [onStartCommand] 首次把 [DataCollectorService.isRunning]
         * 置 true 时翻转，重复 start 命令不重发；[onDestroy] 归零。进程被杀时随进程一起消失（新进程默认 false）。
         */
        private val _running = MutableStateFlow(false)
        val running: StateFlow<Boolean> = _running.asStateFlow()

        private fun p(c: Context, n: String) = c.getSharedPreferences(n, Context.MODE_PRIVATE)
        private fun b(c: Context, n: String, k: String, d: Boolean = false) = p(c, n).getBoolean(k, d)
        private fun sb(c: Context, n: String, k: String, v: Boolean) { p(c, n).edit().putBoolean(k, v).apply() }
        private fun l(c: Context, n: String, k: String, d: Long = 0L) = p(c, n).getLong(k, d)
        private fun sl(c: Context, n: String, k: String, v: Long) { p(c, n).edit().putLong(k, v).apply() }
        private fun s(c: Context, n: String, k: String, d: String? = null) = p(c, n).getString(k, d)
        private fun ss(c: Context, n: String, k: String, v: String) { p(c, n).edit().putString(k, v).apply() }
        private fun f(c: Context, n: String, k: String, d: Float = 0f) = p(c, n).getFloat(k, d)
        private fun sf(c: Context, n: String, k: String, v: Float) { p(c, n).edit().putFloat(k, v).apply() }
        private fun i(c: Context, n: String, k: String, d: Int = 0) = p(c, n).getInt(k, d)
        private fun si(c: Context, n: String, k: String, v: Int) { p(c, n).edit().putInt(k, v).apply() }

        @JvmStatic var vadStatus: String = "idle"; @JvmStatic var currentDbLevel: Float = -80f
        @JvmStatic var lastResponseText: String = ""; @JvmStatic var lastResponseJson: String = ""
        @JvmStatic var lastSensorText: String = ""; @JvmStatic var lastAiResponse: String = ""
        @JvmStatic var lastUploadSuccess: Boolean = true; @JvmStatic var lastMediaText: String = ""
        @JvmStatic var debugStateJson: String = "{}"

        @JvmStatic fun isAudioEnabled(c: Context) = b(c, PD, "audio_enabled")
        @JvmStatic fun setAudioEnabled(c: Context, v: Boolean) { sb(c, PD, "audio_enabled", v) }
        @JvmStatic fun isForegroundEnabled(c: Context) = b(c, PS, "foreground_enabled")
        @JvmStatic fun setForegroundEnabled(c: Context, v: Boolean) { sb(c, PS, "foreground_enabled", v) }
        @JvmStatic fun isNotificationEnabled(c: Context) = b(c, PS, "notification_enabled")
        @JvmStatic fun setNotificationEnabled(c: Context, v: Boolean) { sb(c, PS, "notification_enabled", v) }
        @JvmStatic fun isHealthEnabled(c: Context) = b(c, PS, "health_enabled")
        @JvmStatic fun setHealthEnabled(c: Context, v: Boolean) { sb(c, PS, "health_enabled", v) }
        @JvmStatic fun isGpsEnabled(c: Context) = b(c, PS, "gps_enabled")
        @JvmStatic fun setGpsEnabled(c: Context, v: Boolean) { sb(c, PS, "gps_enabled", v) }
        @JvmStatic fun isInputContentEnabled(c: Context) = b(c, PS, "input_content_enabled")
        @JvmStatic fun setInputContentEnabled(c: Context, v: Boolean) { sb(c, PS, "input_content_enabled", v) }
        @JvmStatic fun isWifiEnabled(c: Context) = b(c, PS, "wifi_enabled")
        @JvmStatic fun setWifiEnabled(c: Context, v: Boolean) { sb(c, PS, "wifi_enabled", v) }
        @JvmStatic fun isBluetoothEnabled(c: Context) = b(c, PS, "bluetooth_enabled")
        @JvmStatic fun setBluetoothEnabled(c: Context, v: Boolean) { sb(c, PS, "bluetooth_enabled", v) }
        @JvmStatic fun isScreenStateEnabled(c: Context) = b(c, PS, "screen_state_enabled")
        @JvmStatic fun setScreenStateEnabled(c: Context, v: Boolean) { sb(c, PS, "screen_state_enabled", v) }
        @JvmStatic fun isBatteryEnabled(c: Context) = b(c, PS, "battery_enabled", true)
        @JvmStatic fun setBatteryEnabled(c: Context, v: Boolean) { sb(c, PS, "battery_enabled", v) }
        @JvmStatic fun isUploadEnabled(c: Context) = b(c, PD, "upload_enabled", true)
        @JvmStatic fun setUploadEnabled(c: Context, v: Boolean) { sb(c, PD, "upload_enabled", v) }
        @JvmStatic fun isCacheEnabled(c: Context) = b(c, PD, "cache_enabled", true)
        @JvmStatic fun setCacheEnabled(c: Context, v: Boolean) { sb(c, PD, "cache_enabled", v) }
        /** 桌面组件总开关（默认 true=失败开放：配置缺失照常写入与渲染，绝不误伤已钉选组件） */
        @JvmStatic fun isWidgetsEnabled(c: Context) = b(c, PD, "widgets_enabled", true)
        @JvmStatic fun setWidgetsEnabled(c: Context, v: Boolean) { sb(c, PD, "widgets_enabled", v) }
        @JvmStatic fun getLoopInterval(c: Context) = l(c, PD, "loop_ms", 30000L)
        @JvmStatic fun setLoopInterval(c: Context, v: Long) { sl(c, PD, "loop_ms", v) }
        @JvmStatic fun getNotifyInterval(c: Context) = l(c, PD, "notify_ms", 5000L)
        @JvmStatic fun setNotifyInterval(c: Context, v: Long) { sl(c, PD, "notify_ms", v) }
        @JvmStatic fun getLastSyncTs(c: Context) = l(c, PD, "last_sync_ts")
        @JvmStatic fun setLastSyncTs(c: Context, v: Long) { sl(c, PD, "last_sync_ts", v) }

        // ── 健康数据上传模式与调度 ──

        /** 健康上传模式："schedule"（定时时段）或 "interval"（固定间隔） */
        @JvmStatic fun getHealthUploadMode(c: Context) =
            s(c, PD, "health_upload_mode", HEALTH_MODE_INTERVAL) ?: HEALTH_MODE_INTERVAL
        @JvmStatic fun setHealthUploadMode(c: Context, v: String) { ss(c, PD, "health_upload_mode", v) }

        /** 定时时段列表：逗号分隔的 HH:mm，如 "08:00,13:00,22:00" */
        @JvmStatic fun getHealthScheduleTimes(c: Context) = s(c, PD, "health_schedule_times", "") ?: ""
        @JvmStatic fun setHealthScheduleTimes(c: Context, v: String) { ss(c, PD, "health_schedule_times", v) }

        /** 间隔模式下的健康采集周期（默认 60 分钟） */
        @JvmStatic fun getHealthIntervalMs(c: Context) = l(c, PD, "health_interval_ms", 3_600_000L)
        @JvmStatic fun setHealthIntervalMs(c: Context, v: Long) { sl(c, PD, "health_interval_ms", v) }

        /** 上次健康采集触发的墙钟毫秒（调度锚点，防重复/漏跑） */
        @JvmStatic fun getLastHealthRunTs(c: Context) = l(c, PD, "last_health_run_ts")
        @JvmStatic fun setLastHealthRunTs(c: Context, v: Long) { sl(c, PD, "last_health_run_ts", v) }

        // ── 通知上行 ──

        /** 通知上行开关（与采集开关 notification_enabled 分离） */
        @JvmStatic fun isNotifyUploadEnabled(c: Context) = b(c, PD, "notify_upload_enabled", false)
        @JvmStatic fun setNotifyUploadEnabled(c: Context, v: Boolean) { sb(c, PD, "notify_upload_enabled", v) }

        /** 通知上行敏感应用黑名单（逗号/换行分隔的包名，默认空） */
        @JvmStatic fun getNotifySensitiveApps(c: Context) = s(c, PD, "notify_sensitive_apps", "") ?: ""
        @JvmStatic fun setNotifySensitiveApps(c: Context, v: String) { ss(c, PD, "notify_sensitive_apps", v) }

        // ── 各采集器独立间隔 ──

        /** GPS 采集间隔（默认 5 分钟） */
        @JvmStatic fun getGpsIntervalMs(c: Context) = l(c, PD, "gps_interval_ms", 300_000L)
        @JvmStatic fun setGpsIntervalMs(c: Context, v: Long) { sl(c, PD, "gps_interval_ms", v) }

        // ── GPS 采集行为选项（由 GpsCollector.collectLocation 消费）──

        /** 精度优先级取值：高精度（GPS 缓存优先） */
        const val GPS_PRIORITY_HIGH = "high"

        /** 精度优先级取值：均衡（PASSIVE→GPS→NETWORK，既有顺序） */
        const val GPS_PRIORITY_BALANCED = "balanced"

        /** 精度优先级取值：低功耗（NETWORK 缓存优先） */
        const val GPS_PRIORITY_LOW_POWER = "low_power"

        /** GPS 精度优先级（默认 balanced，决定 provider 尝试顺序） */
        @JvmStatic fun getGpsAccuracyPriority(c: Context) =
            s(c, PD, "gps_accuracy_priority", GPS_PRIORITY_BALANCED) ?: GPS_PRIORITY_BALANCED
        @JvmStatic fun setGpsAccuracyPriority(c: Context, v: String) { ss(c, PD, "gps_accuracy_priority", v) }

        /** GPS 最小位移（米，默认 0=不过滤）：移动不足该距离时跳过本轮位置更新 */
        @JvmStatic fun getGpsMinDisplacementM(c: Context) = l(c, PD, "gps_min_displacement_m", 0L)
        @JvmStatic fun setGpsMinDisplacementM(c: Context, v: Long) { sl(c, PD, "gps_min_displacement_m", v) }

        /** GPS 最大可接受精度（米，默认 0=不过滤）：精度差于该值的定位被丢弃 */
        @JvmStatic fun getGpsMaxAccuracyM(c: Context) = l(c, PD, "gps_max_accuracy_m", 0L)
        @JvmStatic fun setGpsMaxAccuracyM(c: Context, v: Long) { sl(c, PD, "gps_max_accuracy_m", v) }

        /** GPS 主动定位等待超时（毫秒，默认 0=关闭，仅读缓存）：>0 时主动请求一次新鲜定位，超时回退缓存 */
        @JvmStatic fun getGpsFixTimeoutMs(c: Context) = l(c, PD, "gps_fix_timeout_ms", 0L)
        @JvmStatic fun setGpsFixTimeoutMs(c: Context, v: Long) { sl(c, PD, "gps_fix_timeout_ms", v) }

        /** GPS 逆地理编码开关（默认 false）：开启后把定位解析为可读地址，以独立的 gps_address 字段上报 */
        @JvmStatic fun isGpsReverseGeocode(c: Context) = b(c, PD, "gps_reverse_geocode", false)
        @JvmStatic fun setGpsReverseGeocode(c: Context, v: Boolean) { sb(c, PD, "gps_reverse_geocode", v) }

        /** 系统状态采集间隔（默认 1 秒） */
        @JvmStatic fun getSystemStateIntervalMs(c: Context) = l(c, PD, "system_state_interval_ms", 1_000L)
        @JvmStatic fun setSystemStateIntervalMs(c: Context, v: Long) { sl(c, PD, "system_state_interval_ms", v) }

        /** 音频分段单段硬上限（默认 60 秒；VAD 端点会提前切段，本值仅作上限兜底） */
        @JvmStatic fun getAudioSegmentMs(c: Context) = l(c, PD, "audio_segment_ms", 60_000L)
        @JvmStatic fun setAudioSegmentMs(c: Context, v: Long) { sl(c, PD, "audio_segment_ms", v) }

        /**
         * 音频批量上传间隔（默认 10 分钟）。
         *
         * 与分段时长（[getAudioSegmentMs]）解耦：分段决定切段长度，本值只决定「多久发一次」。
         * 停止/中断或待上传累计超过阈值时无视本值立即上传。
         */
        @JvmStatic fun getAudioUploadBatchMs(c: Context) = l(c, PD, "audio_upload_batch_ms", 600_000L)
        @JvmStatic fun setAudioUploadBatchMs(c: Context, v: Long) { sl(c, PD, "audio_upload_batch_ms", v) }

        /** 上传音频格式 prefs 键（"wav" 默认 | "flac"；每段采集现读，改完即时生效） */
        const val KEY_AUDIO_UPLOAD_FORMAT = "audio_upload_format"

        /**
         * 上传音频格式：`"wav"`（原始）或 `"flac"`（无损压缩，约省 46% 流量）。
         *
         * 采集循环**每段开始现读**（照 audio_segment_ms 模式），设置页改完下一段生效；
         * 非法值一律回退 `"wav"`。产出扩展名 / multipart filename·MIME / 后端落盘
         * 均由本值驱动（见 PcmCheckpointWriter / AudioCollector.sendCachedData）。
         */
        @JvmStatic fun getUploadFormat(c: Context) =
            s(c, PD, KEY_AUDIO_UPLOAD_FORMAT, "wav")?.takeIf { it == "flac" } ?: "wav"

        @JvmStatic fun setUploadFormat(c: Context, v: String) {
            ss(c, PD, KEY_AUDIO_UPLOAD_FORMAT, if (v == "flac") "flac" else "wav")
        }

        /**
         * 常驻音频流式上行开关（**已废弃，固定关闭**）。
         *
         * 2026-09-16：常驻推流（服务端 KWS 路径）已弃用，音频链路拆成两条互不干扰的路径：
         * 环境音频走「固定分段 + multipart 上传」，语音唤醒走「端侧 KWS 命中后按需推流」
         * （见 [isLocalKwsEnabled]）。故本开关恒为 false，设置页不再暴露。
         *
         * 如需回退到服务端 KWS 常驻流式，把这里改回读 prefs（默认 true）即可。
         */
        @JvmStatic fun isAudioStreamEnabled(c: Context) = false
        @JvmStatic fun setAudioStreamEnabled(c: Context, v: Boolean) { sb(c, PD, "audio_stream_enabled", v) }

        // ---------- 端侧唤醒（KWS，本地唤醒词识别）----------

        /** 端侧唤醒开关（默认关：开启后会在录音线程持续推理，额外消耗 CPU） */
        @JvmStatic fun isLocalKwsEnabled(c: Context) = b(c, PD, "local_kws_enabled", false)
        @JvmStatic fun setLocalKwsEnabled(c: Context, v: Boolean) { sb(c, PD, "local_kws_enabled", v) }

        /** KWS 唤醒词加权分（默认 1.8，与服务端 audio.wake_word.keywords_score 对齐） */
        @JvmStatic fun getKwsScore(c: Context) = f(c, PD, "kws_score", 1.8f)
        @JvmStatic fun setKwsScore(c: Context, v: Float) { sf(c, PD, "kws_score", v) }

        /** KWS 判定阈值（默认 0.25，与服务端 audio.wake_word.keywords_threshold 对齐） */
        @JvmStatic fun getKwsThreshold(c: Context) = f(c, PD, "kws_threshold", 0.25f)
        @JvmStatic fun setKwsThreshold(c: Context, v: Float) { sf(c, PD, "kws_threshold", v) }

        /** 自定义唤醒词（已编码 token 串，多行；空串表示沿用 assets 内置词表） */
        @JvmStatic fun getKwsKeywords(c: Context) = s(c, PD, "kws_keywords", "") ?: ""
        @JvmStatic fun setKwsKeywords(c: Context, v: String) { ss(c, PD, "kws_keywords", v) }

        /** 端侧唤醒推理间隔（毫秒，100/200/300）：越大越省电，唤醒延迟同量级增加 */
        @JvmStatic fun getKwsIntervalMs(c: Context) = i(c, PD, "kws_interval_ms", 100).coerceIn(100, 1000)
        @JvmStatic fun setKwsIntervalMs(c: Context, v: Int) { si(c, PD, "kws_interval_ms", v.coerceIn(100, 1000)) }

        /** 云端唤醒测试模式：audio_start 带 test=true，服务端不投递 AI、仅回推结果 */
        @JvmStatic fun isKwsCloudTestEnabled(c: Context) = b(c, PD, "kws_cloud_test_enabled", false)
        @JvmStatic fun setKwsCloudTestEnabled(c: Context, v: Boolean) { sb(c, PD, "kws_cloud_test_enabled", v) }

        /** 唤醒/录制结束提示音音量（0-100，默认 90），由 HintTonePlayer 消费 */
        @JvmStatic fun getHintToneVolume(c: Context) = l(c, PD, "hint_tone_volume", 90L).toInt()
        @JvmStatic fun setHintToneVolume(c: Context, v: Int) { sl(c, PD, "hint_tone_volume", v.coerceIn(0, 100).toLong()) }

        /** TTS 语音音量（0-100，默认 100）：App 设置页写入，WebView 内播放器与本地试听共同消费 */
        @JvmStatic fun getTtsVolume(c: Context) = l(c, PD, "tts_volume", 100L).toInt()
        @JvmStatic fun setTtsVolume(c: Context, v: Int) { sl(c, PD, "tts_volume", v.coerceIn(0, 100).toLong()) }
        private const val DEFAULT_DB_PATH = "/storage/emulated/0/Android/data/nodomain.freeyourgadget.gadgetbridge/files/Gadgetbridge"
        private const val KEY_DB_URI = "gadgetbridge_db_uri"
        @JvmStatic fun getDbPath(c: Context) = s(c, PS, "gadgetbridge_db_path") ?: DEFAULT_DB_PATH
        @JvmStatic fun setDbPath(c: Context, v: String) { ss(c, PS, "gadgetbridge_db_path", v) }
        @JvmStatic fun getDbFile(c: Context) = File(getDbPath(c))
        @JvmStatic fun getDbUri(c: Context): String? = s(c, PS, KEY_DB_URI)
        @JvmStatic fun setDbUri(c: Context, v: String?) { if (v != null) ss(c, PS, KEY_DB_URI, v) else p(c, PS).edit().remove(KEY_DB_URI).apply() }

        /**
         * 清空所有离线缓存目录（audio、health、perception）
         */
        @JvmStatic fun clearAllCaches(c: Context) {
            val dirs = listOf(
                File(c.cacheDir, "upload_cache"),
                File(c.cacheDir, "health_upload_cache"),
                File(c.cacheDir, "perception_cache")
            )
            for (dir in dirs) {
                try {
                    if (dir.exists()) {
                        dir.listFiles()?.forEach { it.delete() }
                        Timber.i("缓存目录已清空: ${dir.name}")
                    }
                } catch (e: Exception) {
                    Timber.w("清空缓存失败 ${dir.name}: ${e.message}")
                }
            }
        }

        @JvmStatic fun getDeviceName(c: Context): String {
            val name = p(c, "axeuh_prefs").getString("device_name", null)
            return name ?: android.os.Build.MODEL
        }
        @JvmStatic fun setDeviceName(c: Context, v: String) {
            p(c, "axeuh_prefs").edit().putString("device_name", v).apply()
        }

        private val _logBuffer = java.util.LinkedList<String>()
        @JvmStatic fun log(tag: String, msg: String) = synchronized(_logBuffer) {
            _logBuffer.addLast("${SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())} $tag: $msg")
            if (_logBuffer.size > 200) _logBuffer.removeFirst()
        }
        @JvmStatic fun getRecentLogs(n: Int = 100) = synchronized(_logBuffer) { _logBuffer.takeLast(n).toList() }

        /** 注入设备名到感知事件 payload（恒携带：自定义名优先，否则用系统原始设备名） */
        private fun injectDeviceName(payload: JSONObject) {
            payload.put("device_name", com.xehuri.kinship.config.ServerConfig.effectiveDeviceName)
        }

        /**
         * 入队一条待上传感知事件（各采集器 / 广播接收器的统一入口）。
         *
         * 只注入设备名并入队 —— 真正的 HTTP 由主循环 [flushPendingUploads] 统一发出，
         * 采集侧不再各自唤醒网络。
         */
        @JvmStatic
        fun enqueueEvent(type: String, payload: JSONObject) {
            injectDeviceName(payload)
            PendingUploadQueue.put(type, payload)
        }

        /**
         * 兼容旧调用名：语义等同于 [enqueueEvent]。
         *
         * 2026-09-16 起改为主循环统一上传，本方法**不再**直接发 HTTP。
         */
        @JvmStatic
        fun pushEvent(type: String, payload: JSONObject) = enqueueEvent(type, payload)

        @JvmStatic fun triggerCycle(c: Context) { try { c.startService(Intent(c, DataCollectorService::class.java).putExtra("trigger_cycle", true)) } catch (e: Exception) { Timber.w("triggerCycle: ${e.message}") } }
        @JvmStatic fun triggerSync(c: Context) { try { c.startService(Intent(c, DataCollectorService::class.java).putExtra("force_sync", true)) } catch (e: Exception) { Timber.w("triggerSync: ${e.message}") } }
        @JvmStatic fun getDebugState(): String = debugStateJson

        /**
         * 解析定时时段字符串为「当日分钟数」列表（HH:mm → hour*60+minute）。
         * 支持逗号/换行/分号分隔；非法项直接忽略，结果去重并升序。
         */
        @JvmStatic
        internal fun parseScheduleTimes(raw: String): List<Int> {
            if (raw.isBlank()) return emptyList()
            return raw.split(',', '\n', ';')
                .mapNotNull { token ->
                    val parts = token.trim().split(':')
                    if (parts.size != 2) return@mapNotNull null
                    val h = parts[0].trim().toIntOrNull()
                    val m = parts[1].trim().toIntOrNull()
                    if (h == null || m == null || h !in 0..23 || m !in 0..59) null else h * 60 + m
                }
                .distinct()
                .sorted()
        }

        /**
         * 判断「当日 minuteOfDay 时刻」是否落在 (last, now] 窗口内。
         *
         * 用默认时区计算今天的该时刻；若晚于 now（今天尚未到）则回退一天再比较，
         * 从而兼容跨午夜与 DST 跳变。last<=0 视为首次运行，直接返回 true，
         * 交由调用方在触发后重新锚定，避免长期不采集。
         */
        @JvmStatic
        internal fun scheduleTimeCrossed(last: Long, now: Long, minuteOfDay: Int): Boolean {
            if (last <= 0L) return true
            val cal = Calendar.getInstance()
            cal.timeInMillis = now
            cal.set(Calendar.HOUR_OF_DAY, minuteOfDay / 60)
            cal.set(Calendar.MINUTE, minuteOfDay % 60)
            cal.set(Calendar.SECOND, 0)
            cal.set(Calendar.MILLISECOND, 0)
            var target = cal.timeInMillis
            if (target > now) target -= 24L * 60 * 60 * 1000
            return target in (last + 1)..now
        }
    }

    private var isRunning = false
    private val handler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var sh: SensorStateHolder
    private lateinit var hc: AppHttpClient
    private lateinit var cm: CollectorManager
    private var tierRuntime: TierRuntime? = null
    private var p2pWebRtcManager: P2pWebRtcManager? = null
    /** 通知下行流式客户端（随服务起停，替代旧轮询） */
    private var notificationStream: com.xehuri.kinship.network.NotificationStreamClient? = null
    private var wakeLockRenewRunnable: Runnable? = null

    /** 观察 micStatus 用的服务级协程作用域（onDestroy 取消） */
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** 提醒子节拍专用 IO 作用域（onCreate 启动、onDestroy 取消；与主线程观察作用域分离） */
    private val reminderBeatScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 提醒子节拍协程句柄（startReminderBeat 幂等启停判据） */
    private var reminderBeatJob: Job? = null

    /** 提醒同步单飞锁：HTTP 慢时下一拍 tryLock 失败即跳过，绝不堆叠并发同步 */
    private val reminderSyncMutex = Mutex()

    /**
     * 上次已渲染的整板指纹（仅内存态、随服务进程存活）。
     * 失败同步绝不清空——网络抖动恢复后若板面未变即不重复重绘；
     * 进程重启后为 null，首拍必刷一次（与旧主循环首轮无条件刷新的语义对齐）。
     */
    @Volatile
    private var lastReminderFingerprint: String? = null

    /** startForeground 是否已成功（成功后才允许用 notify 原地更新常驻通知） */
    @Volatile
    private var foregroundStarted = false

    override fun onBind(intent: Intent?) = null

    override fun onCreate() {
        super.onCreate(); appContext = this; createNotificationChannel()
        // PARTIAL_WAKE_LOCK: 防止 Doze 模式冻结 CPU，保护录音线程（带超时 + 周期续期）
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Axeuh:AudioWakeLock")
        acquireWakeLock()
        startWakeLockRenewal()
        com.xehuri.kinship.config.ServerConfig.init(this)
        sh = SensorStateHolder.shared; hc = AppHttpClient(this); cm = CollectorManager(this, sh, hc)
        // 启动时恢复上次进程被杀遗留的音频 checkpoint 分片，并触发一次补传
        cm.recoverAudioCheckpoints()
        // 恢复上次未发出的待上传感知事件（落盘快照，仅「离线缓存」开启时存在）
        PendingUploadQueue.restoreFromDisk(this)
        // 通知历史增量尾部回填（60s 时间闸封顶风暴；push (id,ts) 去重幂等；失败静默，best-effort。
        // 冷启动拉一次，之后由通知流每次 connected 回执再拉——WS 半开/后端重启期间错过的通知靠重连回补）
        serviceScope.launch { NotificationHistoryBackfill.pullTail(applicationContext) }
        // 提醒卡 15 分钟周期兜底通道随服务启动常驻注册（unique + KEEP 幂等；
        // 语义与演示波不同：不再是用户在演示页手动开关，生产通道开机即在）
        WidgetSyncWorker.schedule(applicationContext)
        // AI 提醒卡同步子节拍：5 秒定频独立协程（替代旧主循环每轮同步），重绘前按指纹判重
        startReminderBeat()
        // 观察麦克风有效性状态，驱动单条常驻通知的动态文案
        serviceScope.launch {
            sh.micStatus.collect { status -> updateOngoingNotification(status) }
        }
        val f = IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) registerReceiver(screenReceiver, f, RECEIVER_NOT_EXPORTED)
        else registerReceiver(screenReceiver, f)
        // 深浅色翻转运行时接收器：ACTION_CONFIGURATION_CHANGED 是 REGISTERED_ONLY（manifest 注册收不到），
        // 必须先按当前 uiMode 初始化差分缓存再注册（首帧不重发），注册模式逐字沿上方 screenReceiver 先例
        lastNightMode = currentNightMode()
        val cf = IntentFilter(Intent.ACTION_CONFIGURATION_CHANGED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) registerReceiver(uiModeReceiver, cf, RECEIVER_NOT_EXPORTED)
        else registerReceiver(uiModeReceiver, cf)
        startNotificationStream()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 启动前台服务；失败时释放 WakeLock 并安全停止，避免异常驻留
        if (!tryStartForeground()) {
            Timber.e("startForeground 失败，停止 DataCollectorService")
            stopSelf()
            return START_NOT_STICKY
        }
        when {
            intent?.getBooleanExtra("force_sync", false) == true -> { Timber.i("Force sync"); cm.forceSync(); return START_STICKY }
            intent?.getBooleanExtra("trigger_cycle", false) == true -> { Timber.i("Trigger cycle"); handler.post { updateSnapshot() }; return START_STICKY }
            intent?.getBooleanExtra("force_restart", false) == true -> {
                Timber.i("Force restart audio")
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                nm?.cancel(1001)
                // 用户已通过通知点击恢复：清除高优先级中断通知
                nm?.cancel(NID_AUDIO_ALERT)
                handler.post { cm.restartAudio() }; return START_STICKY
            }
        }
        if (!isRunning) {
            isRunning = true
            _running.value = true
            cm.startAll()
            startMainLoop()
            startTransportSelection()
        }
        return START_STICKY
    }

    /**
     * 采集启动时引导 tier 运行时（迁移旧配置 -> 首轮选择），之后每 5 分钟刷新一次。
     *
     * 全程在 IO 线程执行；探测失败时保留上一次可用地址，不打断采集。
     */
    private fun startTransportSelection() {
        serviceScope.launch(Dispatchers.IO) {
            val store = TierStore.shared(this@DataCollectorService)
            val probe = HttpTierProbe()
            val selector = TierSelector({ store.state.value }, probe)
            val runtime = TierRuntime(store, selector, serviceScope)
            TierRuntimeHolder.install(runtime)
            tierRuntime = runtime
            runtime.bootstrap()
            startP2pWebRtc()
            while (isActive) {
                delay(5 * 60 * 1000L)
                runtime.refresh(force = false)
            }
        }
    }

    private suspend fun startP2pWebRtc() {
        if (p2pWebRtcManager != null) return
        val manager = P2pWebRtcManager(applicationContext, hc)
        p2pWebRtcManager = manager
        manager.start()
    }

    /**
     * 启动前台服务。按录音权限选择 FGS 类型：
     * - 已授予 RECORD_AUDIO → microphone（后台录音必需，且该类型无时长上限）
     * - 未授予 → specialUse（microphone 未授权会抛 SecurityException，ColorOS 尤甚）
     *
     * 刻意不再声明 dataSync：Android 15(targetSdk 35+) 起 dataSync 前台服务受 6h/24h 配额
     * 限制，配额耗尽后系统停止服务并以 RemoteServiceException 崩溃进程 —— 即「累计 6 小时
     * 后台录音中断」的根因。microphone / specialUse 均无此类配额。
     * 失败时释放 WakeLock 并返回 false。
     */
    private fun tryStartForeground(): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val micGranted = ContextCompat.checkSelfPermission(
                    this, Manifest.permission.RECORD_AUDIO
                ) == PackageManager.PERMISSION_GRANTED
                val fgsType = if (micGranted) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                } else {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                }
                startForeground(NID, createNotification(currentOngoingText()), fgsType)
            } else {
                startForeground(NID, createNotification(currentOngoingText()))
            }
            foregroundStarted = true
            true
        } catch (e: Exception) {
            Timber.e("startForeground 异常: ${e.message}")
            // 前台服务启动失败 → 确保释放 WakeLock，避免持锁泄漏
            releaseWakeLock()
            false
        }
    }

    /**
     * 前台服务类型超时回调（API 35+）。
     *
     * 正常不会触发（microphone / specialUse 均无时长限制），此处仅作防御：若未在宽限期
     * 内停止服务，系统会以 RemoteServiceException 崩溃整个进程。
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Timber.w("前台服务超时（fgsType=$fgsType, startId=$startId），主动停止以免进程崩溃")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** 获取带超时的 WakeLock（未持有时才获取） */
    private fun acquireWakeLock() {
        val wl = wakeLock ?: return
        try {
            if (!wl.isHeld) wl.acquire(WAKE_LOCK_TIMEOUT_MS)
        } catch (e: Exception) {
            Timber.w("WakeLock acquire 失败: ${e.message}")
        }
    }

    /**
     * 续期 WakeLock：带超时的锁在到期后自动释放，
     * 续期时需先释放再重新获取（持有时重复 acquire 不会重置超时）。
     */
    private fun renewWakeLock() {
        val wl = wakeLock ?: return
        try {
            if (wl.isHeld) wl.release()
            wl.acquire(WAKE_LOCK_TIMEOUT_MS)
        } catch (e: Exception) {
            Timber.w("WakeLock 续期失败: ${e.message}")
        }
    }

    /** 周期续期 WakeLock，直至 onDestroy 移除 */
    private fun startWakeLockRenewal() {
        if (wakeLockRenewRunnable != null) return
        val r = object : Runnable {
            override fun run() {
                renewWakeLock()
                handler.postDelayed(this, WAKE_LOCK_RENEW_INTERVAL_MS)
            }
        }
        wakeLockRenewRunnable = r
        handler.postDelayed(r, WAKE_LOCK_RENEW_INTERVAL_MS)
    }

    /** 释放 WakeLock 并停止续期 */
    private fun releaseWakeLock() {
        wakeLockRenewRunnable?.let { handler.removeCallbacks(it) }
        wakeLockRenewRunnable = null
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        isRunning = false
        _running.value = false
        cm.stopAll()
        foregroundStarted = false
        tierRuntime?.close()
        tierRuntime = null
        p2pWebRtcManager?.stop()
        p2pWebRtcManager = null
        serviceScope.cancel()
        reminderBeatScope.cancel()
        try { notificationStream?.close() } catch (_: Exception) {}
        notificationStream = null
        handler.removeCallbacksAndMessages(null)
        releaseWakeLock(); wakeLock = null
        try { unregisterReceiver(screenReceiver) } catch (_: Exception) {}
        runCatching { unregisterReceiver(uiModeReceiver) }
        try { (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(1001) } catch (_: Exception) {}
        if (isAudioEnabled(this)) showServiceStoppedNotification(); super.onDestroy()
    }

    /**
     * 用户从最近任务列表划掉 App 时回调。
     *
     * 此时进程可能随时被杀，先结束音频采集：[AudioCollector.stop] 内部会 finalize
     * 进行中的分段到 `upload_cache` 并触发补传，确保已录内容不丢失。服务若未被杀，
     * 权限复核会在下一轮主循环按开关自动恢复音频采集。
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Timber.i("任务被移除，停止音频采集并落盘当前分段")
        try {
            cm.flushAudioOnTaskRemoved()
        } catch (e: Exception) {
            Timber.w("任务移除落盘异常: ${e.message}")
        }
        super.onTaskRemoved(rootIntent)
    }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            pushEvent("screen", JSONObject().apply { put("locked", intent.action == Intent.ACTION_SCREEN_OFF) })
        }
    }

    /**
     * uiMode 夜键最近值（深浅色差分闸缓存）；onCreate 注册接收器前先以当前值初始化，
     * 保证服务冷启动首帧不因"未初始化 vs 当前值"差异重发一遍卡片。
     */
    private var lastNightMode: Boolean? = null

    /**
     * 深浅色翻转运行时接收器（主通道）：系统翻深浅色广播 ACTION_CONFIGURATION_CHANGED，
     * 该广播 REGISTERED_ONLY，只有进程内存活注册才收得到（daynight-colors 报告 §2.3/§5.2）。
     * 接收器线程绝不 suspend/阻塞——刷卡动作全部投递 serviceScope。
     */
    private val uiModeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            applyNightModeIfChanged()
        }
    }

    /** 本进程配置的夜间键（App 进程 uiMode = 系统全局深浅色，与宿主桌面外观无关） */
    private fun currentNightMode(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /**
     * 夜键差分闸：仅当夜间键真正翻转才对已启用卡片重发（同一函数被广播与
     * onConfigurationChanged 两通道复用，差分兼作去重/防抖——字号、语言等其他配置
     * 变化同样进这里，必须挡掉）。
     * API26-30 上 Glance 把 ColorProvider(day,night) 在翻译期塌缩成单色，不显式
     * updateAll 旧配色就定格；API31+ 成对序列化依赖宿主 reapply，对不重放的宿主
     * （部分三方桌面/HyperOS）此处同样兜底。
     * 卡级无独立开关：updateAll 对未钉选实例天然空操作，只剩 widgets_enabled 总闸。
     */
    private fun applyNightModeIfChanged() {
        val night = currentNightMode()
        if (lastNightMode == night) return
        lastNightMode = night
        Timber.i("深浅色翻转：night=$night，重发已启用卡片")
        serviceScope.launch {
            withContext(Dispatchers.IO) {
                val ctx = applicationContext
                if (!isWidgetsEnabled(ctx)) return@withContext
                runCatching { AiNotifyWidget().updateAll(ctx) }
                    .onFailure { Timber.w("翻转刷卡 AiNotifyWidget 失败: ${it.message}") }
                runCatching { ReminderWidget().updateAll(ctx) }
                    .onFailure { Timber.w("翻转刷卡 ReminderWidget 失败: ${it.message}") }
                runCatching { HealthSummaryWidget().updateAll(ctx) }
                    .onFailure { Timber.w("翻转刷卡 HealthSummaryWidget 失败: ${it.message}") }
                runCatching { HeartRateMiniWidget().updateAll(ctx) }
                    .onFailure { Timber.w("翻转刷卡 HeartRateMiniWidget 失败: ${it.message}") }
            }
        }
    }

    /**
     * 并列兜底通道（belt）：个别 OEM 对 Service 的运行时广播分发不可靠，
     * ComponentCallbacks 回调走同一差分闸（lastNightMode 去重，取先到者）。
     * Service 无需 manifest configChanges 声明即收此回调；接收器仍是主通道。
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyNightModeIfChanged()
    }

    /**
     * 心跳采集：主循环每个上传周期（loop_ms）入队一条 type="heartbeat" 的「存活 + 当前状态」断言。
     *
     * 感知事件流是"状态变化才写"的设计：某时段无行时无法区分"状态真没变"与"采集器死了/没电/断网"。
     * 心跳提供周期性的存活证明，payload 各字段独立可选——来源开关关闭或读取失败时整字段省略，
     * 绝不猜测填充：
     * - locked: PowerManager.isInteractive（恒有，不受 screen_state_enabled 门控）
     * - phone_battery: 电量百分比（受 battery_enabled 门控，与 sensor 事件同源读法）
     * - app: 最后已知前台应用显示名（受 foreground_enabled 门控，取采集器去重缓存，不重复查询）
     *
     * 设备名由 enqueueEvent 统一注入；事件量约 2880 条/天（30s 周期），对 jsonl 体量影响可忽略。
     */
    private fun collectHeartbeat() {
        try {
            val hb = JSONObject()
            try {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                hb.put("locked", !pm.isInteractive)
            } catch (_: Exception) {}
            if (isBatteryEnabled(this)) {
                try {
                    val bi = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                    if (bi != null) hb.put("phone_battery", bi.getIntExtra("level", 0) * 100 / bi.getIntExtra("scale", 100))
                } catch (_: Exception) {}
            }
            try {
                if (isForegroundEnabled(this)) {
                    cm.foregroundAppState()?.let { hb.put("app", it) }
                }
            } catch (_: Exception) {}
            enqueueEvent("heartbeat", hb)
        } catch (e: Exception) {
            Timber.w("心跳采集异常: ${e.message}")
        }
    }

    /**
     * 统一上传：发送本轮各采集器投递的待发感知事件（主循环每轮调用一次）。
     *
     * 除健康数据（`HealthBatchUploader` → `/api/health/sync`）与环境音频（`AudioUploader`
     * / WS 推流）外，所有感知事件都走这里：先按序重放离线缓存，再逐条发送本轮积压；
     * 单条失败落盘（`PerceptionCache`）留待下轮重试，不影响其余条目。网络操作在独立线程
     * 执行，不阻塞主循环。
     */
    private fun flushPendingUploads() {
        val items = PendingUploadQueue.drain()
        if (items.isEmpty()) return
        // 发送前落盘快照（仅「离线缓存」开启时）：发送过程中被杀也不丢，下次启动恢复
        PendingUploadQueue.persistSnapshot(this, items)
        Thread({
            val ctx = appContext
            if (ctx == null) {
                Timber.w("flushPendingUploads: appContext 为空，${items.size} 条事件留待下次启动恢复")
                return@Thread
            }
            var ok = 0
            try {
                val baseUrl = com.xehuri.kinship.config.ServerConfig.BASE_URL
                val token = s(ctx, "axeuh_prefs", "auth_token") ?: ""
                val httpClient = AppHttpClient(ctx)
                // 先按序重放离线缓存（此前失败的条目）
                try {
                    PerceptionCache.flushSync(ctx, httpClient.getClient(), baseUrl, token)
                } catch (_: Exception) {
                }

                val url = "$baseUrl/api/screen/stt/perception-event"
                for (item in items) {
                    try {
                        val requestBody = JSONObject().apply {
                            put("type", item.type)
                            put("payload", item.payload)
                            put("ts", item.ts)
                        }.toString().toRequestBody("application/json".toMediaType())
                        val builder = okhttp3.Request.Builder().url(url).post(requestBody)
                        if (token.isNotEmpty()) {
                            builder.header("Authorization", "Bearer $token")
                        }
                        val response = httpClient.getClient().newCall(builder.build()).execute()
                        response.close()
                        ok++
                    } catch (e: Exception) {
                        Timber.w("flushPendingUploads: ${item.type} 发送失败，转离线缓存: ${e.message}")
                        PerceptionCache.save(ctx, item.type, item.payload)
                    }
                }
                Timber.i("flushPendingUploads: ${items.size} 条已处理（成功 $ok）")
            } catch (e: Exception) {
                Timber.w("flushPendingUploads 异常: ${e.message}")
                // 整体异常（例如建 client 失败）：全部落盘，避免丢数据
                for (item in items) PerceptionCache.save(ctx, item.type, item.payload)
            } finally {
                // 本轮已全部处理（发出 或 转入 PerceptionCache）→ 清掉快照
                PendingUploadQueue.clearPersisted(ctx)
            }
        }, "DcFlushUpload").start()
    }

    private fun startMainLoop() {
        handler.post(object : Runnable {
            override fun run() {
                if (!isRunning) return
                try {
                    try { sendBroadcast(Intent("nodomain.freeyourgadget.gadgetbridge.command.ACTIVITY_SYNC")) } catch (_: Exception) {}
                    try { sendBroadcast(Intent("nodomain.freeyourgadget.gadgetbridge.command.TRIGGER_EXPORT")) } catch (_: Exception) {}
                    val s = JSONObject()
                    if (isGpsEnabled(this@DataCollectorService)) {
                        val gpsStr = sh.snapshotLastGps().takeIf { it.isNotEmpty() }
                        if (gpsStr != null) {
                            val parts = gpsStr.split(",")
                            if (parts.size >= 2) {
                                s.put("gps", "${parts[0]},${parts[1]}")
                                if (parts.size >= 3) {
                                    val acc = parts[2].toFloatOrNull()
                                    if (acc != null) s.put("gps_accuracy", acc)
                                }
                                // 逆地理编码地址：独立字段，缺失时不上报，旧解析器只读 "gps" 不受影响
                                val addr = sh.snapshotLastGpsAddress()
                                if (addr.isNotEmpty()) s.put("gps_address", addr)
                            }
                        }
                    }
                    if (isBatteryEnabled(this@DataCollectorService)) {
                        try { val bi = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                            if (bi != null) s.put("phone_battery", bi.getIntExtra("level", 0) * 100 / bi.getIntExtra("scale", 100)) } catch (_: Exception) {}
                    }
                    if (s.length() > 0) pushEvent("sensor", s)
                    updateSnapshot()
                    // —— AI 提醒卡同步已移出主循环 ——
                    // 改由独立 5 秒提醒子节拍承载（startReminderBeat，Mutex 单飞 + 指纹判重后才重绘）；
                    // 进程被杀仍由 WidgetSyncWorker 15 分钟周期兜底。主循环不再调用 syncFromServer。
                    // 运行时开关即时生效：逐轮比对 isEnabled/isRunning 后启停采集器
                    cm.applyToggle()
                    // 健康数据定时时段调度（服务内常驻判断，不引入精确闹钟）
                    checkHealthSchedule()
                    // 周期复核运行时权限，撤销后停用对应采集器（AN-M6）
                    cm.enforcePermissions()
                    // 心跳：每个上传周期断言一次「存活 + 当前状态」，与感知事件一并发出
                    collectHeartbeat()
                    // 统一上传：把本轮各采集器投递的感知事件一并发出（健康数据与环境音频除外）
                    flushPendingUploads()
                } catch (e: Exception) { Timber.w("Loop: ${e.message}") }
                handler.postDelayed(this, getLoopInterval(this@DataCollectorService))
            }
        })
    }

    /**
     * AI 提醒卡同步子节拍：独立 IO 作用域协程，固定 5 秒定频（首拍立即执行，保证服务拉起即刷新）。
     *
     * 与主循环解耦后 loop_ms（默认 30s，「上传与调度间隔」）只管其余循环职责，
     * 提醒数据新鲜度不再受其支配。幂等：已存活则不重复启动。onDestroy 经
     * [reminderBeatScope] 整体取消。
     *
     * 两道防重绘闸（Glance updateAll 每次跑异步会话、秒级抖动，见 AiNotifyWidget 首帧守卫注释）：
     * 1) 单飞——[reminderSyncMutex] tryLock 失败即跳过本拍，慢 HTTP 绝不堆叠并发同步；
     * 2) 判重——同步成功读本地整板算指纹，与上次已渲染不同才 updateAll；**指纹仅在
     *    updateAll 成功返回后落账**——同步失败或瞬时重绘失败都不落指纹，下一拍同指纹
     *    自然重试，绝不把一次绘制异常固化成永久旧板（WidgetSyncWorker 15 分钟兜底不变）。
     * widgets_enabled 双门控：停用态不联网同步，重绘前再核一次（同步期间被关则本拍不刷、
     * 指纹不落，重新开启后首拍必刷）。
     */
    private fun startReminderBeat() {
        if (reminderBeatJob?.isActive == true) return
        reminderBeatJob = reminderBeatScope.launch {
            while (isActive) {
                runReminderBeatOnce()
                delay(REMINDER_BEAT_MS)
            }
        }
    }

    /** 单拍执行体：任何异常自吞记日志，绝不终止子节拍协程。 */
    private suspend fun runReminderBeatOnce() {
        val ctx = applicationContext
        if (!isWidgetsEnabled(ctx)) return
        if (!reminderSyncMutex.tryLock()) return
        try {
            runCatching {
                if (ReminderStore.syncFromServer(ctx)) {
                    val board = ReminderStore.readBoard(ctx)
                    val fingerprint = ReminderBoardFingerprint.of(board.first, board.second)
                    if (fingerprint != lastReminderFingerprint && isWidgetsEnabled(ctx)) {
                        // 先重绘、成功返回后才落指纹：updateAll 抛异常时 runCatching 截住、
                        // 赋值被跳过，下一拍同指纹自然重试——瞬时失败不落账，防固化成永久旧板
                        ReminderWidget().updateAll(ctx)
                        lastReminderFingerprint = fingerprint
                    }
                }
            }.onFailure { Timber.w("提醒同步失败: ${it.message}") }
        } finally {
            reminderSyncMutex.unlock()
        }
    }

    /**
     * 健康数据「定时时段」调度（每轮主循环调用一次）。
     *
     * 仅处理 mode="schedule"：解析 health_schedule_times，判断是否有目标时刻
     * 落在 (last_health_run_ts, now] 窗口内；命中则触发一次采集并重新锚定。
     * mode="interval" 由 [HealthDataCollector] 自身循环按 health_interval_ms 触发。
     *
     * 时钟回拨/DST 兜底：若锚点比当前时间超前（时钟被回拨），重置锚点并立即
     * 执行一次，避免长期不再采集。
     */
    private fun checkHealthSchedule() {
        try {
            if (!isHealthEnabled(this)) return
            if (getHealthUploadMode(this) != HEALTH_MODE_SCHEDULE) return
            val now = System.currentTimeMillis()
            val last = getLastHealthRunTs(this)

            // 时钟回拨保护：锚点落在未来，重新锚定并执行一次
            if (last > now + CLOCK_ROLLBACK_GUARD_MS) {
                Timber.w("检测到时钟回拨，重置健康调度锚点")
                triggerHealthCollect(now)
                return
            }

            val times = parseScheduleTimes(getHealthScheduleTimes(this))
            if (times.isEmpty()) return
            if (times.any { scheduleTimeCrossed(last, now, it) }) {
                triggerHealthCollect(now)
            }
        } catch (e: Exception) {
            Timber.w("健康调度检查异常: ${e.message}")
        }
    }

    /** 触发一次健康采集并重新锚定调度时间戳（采集器内部互斥防重叠）。 */
    private fun triggerHealthCollect(now: Long) {
        setLastHealthRunTs(this, now)
        try {
            cm.collectHealthNow()
        } catch (e: Exception) {
            Timber.w("触发健康采集失败: ${e.message}")
        }
    }

    inner class CollectorManager(
        private val ctx: Context, private val sh: SensorStateHolder, private val hc: AppHttpClient
    ) {
        private val sc = SystemStateCollector(ctx, sh, hc)
        private val nc = NotificationCollector.create(ctx, sh, hc)
        private val gc = GpsCollector(ctx, sh, hc)
        private val hdc = HealthDataCollector(ctx, sh, hc)
        // 录音中断（无法(重)启动/被系统打断）时，由服务弹出高优先级可点击通知
        private val ac = AudioCollector(ctx, sh, hc).apply {
            onRecordingInterrupted = { handler.post { showAudioInterruptedNotification() } }
        }
        fun startAll() {
            if (sc.isEnabled) sc.start()
            if (nc.isEnabled) nc.start()
            if (gc.isEnabled) gc.start()
            if (hdc.isEnabled) hdc.start()
            if (isAudioEnabled(ctx)) ac.start()
            Timber.i("${listOf(sc.isEnabled, nc.isEnabled, gc.isEnabled, hdc.isEnabled, ac.isEnabled).count { it }} 个采集器已启动")
        }
        fun stopAll() { sc.stop(); nc.stop(); gc.stop(); hdc.stop(); ac.stop(); Timber.i("Collectors stopped") }
        fun restartAudio() { ac.stop(); if (isAudioEnabled(ctx)) ac.start() }
        fun forceSync() { Timber.i("Force sync"); updateSnapshot() }

        /** 启动时恢复上次进程被杀遗留的音频 checkpoint 分片（后台线程，幂等）。 */
        fun recoverAudioCheckpoints() { ac.recoverCheckpointsAndUpload() }

        /**
         * 用户从最近任务列表划掉 App 时结束音频采集。
         *
         * [AudioCollector.stop] 内部会 finalize 进行中的分段到 `upload_cache` 并触发补传，
         * 避免进程被杀导致录音丢失。
         */
        fun flushAudioOnTaskRemoved() { if (ac.isRunning) ac.stop() }

        /**
         * 运行时开关即时生效：逐轮比对各采集器的 isEnabled 与 isRunning，
         * 按需 start/stop，无需重启服务。
         *
         * 音频的「启动」额外受 RECORD_AUDIO 权限约束，统一交由 [enforcePermissions]，
         * 此处只负责在开关关闭时将其停掉，避免与权限复核互相打架。
         */
        fun applyToggle() {
            try {
                syncCollector(sc.isEnabled, sc.isRunning, sc::start, sc::stop)
                syncCollector(nc.isEnabled, nc.isRunning, nc::start, nc::stop)
                syncCollector(gc.isEnabled, gc.isRunning, gc::start, gc::stop)
                syncCollector(hdc.isEnabled, hdc.isRunning, hdc::start, hdc::stop)
                if (!isAudioEnabled(ctx) && ac.isRunning) ac.stop()
            } catch (e: Exception) {
                Timber.w("applyToggle 异常: ${e.message}")
            }
        }

        /** 单个采集器的开关同步：开启且未运行→启动；关闭且运行中→停止。 */
        private fun syncCollector(enabled: Boolean, running: Boolean, start: () -> Unit, stop: () -> Unit) {
            if (enabled && !running) start() else if (!enabled && running) stop()
        }

        /** 心跳复用的「最后已知前台应用」（SystemStateCollector 去重缓存 lastSentApp）；未采集过为 null */
        fun foregroundAppState(): String? = sc.currentForegroundAppState
        /** 由服务调度器触发一次健康采集（异步，挂在采集器自己的 IO 作用域）。 */
        fun collectHealthNow() {
            if (!hdc.isRunning) hdc.start()
            hdc.requestCollect()
        }

        /**
         * 周期复核运行时权限：权限被撤销则停用对应采集器；恢复后按开关重新启动。
         * 仅覆盖受运行时权限约束的采集器（音频/GPS/健康），其余采集器各自在采集时判断。
         */
        fun enforcePermissions() {
            try {
                val audioAllowed = ContextCompat.checkSelfPermission(
                    ctx, Manifest.permission.RECORD_AUDIO
                ) == PackageManager.PERMISSION_GRANTED
                if (isAudioEnabled(ctx)) {
                    if (audioAllowed) {
                        if (!ac.isRunning) ac.start()
                    } else if (ac.isRunning) {
                        ac.stop(); Timber.w("RECORD_AUDIO 权限被撤销，已停用音频采集")
                    }
                }

                val gpsAllowed = ContextCompat.checkSelfPermission(
                    ctx, Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                if (isGpsEnabled(ctx)) {
                    if (gpsAllowed) {
                        if (!gc.isRunning) gc.start()
                    } else if (gc.isRunning) {
                        gc.stop(); Timber.w("定位权限被撤销，已停用 GPS 采集")
                    }
                }

                // 健康采集可用 SAF content URI 兜底，二者其一可用即可
                val healthAllowed = hasStoragePermission() || getDbUri(ctx) != null
                if (isHealthEnabled(ctx)) {
                    if (healthAllowed) {
                        if (!hdc.isRunning) hdc.start()
                    } else if (hdc.isRunning) {
                        hdc.stop(); Timber.w("存储权限被撤销，已停用健康数据采集")
                    }
                }
            } catch (e: Exception) {
                Timber.w("权限复核异常: ${e.message}")
            }
        }

        /** API 30+ 用 MANAGE_EXTERNAL_STORAGE，旧版用 READ_EXTERNAL_STORAGE */
        private fun hasStoragePermission(): Boolean {
            return if (Build.VERSION.SDK_INT >= 30) {
                try { android.os.Environment.isExternalStorageManager() } catch (_: Exception) { false }
            } else {
                ContextCompat.checkSelfPermission(
                    ctx, Manifest.permission.READ_EXTERNAL_STORAGE
                ) == PackageManager.PERMISSION_GRANTED
            }
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_ONGOING, "Kinship 数据采集", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false); description = "传感器+语音采集常驻状态" })
        nm.createNotificationChannel(NotificationChannel("axeuh_notification", "Kinship 系统通知", NotificationManager.IMPORTANCE_HIGH).apply { setShowBadge(true); description = "AI 推送通知" })
        // 录音中断通知：高优先级独立通道（通道重要性创建后不可变，故与常驻通知分通道）
        nm.createNotificationChannel(NotificationChannel(CH_AUDIO_ALERT, "Kinship 录音中断", NotificationManager.IMPORTANCE_HIGH).apply { setShowBadge(true); description = "录音中断时的可点击恢复提醒" })
    }

    /** 常驻状态通知文案，由麦克风有效性状态决定 */
    private fun ongoingText(status: MicStatus): String = when (status) {
        MicStatus.VALID -> "采集中"
        MicStatus.SILENT_ZERO, MicStatus.OCCUPIED -> "麦克风被占用"
        MicStatus.STATE_INVALID -> "等待恢复"
    }

    /** 当前常驻通知文案（sh 未初始化时兜底为「采集中」） */
    private fun currentOngoingText(): String =
        if (::sh.isInitialized) ongoingText(sh.snapshotMicStatus()) else "采集中"

    private fun createNotification(text: String = "采集中") = NotificationCompat.Builder(this, CH_ONGOING)
        .setContentTitle("Kinship 数据采集").setContentText(text)
        .setSmallIcon(android.R.drawable.ic_menu_compass).setOngoing(true).setPriority(NotificationCompat.PRIORITY_MIN).build()

    /** 原地更新常驻通知文案（仅 startForeground 成功后生效，避免重复通知） */
    private fun updateOngoingNotification(status: MicStatus) {
        if (!foregroundStarted) return
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NID, createNotification(ongoingText(status)))
        } catch (e: Exception) {
            Timber.w("updateOngoingNotification: ${e.message}")
        }
    }

    /**
     * 弹出「录音已中断」高优先级可点击通知（独立通道 axeuh_audio_alert）。
     *
     * 固定 ID + setOnlyAlertOnce 避免刷屏；点击拉起 [MainActivity] 并携带
     * [EXTRA_RESTART_AUDIO]，由用户在前台内触发音频链路重启（Android 12+ 禁止
     * 后台启动 microphone 类型前台服务，故这是唯一合规路径）。
     * 通知常驻等待用户操作：不自动重试、不自动消失。
     */
    private fun showAudioInterruptedNotification() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(NotificationChannel(CH_AUDIO_ALERT, "Kinship 录音中断", NotificationManager.IMPORTANCE_HIGH).apply { setShowBadge(true); description = "录音中断时的可点击恢复提醒" })
            }
            val intent = Intent(this, MainActivity::class.java).apply {
                putExtra(EXTRA_RESTART_AUDIO, true)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pi = PendingIntent.getActivity(
                this, REQ_AUDIO_ALERT, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            nm.notify(
                NID_AUDIO_ALERT,
                NotificationCompat.Builder(this, CH_AUDIO_ALERT)
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setContentTitle("录音已中断")
                    .setContentText("点击恢复")
                    .setContentIntent(pi)
                    .setOnlyAlertOnce(true)
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .build()
            )
        } catch (e: Exception) {
            Timber.w("showAudioInterruptedNotification: ${e.message}")
        }
    }

    private fun showServiceStoppedNotification() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager; val ch = "axeuh_service_stopped"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) nm.createNotificationChannel(NotificationChannel(ch, "Service Status", NotificationManager.IMPORTANCE_DEFAULT))
            val pi = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            nm.notify(1002, NotificationCompat.Builder(this, ch).setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("采集已停止").setContentText("点击重新启动").setAutoCancel(true).setContentIntent(pi).build())
        } catch (_: Exception) {}
    }

    /**
     * 启动通知下行流式客户端（替代旧轮询）：随服务建立长连接，
     * 服务端推送 {"type":"notification","data":{id,title,content,ts}} 时弹系统通知；
     * 每次 connected 回执（含重连）触发一次通知历史尾部回补（60s 时间闸封顶风暴）。
     */
    private fun startNotificationStream() {
        try {
            val client = com.xehuri.kinship.network.NotificationStreamClient(this, hc)
            client.onNotification = { id, title, content, tsSec -> showSystemNotification(title, content, id, tsSec) }
            client.onConnected = { serviceScope.launch { NotificationHistoryBackfill.pullTail(applicationContext) } }
            client.start()
            notificationStream = client
        } catch (e: Exception) {
            Timber.w("通知流启动失败: ${e.message}")
        }
    }

    private fun showSystemNotification(title: String, content: String, id: Int, tsSec: Long = 0L) {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val pi = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            // ID 基址 9100：避开常驻 9003 / 服务停止 1002 / 录音中断 9005
            nm.notify(NID_PUSH_BASE + id, NotificationCompat.Builder(this, "axeuh_notification")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(content)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build())
            // —— AI 通知落库 + 桌面卡直更 ——
            // 系统通知本体恒弹；全文历史是 App 自身功能（NotificationStore，封顶 50 条、按 (id,ts) 复合键去重），
            // 与桌面组件开关无关，恒写。镜像失败不影响系统通知本体。
            // 帧 ts 直通：tsSec 与回补 created_at 同为 epoch 秒，*1000 后双路同值 ⇒ 幂等判重；
            // 缺 ts（=0）回落当前毫秒，最坏只退化为一对孪生行，绝不吞推送。
            NotificationStore.push(
                this, id, title, content,
                if (tsSec > 0L) tsSec * 1000L else System.currentTimeMillis()
            )
            // 卡片直更仍受 widgets_enabled 门控（停用态渲染为占位卡，直更无意义）
            if (isWidgetsEnabled(this)) {
                val widgetContext = applicationContext
                serviceScope.launch {
                    runCatching {
                        withContext(Dispatchers.IO) {
                            AiNotifyWidget().updateAll(widgetContext)
                        }
                    }.onFailure { Timber.w("通知卡直更失败: ${it.message}") }
                }
            }
        } catch (e: Exception) {
            Timber.w("showSystemNotification: ${e.message}")
        }
    }

    private fun updateSnapshot() {
        try {
            debugStateJson = JSONObject().apply {
                put("running", isRunning); put("vad", sh.snapshotVadStatus())
                put("hr", sh.snapshotHeartRate()); put("steps", sh.snapshotSteps())
                put("stress", sh.snapshotStress()); put("spo2", sh.snapshotSpo2())
                put("gps", sh.snapshotLastGps().take(80))
                put("last_sensor_text", sh.snapshotLastSensorText().take(100))
                put("last_response_text", sh.snapshotLastResponseText().take(80))
                put("last_media_text", sh.snapshotLastMediaText().take(80))
            }.toString(2)
            vadStatus = sh.snapshotVadStatus(); currentDbLevel = sh.snapshotDbLevel()
            lastSensorText = sh.snapshotLastSensorText(); lastResponseText = sh.snapshotLastResponseText()
            lastMediaText = sh.snapshotLastMediaText()
            // —— 桌面组件数据桥（受 widgets_enabled 总开关门控）——
            // 总开关关闭：不写快照、不直更，函数在此早退——上方内存态字段（debugStateJson 等）
            // 已先更新完毕，设置页传感器预览等旁路消费不受影响。
            // 开启时：Glance 组合只活约 45 秒、update/updateAll 不会重启已在运行的组合，
            // 外部数据变化必须显式直更；冷启动间隙（广播拉起进程时内存单例为空）靠落盘快照兜底。
            // 每轮快照先写独立 prefs（只存非敏感数值），再经 serviceScope 直更两个组件
            // （updateAll 为 suspend 的 binder 通道，转 IO 线程执行，见研究报告 §3.1 / §5 首选方案）。
            if (!isWidgetsEnabled(this)) return
            WidgetSnapshot.write(this, sh.snapshotHeartRate(), sh.snapshotSteps(), isRunning)
            val widgetContext = applicationContext
            serviceScope.launch {
                runCatching {
                    withContext(Dispatchers.IO) {
                        HealthSummaryWidget().updateAll(widgetContext)
                        HeartRateMiniWidget().updateAll(widgetContext)
                    }
                }.onFailure { Timber.w("widget 直更失败: ${it.message}") }
            }
        } catch (_: Exception) {}
    }
}
