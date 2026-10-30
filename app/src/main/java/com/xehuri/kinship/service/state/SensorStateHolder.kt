package com.xehuri.kinship.service.state

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 麦克风有效性状态。
 *
 * - [VALID]         正常采集（存在非零音频）
 * - [SILENT_ZERO]   全零帧 / RMS 恒为 0 的零直流（疑似麦克风未真正激活或被占用）
 * - [STATE_INVALID] AudioRecord 状态非 RECORDING（录音被打断）
 * - [OCCUPIED]      无效条件持续达到防抖窗口（约 10s），判定为麦克风被占用
 */
enum class MicStatus {
    VALID,
    SILENT_ZERO,
    STATE_INVALID,
    OCCUPIED
}

/**
 * 统一传感器状态持有者。
 *
 * 管理 DataCollectorService 中所有传感器状态，使用 Kotlin StateFlow 提供可观察的数据流。
 * 设计为普通类（非单例），由 DataCollectorService 实例化。
 *
 * 纯 Kotlin + Coroutines，无 Android 依赖。
 */
class SensorStateHolder {

    companion object {
        /**
         * 进程内共享实例。
         *
         * 本类本身是普通类、可独立构造（单元测试依赖这一点），但采集端
         * （DataCollectorService）与设置页 UI 必须读写同一个实例，否则 UI 只能读到初值。
         * 历史上两处各 new 一个实例，导致设置页的传感器预览（含 dB 电平）恒为初值。
         */
        val shared: SensorStateHolder by lazy { SensorStateHolder() }
    }

    // ── VAD 状态 ──
    private val _vadStatus = MutableStateFlow("idle")
    val vadStatus: StateFlow<String> = _vadStatus.asStateFlow()

    // ── 当前麦克风音量 dBFS ──
    private val _currentDbLevel = MutableStateFlow(-80f)
    val currentDbLevel: StateFlow<Float> = _currentDbLevel.asStateFlow()

    // ── 调试快照 JSON ──
    private val _debugStateJson = MutableStateFlow("{}")
    val debugStateJson: StateFlow<String> = _debugStateJson.asStateFlow()

    // ── 最近一次传感器文本 ──
    private val _lastSensorText = MutableStateFlow("")
    val lastSensorText: StateFlow<String> = _lastSensorText.asStateFlow()

    // ── 最近一次响应文本 ──
    private val _lastResponseText = MutableStateFlow("")
    val lastResponseText: StateFlow<String> = _lastResponseText.asStateFlow()

    // ── GPS 位置 ──
    private val _lastGps = MutableStateFlow("")
    val lastGps: StateFlow<String> = _lastGps.asStateFlow()

    // ── GPS 逆地理编码地址（独立于坐标，空串表示无地址）──
    private val _lastGpsAddress = MutableStateFlow("")
    val lastGpsAddress: StateFlow<String> = _lastGpsAddress.asStateFlow()

    // ── 媒体播放状态文本 ──
    private val _lastMediaText = MutableStateFlow("")
    val lastMediaText: StateFlow<String> = _lastMediaText.asStateFlow()

    // ── 心率 (bpm) ──
    private val _lastHeartRate = MutableStateFlow(-1)
    val lastHeartRate: StateFlow<Int> = _lastHeartRate.asStateFlow()

    // ── 步数 ──
    private val _lastSteps = MutableStateFlow(-1)
    val lastSteps: StateFlow<Int> = _lastSteps.asStateFlow()

    // ── 压力 ──
    private val _lastStress = MutableStateFlow(-1)
    val lastStress: StateFlow<Int> = _lastStress.asStateFlow()

    // ── 血氧饱和度 (%) ──
    private val _lastSpo2 = MutableStateFlow(-1)
    val lastSpo2: StateFlow<Int> = _lastSpo2.asStateFlow()

    // ── 活跃通知数量 ──
    private val _lastNotificationCount = MutableStateFlow(0)
    val lastNotificationCount: StateFlow<Int> = _lastNotificationCount.asStateFlow()

