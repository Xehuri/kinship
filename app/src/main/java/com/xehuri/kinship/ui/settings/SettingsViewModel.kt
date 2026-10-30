package com.xehuri.kinship.ui.settings

import android.Manifest
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.drawable.toBitmap
import androidx.glance.appwidget.updateAll
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.xehuri.kinship.auth.SessionManager
import com.xehuri.kinship.auth.SessionState
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.ota.ApkDownloader
import com.xehuri.kinship.ota.ApkInstaller
import com.xehuri.kinship.ota.DownloadProgress as OtaDownloadProgress
import com.xehuri.kinship.ota.InstallResult
import com.xehuri.kinship.service.DataCollectorService
import com.xehuri.kinship.service.collectors.AudioCollector
import com.xehuri.kinship.service.state.SensorStateHolder
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.transport.TierConfig
import com.xehuri.kinship.transport.TierStore
import com.xehuri.kinship.util.HintTonePlayer
import com.xehuri.kinship.wakeword.LocalKwsEngine
import com.xehuri.kinship.widget.AiNotifyWidget
import com.xehuri.kinship.widget.HealthSummaryWidget
import com.xehuri.kinship.widget.HeartRateMiniWidget
import com.xehuri.kinship.widget.ReminderWidget
import com.xehuri.kinship.widget.WidgetBackgroundStore
import com.xehuri.kinship.widget.WidgetColorStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import kotlin.math.log10

// ─── Data Models ───────────────────────────────────────────────────

/**
 * 已安装应用项（供敏感应用选择器展示）。
 *
 * [icon] 为后台线程预解析好的位图，避免在主线程做 Drawable 转换。
 */
data class InstalledAppItem(
    val packageName: String,
    val label: String,
    val icon: ImageBitmap?
)

/**
 * 传感器预览状态 -- 由 SensorStateHolder 的快照值 + debugStateJson 解析得到
 */
data class SensorPreviewState(
    val vadText: String = "",
    val dbText: String = "",
    val healthText: String = "",
    val responseText: String = "",
    val foregroundText: String = "",
    val notifText: String = "",
    val mediaText: String = "",
    val gpsText: String = "",
    val wifiText: String = "",
    val btText: String = "",
    val screenText: String = ""
)

/**
 * SettingsActivity 的 ViewModel -- 提取所有状态管理和网络操作
 *
 * 使用 ViewModelProvider.Factory 模式（无 Hilt）。
 * 所有状态通过 StateFlow 暴露，Activity 通过 collect 观察。
 *
 * @param appContext Application Context，用于 SharedPreferences 和系统服务
 * @param httpClient 统一 HTTP 客户端
 * @param sensorStateHolder 传感器状态持有者（由 Activity 创建并注入）
 */