    // ── 麦克风有效性状态 ──
    private val _micStatus = MutableStateFlow(MicStatus.VALID)
    val micStatus: StateFlow<MicStatus> = _micStatus.asStateFlow()

    // ── 端侧唤醒（KWS）状态 ──

    /** KWS 状态：未启用 / 加载中 / 监听中 / 已命中 */
    private val _kwsStatus = MutableStateFlow("未启用")
    val kwsStatus: StateFlow<String> = _kwsStatus.asStateFlow()

    /** 本次运行累计命中次数 */
    private val _kwsHitCount = MutableStateFlow(0)
    val kwsHitCount: StateFlow<Int> = _kwsHitCount.asStateFlow()

    /** 最近一次命中（格式：唤醒词 · HH:mm:ss），空串表示尚未命中 */
    private val _kwsLastHit = MutableStateFlow("")
    val kwsLastHit: StateFlow<String> = _kwsLastHit.asStateFlow()

    /** 云端 KWS 测试模式最近一次结果摘要（空串表示尚无） */
    private val _kwsCloudTestResult = MutableStateFlow("")
    val kwsCloudTestResult: StateFlow<String> = _kwsCloudTestResult.asStateFlow()

    // ── Update 方法 ──

    fun updateVadStatus(value: String) { _vadStatus.value = value }
    fun updateDbLevel(value: Float) { _currentDbLevel.value = value }
    fun updateDebugState(json: String) { _debugStateJson.value = json }
    fun updateLastSensorText(value: String) { _lastSensorText.value = value }
    fun updateLastResponseText(value: String) { _lastResponseText.value = value }
    fun updateLastGps(value: String) { _lastGps.value = value }
    fun updateLastGpsAddress(value: String) { _lastGpsAddress.value = value }
    fun updateLastMediaText(value: String) { _lastMediaText.value = value }
    fun updateHeartRate(value: Int) { _lastHeartRate.value = value }
    fun updateSteps(value: Int) { _lastSteps.value = value }
    fun updateStress(value: Int) { _lastStress.value = value }
    fun updateSpo2(value: Int) { _lastSpo2.value = value }
    fun updateNotificationCount(value: Int) { _lastNotificationCount.value = value }
    fun updateMicStatus(value: MicStatus) { _micStatus.value = value }
    fun updateKwsStatus(value: String) { _kwsStatus.value = value }
    fun updateKwsHitCount(value: Int) { _kwsHitCount.value = value }
    fun updateKwsLastHit(value: String) { _kwsLastHit.value = value }
    fun updateKwsCloudTestResult(value: String) { _kwsCloudTestResult.value = value }

    // ── Snapshot 方法（非 suspend 获取当前值） ──

    fun snapshotVadStatus(): String = _vadStatus.value
    fun snapshotDbLevel(): Float = _currentDbLevel.value
    fun snapshotDebugState(): String = _debugStateJson.value
    fun snapshotLastSensorText(): String = _lastSensorText.value
    fun snapshotLastResponseText(): String = _lastResponseText.value
    fun snapshotLastGps(): String = _lastGps.value
    fun snapshotLastGpsAddress(): String = _lastGpsAddress.value
    fun snapshotLastMediaText(): String = _lastMediaText.value
    fun snapshotHeartRate(): Int = _lastHeartRate.value
    fun snapshotSteps(): Int = _lastSteps.value
    fun snapshotStress(): Int = _lastStress.value
    fun snapshotSpo2(): Int = _lastSpo2.value
    fun snapshotNotificationCount(): Int = _lastNotificationCount.value
    fun snapshotMicStatus(): MicStatus = _micStatus.value
    fun snapshotKwsStatus(): String = _kwsStatus.value
    fun snapshotKwsHitCount(): Int = _kwsHitCount.value
    fun snapshotKwsLastHit(): String = _kwsLastHit.value
    fun snapshotKwsCloudTestResult(): String = _kwsCloudTestResult.value
}