class SettingsViewModel(
    private val appContext: Context,
    private val httpClient: AppHttpClient,
    val sensorStateHolder: SensorStateHolder,
    /**
     * 加密偏好提供者（存储密码等敏感项）。
     *
     * 生产环境默认使用 AndroidKeyStore 支撑的 [EncryptedSharedPreferences]；
     * Robolectric 单元测试无 AndroidKeyStore，可注入普通 [android.content.SharedPreferences] 替身。
     * 以 provider 形式注入，保持与既有实现一致的惰性创建时机。
     */
    private val securePrefsProvider: () -> android.content.SharedPreferences =
        { createEncryptedPrefs(appContext) }
) : ViewModel() {

    // ─── Factory ───────────────────────────────────────────────────

    class Factory(
        private val appContext: Context,
        private val httpClient: AppHttpClient,
        private val sensorStateHolder: SensorStateHolder
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            if (modelClass.isAssignableFrom(SettingsViewModel::class.java)) {
                return SettingsViewModel(appContext, httpClient, sensorStateHolder) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
    }

    // ─── Constants ─────────────────────────────────────────────────

    companion object {
        const val PREFS_NAME = "axeuh_prefs"
        const val PREFS_SENSORS = "sensor_toggles"
        const val PREFS_DATA_COLLECTOR = "data_collector"
        const val KEY_SERVER_URL = "server_url"
        const val KEY_TOKEN = "auth_token"
        const val KEY_USERNAME = "auth_username"
        const val KEY_PASSWORD = "auth_password"
        const val KEY_SSL_VERIFY = "ssl_verify"
        private const val LOOP_MS_DEFAULT = 30000L
        private const val NOTIFY_MS_DEFAULT = 5000L

        // ── 新增 prefs 键（文件 data_collector，见 plans/settings-redesign.md 第三节）──
        const val KEY_HEALTH_UPLOAD_MODE = "health_upload_mode"
        const val KEY_HEALTH_SCHEDULE_TIMES = "health_schedule_times"
        const val KEY_HEALTH_INTERVAL_MS = "health_interval_ms"
        const val KEY_NOTIFY_UPLOAD_ENABLED = "notify_upload_enabled"
        const val KEY_GPS_INTERVAL_MS = "gps_interval_ms"
        const val KEY_GPS_ACCURACY_PRIORITY = "gps_accuracy_priority"
        const val KEY_GPS_MIN_DISPLACEMENT_M = "gps_min_displacement_m"
        const val KEY_GPS_MAX_ACCURACY_M = "gps_max_accuracy_m"
        const val KEY_GPS_FIX_TIMEOUT_MS = "gps_fix_timeout_ms"
        const val KEY_GPS_REVERSE_GEOCODE = "gps_reverse_geocode"
        const val KEY_SYSTEM_STATE_INTERVAL_MS = "system_state_interval_ms"
        const val KEY_AUDIO_SEGMENT_MS = "audio_segment_ms"
        const val KEY_AUDIO_UPLOAD_BATCH_MS = "audio_upload_batch_ms"
        const val KEY_NOTIFY_SENSITIVE_APPS = "notify_sensitive_apps"
        const val KEY_HINT_TONE_VOLUME = "hint_tone_volume"
        const val KEY_TTS_VOLUME = "tts_volume"

        /** TTS 试听使用的测试文案 */
        private const val TTS_TEST_TEXT = "这是一条语音测试。"

        /** 内置默认唤醒词（清空自定义词表时服务端同步恢复为该词） */
        private const val DEFAULT_WAKE_KEYWORD = "小贺同学"
    }

    /**
     * data_collector 偏好文件。
     *
     * 新建键目前直接读写该文件；后续采集层接入时应统一到 DataCollectorService 静态访问器，
     * 届时移除这里的直接读写。
     */
    private fun dataCollectorPrefs(): android.content.SharedPreferences =
        appContext.getSharedPreferences(PREFS_DATA_COLLECTOR, Context.MODE_PRIVATE)

    private val session = SessionManager(
        appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
        securePrefsProvider
    ) { ServerConfig.BASE_URL }

    /** 试听提示音用的播放器（与采集器实例隔离，避免相互 release 干扰） */
    private val previewTonePlayer = HintTonePlayer(appContext)

    /** 试听 TTS 用的本地播放器 */
    private var ttsTestPlayer: android.media.MediaPlayer? = null

    // ═══════════════════════════════════════════════════════════════
    //  Login State
    // ═══════════════════════════════════════════════════════════════

    private val _serverUrl = MutableStateFlow(ServerConfig.BASE_URL)
    val serverUrl: StateFlow<String> = _serverUrl.asStateFlow()

    private val _isLoggedIn = MutableStateFlow(false)
    val isLoggedIn: StateFlow<Boolean> = _isLoggedIn.asStateFlow()

    private val _loginStatus = MutableStateFlow("未连接")
    val loginStatus: StateFlow<String> = _loginStatus.asStateFlow()

    private val _loginError = MutableStateFlow("")
    val loginError: StateFlow<String> = _loginError.asStateFlow()

    private val _savedUsername = MutableStateFlow("")
    val savedUsername: StateFlow<String> = _savedUsername.asStateFlow()

    // ═══════════════════════════════════════════════════════════════
    //  Sensor Toggles (11 boolean toggles)
    // ═══════════════════════════════════════════════════════════════

    private val _audioEnabled = MutableStateFlow(false)
    val audioEnabled: StateFlow<Boolean> = _audioEnabled.asStateFlow()

    private val _foregroundEnabled = MutableStateFlow(false)
    val foregroundEnabled: StateFlow<Boolean> = _foregroundEnabled.asStateFlow()

    private val _notificationEnabled = MutableStateFlow(false)
    val notificationEnabled: StateFlow<Boolean> = _notificationEnabled.asStateFlow()

    private val _healthEnabled = MutableStateFlow(false)
    val healthEnabled: StateFlow<Boolean> = _healthEnabled.asStateFlow()

    private val _gpsEnabled = MutableStateFlow(false)
    val gpsEnabled: StateFlow<Boolean> = _gpsEnabled.asStateFlow()

    private val _wifiEnabled = MutableStateFlow(false)
    val wifiEnabled: StateFlow<Boolean> = _wifiEnabled.asStateFlow()

    private val _bluetoothEnabled = MutableStateFlow(false)
    val bluetoothEnabled: StateFlow<Boolean> = _bluetoothEnabled.asStateFlow()

    private val _screenStateEnabled = MutableStateFlow(false)
    val screenStateEnabled: StateFlow<Boolean> = _screenStateEnabled.asStateFlow()

    private val _inputContentEnabled = MutableStateFlow(false)
    val inputContentEnabled: StateFlow<Boolean> = _inputContentEnabled.asStateFlow()

    private val _uploadEnabled = MutableStateFlow(true)
    val uploadEnabled: StateFlow<Boolean> = _uploadEnabled.asStateFlow()

    private val _cacheEnabled = MutableStateFlow(true)
    val cacheEnabled: StateFlow<Boolean> = _cacheEnabled.asStateFlow()

    /** 桌面组件总开关（默认开；关闭后桌面卡片渲染停用占位、健康快照停更，通知历史全文仍记录） */
    private val _widgetsEnabled = MutableStateFlow(true)
    val widgetsEnabled: StateFlow<Boolean> = _widgetsEnabled.asStateFlow()

    /** AI 通知卡背景显示名（null=未设置；真源在 WidgetBackgroundStore prefs，本流仅设置页回显） */
    private val _notifyBgName = MutableStateFlow<String?>(null)
    val notifyBgName: StateFlow<String?> = _notifyBgName.asStateFlow()

    /** AI 提醒卡背景显示名（口径同 notifyBgName） */
    private val _reminderBgName = MutableStateFlow<String?>(null)
    val reminderBgName: StateFlow<String?> = _reminderBgName.asStateFlow()

    /**
     * AI 通知卡背景昼夜 ARGB 对回显（null=未设置、跟随文件私有色板）。
     * 真源在 WidgetColorStore prefs；store 读侧保证"要么成对、要么全空"，
     * 本流与读侧口径一致（成对→Pair、全空→null），仅设置页消费。
     */
    private val _notifyBgPair = MutableStateFlow<Pair<Int?, Int?>?>(null)
    val notifyBgPair: StateFlow<Pair<Int?, Int?>?> = _notifyBgPair.asStateFlow()

    /** AI 通知卡文字昼夜对回显（口径同 notifyBgPair） */
    private val _notifyTextPair = MutableStateFlow<Pair<Int?, Int?>?>(null)
    val notifyTextPair: StateFlow<Pair<Int?, Int?>?> = _notifyTextPair.asStateFlow()

    /** AI 通知卡可读性遮罩开关回显（键缺失=true 默认开，真源 WidgetColorStore.readScrim） */
    private val _notifyScrimOn = MutableStateFlow(true)
    val notifyScrimOn: StateFlow<Boolean> = _notifyScrimOn.asStateFlow()

    /** AI 提醒卡背景昼夜对回显（口径同通知卡，cardKey=KEY_AI_REMINDER） */
    private val _reminderBgPair = MutableStateFlow<Pair<Int?, Int?>?>(null)
    val reminderBgPair: StateFlow<Pair<Int?, Int?>?> = _reminderBgPair.asStateFlow()

    /** AI 提醒卡文字昼夜对回显 */
    private val _reminderTextPair = MutableStateFlow<Pair<Int?, Int?>?>(null)
    val reminderTextPair: StateFlow<Pair<Int?, Int?>?> = _reminderTextPair.asStateFlow()

    /** AI 提醒卡可读性遮罩开关回显 */
    private val _reminderScrimOn = MutableStateFlow(true)
    val reminderScrimOn: StateFlow<Boolean> = _reminderScrimOn.asStateFlow()

    // ═══════════════════════════════════════════════════════════════
    //  Sensor Intervals
    // ═══════════════════════════════════════════════════════════════

    private val _collectionInterval = MutableStateFlow(LOOP_MS_DEFAULT.toInt())
    val collectionInterval: StateFlow<Int> = _collectionInterval.asStateFlow()

    private val _notifyInterval = MutableStateFlow(NOTIFY_MS_DEFAULT.toInt())
    val notifyInterval: StateFlow<Int> = _notifyInterval.asStateFlow()

    // ═══════════════════════════════════════════════════════════════
    //  新增设置项（健康数据上传模式 / 通知上行 / 各数据源独立间隔）
    // ═══════════════════════════════════════════════════════════════

    /** 健康数据上传模式："schedule"（定时时段）| "interval"（间隔） */
    private val _healthUploadMode = MutableStateFlow("interval")
    val healthUploadMode: StateFlow<String> = _healthUploadMode.asStateFlow()

    /** 定时时段，逗号分隔 HH:mm，例如 "08:00,13:00,22:00" */
    private val _healthScheduleTimes = MutableStateFlow("")
    val healthScheduleTimes: StateFlow<String> = _healthScheduleTimes.asStateFlow()

    /** 间隔模式下的健康数据上传周期（毫秒，默认 60 分钟） */
    private val _healthIntervalMs = MutableStateFlow(3_600_000L)
    val healthIntervalMs: StateFlow<Long> = _healthIntervalMs.asStateFlow()

    /** 通知上行开关（与 notification_enabled 采集开关分离） */
    private val _notifyUploadEnabled = MutableStateFlow(false)
    val notifyUploadEnabled: StateFlow<Boolean> = _notifyUploadEnabled.asStateFlow()

    /** GPS 采集间隔（毫秒，默认 5 分钟） */
    private val _gpsIntervalMs = MutableStateFlow(300_000L)
    val gpsIntervalMs: StateFlow<Long> = _gpsIntervalMs.asStateFlow()

    /** GPS 精度优先级："high" | "balanced" | "low_power"（默认 balanced） */
    private val _gpsAccuracyPriority = MutableStateFlow(DataCollectorService.GPS_PRIORITY_BALANCED)
    val gpsAccuracyPriority: StateFlow<String> = _gpsAccuracyPriority.asStateFlow()

    /** GPS 最小位移（米，默认 0=不过滤） */
    private val _gpsMinDisplacementM = MutableStateFlow(0L)
    val gpsMinDisplacementM: StateFlow<Long> = _gpsMinDisplacementM.asStateFlow()

    /** GPS 最大可接受精度（米，默认 0=不过滤） */
    private val _gpsMaxAccuracyM = MutableStateFlow(0L)
    val gpsMaxAccuracyM: StateFlow<Long> = _gpsMaxAccuracyM.asStateFlow()

    /** GPS 主动定位等待超时（毫秒，默认 0=关闭，仅读缓存） */
    private val _gpsFixTimeoutMs = MutableStateFlow(0L)
    val gpsFixTimeoutMs: StateFlow<Long> = _gpsFixTimeoutMs.asStateFlow()

    /** GPS 逆地理编码开关（默认关闭） */
    private val _gpsReverseGeocode = MutableStateFlow(false)
    val gpsReverseGeocode: StateFlow<Boolean> = _gpsReverseGeocode.asStateFlow()

    /** 系统状态采集间隔（毫秒，默认 1 秒） */
    private val _systemStateIntervalMs = MutableStateFlow(1_000L)
    val systemStateIntervalMs: StateFlow<Long> = _systemStateIntervalMs.asStateFlow()

    /** 音频分段单段硬上限（毫秒，默认 60 秒；VAD 端点会提前切段） */
    private val _audioSegmentMs = MutableStateFlow(60_000L)
    val audioSegmentMs: StateFlow<Long> = _audioSegmentMs.asStateFlow()

    /** 音频批量上传间隔（毫秒，默认 10 分钟；与分段时长解耦，只决定多久发一次） */
    private val _audioUploadBatchMs = MutableStateFlow(600_000L)
    val audioUploadBatchMs: StateFlow<Long> = _audioUploadBatchMs.asStateFlow()

    /** 上传音频格式（"wav" 默认 | "flac"；采集层每段现读同一 prefs 键） */
    private val _audioUploadFormat = MutableStateFlow("wav")
    val audioUploadFormat: StateFlow<String> = _audioUploadFormat.asStateFlow()

    /** 唤醒/录制结束提示音音量（0-100，默认 90） */
    private val _hintToneVolume = MutableStateFlow(HintTonePlayer.DEFAULT_VOLUME)
    val hintToneVolume: StateFlow<Int> = _hintToneVolume.asStateFlow()

    /** TTS 语音音量（0-100，默认 100） */
    private val _ttsVolume = MutableStateFlow(100)
    val ttsVolume: StateFlow<Int> = _ttsVolume.asStateFlow()

    /** TTS 试听状态文案（空串表示无提示） */
    private val _ttsTestStatus = MutableStateFlow("")
    val ttsTestStatus: StateFlow<String> = _ttsTestStatus.asStateFlow()

    /** TTS 试听是否进行中（防止重复点击） */
    private val _ttsTestLoading = MutableStateFlow(false)
    val ttsTestLoading: StateFlow<Boolean> = _ttsTestLoading.asStateFlow()

    /** 电量感知开关（默认 true） */
    private val _batteryEnabled = MutableStateFlow(true)
    val batteryEnabled: StateFlow<Boolean> = _batteryEnabled.asStateFlow()

    /** 敏感应用黑名单（逗号分隔包名） */
    private val _sensitiveApps = MutableStateFlow("")
    val sensitiveApps: StateFlow<String> = _sensitiveApps.asStateFlow()

    /** 已安装应用列表（标签 + 图标，后台解析并缓存），供敏感应用选择器使用 */
    private val _installedApps = MutableStateFlow<List<InstalledAppItem>>(emptyList())
    val installedApps: StateFlow<List<InstalledAppItem>> = _installedApps.asStateFlow()

    /** 已安装应用枚举是否进行中 */
    private val _installedAppsLoading = MutableStateFlow(false)
    val installedAppsLoading: StateFlow<Boolean> = _installedAppsLoading.asStateFlow()

    /** 是否已成功枚举过（避免重复开销，可用 force 强制刷新） */
    @Volatile
    private var installedAppsLoaded = false

    // ═══════════════════════════════════════════════════════════════
    //  Hardware DB Path
    // ═══════════════════════════════════════════════════════════════

    private val _dbFilePath = MutableStateFlow("")
    val dbFilePath: StateFlow<String> = _dbFilePath.asStateFlow()

    private val _showVoiceprintPanel = MutableStateFlow(false)
    val showVoiceprintPanel: StateFlow<Boolean> = _showVoiceprintPanel.asStateFlow()

    // ═══════════════════════════════════════════════════════════════
    //  OTA State
    // ═══════════════════════════════════════════════════════════════

    private val _otaStatusText = MutableStateFlow("点击检查更新")
    val otaStatusText: StateFlow<String> = _otaStatusText.asStateFlow()

    private val _otaChecking = MutableStateFlow(false)
    val otaChecking: StateFlow<Boolean> = _otaChecking.asStateFlow()

    private val _otaChangelog = MutableStateFlow("")
    val otaChangelog: StateFlow<String> = _otaChangelog.asStateFlow()

    private val _otaDownloadUrl = MutableStateFlow("")
    val otaDownloadUrl: StateFlow<String> = _otaDownloadUrl.asStateFlow()

    private val _otaProgress = MutableStateFlow(0)
    val otaProgress: StateFlow<Int> = _otaProgress.asStateFlow()

    /** 后端 OTA 元数据提供的期望哈希（SHA-256 优先，缺省为空表示未提供） */
    private val _otaExpectedHash = MutableStateFlow<String?>(null)

    // ═══════════════════════════════════════════════════════════════
    //  System
    // ═══════════════════════════════════════════════════════════════

    private val _syncStatusText = MutableStateFlow("")
    val syncStatusText: StateFlow<String> = _syncStatusText.asStateFlow()

    private val _deviceName = MutableStateFlow("")
    val deviceName: StateFlow<String> = _deviceName.asStateFlow()

    /** SSL 证书验证开关（缺省 true = 校验；显式 false 才接受任意证书） */
    private val _sslVerify = MutableStateFlow(true)
    val sslVerify: StateFlow<Boolean> = _sslVerify.asStateFlow()

    // ═══════════════════════════════════════════════════════════════
    //  Run Status
    // ═══════════════════════════════════════════════════════════════

    val serviceRunning: StateFlow<Boolean> = DataCollectorService.running

    private val _tierConfig = MutableStateFlow(TierStore.shared(appContext).state.value)
    val tierConfig: StateFlow<TierConfig> = _tierConfig.asStateFlow()

    private val _permissionChecks = MutableStateFlow<List<PermissionCheck>>(emptyList())
    val permissionChecks: StateFlow<List<PermissionCheck>> = _permissionChecks.asStateFlow()

    private val _batteryOptimized = MutableStateFlow(false)
    val batteryOptimized: StateFlow<Boolean> = _batteryOptimized.asStateFlow()

    // ═══════════════════════════════════════════════════════════════
    //  Sensor Preview (computed from SensorStateHolder + debug JSON)
    // ═══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    //  端侧唤醒推理间隔
    // ═══════════════════════════════════════════════════════════════

    /** 端侧唤醒推理间隔（毫秒，100/200/300）：越大越省电，唤醒延迟同量级增加。 */
    private val _kwsIntervalMs = MutableStateFlow(100)
    val kwsIntervalMs: StateFlow<Int> = _kwsIntervalMs.asStateFlow()

    /** 端侧唤醒（KWS）状态：未启用 / 模型不可用 / 监听中 / 已命中。 */
    val kwsStatus: StateFlow<String> = sensorStateHolder.kwsStatus

    /** 本次运行累计唤醒命中次数。 */
    val kwsHitCount: StateFlow<Int> = sensorStateHolder.kwsHitCount

    /** 最近一次命中（唤醒词 · HH:mm:ss），空串表示尚未命中。 */
    val kwsLastHit: StateFlow<String> = sensorStateHolder.kwsLastHit

    /** 端侧唤醒开关 */
    private val _localKwsEnabled = MutableStateFlow(false)
    val localKwsEnabled: StateFlow<Boolean> = _localKwsEnabled.asStateFlow()

    /** KWS 唤醒词加权分（灵敏度） */
    private val _kwsScore = MutableStateFlow(LocalKwsEngine.KEYWORDS_SCORE)
    val kwsScore: StateFlow<Float> = _kwsScore.asStateFlow()

    /** KWS 判定阈值 */
    private val _kwsThreshold = MutableStateFlow(LocalKwsEngine.KEYWORDS_THRESHOLD)
    val kwsThreshold: StateFlow<Float> = _kwsThreshold.asStateFlow()

    /** 唤醒词输入（中文，仅本地态；点击转换后才落盘生效） */
    private val _kwsKeywordsInput = MutableStateFlow("")
    val kwsKeywordsInput: StateFlow<String> = _kwsKeywordsInput.asStateFlow()

    /** 已编码的唤醒词 token（多行；空串表示沿用 assets 内置词表） */
    private val _kwsKeywordsToken = MutableStateFlow("")
    val kwsKeywordsToken: StateFlow<String> = _kwsKeywordsToken.asStateFlow()

    /** 唤醒词转换结果提示 */
    private val _kwsEncodeStatus = MutableStateFlow("")
    val kwsEncodeStatus: StateFlow<String> = _kwsEncodeStatus.asStateFlow()

    /** 唤醒词转换进行中 */
    private val _kwsEncoding = MutableStateFlow(false)
    val kwsEncoding: StateFlow<Boolean> = _kwsEncoding.asStateFlow()

    /** 云端唤醒测试模式（audio_start 带 test=true，服务端只回推结果、不投递 AI） */
    private val _kwsCloudTestEnabled = MutableStateFlow(false)
    val kwsCloudTestEnabled: StateFlow<Boolean> = _kwsCloudTestEnabled.asStateFlow()

    /** 云端唤醒测试最近一次结果摘要 */
    val kwsCloudTestResult: StateFlow<String> = sensorStateHolder.kwsCloudTestResult

    private val _sensorPreviewState = MutableStateFlow(SensorPreviewState())
    val sensorPreviewState: StateFlow<SensorPreviewState> = _sensorPreviewState.asStateFlow()

    // ═══════════════════════════════════════════════════════════════
    //  Dialog/Drawer State
    // ═══════════════════════════════════════════════════════════════

    private val _showNotificationListenerDialog = MutableStateFlow(false)
    val showNotificationListenerDialog: StateFlow<Boolean> = _showNotificationListenerDialog.asStateFlow()

    // ═══════════════════════════════════════════════════════════════
    //  Init
    // ═══════════════════════════════════════════════════════════════

    init {
        loadInitialState()
        refreshRunStatus()
        viewModelScope.launch {
            session.state.collect { applySessionState(it) }
        }
        viewModelScope.launch {
            TierStore.shared(appContext).state.collect { _tierConfig.value = it }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  Public Methods
    // ═══════════════════════════════════════════════════════════════

    // ── Login ─────────────────────────────────────────────────────

    /** 使用显式账号密码登录；成功后经 [SessionManager] 落盘并同步登录态。 */
    fun login(username: String, password: String) {
        val u = username.trim()
        val p = password
        if (u.isBlank() || p.isBlank()) {
            _loginError.value = "请输入账号和密码"
            return
        }
        viewModelScope.launch {
            _loginStatus.value = "登录中..."
            _loginError.value = ""
            try {
                val result = performLogin(u, p)
                if (result != null) {
                    session.save(ServerConfig.BASE_URL, result, u, p)
                    applySessionState(session.state.value)
                    AppHttpClient.resetAuthFailureFlag()
                } else {
                    _loginError.value = "账号或密码错误"
                    _loginStatus.value = "未连接"
                }
            } catch (e: Exception) {
                _loginError.value = "网络连接失败: ${e.message}"
                _loginStatus.value = "未连接"
            }
        }
    }

    /**
     * 退出登录 -- 清除 token/username/密码并广播登出状态
     */
    fun logout() {
        session.logout()
        applySessionState(session.state.value)
    }

    // ── Sensor Toggles ────────────────────────────────────────────

    /**
     * 切换传感器开关，并持久化到 SharedPreferences
     *
     * @param key  传感器标识（audio, foreground, notification, health, gps,
     *             wifi, bluetooth, screen, inputContent, upload）
     * @param enabled 新状态
     */
    fun toggleSensor(key: String, enabled: Boolean) {
        when (key) {
            "audio" -> {
                _audioEnabled.value = enabled
                DataCollectorService.setAudioEnabled(appContext, enabled)
            }
            "foreground" -> {
                _foregroundEnabled.value = enabled
                DataCollectorService.setForegroundEnabled(appContext, enabled)
            }
            "notification" -> {
                _notificationEnabled.value = enabled
                DataCollectorService.setNotificationEnabled(appContext, enabled)
            }
            "health" -> {
                _healthEnabled.value = enabled
                DataCollectorService.setHealthEnabled(appContext, enabled)
            }
            "gps" -> {
                _gpsEnabled.value = enabled
                DataCollectorService.setGpsEnabled(appContext, enabled)
            }
            "wifi" -> {
                _wifiEnabled.value = enabled
                DataCollectorService.setWifiEnabled(appContext, enabled)
            }
            "bluetooth" -> {
                _bluetoothEnabled.value = enabled
                DataCollectorService.setBluetoothEnabled(appContext, enabled)
            }
            "screen" -> {
                _screenStateEnabled.value = enabled
                DataCollectorService.setScreenStateEnabled(appContext, enabled)
            }
            "battery" -> {
                _batteryEnabled.value = enabled
                DataCollectorService.setBatteryEnabled(appContext, enabled)
            }
            "inputContent" -> {
                _inputContentEnabled.value = enabled
                DataCollectorService.setInputContentEnabled(appContext, enabled)
            }
            "upload" -> {
                _uploadEnabled.value = enabled
                DataCollectorService.setUploadEnabled(appContext, enabled)
            }
            "cache" -> {
                _cacheEnabled.value = enabled
                DataCollectorService.setCacheEnabled(appContext, enabled)
                if (!enabled) {
                    // 关闭缓存时立即清空所有离线缓存
                    DataCollectorService.clearAllCaches(appContext)
                }
            }
        }
    }

    // ── Intervals ─────────────────────────────────────────────────

    /** 设置采集间隔（毫秒） */
    fun setCollectionInterval(ms: Int) {
        _collectionInterval.value = ms
        DataCollectorService.setLoopInterval(appContext, ms.toLong())
    }

    /** 设置通知轮询间隔（毫秒） */
    fun setNotifyInterval(ms: Int) {
        _notifyInterval.value = ms
        DataCollectorService.setNotifyInterval(appContext, ms.toLong())
    }

    // ── 新增设置项 Setter ─────────────────────────────────────────

    /** 设置健康数据上传模式（"schedule" | "interval"） */
    fun setHealthUploadMode(mode: String) {
        _healthUploadMode.value = mode
        // TODO 新增键：采集层接入后统一到 DataCollectorService 访问器
        dataCollectorPrefs().edit().putString(KEY_HEALTH_UPLOAD_MODE, mode).apply()
    }

    /** 设置健康数据定时时段（逗号分隔 HH:mm） */
    fun setHealthScheduleTimes(times: String) {
        _healthScheduleTimes.value = times
        // TODO 新增键：采集层接入后统一到 DataCollectorService 访问器
        dataCollectorPrefs().edit().putString(KEY_HEALTH_SCHEDULE_TIMES, times).apply()
    }

    /** 设置健康数据上传间隔（毫秒） */
    fun setHealthIntervalMs(ms: Long) {
        _healthIntervalMs.value = ms
        // TODO 新增键：采集层接入后统一到 DataCollectorService 访问器
        dataCollectorPrefs().edit().putLong(KEY_HEALTH_INTERVAL_MS, ms).apply()
    }

    /** 设置通知上行开关 */
    fun setNotifyUploadEnabled(enabled: Boolean) {
        _notifyUploadEnabled.value = enabled
        // TODO 新增键：采集层接入后统一到 DataCollectorService 访问器
        dataCollectorPrefs().edit().putBoolean(KEY_NOTIFY_UPLOAD_ENABLED, enabled).apply()
    }

    /**
     * 通知总开关（2026-09-16 合并）。
     *
     * 原先「读取系统通知」(notification_enabled) 与「上传到后端」(notify_upload_enabled)
     * 是两个并列开关，使用者难以分辨二者区别；现合并为一个：开启即读取并按间隔上传，
     * 关闭则既不读也不传。底层仍写两个 prefs 键（NotificationCollector 的双重判定不变），
     * [setNotifyUploadEnabled] 保留供内部与历史状态使用。
     */
    fun setNotificationEnabled(enabled: Boolean) {
        toggleSensor("notification", enabled)
        setNotifyUploadEnabled(enabled)
    }

    /**
     * 桌面组件总开关（写 prefs + 即时回显卡片）。
     *
     * 回显路径：
     * - 开启时走既有公开入口 DataCollectorService.triggerSync（内部即 forceSync -> updateSnapshot，
     *   服务未运行时该入口会拉起服务，与「立即同步」同语义），立刻刷新快照；
     * - 无论开/关都在 IO 上 updateAll 四卡——关闭时渲染端现读标志换占位卡，
     *   开启时读到（刚刷新的）最新快照重绘，开关拨动立刻"看得见"。
     */
    fun setWidgetsEnabled(enabled: Boolean) {
        _widgetsEnabled.value = enabled
        DataCollectorService.setWidgetsEnabled(appContext, enabled)
        if (enabled) runCatching { DataCollectorService.triggerSync(appContext) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    HealthSummaryWidget().updateAll(appContext)
                    HeartRateMiniWidget().updateAll(appContext)
                    AiNotifyWidget().updateAll(appContext)
                    ReminderWidget().updateAll(appContext)
                }
            }
        }
    }

    /**
     * AI 通知卡背景图（图库选择结果 → IO 降采样落盘 → 回显 → IO 直更卡片）。
     *
     * 形态克隆 [setWidgetsEnabled]：重活恒 Dispatchers.IO、updateAll 失败静默
     * （渲染端下次刷新自愈）；保存失败不动 StateFlow（保持"未设置/旧图"原显示）。
     * 背景图本体进 [WidgetBackgroundStore]，卡片消费（T4）经 bitmapFile 读数。
     */
    fun setNotifyBackground(context: Context, uri: Uri, displayName: String?) {
        viewModelScope.launch {
            val saved = withContext(Dispatchers.IO) {
                WidgetBackgroundStore.saveFromUri(context, WidgetBackgroundStore.KEY_AI_NOTIFY, uri, displayName)
            }
            if (!saved) return@launch
            _notifyBgName.value = WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_NOTIFY)
            runCatching { withContext(Dispatchers.IO) { AiNotifyWidget().updateAll(context) } }
        }
    }

    /** AI 通知卡背景图清除（store 双删 + 回显归零 + 直更，先落显示态再异步清） */
    fun clearNotifyBackground(context: Context) {
        _notifyBgName.value = null
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    WidgetBackgroundStore.clear(context, WidgetBackgroundStore.KEY_AI_NOTIFY)
                    AiNotifyWidget().updateAll(context)
                }
            }
        }
    }

    /** AI 提醒卡背景图（口径同 [setNotifyBackground]，直更走 ReminderWidget） */
    fun setReminderBackground(context: Context, uri: Uri, displayName: String?) {
        viewModelScope.launch {
            val saved = withContext(Dispatchers.IO) {
                WidgetBackgroundStore.saveFromUri(context, WidgetBackgroundStore.KEY_AI_REMINDER, uri, displayName)
            }
            if (!saved) return@launch
            _reminderBgName.value = WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_REMINDER)
            runCatching { withContext(Dispatchers.IO) { ReminderWidget().updateAll(context) } }
        }
    }

    /** AI 提醒卡背景图清除（口径同 [clearNotifyBackground]） */
    fun clearReminderBackground(context: Context) {
        _reminderBgName.value = null
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    WidgetBackgroundStore.clear(context, WidgetBackgroundStore.KEY_AI_REMINDER)
                    ReminderWidget().updateAll(context)
                }
            }
        }
    }

    // ─── 卡片配色（背景/文字昼夜对 + 可读性遮罩，真源 WidgetColorStore） ───

    /**
     * AI 通知卡背景昼夜色对（IO 写 store → saved-再回读回显 → IO 直更卡片，形态克隆
     * [setNotifyBackground] 的 saved-reread 语义：回显真源是 store 现值，不是入参）。
     *
     * 半对色组由 store 拒写并返回 false——此时回显流分毫不动（什么没持久化就显示什么），
     * 由调用方拿返回值做内联反馈；成功恒 true（成对写或双 null 复位均落 store 成功分支）。
     */
    suspend fun setNotifyBackgroundColors(context: Context, dayArgb: Int?, nightArgb: Int?): Boolean {
        val saved = withContext(Dispatchers.IO) {
            WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, dayArgb, nightArgb)
        }
        if (!saved) return false
        _notifyBgPair.value = WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY).asStoredPair()
        runCatching { withContext(Dispatchers.IO) { AiNotifyWidget().updateAll(context) } }
        return true
    }

    /** AI 通知卡背景色对复位（remove 两键回色板默认 + 回显归零 + 直更，先落显示态再异步清，口径同 [clearNotifyBackground]） */
    fun clearNotifyBackgroundColors(context: Context) {
        _notifyBgPair.value = null
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    WidgetColorStore.clearBackground(context, WidgetColorStore.KEY_AI_NOTIFY)
                    AiNotifyWidget().updateAll(context)
                }
            }
        }
    }

    /** AI 通知卡文字昼夜色对（口径同 [setNotifyBackgroundColors]，走 writeText/readText） */
    suspend fun setNotifyTextColors(context: Context, dayArgb: Int?, nightArgb: Int?): Boolean {
        val saved = withContext(Dispatchers.IO) {
            WidgetColorStore.writeText(context, WidgetColorStore.KEY_AI_NOTIFY, dayArgb, nightArgb)
        }
        if (!saved) return false
        _notifyTextPair.value = WidgetColorStore.readText(context, WidgetColorStore.KEY_AI_NOTIFY).asStoredPair()
        runCatching { withContext(Dispatchers.IO) { AiNotifyWidget().updateAll(context) } }
        return true
    }

    /** AI 通知卡文字色对复位（口径同 [clearNotifyBackgroundColors]） */
    fun clearNotifyTextColors(context: Context) {
        _notifyTextPair.value = null
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    WidgetColorStore.clearText(context, WidgetColorStore.KEY_AI_NOTIFY)
                    AiNotifyWidget().updateAll(context)
                }
            }
        }
    }

    /**
     * AI 通知卡可读性遮罩开关。
     *
     * 复位语义与色对"清键回默认"对齐：关=显式写 false；开=remove 键回"缺失⇒默认开"
     * （store.readScrim 缺键即 true，两路径读数等价，清键让"开"永远等于出厂态）。
     * store 冻结 API 无 scrim 写入口，按 [WidgetColorStore] 类头契约走原生 prefs 键
     * "${cardKey}_scrim"（键名由 WidgetColorStoreTest 钉死）。
     * 形态克隆 [clearNotifyBackground]：先落显示态、IO 写+直更、失败静默。
     */
    fun setNotifyScrim(context: Context, on: Boolean) {
        _notifyScrimOn.value = on
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    persistScrimPref(context, WidgetColorStore.KEY_AI_NOTIFY, on)
                    AiNotifyWidget().updateAll(context)
                }
            }
        }
    }

    /** AI 提醒卡背景昼夜色对（口径同 [setNotifyBackgroundColors]，直更走 ReminderWidget） */
    suspend fun setReminderBackgroundColors(context: Context, dayArgb: Int?, nightArgb: Int?): Boolean {
        val saved = withContext(Dispatchers.IO) {
            WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_REMINDER, dayArgb, nightArgb)
        }
        if (!saved) return false
        _reminderBgPair.value = WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_REMINDER).asStoredPair()
        runCatching { withContext(Dispatchers.IO) { ReminderWidget().updateAll(context) } }
        return true
    }

    /** AI 提醒卡背景色对复位（口径同 [clearNotifyBackgroundColors]） */
    fun clearReminderBackgroundColors(context: Context) {
        _reminderBgPair.value = null
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    WidgetColorStore.clearBackground(context, WidgetColorStore.KEY_AI_REMINDER)
                    ReminderWidget().updateAll(context)
                }
            }
        }
    }

    /** AI 提醒卡文字昼夜色对（口径同 [setNotifyTextColors]） */
    suspend fun setReminderTextColors(context: Context, dayArgb: Int?, nightArgb: Int?): Boolean {
        val saved = withContext(Dispatchers.IO) {
            WidgetColorStore.writeText(context, WidgetColorStore.KEY_AI_REMINDER, dayArgb, nightArgb)
        }
        if (!saved) return false
        _reminderTextPair.value = WidgetColorStore.readText(context, WidgetColorStore.KEY_AI_REMINDER).asStoredPair()
        runCatching { withContext(Dispatchers.IO) { ReminderWidget().updateAll(context) } }
        return true
    }

    /** AI 提醒卡文字色对复位（口径同 [clearNotifyTextColors]） */
    fun clearReminderTextColors(context: Context) {
        _reminderTextPair.value = null
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    WidgetColorStore.clearText(context, WidgetColorStore.KEY_AI_REMINDER)
                    ReminderWidget().updateAll(context)
                }
            }
        }
    }

    /** AI 提醒卡可读性遮罩开关（口径同 [setNotifyScrim]，直更走 ReminderWidget） */
    fun setReminderScrim(context: Context, on: Boolean) {
        _reminderScrimOn.value = on
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    persistScrimPref(context, WidgetColorStore.KEY_AI_REMINDER, on)
                    ReminderWidget().updateAll(context)
                }
            }
        }
    }

    /** 遮罩原生 prefs 写入口（T6 同源口径，见 [setNotifyScrim] 类头说明）：关=putBoolean(false)，开=remove 回默认开 */
    private fun persistScrimPref(context: Context, cardKey: String, on: Boolean) {
        val editor = context
            .getSharedPreferences(WidgetColorStore.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
        val key = "${cardKey}_scrim"
        if (on) editor.remove(key) else editor.putBoolean(key, false)
        editor.apply()
    }

    /** 设置 GPS 采集间隔（毫秒） */
    fun setGpsIntervalMs(ms: Long) {
        _gpsIntervalMs.value = ms
        // TODO 新增键：采集层接入后统一到 DataCollectorService 访问器
        dataCollectorPrefs().edit().putLong(KEY_GPS_INTERVAL_MS, ms).apply()
    }

    /** 设置 GPS 精度优先级（"high" | "balanced" | "low_power"） */
    fun setGpsAccuracyPriority(priority: String) {
        _gpsAccuracyPriority.value = priority
        dataCollectorPrefs().edit().putString(KEY_GPS_ACCURACY_PRIORITY, priority).apply()
    }

    /** 设置 GPS 最小位移（米，0=不过滤） */
    fun setGpsMinDisplacementM(meters: Long) {
        _gpsMinDisplacementM.value = meters
        dataCollectorPrefs().edit().putLong(KEY_GPS_MIN_DISPLACEMENT_M, meters).apply()
    }

    /** 设置 GPS 最大可接受精度（米，0=不过滤） */
    fun setGpsMaxAccuracyM(meters: Long) {
        _gpsMaxAccuracyM.value = meters
        dataCollectorPrefs().edit().putLong(KEY_GPS_MAX_ACCURACY_M, meters).apply()
    }

    /** 设置 GPS 主动定位等待超时（毫秒，0=关闭，仅读缓存） */
    fun setGpsFixTimeoutMs(ms: Long) {
        _gpsFixTimeoutMs.value = ms
        dataCollectorPrefs().edit().putLong(KEY_GPS_FIX_TIMEOUT_MS, ms).apply()
    }

    /** 设置 GPS 逆地理编码开关 */
    fun setGpsReverseGeocode(enabled: Boolean) {
        _gpsReverseGeocode.value = enabled
        dataCollectorPrefs().edit().putBoolean(KEY_GPS_REVERSE_GEOCODE, enabled).apply()
    }

    // ---------- 端侧唤醒（KWS）----------

    /** 端侧唤醒开关（切换后由采集线程在下一帧生效：加载或释放模型） */
    fun setLocalKwsEnabled(enabled: Boolean) {
        _localKwsEnabled.value = enabled
        DataCollectorService.setLocalKwsEnabled(appContext, enabled)
    }

    /** KWS 唤醒词加权分（灵敏度，越大越难触发） */
    fun setKwsScore(value: Float) {
        _kwsScore.value = value
        DataCollectorService.setKwsScore(appContext, value)
        // 引擎参数在加载时固化 → 请求采集线程重建（内部有节流），改动立即生效
        AudioCollector.requestKwsReload()
    }

    /** KWS 判定阈值 */
    fun setKwsThreshold(value: Float) {
        _kwsThreshold.value = value
        DataCollectorService.setKwsThreshold(appContext, value)
        AudioCollector.requestKwsReload()
    }

    /** 唤醒词输入（中文，仅本地状态；点击「转换」后才落盘生效） */
    fun setKwsKeywordsInput(value: String) {
        _kwsKeywordsInput.value = value
    }

    /** 端侧唤醒推理间隔（毫秒）。改动后由采集线程重建引擎，立即生效。 */
    fun setKwsIntervalMs(value: Int) {
        val v = value.coerceIn(100, 1000)
        _kwsIntervalMs.value = v
        DataCollectorService.setKwsIntervalMs(appContext, v)
        AudioCollector.requestKwsReload()
    }

    /** 云端唤醒测试模式开关（下次推流生效） */
    fun setKwsCloudTestEnabled(enabled: Boolean) {
        _kwsCloudTestEnabled.value = enabled
        DataCollectorService.setKwsCloudTestEnabled(appContext, enabled)
    }

    /** 清空自定义唤醒词，回退到 assets 内置词表，并把服务端词表恢复为默认「小贺同学」。 */
    fun clearKwsKeywords() {
        _kwsKeywordsToken.value = ""
        DataCollectorService.setKwsKeywords(appContext, "")
        // 词表变更 → 重建引擎，让新词表立即生效
        AudioCollector.requestKwsReload()
        _kwsEncodeStatus.value = "已回退为内置唤醒词"
        // 服务端词表同步恢复默认；失败时仅追加提示，不影响本地回退
        viewModelScope.launch {
            if (!syncWakeWordKeywords(DEFAULT_WAKE_KEYWORD)) {
                _kwsEncodeStatus.value = "已回退为内置唤醒词，服务端同步失败"
            }
        }
    }

    /**
     * 同步服务端 KWS 唤醒词词表（下发中文原文，由服务端自行转 token）。
     *
     * 与 [encodeKwsKeywords] 的 encode 调用保持一致的写法与异常处理风格：
     * 网络异常一律吞掉并返回 false，由调用方决定提示文案。
     *
     * @param text 中文原文唤醒词（多个用逗号或换行分隔）
     * @return true 表示服务端已确认接受
     */
    private suspend fun syncWakeWordKeywords(text: String): Boolean {
        return try {
            val body = JSONObject().put("keywords", text)
            val response = withContext(Dispatchers.IO) {
                httpClient.post(
                    "${_serverUrl.value}/api/screen/wake_word/keywords",
                    body.toString()
                )
            }
            JSONObject(response).optBoolean("ok")
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 调服务端把中文唤醒词编码为 KWS token 并持久化，同时同步服务端唤醒词词表。
     *
     * sherpa-onnx 只接受拼音 token，中文需服务端用 text2token 转换；
     * 本地 token 生效后再把中文原文下发，使服务端唤醒确认使用同一词表。
     */
    fun encodeKwsKeywords() {
        val text = _kwsKeywordsInput.value.trim()
        if (text.isEmpty()) {
            _kwsEncodeStatus.value = "请先输入唤醒词（中文）"
            return
        }
        if (_kwsEncoding.value) return
        viewModelScope.launch {
            _kwsEncoding.value = true
            _kwsEncodeStatus.value = "转换中..."
            try {
                val body = JSONObject().put("text", text)
                val response = withContext(Dispatchers.IO) {
                    httpClient.post(
                        "${_serverUrl.value}/api/screen/wake_word/encode",
                        body.toString()
                    )
                }
                val json = JSONObject(response)
                if (!json.optBoolean("ok")) {
                    val msg = json.optString("message").ifBlank { "未知错误" }
                    _kwsEncodeStatus.value = "转换失败：$msg"
                    return@launch
                }
                val kws = json.optString("keywords")
                if (kws.isBlank()) {
                    _kwsEncodeStatus.value = "转换失败：返回为空"
                    return@launch
                }
                _kwsKeywordsToken.value = kws
                DataCollectorService.setKwsKeywords(appContext, kws)
                // 词表变更 → 重建引擎，让新词表立即生效
                AudioCollector.requestKwsReload()
                // 本地 token 生效后，同一次操作里把中文原文同步到服务端 KWS 词表
                val count = kws.split("\n").size
                val synced = syncWakeWordKeywords(text)
                _kwsEncodeStatus.value = if (synced) {
                    "已应用并同步到服务端（$count 条）"
                } else {
                    "本地已应用，服务端同步失败（$count 条）"
                }
            } catch (e: Exception) {
                _kwsEncodeStatus.value = "请求失败：" + (e.message ?: "网络错误")
            } finally {
                _kwsEncoding.value = false
            }
        }
    }

    /** 设置系统状态采集间隔（毫秒） */
    fun setSystemStateIntervalMs(ms: Long) {
        _systemStateIntervalMs.value = ms
        // TODO 新增键：采集层接入后统一到 DataCollectorService 访问器
        dataCollectorPrefs().edit().putLong(KEY_SYSTEM_STATE_INTERVAL_MS, ms).apply()
    }

    /** 设置音频分段单段硬上限（毫秒） */
    fun setAudioSegmentMs(ms: Long) {
        _audioSegmentMs.value = ms
        // TODO 新增键：采集层接入后统一到 DataCollectorService 访问器
        dataCollectorPrefs().edit().putLong(KEY_AUDIO_SEGMENT_MS, ms).apply()
    }

    /** 设置音频批量上传间隔（毫秒），与分段时长解耦 */
    fun setAudioUploadBatchMs(ms: Long) {
        _audioUploadBatchMs.value = ms
        // 采集层通过 DataCollectorService.getAudioUploadBatchMs 读取同一键
        dataCollectorPrefs().edit().putLong(KEY_AUDIO_UPLOAD_BATCH_MS, ms).apply()
    }

    /**
     * 设置上传音频格式（"wav" | "flac"）。
     *
     * 键与采集层 [DataCollectorService.KEY_AUDIO_UPLOAD_FORMAT] 同一常量（单一真源）；
     * 非法值归一为 "wav"。采集循环每段现读，改完下一段生效、无需重启。
     */
    fun setAudioUploadFormat(fmt: String) {
        val normalized = if (fmt == "flac") "flac" else "wav"
        _audioUploadFormat.value = normalized
        dataCollectorPrefs().edit()
            .putString(DataCollectorService.KEY_AUDIO_UPLOAD_FORMAT, normalized).apply()
    }

    /** 设置敏感应用黑名单（逗号分隔包名） */
    fun setSensitiveApps(csv: String) {
        _sensitiveApps.value = csv
        // TODO 新增键 notify_sensitive_apps：采集层接入后统一到 DataCollectorService 访问器
        dataCollectorPrefs().edit().putString(KEY_NOTIFY_SENSITIVE_APPS, csv).apply()
    }

    /** 设置提示音音量（0-100），采集器每次播放前读取，改动即时生效 */
    fun setHintToneVolume(value: Int) {
        val v = value.coerceIn(0, 100)
        _hintToneVolume.value = v
        dataCollectorPrefs().edit().putLong(KEY_HINT_TONE_VOLUME, v.toLong()).apply()
    }

    /** 设置 TTS 语音音量（0-100），同时下发到 WebView 内播放器与本地试听 */
    fun setTtsVolume(value: Int) {
        val v = value.coerceIn(0, 100)
        _ttsVolume.value = v
        dataCollectorPrefs().edit().putLong(KEY_TTS_VOLUME, v.toLong()).apply()
    }

    // ── 音量试听 ───────────────────────────────────────────────────

    /** 试听提示音：以当前音量播放一次「唤醒确认」双音序列 */
    fun testHintTone() {
        previewTonePlayer.setVolume(_hintToneVolume.value)
        previewTonePlayer.playStart()
    }

    /**
     * 试听 TTS：请求后端合成一句测试语音，并以当前音量在本地播放。
     *
     * 后端 `POST /api/screen/tts/synthesize` 返回 base64 WAV（HTTP 200，错误在 body 的
     * status 字段）。合成失败（如未配置 MiMo Key）时把错误文案写入 [ttsTestStatus]。
     */
    fun testTts() {
        if (_ttsTestLoading.value) return
        viewModelScope.launch {
            _ttsTestLoading.value = true
            _ttsTestStatus.value = "合成中..."
            try {
                val body = JSONObject().put("text", TTS_TEST_TEXT)
                val response = withContext(Dispatchers.IO) {
                    httpClient.post("${_serverUrl.value}/api/screen/tts/synthesize", body.toString())
                }
                val json = JSONObject(response)
                if (json.optString("status") != "success") {
                    val error = json.optString("error").ifBlank { "未知错误" }
                    _ttsTestStatus.value = "试听失败：$error"
                    return@launch
                }
                val audioBase64 = json.optString("audio")
                if (audioBase64.isBlank()) {
                    _ttsTestStatus.value = "试听失败：返回音频为空"
                    return@launch
                }
                val bytes = android.util.Base64.decode(audioBase64, android.util.Base64.DEFAULT)
                val tmp = File(appContext.cacheDir, "tts_test.wav")
                withContext(Dispatchers.IO) { tmp.writeBytes(bytes) }
                playTtsSample(tmp, _ttsVolume.value)
            } catch (e: Exception) {
                _ttsTestStatus.value = "试听失败：" + (e.message ?: "网络错误")
            } finally {
                _ttsTestLoading.value = false
            }
        }
    }

    /** 以指定音量本地播放试听音频（MediaPlayer，音量 0-100） */
    private fun playTtsSample(file: File, volume: Int) {
        try {
            ttsTestPlayer?.release()
            ttsTestPlayer = android.media.MediaPlayer().apply {
                setAudioAttributes(
                    android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                setDataSource(file.absolutePath)
                setVolume(volume / 100f, volume / 100f)
                setOnCompletionListener { mp ->
                    _ttsTestStatus.value = "试听完成"
                    try { mp.release() } catch (_: Exception) {}
                    if (ttsTestPlayer === mp) ttsTestPlayer = null
                }
                setOnErrorListener { mp, _, _ ->
                    _ttsTestStatus.value = "试听失败：播放器错误"
                    try { mp.release() } catch (_: Exception) {}
                    if (ttsTestPlayer === mp) ttsTestPlayer = null
                    true
                }
                prepare()
                start()
            }
            _ttsTestStatus.value = "试听中..."
        } catch (e: Exception) {
            _ttsTestStatus.value = "试听失败：" + (e.message ?: "播放错误")
        }
    }

    override fun onCleared() {
        session.close()
        try { previewTonePlayer.release() } catch (_: Exception) {}
        try { ttsTestPlayer?.release() } catch (_: Exception) {}
        ttsTestPlayer = null
        super.onCleared()
    }

    /**
     * 枚举已安装应用（标签 + 图标）并缓存。
     *
     * 全量枚举与图标转位图都在 IO 线程完成，避免阻塞主线程；
     * 结果缓存到 [_installedApps]，重复调用直接复用（[force] 可强制刷新）。
     */
    fun loadInstalledApps(force: Boolean = false) {
        if (installedAppsLoaded && !force) return
        viewModelScope.launch {
            _installedAppsLoading.value = true
            try {
                val pm = appContext.packageManager
                val items = withContext(Dispatchers.IO) {
                    pm.getInstalledApplications(0)
                        .map { info ->
                            val label = runCatching {
                                pm.getApplicationLabel(info).toString()
                            }.getOrDefault(info.packageName)
                            val icon = runCatching {
                                info.loadIcon(pm).toBitmap().asImageBitmap()
                            }.getOrNull()
                            InstalledAppItem(info.packageName, label, icon)
                        }
                        .distinctBy { it.packageName }
                        .sortedWith(compareBy({ it.label.lowercase() }, { it.packageName }))
                }
                _installedApps.value = items
                installedAppsLoaded = true
            } catch (_: Exception) {
                // 枚举失败保持空列表，选择器仍可用「手动添加包名」兜底
            } finally {
                _installedAppsLoading.value = false
            }
        }
    }

    // ── DB Path ───────────────────────────────────────────────────

    /** 设置 Gadgetbridge 数据库路径 */
    fun setDbPath(path: String) {
        _dbFilePath.value = path
        DataCollectorService.setDbPath(appContext, path)
    }

    /** 设置 Gadgetbridge 数据库 content URI（SAF 持久化） */
    fun setDbUri(uri: String) {
        DataCollectorService.setDbUri(appContext, uri)
    }

    // ── OTA ───────────────────────────────────────────────────────

    /** 检查 OTA 更新 */
    fun checkUpdate() {
        viewModelScope.launch {
            _otaChecking.value = true
            _otaStatusText.value = "检查中..."
            try {
                val baseUrl = _serverUrl.value
                val token = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(KEY_TOKEN, "") ?: ""
                val response = withContext(Dispatchers.IO) {
                    httpClient.get("$baseUrl/api/ota/info?token=$token")
                }
                val json = JSONObject(response)
                if (json.optString("status") == "active") {
                    val fileSize = json.optLong("fileSize", 0L)
                    val sizeMb = fileSize / (1024 * 1024)
                    _otaStatusText.value = "发现更新 (${sizeMb}MB)"
                    _otaDownloadUrl.value = "$baseUrl/api/ota/download?token=$token"
                    _otaChangelog.value = json.optString("changelog", "")
                    // 后端若提供哈希则记录，安装前用于完整性校验（支持 sha256/md5/hash 字段）
                    _otaExpectedHash.value = when {
                        json.has("sha256") -> json.getString("sha256")
                        json.has("md5") -> json.getString("md5")
                        json.has("hash") -> json.getString("hash")
                        else -> null
                    }
                } else {
                    _otaStatusText.value = "已是最新版本"
                    _otaChangelog.value = ""
                    _otaDownloadUrl.value = ""
                    _otaExpectedHash.value = null
                }
            } catch (e: Exception) {
                _otaStatusText.value = "检查失败: ${e.message}"
            }
            _otaChecking.value = false
        }
    }

    /** 下载并安装 OTA 更新 */
    fun downloadUpdate() {
        viewModelScope.launch {
            _otaStatusText.value = "下载中..."
            try {
                val token = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(KEY_TOKEN, "") ?: ""
                val downloader = ApkDownloader(httpClient, authToken = token)
                val targetFile = File(appContext.cacheDir, "axeuh_update.apk")
                downloader.download(_otaDownloadUrl.value, targetFile).collect { p ->
                    when (p) {
                        is OtaDownloadProgress.Started -> {
                            _otaStatusText.value = "下载中..."
                        }
                        is OtaDownloadProgress.InProgress -> {
                            _otaProgress.value = p.progressPercent
                        }
                        is OtaDownloadProgress.Completed -> {
                            _otaStatusText.value = "校验中..."
                            // 期望哈希优先级：后端元数据 sha256/md5 > 下载响应头 Content-MD5
                            val expectedHash = _otaExpectedHash.value ?: p.serverMd5
                            val installer = ApkInstaller(appContext)
                            val result = installer.install(p.file, expectedHash)
                            _otaStatusText.value = if (result is InstallResult.Success) {
                                "更新完成"
                            } else {
                                "安装失败: ${(result as InstallResult.Failure).error}"
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                _otaStatusText.value = "更新失败: ${e.message}"
            }
        }
    }

    // ── Sync ──────────────────────────────────────────────────────

    /** 立即同步数据 */
    fun syncNow() {
        _syncStatusText.value = "同步中..."
        DataCollectorService.triggerSync(appContext)
        viewModelScope.launch {
            kotlinx.coroutines.delay(3000)
            _syncStatusText.value = "同步完成"
        }
    }

    /** 重新采集系统权限与电池优化状态；页面进入与「重新检查」按钮均调用。 */
    fun refreshRunStatus() {
        val ignored = isIgnoringBatteryOptimizations()
        _batteryOptimized.value = ignored
        _permissionChecks.value = RunStatusModel.permissions(
            PermissionInputs(
                notificationEnabled = _notificationEnabled.value,
                foregroundEnabled = _foregroundEnabled.value,
                inputContentEnabled = _inputContentEnabled.value,
                gpsEnabled = _gpsEnabled.value,
                wifiEnabled = _wifiEnabled.value,
                healthEnabled = _healthEnabled.value,
                audioEnabled = _audioEnabled.value,
                bluetoothEnabled = _bluetoothEnabled.value,
                notificationGranted = hasNotificationListenerPermission(appContext),
                usageStatsGranted = hasUsageStatsPermission(appContext),
                accessibilityGranted = hasAccessibilityServiceEnabled(appContext),
                locationGranted = hasLocationPermission(appContext),
                storageGranted = hasHealthDataAccess(appContext),
                microphoneGranted = hasRuntimePermission(
                    appContext,
                    Manifest.permission.RECORD_AUDIO
                ),
                bluetoothGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
                    hasRuntimePermission(appContext, Manifest.permission.BLUETOOTH_CONNECT),
                uploadEnabled = _uploadEnabled.value,
                batteryOptimized = ignored,
            )
        )
    }

    // ── SSL ───────────────────────────────────────────────────────

    /**
     * 设置 SSL 证书验证开关
     *
     * 持久化到 `axeuh_prefs["ssl_verify"]`，更新状态并重建所有活跃的
     * HTTP 客户端，使新策略立即生效。
     *
     * @param enabled true=验证服务器证书（推荐），false=接受任意证书
     */
    fun setSslVerify(enabled: Boolean) {
        appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_SSL_VERIFY, enabled)
            .apply()
        _sslVerify.value = enabled
        AppHttpClient.rebuildAll()
    }

    // ── Sensor Preview ────────────────────────────────────────────

    /**
     * 从 SensorStateHolder 快照刷新传感器预览状态
     *
     * 由 Activity 的 LaunchedEffect 每 2 秒调用一次。
     */
    fun refreshSensorPreviews() {
        _sensorPreviewState.value = computeSensorPreview()
    }

    // ── Dialog State ──────────────────────────────────────────────

    fun showNotificationListenerDialog() { _showNotificationListenerDialog.value = true }
    fun dismissNotificationListenerDialog() { _showNotificationListenerDialog.value = false }

    fun showVoiceprintPanel() { _showVoiceprintPanel.value = true }
    fun dismissVoiceprintPanel() { _showVoiceprintPanel.value = false }

    // ═══════════════════════════════════════════════════════════════
    //  Private Methods
    // ═══════════════════════════════════════════════════════════════

    private fun isIgnoringBatteryOptimizations(): Boolean = try {
        val pm = appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
        pm?.isIgnoringBatteryOptimizations(appContext.packageName) ?: false
    } catch (_: Exception) {
        false
    }

    private fun applySessionState(state: SessionState) {        when (state) {
            is SessionState.Authenticated -> {
                _isLoggedIn.value = true
                _savedUsername.value = state.username
                _loginStatus.value = "已连接"
                _loginError.value = ""
            }
            is SessionState.Expired -> {
                _isLoggedIn.value = false
                _savedUsername.value = ""
                _loginStatus.value = "登录已失效"
            }
            SessionState.LoggedOut -> {
                _isLoggedIn.value = false
                _savedUsername.value = ""
                _loginStatus.value = "未连接"
            }
            SessionState.Authenticating -> {
                _loginStatus.value = "登录中..."
            }
        }
    }

    /**
     * 从 SharedPreferences 加载所有初始状态
     */
    private fun loadInitialState() {
        ServerConfig.init(appContext)
        val axeuhPrefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val sensorPrefs = appContext.getSharedPreferences(PREFS_SENSORS, Context.MODE_PRIVATE)
        val dataPrefs = appContext.getSharedPreferences(PREFS_DATA_COLLECTOR, Context.MODE_PRIVATE)

        // Login
        val savedUrl = ServerConfig.BASE_URL
        _serverUrl.value = savedUrl
        applySessionState(session.state.value)

        // Sensor toggles
        _audioEnabled.value = DataCollectorService.isAudioEnabled(appContext)
        _foregroundEnabled.value = DataCollectorService.isForegroundEnabled(appContext)
        _notificationEnabled.value = DataCollectorService.isNotificationEnabled(appContext)
        _healthEnabled.value = DataCollectorService.isHealthEnabled(appContext)
        _gpsEnabled.value = DataCollectorService.isGpsEnabled(appContext)
        _wifiEnabled.value = DataCollectorService.isWifiEnabled(appContext)
        _bluetoothEnabled.value = DataCollectorService.isBluetoothEnabled(appContext)
        _screenStateEnabled.value = DataCollectorService.isScreenStateEnabled(appContext)
        _inputContentEnabled.value = DataCollectorService.isInputContentEnabled(appContext)
        _uploadEnabled.value = DataCollectorService.isUploadEnabled(appContext)
        _cacheEnabled.value = DataCollectorService.isCacheEnabled(appContext)
        _widgetsEnabled.value = DataCollectorService.isWidgetsEnabled(appContext)

        // 卡片背景回显（prefs 只存显示文件名，真源见 WidgetBackgroundStore）
        _notifyBgName.value = WidgetBackgroundStore.displayName(appContext, WidgetBackgroundStore.KEY_AI_NOTIFY)
        _reminderBgName.value = WidgetBackgroundStore.displayName(appContext, WidgetBackgroundStore.KEY_AI_REMINDER)

        // 卡片配色回显（真源见 WidgetColorStore；色对 null=未设置，遮罩缺键⇒默认开）
        _notifyBgPair.value = WidgetColorStore.readBackground(appContext, WidgetColorStore.KEY_AI_NOTIFY).asStoredPair()
        _notifyTextPair.value = WidgetColorStore.readText(appContext, WidgetColorStore.KEY_AI_NOTIFY).asStoredPair()
        _notifyScrimOn.value = WidgetColorStore.readScrim(appContext, WidgetColorStore.KEY_AI_NOTIFY)
        _reminderBgPair.value = WidgetColorStore.readBackground(appContext, WidgetColorStore.KEY_AI_REMINDER).asStoredPair()
        _reminderTextPair.value = WidgetColorStore.readText(appContext, WidgetColorStore.KEY_AI_REMINDER).asStoredPair()
        _reminderScrimOn.value = WidgetColorStore.readScrim(appContext, WidgetColorStore.KEY_AI_REMINDER)

        // 端侧唤醒（KWS）
        _localKwsEnabled.value = DataCollectorService.isLocalKwsEnabled(appContext)
        _kwsScore.value = DataCollectorService.getKwsScore(appContext)
        _kwsThreshold.value = DataCollectorService.getKwsThreshold(appContext)
        _kwsKeywordsToken.value = DataCollectorService.getKwsKeywords(appContext)
        _kwsCloudTestEnabled.value = DataCollectorService.isKwsCloudTestEnabled(appContext)
        _kwsIntervalMs.value = DataCollectorService.getKwsIntervalMs(appContext)

        // Intervals
        _collectionInterval.value = DataCollectorService.getLoopInterval(appContext).toInt()
        _notifyInterval.value = DataCollectorService.getNotifyInterval(appContext).toInt()

        // 新增设置项（文件 data_collector，键名见 plans/settings-redesign.md 第三节）
        _healthUploadMode.value = dataCollectorPrefs().getString(KEY_HEALTH_UPLOAD_MODE, "interval") ?: "interval"
        _healthScheduleTimes.value = dataCollectorPrefs().getString(KEY_HEALTH_SCHEDULE_TIMES, "") ?: ""
        _healthIntervalMs.value = dataCollectorPrefs().getLong(KEY_HEALTH_INTERVAL_MS, 3_600_000L)
        _notifyUploadEnabled.value = dataCollectorPrefs().getBoolean(KEY_NOTIFY_UPLOAD_ENABLED, false)
        _gpsIntervalMs.value = dataCollectorPrefs().getLong(KEY_GPS_INTERVAL_MS, 300_000L)
        _gpsAccuracyPriority.value = dataCollectorPrefs().getString(
            KEY_GPS_ACCURACY_PRIORITY, DataCollectorService.GPS_PRIORITY_BALANCED
        ) ?: DataCollectorService.GPS_PRIORITY_BALANCED
        _gpsMinDisplacementM.value = dataCollectorPrefs().getLong(KEY_GPS_MIN_DISPLACEMENT_M, 0L)
        _gpsMaxAccuracyM.value = dataCollectorPrefs().getLong(KEY_GPS_MAX_ACCURACY_M, 0L)
        _gpsFixTimeoutMs.value = dataCollectorPrefs().getLong(KEY_GPS_FIX_TIMEOUT_MS, 0L)
        _gpsReverseGeocode.value = dataCollectorPrefs().getBoolean(KEY_GPS_REVERSE_GEOCODE, false)
        _systemStateIntervalMs.value = dataCollectorPrefs().getLong(KEY_SYSTEM_STATE_INTERVAL_MS, 1_000L)
        _audioSegmentMs.value = dataCollectorPrefs().getLong(KEY_AUDIO_SEGMENT_MS, 60_000L)
        _audioUploadBatchMs.value = dataCollectorPrefs().getLong(KEY_AUDIO_UPLOAD_BATCH_MS, 600_000L)
        _audioUploadFormat.value = dataCollectorPrefs()
            .getString(DataCollectorService.KEY_AUDIO_UPLOAD_FORMAT, "wav")
            ?.takeIf { it == "flac" } ?: "wav"
        _hintToneVolume.value = dataCollectorPrefs()
            .getLong(KEY_HINT_TONE_VOLUME, HintTonePlayer.DEFAULT_VOLUME.toLong()).toInt()
        _ttsVolume.value = dataCollectorPrefs().getLong(KEY_TTS_VOLUME, 100L).toInt()
        _batteryEnabled.value = DataCollectorService.isBatteryEnabled(appContext)
        _sensitiveApps.value = dataCollectorPrefs().getString(KEY_NOTIFY_SENSITIVE_APPS, "") ?: ""

        // DB path
        _dbFilePath.value = DataCollectorService.getDbPath(appContext)

        // Device name
        _deviceName.value = DataCollectorService.getDeviceName(appContext)

        // SSL 证书验证开关（缺省 true = 校验；显式 false 保留自签名/IP 直连逃生口）
        _sslVerify.value = axeuhPrefs.getBoolean(KEY_SSL_VERIFY, true)
    }

    /**
     * POST /login -- 使用 HttpURLConnection 发送登录请求
     *
     * 保留与 SettingsActivity 相同的 trust-all SSL 行为。
     */
    private suspend fun performLogin(username: String, password: String): String? =
        withContext(Dispatchers.IO) {
            try {
                val body = JSONObject().apply {
                    put("username", username)
                    put("password", password)
                }
                val response = httpClient.post("${_serverUrl.value}/login", body.toString())
                val json = JSONObject(response)
                if (json.optBoolean("success", false) && !json.isNull("token")) {
                    json.getString("token")
                } else {
                    null
                }
            } catch (_: Exception) {
                null
            }
        }

    fun saveDeviceName(name: String) {
        _deviceName.value = name
        DataCollectorService.setDeviceName(appContext, name)
        com.xehuri.kinship.config.ServerConfig.updateDeviceName(name)
    }

    /**
     * 计算当前传感器预览状态
     *
     * 从 SensorStateHolder 快照值读取，并解析 debugStateJson 获取
     * 前台应用、WiFi、蓝牙、屏幕、通知数等合成字段。
     */
    private fun computeSensorPreview(): SensorPreviewState {
        val debug = try {
            JSONObject(sensorStateHolder.snapshotDebugState())
        } catch (_: Exception) {
            null
        }

        var foregroundText = ""
        var notifText = ""
        var wifiText = ""
        var btText = ""
        var screenText = ""
        var healthText = sensorStateHolder.snapshotLastSensorText()

        if (debug != null) {
            // 前台应用
            val usageArr = debug.optJSONArray("usage_stats")
            foregroundText = if (usageArr != null && usageArr.length() > 0) {
                usageArr.getJSONObject(0).optString("name", "")
            } else {
                debug.optString("foreground_app", "")
            }

            // 通知数
            val notifCount = debug.optInt("notification_count", -1)
            notifText = when {
                notifCount > 0 -> "通知 ${notifCount}条"
                notifCount == 0 -> "无通知"
                else -> ""
            }

            // WiFi / 蓝牙 / 屏幕
            wifiText = debug.optString("wifi", "")
            btText = debug.optString("bluetooth", "")
            screenText = debug.optString("screen", "")

            // 健康摘要
            val healthParts = mutableListOf<String>()
            debug.optInt("hr", -1).let { if (it > 0) healthParts.add("心率 ${it}bpm") }
            debug.optInt("steps", -1).let { if (it > 0) healthParts.add("步数 $it") }
            debug.optInt("stress", -1).let { if (it > 0) healthParts.add("压力 $it") }
            debug.optInt("spo2", -1).let { if (it > 0) healthParts.add("血氧 ${it}%") }
            if (healthParts.isNotEmpty()) healthText = healthParts.joinToString(" · ")
        }

        return SensorPreviewState(
            vadText = sensorStateHolder.snapshotVadStatus(),
            dbText = "%.1f dBFS".format(sensorStateHolder.snapshotDbLevel().toDouble()),
            healthText = healthText,
            responseText = sensorStateHolder.snapshotLastResponseText(),
            foregroundText = foregroundText,
            notifText = notifText,
            mediaText = sensorStateHolder.snapshotLastMediaText(),
            gpsText = sensorStateHolder.snapshotLastGps(),
            wifiText = wifiText,
            btText = btText,
            screenText = screenText
        )
    }
}

/**
 * store 色对读数 → 设置页回显口径：两键齐备才算"已设置"，全空归 null。
 * store 读侧已把半对拒之门外（readPair 只认全有/全无），本函数只做表示法转换。
 */
private fun Pair<Int?, Int?>.asStoredPair(): Pair<Int?, Int?>? =
    if (first != null && second != null) this else null

/**
 * 创建 AndroidKeyStore 支撑的加密偏好实例。
 *
 * 抽为顶层私有函数，以便作为 [SettingsViewModel] 构造参数的默认值使用。
 */
private fun createEncryptedPrefs(context: Context): android.content.SharedPreferences {
    val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
    return EncryptedSharedPreferences.create(
        context,
        "axeuh_secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )
}
