package com.xehuri.kinship.service.collectors

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import timber.log.Timber
import com.xehuri.kinship.config.EndpointType
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.config.TransportMode
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.network.AudioStreamClient
import com.xehuri.kinship.p2p.AudioChunker
import com.xehuri.kinship.p2p.AudioMeta
import com.xehuri.kinship.p2p.P2pProtocol
import com.xehuri.kinship.p2p.P2pWebRtcManager
import com.xehuri.kinship.service.DataCollectorService
import com.xehuri.kinship.service.state.MicStatus
import com.xehuri.kinship.service.state.SensorStateHolder
import com.xehuri.kinship.service.uploader.CheckpointRecovery
import com.xehuri.kinship.service.uploader.FlacFinalizer
import com.xehuri.kinship.service.uploader.PcmCheckpointFormat
import com.xehuri.kinship.service.uploader.PcmCheckpointWriter
import com.xehuri.kinship.util.DeviceId
import com.xehuri.kinship.util.HintTonePlayer
import com.xehuri.kinship.wakeword.LocalKwsEngine
import kotlin.math.log10
import kotlin.math.sqrt
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * 音频采集器 —— 从 [com.xehuri.kinship.service.DataCollectorService] 提取的
 * AudioRecord PCM 录音 + 固定分段 + WAV 封装 + multipart 上传。
 *
 * 音源策略：只使用 VOICE_RECOGNITION（绕过蓝牙 MIC）。在后台线程中等 1s
 * 让硬件初始化，然后读 30ms 验证数据是否全零。全零则释放并 1s 后重试，
 * 通过则走完整录音周期。录音完成后再全零检查兜底，跳过上传。
 *
 * ## 采集参数
 * - 采样率: 16000 Hz (SR)
 * - 帧大小: 480 samples (30ms @ 16kHz)
 * - RMS 电平阈值: 8.0（仅用于 UI 电平显示、流式 VAD 展示状态与离线碎片静音切分，不参与分段切段）
 * - 连续静音 1500ms: 仅影响 UI 展示状态与流式碎片边界
 *
 * ## 三种采集模式（端侧唤醒优先于常驻流式）
 * 1. **端侧唤醒模式**（`data_collector["local_kws_enabled"]=true`，与
 *    `audio_stream_enabled` 取值无关）：走 [runSegmentedCaptureLoop] 分段采集，
 *    [LocalKwsEngine] 命中唤醒词后经 [startWakeStream] 按需推流（先回填预滚），
 *    收到服务端 `wake/end` 后回到分段采集。
 * 2. **常驻流式模式**（`local_kws_enabled=false` + `audio_stream_enabled=true`）：
 *    验证通过后连续读 100ms PCM 帧直送 [AudioStreamClient]（`/ws/audio-stream`）；
 *    WS 离线或收到 throttle 时，按 ~5 分钟物理分片（优先静音点切分）缓存到
 *    `upload_cache`，重连后经旧 multipart 端点补传并删除。时间戳一律由会话起始
 *    墙钟 + 样本数推算。
 * 3. **纯分段模式**（`local_kws_enabled=false` + `audio_stream_enabled=false`）：
 *    按固定时长 `audio_segment_ms` 封段（App 端不做语义/端点切分，语义连续性由后端
 *    无缝流负责），每段先落盘 `upload_cache`，再按 `audio_upload_batch_ms` 批量
 *    multipart 上传，无 KWS、无推流。
 *
 * ## 工作流程
 * ```
 * start() → AudioRecord.startRecording() [VOICE_RECOGNITION]
 *   → 后台线程等 1s → 30ms 全零验证 → 失败释放 1s 后重试
 *   → 录音线程模式选择（端侧唤醒优先于常驻流式）
 *       ├─ local_kws_enabled: runSegmentedCaptureLoop() → 命中 → startWakeStream()
 *       ├─ audio_stream_enabled: startStreaming() → 100ms 帧 → WS 直送 / 离线分片缓存
 *       └─ 两者皆关: runSegmentedCaptureLoop() → 固定分段 → checkpoint 落盘 → 批量上传
 * ```
 *
 * ## 数据流（分段模式）
 * ```
 * AudioRecord PCM → audioCaptureLoop（按 audio_segment_ms 固定分段 + 500ms 前滚重叠）
 *   → PcmCheckpointWriter.finalizeSegment()（先落盘，崩溃可由 CheckpointRecovery 恢复）
 *   → upload_cache/{startMs}-{seq}.wav + .json
 *   → 批量调度 uploadCachedData() 按节奏 multipart 上传
 *   → /api/screen/stt/voice-session-multipart（失败保留条目，下轮重试）
 * ```
 */
class AudioCollector(
    context: Context,
    stateHolder: SensorStateHolder,
    httpClient: AppHttpClient
) : BaseCollector(context, stateHolder, httpClient) {

    companion object {
        /** 采样率 16kHz */
        const val SR = 16000

        private const val WEBRTC_SEND_TIMEOUT_MS = 15_000L

        /** 帧大小 30ms @ 16kHz */
        const val FRAME_SIZE = 480

        /** 每帧毫秒数 */
        const val FRAME_MS = 30

        /**
         * RMS 电平阈值（16-bit 采样幅度，0~32768）。
         *
         * **不参与分段切段**（App 端只按 `audio_segment_ms` 固定封段）。当前用途：
         * - 流式模式的 VAD 展示状态判定，以及离线碎片在静音点的切分（`rms < RMS_THRESHOLD`）；
         * - UI 电平条的阈值参考线（经 dBFS 换算后展示）。
         */
        const val RMS_THRESHOLD = 8.0

        /**
         * 连续静音多久（ms）后 VAD 展示状态转为 idle。
         *
         * 仅用于 UI 展示状态与流式碎片边界，不参与分段切段。
         */
        const val SILENCE_MS = 1500

        /**
         * 分段前滚重叠样本数（[AudioSegmentPolicy.OVERLAP_MS] 毫秒 @ [SR]）。
         *
         * 切段时把上一段尾部这些采样作为下一段开头，避免首字被端点切掉。
         */
        const val SEGMENT_OVERLAP_SAMPLES = SR * AudioSegmentPolicy.OVERLAP_MS / 1000

        private const val CACHE_DIR_NAME = "upload_cache"

        /** 流式模式：每帧样本数（100ms @ 16kHz） */
        const val STREAM_FRAME_SAMPLES = 1600

        /** 流式模式：每帧字节数（s16le，2 字节/样本） */
        const val STREAM_FRAME_BYTES = STREAM_FRAME_SAMPLES * 2

        /** 离线物理分片目标时长（约 5 分钟），优先在静音点切分 */
        const val FRAGMENT_MS = 5 * 60 * 1000L

        /** 离线物理分片无静音点时的硬上限（5 分钟 + 15 秒） */
        const val FRAGMENT_HARD_MS = FRAGMENT_MS + 15_000L

        /** 端侧唤醒命中时回填的预滚时长（ms） */
        const val PRE_ROLL_MS = 2000

        /** 预滚样本数（[PRE_ROLL_MS] 毫秒 @ [SR]） */
        const val PRE_ROLL_SAMPLES = SR * PRE_ROLL_MS / 1000

        /** 预滚环形缓冲字节数（s16le，2 字节/样本） */
        const val PRE_ROLL_BYTES = PRE_ROLL_SAMPLES * 2

        /** 唤醒引擎参数重载的最小间隔（ms）：避免拖动滑块时反复重建引擎 */
        private const val KWS_RELOAD_MIN_GAP_MS = 2000L

        /** 待重载唤醒引擎标记（设置页改动识别参数后置位，由采集线程消费） */
        @Volatile
        private var kwsReloadRequested = false

        /**
         * 请求重载端侧唤醒引擎。
         *
         * 设置页改动灵敏度/判定阈值/唤醒词/推理间隔时调用：引擎参数在加载时固化，
         * 直接改 prefs 不会生效。这里只置位标记，由采集线程在下一次推理前重建引擎
         * （重新读 prefs），避免在设置页线程做重活。重建受 [KWS_RELOAD_MIN_GAP_MS]
         * 节流，防止拖动滑块时连续重建造成录音卡顿。
         */
        @JvmStatic
        fun requestKwsReload() {
            kwsReloadRequested = true
        }

        /**
         * 唤醒命中后等待 WS 连接就绪的上限（ms）。
         *
         * 仅用于「避免无限等待」：连接未就绪期间不启动命中确认计时，超过该上限
         * 仍未就绪则记录明确告警并结束本轮推流（期间音频落离线碎片缓存）。
         */
        const val WAKE_CONNECT_TIMEOUT_MS = 30000L

        /**
         * 连接就绪（CONNECTED）后等待服务端确认（`wake/start`，含声纹进门验证）的上限（ms）。
         *
         * 计时基准是「连接就绪时刻」，不含建连耗时；已确认后不再受此约束。
         */
        const val WAKE_CONFIRM_TIMEOUT_MS = 5000L

        /** 唤醒推流安全上限（ms）：服务端 end 丢失时的兜底，避免无限推流 */
        const val WAKE_STREAM_MAX_MS = 120_000L

        /**
         * 麦克风有效性防抖窗口（ms）。
         * 无效条件需持续该时长才升级为 [MicStatus.OCCUPIED]；
         * 恢复后需稳定该时长才回到 [MicStatus.VALID]，避免真实安静房间误报。
         */
        const val MIC_DEBOUNCE_MS = 10_000L
    }

    // ── 录音状态 ──

    /** AudioRecord 实例（录音期间非空） */
    private var record: AudioRecord? = null

    /**
     * 上次批量上传调度的墙钟（ms）。
     *
     * [start] 时建立锚点；每次触发上传时刷新。批次间隔判定以此为基准，与分段时长解耦。
     */
    @Volatile
    private var lastUploadScheduledMs: Long = 0L

    // ── 分段 checkpoint（崩溃安全落盘，避免停止/被杀时丢已录内容）──

    /** 当前分段的 checkpoint 写盘器（分段采集中非空；结束/停止后置空） */
    @Volatile
    private var segmentCheckpoint: PcmCheckpointWriter? = null

    /** 分段序号（每开始一个新分段自增，供 checkpoint 与 upload_cache 条目命名） */
    private val segmentSeqCounter = AtomicInteger(0)

    /** 保护 [segmentCheckpoint] 开始/结束的原子性（主线程 stop() 与采集线程可并发） */
    private val checkpointLock = Any()

    /** checkpoint 会话标识，用于 `pending/<sessionId>/` 目录分组 */
    private val checkpointSessionId: String = "seg-" + System.currentTimeMillis()

    /** 初始化失败重试延迟（ms），指数退避 */
    private var retryDelayMs = 1000L

    /** 端侧唤醒引擎（惰性加载；null 表示尚未初始化） */
    private var kwsEngine: LocalKwsEngine? = null

    /** KWS 初始化是否已失败（失败后不再重试，避免每帧重复尝试） */
    private var kwsInitFailed = false

    /** 上次重建唤醒引擎的时间戳（仅采集线程访问），用于 [KWS_RELOAD_MIN_GAP_MS] 节流 */
    private var lastKwsReloadMs = 0L

    /** 本次运行累计唤醒命中次数 */
    private var kwsHitCount = 0

    // ── 端侧唤醒预滚缓冲（仅采集线程读写，无需同步）──

    /** 最近 [PRE_ROLL_MS] 毫秒的原始 PCM 环形缓冲（s16le 单声道） */
    private val preRollBuffer = ByteArray(PRE_ROLL_BYTES)

    /** 环形缓冲写指针 */
    private var preRollWritePos = 0

    /** 环形缓冲中的有效字节数（不超过容量） */
    private var preRollFilled = 0

    /** 停止连续录音循环的标志 */
    @Volatile
    private var shouldStopLoop = false

    /**
     * 服务端下发唤醒结束（`wake/end`）时置位，供唤醒推流循环退出。
     *
     * 回调运行在 OkHttp 读取线程，只能置位标志；采集线程消费后回到分段采集。
     */
    @Volatile
    private var stopStreamRequested = false

    /**
     * 服务端是否已确认本轮唤醒（收到 `wake/start`，即声纹进门验证通过）。
     *
     * 由 OkHttp 读取线程置位；采集线程用它做「未确认超时」兜底：
     * 端侧命中后若迟迟收不到确认，说明说话人未通过验证，应主动结束推流。
     */
    @Volatile
    private var wakeConfirmed = false

    /** 采集器是否处于运行态（含重试等待），供权限复核判断 */
    @Volatile
    private var running = false

    /** 用于调度重试的 Handler；延迟创建以兼容无 Android Looper 的单元测试环境 */
    private val handler: Handler? by lazy {
        try { Handler(Looper.getMainLooper()) } catch (_: Throwable) { null }
    }

    // ── 流式采集状态（仅流式模式使用）──

    /** 流式 WS 客户端（流式模式下非空） */
    private var streamClient: AudioStreamClient? = null

    /** 唤醒提示音播放器（播放 res/raw 内的 start / end 音效，构造时预热，stop() 时释放） */
    private val hintTonePlayer = HintTonePlayer(context)

    /** 流式会话起始墙钟毫秒（验证通过、真正开始读帧时打点） */
    @Volatile
    private var streamStartWallMs = 0L

    /** 本会话已采集样本总数（推算真实时间与碎片起始时间的唯一依据） */
    @Volatile
    private var totalCapturedSamples = 0L

    /** 本会话客户端生成的会话 ID（碎片元数据使用，避免 stop() 后取不到） */
    @Volatile
    private var streamSessionId = ""

    /** 离线碎片序号 */
    private var fragmentSeq = 0

    /** 当前离线碎片 PCM 缓冲（仅采集线程访问，无需同步） */
    private var fragmentBuffer: java.io.ByteArrayOutputStream? = null

    /** 当前碎片起始的全局样本偏移（仅采集线程访问） */
    private var fragmentStartSample = 0L

    /** 重连成功后的落盘/补传挂起标记（回调置位，采集线程消费） */
    @Volatile
    private var pendingReconnectFlush = false

    /** 缓存补传线程互斥标记，避免并发补传导致同一条被重复上传 */
    @Volatile
    private var cacheUploadInFlight = false

    /**
     * 补传进行中又收到新触发时的「再跑一轮」请求。
     *
     * 中断/停止路径新落盘的条目可能在上一轮补传开始后才写入，若不补跑一轮会被
     * in-flight 状态吞掉；这里只排队不并发，避免同一条被两个线程重复上传。
     */
    @Volatile
    private var cacheUploadRerunRequested = false

    /** 保护 [cacheUploadInFlight] / [cacheUploadRerunRequested] 的状态转换 */
    private val cacheUploadLock = Any()

    // ── 麦克风有效性检测状态 ──

    /** 无效条件的连续起始墙钟（ms），null 表示当前无无效条件 */
    @Volatile
    private var micInvalidSinceMs: Long? = null

    /** 恢复稳定的连续起始墙钟（ms），仅在进入无效状态后用于确认恢复 */
    @Volatile
    private var micValidSinceMs: Long? = null

    /**
     * 录音中断回调：AudioRecord 无法（重）启动或被系统打断时触发，
     * 由 [com.xehuri.kinship.service.DataCollectorService] 注入以弹出高优先级可点击通知。
     */
    @Volatile
    var onRecordingInterrupted: (() -> Unit)? = null

    // ── 生命周期 ──

    /** 是否启用音频采集（从 SharedPreferences 读取） */
    override val isEnabled: Boolean
        get() = context.getSharedPreferences("data_collector", Context.MODE_PRIVATE)
            .getBoolean("audio_enabled", false)

    /**
     * 是否启用流式上行（灰度开关，默认 true）。
     *
     * 关闭时完全退回旧的「N 秒 WAV 打包 + multipart 上传」路径，便于回滚。
     */
    private val isStreamingEnabled: Boolean
        get() = DataCollectorService.isAudioStreamEnabled(context)

    /**
     * 是否开启端侧唤醒（`data_collector["local_kws_enabled"]`）。
     *
     * 开启后优先于常驻流式：总是走分段采集，命中唤醒词后由 [startWakeStream] 按需推流，
     * 等待服务端唤醒结束信号后回到分段采集。
     */
    private val isLocalKwsEnabled: Boolean
        get() = DataCollectorService.isLocalKwsEnabled(context)

    override val isRunning: Boolean
        get() = running

    /**
     * 启动音频采集。
     *
     * 如果音频已启用，立即创建 AudioRecord 并开始录音循环。
     * 如果音频已关闭，记录日志并跳过。
     */
    override fun start() {
        shouldStopLoop = false
        // 新一轮采集：清空有效性防抖历史，避免上一会话状态残留
        micInvalidSinceMs = null
        micValidSinceMs = null
        // 建立批量上传调度锚点：从本次启动时刻起算第一个批次间隔
        lastUploadScheduledMs = System.currentTimeMillis()
        if (isEnabled) {
            running = true
            Timber.i("音频采集已启动")
            startRecording()
        } else {
            running = false
            Timber.i("音频采集已关闭，跳过启动")
        }
    }

    /**
     * 停止音频采集。
     *
     * 释放 AudioRecord 实例，清空缓存音频数据，并清空 Handler 中待执行的
     * 重试任务，确保停止后不会再重新打开麦克风。
     * 调用 [start] 后可重新开始录音。
     */
    override fun stop() {
        Timber.i("音频采集已停止")
        shouldStopLoop = true
        running = false
        // 立即结束进行中的分段并落盘 upload_cache + 触发补传，避免停止时丢弃已录内容。
        // 与采集线程原子认领：谁先拿到谁负责落盘，另一方不会重复。
        closeCurrentSegment(toCache = true, triggerUpload = true)
        // 清空待执行的重试回调，避免停止后重新开麦
        handler?.removeCallbacksAndMessages(null)
        // 停止后不再报告麦克风占用，避免常驻通知停留在异常文案
        micInvalidSinceMs = null
        micValidSinceMs = null
        stateHolder.updateMicStatus(MicStatus.VALID)
        // 停止流式客户端；缓冲中未发送的帧由采集线程退出时落盘缓存
        streamClient?.let {
            try { it.stopStream() } catch (_: Exception) {}
            try { it.close() } catch (_: Exception) {}
        }
        streamClient = null
        // 释放端侧唤醒引擎（持有原生资源）
        releaseKws()
        // 释放提示音生成器（持有音频资源），避免常驻占用
        hintTonePlayer.release()
        record?.let { ar ->
            try {
                if (ar.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    ar.stop()
                }
            } catch (_: Exception) {}
            // release 由 DcRecord 线程 finally 块负责
        }
    }

    // ======================== 录音 ========================

    /**
     * 创建 AudioRecord 实例并启动录音线程。
     *
     * 1. 使用 VOICE_RECOGNITION 音源（绕过蓝牙 MIC，不降级到其他音源）
     * 2. 录音线程中等 1s 让麦克风硬件初始化，然后读 30ms 验证数据是否全零
     * 3. 全零说明麦克风未激活，释放并 1s 后重试
     * 4. 验证通过则进入 [audioCaptureLoop] 完整录音循环
     * 5. 录音完成再检测全零兜底，跳过上传
     * 6. 如果仍启用，自动开始下一轮录音
     *
     * 线程名: DcRecord（与原始 DataCollectorService 一致）
     */
    private fun startRecording() {
        // 防止重复创建
        if (record != null && record!!.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
            Timber.i("已有活跃录音实例，跳过")
            resetRetryDelay()
            return
        }

        try {
            val bufSize = AudioRecord.getMinBufferSize(
                SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            if (bufSize <= 0) {
                Timber.w("系统不支持 16kHz 录音，${retryDelayMs}ms 后重试")
                signalRecordingInterrupted("系统不支持 16kHz 录音")
                scheduleRetry()
                return
            }

            // 只用 VOICE_RECOGNITION（绕过蓝牙 MIC，用户明确要求不用 MIC）
            var ar: AudioRecord? = null
            try {
                val a = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SR, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufSize * 4
                )
                if (a.state != AudioRecord.STATE_INITIALIZED) {
                    a.release()
                    Timber.w("VOICE_RECOGNITION 初始化失败，1s 后重试")
                    signalRecordingInterrupted("VOICE_RECOGNITION 初始化失败")
                    scheduleRetry()
                    return
                }
                a.startRecording()
                ar = a
                Timber.i("VOICE_RECOGNITION 启动录音")
            } catch (e: Exception) {
                Timber.w("VOICE_RECOGNITION 异常: ${e.message}，1s 后重试")
                signalRecordingInterrupted("VOICE_RECOGNITION 异常: ${e.message}")
                scheduleRetry()
                return
            }

            resetRetryDelay()
            record = ar
            Timber.i("录音已启动")

            // ── 录音线程（含 1s 等待 + 全零验证）──
            Thread({
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
                try {
                    // 等 1s 让麦克风硬件完成初始化（在后台线程，不阻塞主线程）
                    Thread.sleep(1000)

                    // 读 10 帧（300ms）检查是否全零，避免单帧静音误判
                    var hasAudio = false
                    val testBuf = ShortArray(FRAME_SIZE)
                    for (i in 0 until 10) {
                        val n = ar.read(testBuf, 0, FRAME_SIZE)
                        if (n > 0 && testBuf.any { it != 0.toShort() }) {
                            hasAudio = true
                            break
                        }
                    }
                    if (!hasAudio) {
                        Timber.w("VOICE_RECOGNITION 300ms 内所有帧均为零，麦克风未激活")
                        signalRecordingInterrupted("300ms 内所有帧均为零，麦克风未激活")
                        // 验证失败时释放并重试（走 backoff）
                        try { ar.stop() } catch (_: Exception) {}
                        try { ar.release() } catch (_: Exception) {}
                        if (record === ar) record = null
                        if (isEnabled && !shouldStopLoop) scheduleRetry()
                        return@Thread
                    }

                    // ── 模式选择：端侧唤醒优先于常驻流式 ──
                    // 1. local_kws_enabled=true：总是走端侧唤醒分段采集 + 命中按需推流（与流式开关无关）
                    // 2. local_kws_enabled=false + audio_stream_enabled=true：常驻流式（服务端跑 KWS）
                    // 3. local_kws_enabled=false + audio_stream_enabled=false：纯分段 WAV + multipart 上传
                    if (isLocalKwsEnabled) {
                        runSegmentedCaptureLoop(ar)
                    } else if (isStreamingEnabled) {
                        // ── 流式模式：连续读 100ms 帧直送 WS；离线转本地物理分片 ──
                        startStreaming(ar)
                    } else {
                        // ── 纯分段模式（灰度回退）：N 秒 WAV 打包 + multipart 上传 ──
                        runSegmentedCaptureLoop(ar)
                    }
                } catch (e: Exception) {
                    Timber.w(e, "录音线程异常")
                } finally {
                    // 停止并释放 AudioRecord（try 保护，防止重复 release）
                    try {
                        if (ar.recordingState == AudioRecord.RECORDSTATE_RECORDING) ar.stop()
                    } catch (_: Exception) {}
                    try {
                        ar.release()
                    } catch (_: Exception) {}
                    if (record === ar) record = null

                    // 非主动 stop 导致的退出 → backoff 重试
                    if (isEnabled && !shouldStopLoop) {
                        scheduleRetry()
                    }
                }
            // 设为守护线程，避免录音线程阻塞 JVM 退出
            }, "DcRecord").apply { isDaemon = true }.start()
        } catch (e: Exception) {
            Timber.w("录音启动失败: ${e.message}，${retryDelayMs}ms 后重试")
            signalRecordingInterrupted("录音启动失败: ${e.message}")
            scheduleRetry()
        }
    }

    // ======================== 分段采集循环 ========================

    /**
     * 分段采集循环：按 `audio_segment_ms` 固定封段 + checkpoint 落盘 + 批量上传，端侧唤醒命中时可切入按需推流。
     *
     * 供以下两种模式复用：
     * - 端侧唤醒模式（`local_kws_enabled=true`）：命中且启用按需推流时切入 [startWakeStream]；
     * - 纯分段模式（`local_kws_enabled=false` + `audio_stream_enabled=false`）：
     *   [audioCaptureLoop] 内 KWS 引擎不可用（返回 null），不会因命中提前返回。
     *
     * [audioCaptureLoop] 内部已按分段滚动处理并把每段 finalize 到 `upload_cache`，本方法只负责
     * 唤醒切流与兜底收尾。AudioRecord 跨周期存活，不释放不重建。
     */
    private fun runSegmentedCaptureLoop(ar: AudioRecord) {
        while (isEnabled && !shouldStopLoop) {
            // 端侧唤醒命中时 audioCaptureLoop 提前返回命中的关键词
            val hitKeyword = try {
                audioCaptureLoop(ar)
            } catch (e: Exception) {
                Timber.w(e, "audioCaptureLoop 异常")
                // 异常退出：先把已录内容 finalize 到 upload_cache 并立即补传
                closeCurrentSegment(toCache = true, triggerUpload = true)
                break
            }

            // 检测 AudioRecord 是否在 captureLoop 中被系统回收
            if (ar.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                Timber.w("AudioRecord 状态异常 state=${ar.recordingState}，退出连续循环")
                // 系统回收/状态异常：finalize 当前分段，绝不丢弃已录内容
                closeCurrentSegment(toCache = true, triggerUpload = true)
                break
            }

            // 唤醒命中且已启用按需推流：丢弃半段（服务端会记录完整唤醒指令），
            // 复用同一 AudioRecord 切入推流，等待服务端 wake/end 后回到分段采集
            if (hitKeyword != null && isLocalKwsEnabled) {
                // 半段音频由推流链路（预滚 + 直送）承载，丢弃 checkpoint 分段避免重复
                closeCurrentSegment(toCache = false)
                startWakeStream(ar, hitKeyword)
                continue
            }

            // 停止/开关关闭：退出循环（当前分段已在 audioCaptureLoop 内落盘）
            if (!isEnabled || shouldStopLoop) break

            // 兜底再按批次节奏触发一次上传（正常情况下 audioCaptureLoop 每段已调度过）
            maybeTriggerScheduledUpload(force = false)
        }
        // 停止/开关关闭导致循环退出：兜底 finalize（stop() 已处理时为幂等空操作）
        closeCurrentSegment(toCache = true, triggerUpload = true)
    }

    // ======================== 分段 checkpoint（崩溃安全）========================

    /**
     * 开始一个新分段的 checkpoint 落盘（采集线程调用）。
     *
     * 周期 flush 采用 [PcmCheckpointWriter.DEFAULT_FLUSH_INTERVAL_MS]（10 秒），
     * 崩溃后由 [CheckpointRecovery] 把残留 `.part` 转成可重放条目。
     *
     * @param startMs 本分段真实起始墙钟（毫秒）
     * @param uploadFormat 本段上传格式（"wav" | "flac"），调用方每段现读后传入
     */
    internal fun beginSegmentCheckpoint(
        startMs: Long,
        uploadFormat: String = DataCollectorService.getUploadFormat(context)
    ): PcmCheckpointWriter {
        synchronized(checkpointLock) {
            // 兜底：上一个分段未正常结束（正常流程不应发生），先落盘避免丢数据
            segmentCheckpoint?.let { stale ->
                segmentCheckpoint = null
                stale.finalizeSegment()
            }
            val writer = PcmCheckpointWriter(
                context = context,
                sessionId = checkpointSessionId,
                segSeq = segmentSeqCounter.getAndIncrement(),
                deviceId = DeviceId.get(context),
                sampleRate = SR,
                segStartMs = startMs,
                flushIntervalMs = PcmCheckpointWriter.DEFAULT_FLUSH_INTERVAL_MS,
                uploadFormat = uploadFormat
            )
            segmentCheckpoint = writer
            return writer
        }
    }

    /**
     * 把一帧原始 PCM 追加到当前分段 checkpoint（采集线程调用）。
     *
     * 无进行中分段时为空操作；写入异常由 [PcmCheckpointWriter] 内部吞掉，绝不影响采集。
     */
    internal fun appendSegmentPcm(pcm: ByteArray) {
        segmentCheckpoint?.append(pcm)
    }

    /**
     * 结束当前分段（原子认领，主线程与采集线程可并发调用）。
     *
     * @param toCache true：finalize 成 `upload_cache` 条目；false：丢弃 `.part`
     * @param triggerUpload 仅 [toCache]=true 时生效：true 立即触发补传（停止/中断路径）；
     *                      false 交给批量上传调度按 `audio_upload_batch_ms` 决定时机。
     *                      注意：中断路径即便本次没有认领到进行中分段，也会照常触发补传，
     *                      把此前正常切段留下的待上传条目一并发出（停止后不会再有任何批次调度）
     * @return 是否由本次调用完成结束（false 表示已被其他线程抢先结束或本无进行中分段）
     */
    internal fun closeCurrentSegment(toCache: Boolean, triggerUpload: Boolean = true): Boolean {
        // 先原子认领进行中的分段；置空后其它线程再调用即认领失败（幂等）
        val writer = synchronized(checkpointLock) {
            val current = segmentCheckpoint
            segmentCheckpoint = null
            current
        }
        val claimed = if (writer == null) {
            false
        } else if (toCache) {
            writer.finalizeSegment() != null
        } else {
            writer.abort()
            true
        }

        // 中断/停止路径：即使本次未认领到分段，也立即补传已落盘但尚未发送的条目。
        // 正常切段（forceUpload=false）留下的条目在采集器停止后再无批次调度可用，
        // 必须在此刻发出，否则要等到下次启动才可能上传。
        if (toCache && triggerUpload) triggerCacheUpload()

        return claimed
    }

    /**
     * 启动时恢复上次进程被杀遗留的 checkpoint 分片，并触发一次补传。
     *
     * 由 [com.xehuri.kinship.service.DataCollectorService] 在服务创建时调用；
     * 全程在后台线程执行，任何异常只记日志，绝不影响服务启动。
     */
    fun recoverCheckpointsAndUpload() {
        Thread({
            try {
                val recovered = CheckpointRecovery.recover(context, SR, DeviceId.get(context))
                if (recovered > 0) {
                    // 把恢复出的条目立即补传
                    uploadCachedData()
                }
            } catch (e: Exception) {
                Timber.w("checkpoint 恢复异常: ${e.message}")
            }
        // 设为守护线程，避免恢复线程阻塞 JVM 退出
        }, "DcCheckpointRecover").apply { isDaemon = true }.start()
    }

    // ======================== PCM 音频采集循环 ========================

    /**
     * PCM 音频采集循环（分段模式：按 `audio_segment_ms` 固定封段 + 崩溃安全落盘）。
     *
     * 与旧的「录满固定时长再上传」不同，本循环在内部按分段滚动：
     * - 每段开始时先补上一段的尾部 PCM 作为前滚重叠（避免段首语音被切掉）；
     * - 逐 30ms 帧读入并写入 checkpoint（周期 flush，崩溃可由 CheckpointRecovery 恢复）；
     * - 录满 `audio_segment_ms`（单段固定时长）即自然封段，**不做语义/端点提前切段**；
     * - 切段后 finalize 到 `upload_cache`，由批量上传调度按 `audio_upload_batch_ms` 决定发送时机；
     *   停止/中断路径立即触发上传，绝不丢已落盘内容。
     *
     * 循环退出条件：
     * 1. 主动停止 / 采集开关关闭；
     * 2. AudioRecord 状态异常或读取错误；
     * 3. 端侧唤醒命中且启用按需推流（提前返回命中词，交给外层切入推流）。
     *
     * @return 唤醒命中且启用按需推流时返回命中的唤醒词；否则返回 null
     */
    private fun audioCaptureLoop(ar: AudioRecord): String? {
        val frameBuf = ShortArray(FRAME_SIZE)
        val overlapBytes = SEGMENT_OVERLAP_SAMPLES * 2

        // 前滚重叠：上一段尾部 PCM 作为下一段开头（首段为空）
        var overlapPcm: ByteArray = ByteArray(0)
        var overlapStartMs = 0L

        while (isEnabled && !shouldStopLoop) {
            // 单段固定时长：audio_segment_ms（App 端不做语义/端点切分，语义连续性由后端无缝流负责）
            // 每段重新读取 prefs，设置页改动立即生效、无需重启采集
            val intervalMs = DataCollectorService.getAudioSegmentMs(context)
            // T2: 上传格式同样每段现读（wav|flac），改完下一段生效
            val uploadFormat = DataCollectorService.getUploadFormat(context)
            val maxFrames = SR * (intervalMs / 1000).toInt().coerceAtLeast(1)

            // 段起始墙钟：有重叠时回推到重叠音频的真实起点，保证时间轴连续
            val segStartMs = if (overlapPcm.isNotEmpty()) overlapStartMs else System.currentTimeMillis()
            beginSegmentCheckpoint(segStartMs, uploadFormat)

            var pos = 0
            val ring = PcmRing(overlapBytes)
            if (overlapPcm.isNotEmpty()) {
                // 重叠音频已属上一段，仅补写本段 checkpoint 与重叠环，不再重复进预滚缓冲
                appendSegmentPcm(overlapPcm)
                ring.append(overlapPcm)
                pos += overlapPcm.size / 2
            }
            overlapPcm = ByteArray(0)

            // 本段说话/静音统计（仅用于 UI 展示与分段日志，不参与切段）
            val tracker = SegmentSpeechTracker(RMS_THRESHOLD)
            val segLoopStartMs = System.currentTimeMillis()
            // 本段是否存在非零 PCM（全零表示麦克风未实际激活，应丢弃）
            var hasAudio = false
            var interrupted = false

            stateHolder.updateVadStatus("idle")

            while (pos < maxFrames && isEnabled && !shouldStopLoop) {
                if (ar.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                    Timber.w("录音状态异常 state=${ar.recordingState}，立即退出")
                    signalRecordingInterrupted("AudioRecord 状态异常 state=${ar.recordingState}")
                    interrupted = true
                    break
                }
                val n = ar.read(frameBuf, 0, FRAME_SIZE)
                if (n > 0) {
                    pos += n
                    val frameBytes = pcmToBytes(frameBuf, n)
                    // 预滚：保存本帧原始 PCM，命中唤醒词时回填给服务端补全唤醒指令开头
                    appendPreRoll(frameBytes)
                    // checkpoint：把本帧写入当前分段 `.part`，崩溃时可由 CheckpointRecovery 恢复
                    appendSegmentPcm(frameBytes)
                    // 前滚重叠环：只保留最近 [SEGMENT_OVERLAP_SAMPLES] 个采样
                    ring.append(frameBytes)

                    // 计算 RMS 与 dB 电平（供电平显示与说话统计）
                    val elapsedMs = System.currentTimeMillis() - segLoopStartMs
                    val rms = computeRms(frameBuf, n)
                    if (rms > 0.0) hasAudio = true
                    // 上报麦克风有效性（带 10s 防抖），驱动常驻通知文案
                    reportMicActivity(rms, n, recordingOk = true)
                    val dbLevel = if (rms > 0) {
                        (20.0 * log10(rms / 32768.0)).toFloat()
                    } else {
                        -80f
                    }
                    stateHolder.updateDbLevel(dbLevel)

                    // 端侧唤醒词检测；命中且启用按需推流时立即返回，交由外层切入推流
                    val hitKeyword = feedKws(frameBuf, n)
                    if (hitKeyword != null) {
                        onKwsHit(hitKeyword)
                        if (isLocalKwsEnabled) return hitKeyword
                    }

                    // 更新说话/静音统计并刷新 UI 状态；本段仍录满 audio_segment_ms 才封段
                    tracker.onFrame(rms, elapsedMs)
                    stateHolder.updateVadStatus(tracker.uiStatus())
                } else if (n < 0) {
                    Timber.w("录音读取错误: $n")
                    signalRecordingInterrupted("录音读取错误: $n")
                    interrupted = true
                    break
                }
            }

            if (interrupted) {
                // 中断：落盘并立即上传，绝不丢弃已录内容
                finalizeSegmentToCache(hasAudio, forceUpload = true)
                return null
            }
            if (!isEnabled || shouldStopLoop) {
                // 停止/开关关闭：同样立即落盘上传
                finalizeSegmentToCache(hasAudio, forceUpload = true)
                return null
            }

            // 录满单段时长正常封段：落盘后交给批量上传调度（不立即发送）
            finalizeSegmentToCache(hasAudio, forceUpload = false)
            overlapPcm = ring.drain(overlapBytes)
            overlapStartMs = AudioSegmentPolicy.nextSegmentStartMs(
                segStartMs, pos, SR, SEGMENT_OVERLAP_SAMPLES
            )
            Timber.i(
                "分段完成: ${pos * 1000L / SR}ms（说话 ${tracker.speechMs}ms，" +
                    "重叠 ${overlapPcm.size * 1000L / (SR * 2)}ms），等待批量上传"
            )
        }
        // 外层条件不再满足：兜底落盘（无进行中分段时为幂等空操作）
        closeCurrentSegment(toCache = true, triggerUpload = true)
        return null
    }

    // ======================== 批量上传调度 ========================

    /**
     * 结束当前分段并按批次节奏决定是否上传。
     *
     * @param hasAudio 本段是否存在非零 PCM（全零表示麦克风未实际激活，直接丢弃，不产生条目）
     * @param forceUpload true 立即触发上传（停止/中断路径）
     */
    private fun finalizeSegmentToCache(hasAudio: Boolean, forceUpload: Boolean) {
        val claimed = if (hasAudio) {
            closeCurrentSegment(toCache = true, triggerUpload = false)
        } else {
            // 全零段不产生条目（麦克风未实际激活），直接丢弃
            closeCurrentSegment(toCache = false)
            false
        }
        // 中断路径必须立即补传：即便本段未产出条目，也要把此前正常切段留下的待上传条目发出；
        // 正常切段仅在本段确实产出条目时按批次节奏判定
        if (forceUpload) {
            maybeTriggerScheduledUpload(force = true)
        } else if (claimed) {
            maybeTriggerScheduledUpload(force = false)
        }
    }

    /**
     * 按批次节奏触发 `upload_cache` 补传。
     *
     * 触发条件（任一）：距上次调度达到 `audio_upload_batch_ms`；待上传累计达到
     * [AudioSegmentPolicy.PENDING_UPLOAD_THRESHOLD_MS]；[force]=true（停止/中断立即发送）。
     *
     * @param force true 无视批次间隔立即上传
     */
    private fun maybeTriggerScheduledUpload(force: Boolean) {
        val now = System.currentTimeMillis()
        if (force) {
            lastUploadScheduledMs = now
            triggerCacheUpload()
            return
        }
        val pendingMs = pendingCacheDurationMs()
        val batchMs = DataCollectorService.getAudioUploadBatchMs(context)
        if (AudioSegmentPolicy.isBatchUploadDue(lastUploadScheduledMs, now, pendingMs, batchMs)) {
            lastUploadScheduledMs = now
            triggerCacheUpload()
        }
    }

    /**
     * 统计 `upload_cache` 中待上传音频的总时长（毫秒）。
     *
     * 经 sibling `.json` 的 `sample_count`/`sample_rate` 换算（与格式无关，
     * `.wav`/`.flac` 条目一视同仁）；JSON 缺失或损坏的孤儿音频按 0 计。
     * 目录不存在返回 0。
     */
    internal fun pendingCacheDurationMs(): Long {
        val cacheDir = File(context.cacheDir, CACHE_DIR_NAME)
        val jsons = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(".json") } ?: return 0L
        var totalMs = 0L
        for (jf in jsons) {
            try {
                val o = JSONObject(jf.readText())
                val sc = o.optLong("sample_count", -1L)
                val sr = o.optInt("sample_rate", 0)
                if (sc > 0 && sr > 0) {
                    totalMs += sc * 1000L / sr
                }
            } catch (_: Exception) {
                // 损坏 JSON 不计入
            }
        }
        return totalMs
    }

    // ======================== 端侧唤醒（KWS）========================

    /**
     * 端侧唤醒词检测（当前为测试用途，不参与推流决策）。
     *
     * 惰性加载模型；加载失败后不再重试。推理异常静默跳过，绝不影响采集链路。
     *
     * @return 命中的唤醒词；未命中或引擎不可用返回 null
     */
    private fun feedKws(frame: ShortArray, count: Int): String? {
        if (count <= 0) return null
        val engine = ensureKwsEngine() ?: return null
        val samples = FloatArray(count) { frame[it] / 32768.0f }
        return engine.accept(samples)
    }

    /** 惰性获取 KWS 引擎；开关关闭或加载失败时返回 null 并同步状态。 */
    private fun ensureKwsEngine(): LocalKwsEngine? {
        // 开关关闭：释放已加载引擎（设置页可随时切换）
        if (!DataCollectorService.isLocalKwsEnabled(context)) {
            if (kwsEngine != null) releaseKws()
            return null
        }
        // 设置页改了识别参数（灵敏度/阈值/唤醒词/推理间隔）→ 重建引擎让新参数生效。
        // 节流：距上次重建不足 KWS_RELOAD_MIN_GAP_MS 时保留标记，下一帧再试。
        if (kwsReloadRequested &&
            System.currentTimeMillis() - lastKwsReloadMs >= KWS_RELOAD_MIN_GAP_MS
        ) {
            kwsReloadRequested = false
            lastKwsReloadMs = System.currentTimeMillis()
            releaseKws()
            kwsInitFailed = false
        }
        kwsEngine?.let { return it }
        if (kwsInitFailed) return null
        val engine = LocalKwsEngine(
            context,
            LocalKwsEngine.Config(
                keywordsScore = DataCollectorService.getKwsScore(context),
                keywordsThreshold = DataCollectorService.getKwsThreshold(context),
                customKeywords = DataCollectorService.getKwsKeywords(context),
                intervalMs = DataCollectorService.getKwsIntervalMs(context),
            ),
        )
        return if (engine.initialize()) {
            kwsEngine = engine
            stateHolder.updateKwsStatus("监听中")
            engine
        } else {
            kwsInitFailed = true
            stateHolder.updateKwsStatus("模型不可用")
            null
        }
    }

    /** 记录一次唤醒命中并刷新 UI 状态。 */
    private fun onKwsHit(keyword: String) {
        kwsHitCount += 1
        val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        stateHolder.updateKwsHitCount(kwsHitCount)
        stateHolder.updateKwsLastHit("$keyword · $time")
        stateHolder.updateKwsStatus("已命中")
        Timber.i("[LocalKws] 命中唤醒词: $keyword（累计 $kwsHitCount 次）")
    }

    /** 释放 KWS 资源（停止采集时调用）。 */
    private fun releaseKws() {
        kwsEngine?.release()
        kwsEngine = null
        stateHolder.updateKwsStatus("未启用")
    }

    // ======================== 端侧唤醒预滚 ========================

    /**
     * 将一帧原始 PCM 追加到预滚环形缓冲（仅采集线程调用）。
     *
     * 缓冲固定保留最近 [PRE_ROLL_MS] 毫秒音频；单帧超过容量时只保留帧尾。
     */
    private fun appendPreRoll(pcm: ByteArray) {
        if (pcm.isEmpty()) return
        val cap = preRollBuffer.size
        // 单帧大于整个缓冲时，只保留最新的尾部数据
        val src = if (pcm.size >= cap) pcm.copyOfRange(pcm.size - cap, pcm.size) else pcm
        val firstPart = (cap - preRollWritePos).coerceAtMost(src.size)
        System.arraycopy(src, 0, preRollBuffer, preRollWritePos, firstPart)
        if (src.size > firstPart) {
            System.arraycopy(src, firstPart, preRollBuffer, 0, src.size - firstPart)
        }
        preRollWritePos = (preRollWritePos + src.size) % cap
        preRollFilled = if (preRollFilled + src.size >= cap) cap else preRollFilled + src.size
    }

    /**
     * 取出预滚缓冲中的全部原始 PCM（由旧到新）并清空。
     *
     * @return 最旧到最新的连续 PCM 字节；缓冲为空时返回 null
     */
    private fun drainPreRoll(): ByteArray? {
        if (preRollFilled <= 0) return null
        val cap = preRollBuffer.size
        val out = ByteArray(preRollFilled)
        val start = (preRollWritePos - preRollFilled + cap) % cap
        val firstPart = (cap - start).coerceAtMost(preRollFilled)
        System.arraycopy(preRollBuffer, start, out, 0, firstPart)
        if (preRollFilled > firstPart) {
            System.arraycopy(preRollBuffer, 0, out, firstPart, preRollFilled - firstPart)
        }
        preRollWritePos = 0
        preRollFilled = 0
        return out
    }

    // ======================== 唤醒命中按需推流 ========================

    /**
     * 唤醒命中后的按需推流（复用当前 AudioRecord，仍在 DcRecord 线程内执行）。
     *
     * 流程：
     * 1. 先取出预滚 PCM，并按其实时长回推会话起始墙钟；
     * 2. [AudioStreamClient.startStream] 发起连接，等待就绪期间继续读帧暂存，避免丢指令；
     *    超过 [WAKE_CONNECT_TIMEOUT_MS] 仍未就绪则告警并结束本轮推流（音频落离线缓存）；
     * 3. 连接就绪后先回填预滚（服务端据此还原完整唤醒词），再送等待期间的暂存帧；
     * 4. 之后按 100ms 帧持续上行，直到服务端 `wake/end` 置位 [stopStreamRequested]；
     *    命中确认（[WAKE_CONFIRM_TIMEOUT_MS]）自连接就绪时刻起算，建连期间不计时；
     * 5. 结束时仅 [AudioStreamClient.stopStream] 冲刷尾段，不调用 close()，
     *    保留客户端实例与调度线程供下次唤醒复用，并把 KWS 状态复位为「监听中」。
     *
     * @param hitKeyword 端侧实际命中的唤醒词文本，随 audio_start 上报给服务端
     */
    private fun startWakeStream(ar: AudioRecord, hitKeyword: String) {
        val client = ensureStreamClient()
        stopStreamRequested = false

        // 预滚先取出：据此回推会话起始时间，保证服务端按真实时间戳对齐唤醒词
        val preRoll = drainPreRoll()
        val preRollMs = if (preRoll != null) preRoll.size.toLong() * 1000L / (SR * 2) else 0L
        streamStartWallMs = System.currentTimeMillis() - preRollMs
        totalCapturedSamples = 0L
        fragmentSeq = 0
        fragmentBuffer = null
        pendingReconnectFlush = false
        // 端侧命中路径：置位 local_hit，服务端据此跳过自身 KWS，直接做声纹进门验证
        wakeConfirmed = false
        client.localHit = true
        // 上报实际命中的唤醒词（多词表下供服务端 wake_start 精确回显）
        client.localHitKeyword = hitKeyword
        client.startStream(streamStartWallMs)
        streamSessionId = client.currentSessionId()
        stateHolder.updateKwsStatus("已命中（推流中）")
        Timber.i("唤醒推流开始: session=$streamSessionId preRoll=${preRollMs}ms")

        val frameBuf = ShortArray(STREAM_FRAME_SAMPLES)
        // 等待连接期间继续读帧暂存，避免唤醒词后的指令内容在握手期间丢失
        val pending = java.io.ByteArrayOutputStream(STREAM_FRAME_BYTES * 8)
        var waitedMs = 0L
        while (!stopStreamRequested && !shouldStopLoop &&
            client.state.value != AudioStreamClient.ConnectionState.CONNECTED &&
            waitedMs < WAKE_CONNECT_TIMEOUT_MS
        ) {
            val n = ar.read(frameBuf, 0, STREAM_FRAME_SAMPLES)
            if (n > 0) {
                pending.write(pcmToBytes(frameBuf, n))
                waitedMs += n * 1000L / SR
            } else if (n < 0) {
                Timber.w("唤醒推流握手期间读取错误: $n")
                break
            }
        }

        // 建连超时判定：连接就绪与否决定后续音频走直送还是离线碎片缓存。
        // 注意：建连超时只用于「避免无限等待」，不参与命中确认计时。
        val connectTimedOut = !stopStreamRequested && !shouldStopLoop &&
            client.state.value != AudioStreamClient.ConnectionState.CONNECTED
        // 连接是否已就绪（未就绪则预滚/暂存帧一并转离线碎片缓存）
        val wsReady = !stopStreamRequested && !shouldStopLoop && !connectTimedOut
        if (connectTimedOut) {
            Timber.w("唤醒推流建连超时（${WAKE_CONNECT_TIMEOUT_MS}ms 内未就绪），结束本轮推流，音频转离线缓存")
        }

        // 连接就绪：先发预滚，再发握手期间暂存的帧；未就绪则一并转离线碎片缓存
        if (!stopStreamRequested && !shouldStopLoop) {
            preRoll?.let { flushWakeBytes(client, it, wsReady) }
            val pendingBytes = pending.toByteArray()
            if (pendingBytes.isNotEmpty()) flushWakeBytes(client, pendingBytes, wsReady)
        }

        // 建连超时：落盘尾部分片并结束本轮推流（保留客户端实例供下次唤醒复用）
        if (connectTimedOut) {
            persistFragment()
            client.stopStream()
            client.localHit = false
            stateHolder.updateKwsStatus("监听中")
            Timber.i("唤醒推流结束（建连超时），回到分段采集")
            return
        }

        try {
            var streamedMs = 0L
            // 命中确认计时基准：连接就绪（CONNECTED）时刻，不含此前的建连耗时。
            // 未建连期间不触发该超时（期间的音频已在走离线碎片缓存兜底）。
            val confirmStartMs = System.currentTimeMillis()
            while (isEnabled && !shouldStopLoop && !stopStreamRequested &&
                streamedMs < WAKE_STREAM_MAX_MS
            ) {
                // 命中确认超时兜底：连接就绪后 5 秒内仍未收到 wake/start（声纹进门验证
                // 未通过或服务端无响应），主动结束本轮推流回到分段采集；已确认后不再受此约束
                if (!wakeConfirmed && System.currentTimeMillis() - confirmStartMs >= WAKE_CONFIRM_TIMEOUT_MS) {
                    Timber.w("唤醒未确认（声纹进门验证未通过或超时），结束本轮推流")
                    break
                }
                if (ar.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                    Timber.w("唤醒推流期间录音状态异常 state=${ar.recordingState}")
                    signalRecordingInterrupted("AudioRecord 状态异常 state=${ar.recordingState}")
                    break
                }
                val n = ar.read(frameBuf, 0, STREAM_FRAME_SAMPLES)
                if (n < 0) {
                    Timber.w("唤醒推流读取错误: $n")
                    signalRecordingInterrupted("唤醒推流读取错误: $n")
                    break
                }
                if (n == 0) continue

                totalCapturedSamples += n
                streamedMs += n * 1000L / SR
                val rms = computeRms(frameBuf, n)
                reportMicActivity(rms, n, recordingOk = true)
                stateHolder.updateDbLevel(
                    if (rms > 0) (20.0 * log10(rms / 32768.0)).toFloat() else -80f
                )

                val bytes = pcmToBytes(frameBuf, n)
                val connected = client.state.value == AudioStreamClient.ConnectionState.CONNECTED
                if (!(connected && client.send(bytes))) {
                    // WS 不可用 → 转本地物理分片缓存，避免丢唤醒指令音频
                    appendFragment(bytes)
                }

                // 重连成功 → 落盘挂起碎片并触发补传（与流式模式一致）
                if (pendingReconnectFlush) {
                    pendingReconnectFlush = false
                    persistFragment()
                    triggerCacheUpload()
                }
            }
        } finally {
            // 尾部分片落盘，避免丢尾音
            persistFragment()
            // 只停推流不 close()：保留客户端实例供下次唤醒复用
            client.stopStream()
            // 复位端侧命中标记，避免影响后续常驻流式模式
            client.localHit = false
            stateHolder.updateKwsStatus("监听中")
            Timber.i("唤醒推流结束，回到分段采集")
        }
    }

    /**
     * 发送一段唤醒推流 PCM：已连接则直送，否则落入离线分片缓存。
     *
     * @param client 流式客户端
     * @param pcm 待发送的原始 PCM（s16le 单声道）
     * @param connected 当前是否已连接
     */
    private fun flushWakeBytes(client: AudioStreamClient, pcm: ByteArray, connected: Boolean) {
        totalCapturedSamples += pcm.size / 2
        if (!(connected && client.send(pcm))) {
            appendFragment(pcm)
        }
    }

    /** 云端 KWS 测试结果：汇总为一行摘要供设置页展示（回调运行在 OkHttp 读取线程）。 */
    private fun onKwsCloudTestResult(json: JSONObject) {
        try {
            val keyword = json.optString("keyword", "")
            val reason = json.optString("reason", "")
            val durMs = json.optInt("dur_ms", 0)
            val entry = json.optDouble("entry_score", 0.0)
            val entryAsNorm = json.optBoolean("entry_as_norm", false)
            val asr = json.optString("asr_text", "")
            val vpCount = json.optJSONArray("vp_scores")?.length() ?: 0
            val summary = buildString {
                append("词=").append(keyword.ifBlank { "-" })
                append(" | 时长=").append(durMs).append("ms")
                append(" | 进门=").append("%.3f".format(entry))
                append(if (entryAsNorm) "(AS-Norm)" else "(raw)")
                append(" | 滑窗=").append(vpCount).append("点")
                append(" | 原因=").append(reason.ifBlank { "-" })
                if (asr.isNotBlank()) append(" | ASR=").append(asr.take(40))
            }
            stateHolder.updateKwsCloudTestResult(summary)
            Timber.i("[LocalKws] 云端测试结果: $summary")
        } catch (e: Exception) {
            Timber.w(e, "[LocalKws] 云端测试结果解析失败")
        }
    }

    /**
     * 计算 PCM 帧的均方根 (RMS) 能量。
     *
     * @param frame 短整型 PCM 数据（16-bit）
     * @param count 有效采样数
     * @return RMS 值（0 ~ 32768）
     */
    internal fun computeRms(frame: ShortArray, count: Int): Double {
        if (count <= 0) return 0.0
        var sum = 0.0
        for (i in 0 until count) {
            val s = frame[i].toDouble()
            sum += s * s
        }
        return sqrt(sum / count)
    }

    // ======================== 麦克风有效性检测 ========================

    /**
     * 上报一帧音频的麦克风有效性（仅采集线程调用，无需同步）。
     *
     * 无效条件（任一成立即视为无效）：
     * - (a) 全零帧；
     * - (b) AudioRecord.recordingState != RECORDSTATE_RECORDING；
     * - (c) RMS == 0 的恒定零直流（真实安静环境仍有底噪，RMS 通常 > 0）。
     *
     * 防抖：无效条件持续 [MIC_DEBOUNCE_MS] 才升级为 [MicStatus.OCCUPIED]；
     * 恢复后需稳定 [MIC_DEBOUNCE_MS] 才回到 [MicStatus.VALID]，避免真实安静房间误报。
     *
     * @param rms 本帧均方根能量
     * @param count 本帧有效样本数
     * @param recordingOk AudioRecord 是否处于 RECORDING 状态
     */
    private fun reportMicActivity(rms: Double, count: Int, recordingOk: Boolean) {
        val now = System.currentTimeMillis()
        val invalidKind: MicStatus? = when {
            !recordingOk -> MicStatus.STATE_INVALID
            count <= 0 || rms <= 0.0 -> MicStatus.SILENT_ZERO
            else -> null
        }
        if (invalidKind != null) {
            micValidSinceMs = null
            if (micInvalidSinceMs == null) micInvalidSinceMs = now
            val sustained = now - (micInvalidSinceMs ?: now) >= MIC_DEBOUNCE_MS
            stateHolder.updateMicStatus(if (sustained) MicStatus.OCCUPIED else invalidKind)
        } else {
            micInvalidSinceMs = null
            if (micValidSinceMs == null) micValidSinceMs = now
            if (now - (micValidSinceMs ?: now) >= MIC_DEBOUNCE_MS) {
                stateHolder.updateMicStatus(MicStatus.VALID)
            }
        }
    }

    /**
     * 上报录音中断（无法(重)启动或被系统打断），驱动 DataCollectorService 弹出
     * 「录音已中断」高优先级可点击通知。此路径不做自动重试之外的用户可见恢复，
     * 恢复动作由用户点击通知进入前台触发。
     */
    private fun signalRecordingInterrupted(reason: String) {
        Timber.w("录音中断: $reason")
        stateHolder.updateMicStatus(MicStatus.STATE_INVALID)
        try {
            onRecordingInterrupted?.invoke()
        } catch (e: Exception) {
            Timber.w("录音中断回调异常: ${e.message}")
        }
    }

    // ======================== 流式采集 ========================

    /**
     * 流式采集模式：连续读取 100ms PCM 帧并直送 WS。
     *
     * - WS 已连接 → [AudioStreamClient.send] 直送；
     * - WS 离线 / 收到 throttle → 累积为本地物理分片（约 5 分钟，优先静音点切分）；
     * - 重连成功 → 落盘挂起碎片并触发 HTTP 补传。
     *
     * 退出条件：主动停止或 AudioRecord 状态异常；退出时冲刷尾部分片，避免丢尾音。
     */
    private fun startStreaming(ar: AudioRecord) {
        val client = ensureStreamClient()
        // 真正的采集起始墙钟：在验证通过、开始读帧时才打点
        streamStartWallMs = System.currentTimeMillis()
        totalCapturedSamples = 0L
        fragmentSeq = 0
        fragmentBuffer = null
        pendingReconnectFlush = false
        // 常驻流式模式由服务端自行跑 KWS，绝不能携带端侧命中标记
        client.localHit = false
        client.startStream(streamStartWallMs)
        streamSessionId = client.currentSessionId()

        val frameBuf = ShortArray(STREAM_FRAME_SAMPLES)
        stateHolder.updateVadStatus("idle")
        var silenceStartMs: Long? = null
        var hasEverSpoken = false

        try {
            while (isEnabled && !shouldStopLoop) {
                if (ar.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                    Timber.w("录音状态异常 state=${ar.recordingState}，流式采集退出")
                    signalRecordingInterrupted("AudioRecord 状态异常 state=${ar.recordingState}")
                    break
                }
                val n = ar.read(frameBuf, 0, STREAM_FRAME_SAMPLES)
                if (n < 0) {
                    Timber.w("流式读取错误: $n")
                    signalRecordingInterrupted("流式读取错误: $n")
                    break
                }
                if (n == 0) continue

                totalCapturedSamples += n
                val rms = computeRms(frameBuf, n)
                // 上报麦克风有效性（带 10s 防抖），驱动常驻通知文案
                reportMicActivity(rms, n, recordingOk = true)
                stateHolder.updateDbLevel(
                    if (rms > 0) (20.0 * log10(rms / 32768.0)).toFloat() else -80f
                )

                // 端侧唤醒词检测（测试用途，不参与推流决策）
                feedKws(frameBuf, n)?.let { onKwsHit(it) }

                // VAD 状态（沿用旧语义，用于 UI 展示与分片静音边界）
                val nowMs = System.currentTimeMillis()
                if (rms >= RMS_THRESHOLD) {
                    hasEverSpoken = true
                    stateHolder.updateVadStatus("speaking")
                    silenceStartMs = null
                } else {
                    if (silenceStartMs == null) silenceStartMs = nowMs
                    stateHolder.updateVadStatus(
                        if (!hasEverSpoken) "listening"
                        else if (nowMs - (silenceStartMs ?: nowMs) >= SILENCE_MS) "idle"
                        else "speaking"
                    )
                }

                // 重连成功 → 落盘挂起碎片并触发补传（在采集线程执行，避免缓冲竞态）
                if (pendingReconnectFlush) {
                    pendingReconnectFlush = false
                    persistFragment()
                    triggerCacheUpload()
                }

                val bytes = pcmToBytes(frameBuf, n)
                val connected = client.state.value == AudioStreamClient.ConnectionState.CONNECTED
                if (connected && client.send(bytes)) {
                    // 直送成功
                } else {
                    // 离线或发送失败 → 转本地物理分片缓存
                    appendFragment(bytes)
                }

                maybeCutFragment(rms)
            }
        } finally {
            // 尾部分片落盘，避免丢尾部语音
            persistFragment()
        }
    }

    /** 惰性创建流式客户端，绑定节流/重连回调与时间基准提供器。 */
    private fun ensureStreamClient(): AudioStreamClient {
        streamClient?.let { return it }
        val client = AudioStreamClient(context, httpClient, ServerConfig.DEVICE_NAME)
        // 云端 KWS 测试模式：服务端收到 test=true 后只回推结果，不投递 AI、不落盘
        client.testMode = DataCollectorService.isKwsCloudTestEnabled(context)
        client.onKwsTestResult = { json -> onKwsCloudTestResult(json) }
        // 重连时用「会话起始 + 已采集样本」推算当前位置，纠正 audio_start 时间
        client.positionProvider = { streamStartWallMs + totalCapturedSamples * 1000L / SR }
        client.onThrottle = { Timber.w("服务端 throttle，已转本地缓存") }
        client.onConnected = { pendingReconnectFlush = true }
        // 服务端唤醒事件：确认开始说话播上行双音，录制结束播下行双音，未知 stage 仅记日志
        // 每次播放前读取当前音量，使设置页的调整即时生效
        client.onWakeEvent = { stage, reason ->
            val toneVolume = DataCollectorService.getHintToneVolume(context)
            when (stage) {
                "start" -> {
                    hintTonePlayer.setVolume(toneVolume)
                    hintTonePlayer.playStart()
                    // 服务端已确认唤醒（声纹进门验证通过），通知采集线程解除确认超时兜底
                    wakeConfirmed = true
                }
                "end" -> {
                    hintTonePlayer.setVolume(toneVolume)
                    hintTonePlayer.playEnd()
                    // 通知采集线程结束本轮唤醒推流（回调在 OkHttp 读取线程，只能置位标志）
                    stopStreamRequested = true
                }
                else -> Timber.d("忽略未知唤醒 stage=$stage reason=${reason ?: "-"}")
            }
        }
        streamClient = client
        return client
    }

    /** 追加一帧 PCM 到当前离线碎片缓冲（离线期间调用）。 */
    private fun appendFragment(pcm: ByteArray) {
        var buf = fragmentBuffer
        if (buf == null) {
            buf = java.io.ByteArrayOutputStream(STREAM_FRAME_BYTES * 32)
            fragmentBuffer = buf
            // 本片起始样本偏移 = 已采集总数 - 本帧样本数
            fragmentStartSample = totalCapturedSamples - pcm.size / 2
        }
        buf.write(pcm)
    }

    /**
     * 判断是否需要切分离线碎片：
     * 达到目标时长（5 分钟）且当前帧为静音 → 切片；
     * 长时间无静音点则在硬上限处强制切片，避免缓冲无界增长。
     */
    private fun maybeCutFragment(rms: Double) {
        val buf = fragmentBuffer ?: return
        val bufferedMs = (buf.size() / 2) * 1000L / SR
        if (bufferedMs >= FRAGMENT_MS && rms < RMS_THRESHOLD) {
            persistFragment()
        } else if (bufferedMs >= FRAGMENT_HARD_MS) {
            persistFragment()
        }
    }

    /**
     * 将当前碎片缓冲封装为 WAV 并以真实采集起始时间落盘缓存。
     *
     * 碎片起始墙钟 = 会话起始墙钟 + 碎片起始样本偏移推算，绝不使用当前时间。
     * 采集线程独占调用。
     */
    private fun persistFragment() {
        val buf = fragmentBuffer ?: return
        fragmentBuffer = null
        val pcm = try { buf.toByteArray() } catch (_: Exception) { ByteArray(0) }
        if (pcm.isEmpty()) return
        try {
            val sampleCount = pcm.size / 2
            val startWallMs = streamStartWallMs + fragmentStartSample * 1000L / SR
            val seq = fragmentSeq++
            saveFragmentToCache(pcm, startWallMs, sampleCount, seq)
        } catch (e: Exception) {
            Timber.w("离线碎片落盘失败: ${e.message}")
        }
    }

    /**
     * 保存一个离线碎片到 upload_cache，复用旧 multipart 补传通道。
     *
     * 按当前 [DataCollectorService.getUploadFormat] 决定编码格式：
     * flac 经 [FlacFinalizer]，编码失败降级 WAV（数据绝不丢）。
     * JSON 同时携带完整元数据（session_id/device_id/seq/start_wall_ms/
     * sample_count/sample_rate/format），其中 client_time 使用碎片的真实起始时间
     * （毫秒精度，与 PcmCheckpointFormat.CLIENT_TIME_PATTERN 对齐）。
     */
    private fun saveFragmentToCache(
        pcm: ByteArray, startWallMs: Long, sampleCount: Int, seq: Int
    ) {
        if (!com.xehuri.kinship.service.DataCollectorService.isCacheEnabled(context)) {
            Timber.i("缓存已禁用，丢弃离线碎片")
            return
        }
        try {
            val cacheDir = File(context.cacheDir, CACHE_DIR_NAME)
            cacheDir.mkdirs()
            val clientTimeStr = SimpleDateFormat(
                "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.getDefault()
            ).format(Date(startWallMs))

            // 按当前上传格式编码；flac 失败降级 wav
            val wantFlac = com.xehuri.kinship.service.DataCollectorService
                .getUploadFormat(context) == PcmCheckpointWriter.FORMAT_FLAC
            var audioBytes: ByteArray? = null
            var ext = PcmCheckpointWriter.FORMAT_WAV
            if (wantFlac) {
                audioBytes = FlacFinalizer.encode(pcm, SR)
                if (audioBytes != null && audioBytes.size > 42) {
                    ext = PcmCheckpointWriter.FORMAT_FLAC
                } else {
                    audioBytes = null
                }
            }
            if (audioBytes == null) {
                audioBytes = pcmToWav(pcm)
                ext = PcmCheckpointWriter.FORMAT_WAV
            }

            val jsonData = JSONObject().apply {
                put("client_time", clientTimeStr)
                put("mode", "listen")
                put("session_id", streamSessionId)
                put("device_id", DeviceId.get(context))
                put("seq", seq)
                put("start_wall_ms", startWallMs)
                put("sample_count", sampleCount)
                put("sample_rate", SR)
                put("format", ext)
            }
            val base = "$startWallMs-$seq"
            File(cacheDir, "$base.json").writeText(jsonData.toString())
            File(cacheDir, "$base.$ext").writeBytes(audioBytes)
            Timber.i("离线碎片已缓存: $base.$ext (${sampleCount / SR}s, ${audioBytes.size}B)")
        } catch (e: Exception) {
            Timber.w("离线碎片缓存失败: ${e.message}")
        }
    }

    /**
     * 后台触发离线缓存补传（同一时刻仅一个线程，避免同一条被并发重复上传）。
     *
     * 补传进行中又收到新触发时，不并发起第二个线程，而是标记「再跑一轮」：待当前轮
     * 结束后立即补传新落盘的条目。这样中断路径新产生的分段不会被 in-flight 状态吞掉，
     * 同时仍保持单线程顺序消费，不会重复上传同一条。
     */
    private fun triggerCacheUpload() {
        synchronized(cacheUploadLock) {
            if (cacheUploadInFlight) {
                cacheUploadRerunRequested = true
                return
            }
            cacheUploadInFlight = true
        }
        Thread({
            try {
                while (true) {
                    uploadCachedData()
                    val rerun = synchronized(cacheUploadLock) {
                        val requested = cacheUploadRerunRequested
                        cacheUploadRerunRequested = false
                        // 无待补跑请求：本轮结束，释放互斥标记供后续触发起新线程
                        if (!requested) cacheUploadInFlight = false
                        requested
                    }
                    if (!rerun) break
                }
            } catch (e: Exception) {
                Timber.w("缓存补传异常: ${e.message}")
                synchronized(cacheUploadLock) { cacheUploadInFlight = false }
            }
        // 设为守护线程，避免缓存补传线程阻塞 JVM 退出
        }, "DcCacheUpload").apply { isDaemon = true }.start()
    }

    /** ShortArray PCM 转小端 s16le 字节数组。 */
    private fun pcmToBytes(pcm: ShortArray, count: Int): ByteArray {
        val out = ByteArray(count * 2)
        for (i in 0 until count) {
            val v = pcm[i].toInt()
            out[i * 2] = (v and 0xFF).toByte()
            out[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
        }
        return out
    }

    /** 为裸 PCM（s16le / 单声道 / 16kHz）添加 44 字节 WAV 头。 */
    private fun pcmToWav(pcm: ByteArray): ByteArray {
        val totalBytes = pcm.size
        val baos = java.io.ByteArrayOutputStream(44 + totalBytes)
        fun w16(v: Int) {
            baos.write(v and 0xFF)
            baos.write(v shr 8 and 0xFF)
        }
        fun w32(v: Int) { w16(v); w16(v shr 16) }
        baos.write("RIFF".toByteArray()); w32(36 + totalBytes)
        baos.write("WAVE".toByteArray())
        baos.write("fmt ".toByteArray()); w32(16)
        w16(1)      // PCM
        w16(1)      // mono
        w32(SR)     // sample rate
        w32(SR * 2) // byte rate
        w16(2)      // block align
        w16(16)     // bits per sample
        baos.write("data".toByteArray()); w32(totalBytes)
        baos.write(pcm)
        return baos.toByteArray()
    }

    /** 指数退避重试（1s→2s→4s→...→30s 封顶）；停止后不再重试 */
    private fun scheduleRetry() {
        val delay = retryDelayMs
        retryDelayMs = (retryDelayMs * 2).coerceAtMost(30000L)
        if (isEnabled && !shouldStopLoop) {
            handler?.postDelayed({
                if (isEnabled && !shouldStopLoop) {
                    startRecording()
                }
            }, delay)
        }
    }

    /** 重置重试延迟（录音启动成功时调用） */
    private fun resetRetryDelay() {
        retryDelayMs = 1000L
    }

    // ======================== 离线缓存补传 ========================

    internal fun trySendCachedViaWebRtc(
        cachedJson: JSONObject,
        audioFile: File?,
        manager: P2pWebRtcManager? = P2pWebRtcManager.instance
    ): Boolean {
        if (ServerConfig.transportMode == TransportMode.FORCE_FRP) return false
        if (ServerConfig.selectedEndpointType != EndpointType.FRP) return false
        if (manager == null) return false
        if (!manager.isReady) return false
        val file = audioFile ?: return false
        if (!file.exists()) return false
        val declaredSize = file.length()
        if (declaredSize <= 0L || declaredSize > AudioChunker.MAX_TOTAL_BYTES) return false
        val startMs = cachedJson.optLong(
            "start_ms",
            cachedJson.optLong("start_wall_ms", 0L)
        )
        if (startMs <= 0L) return false
        return try {
            val bytes = file.readBytes()
            if (bytes.size.toLong() != declaredSize) return false
            val format = if (file.name.endsWith(".flac")) {
                P2pProtocol.FORMAT_FLAC
            } else {
                cachedJson.optString("format", P2pProtocol.FORMAT_WAV)
            }
            val meta = AudioMeta.forAudio(
                sessionId = cachedJson.optString("session_id", ""),
                seq = cachedJson.optInt("seq", -1),
                startMs = startMs,
                clientTime = cachedJson.optString("client_time", ""),
                format = format,
                size = bytes.size
            ) ?: return false
            val sent = runBlocking {
                withTimeoutOrNull(WEBRTC_SEND_TIMEOUT_MS) { manager.sendAudio(meta, bytes) }
            } ?: false
            if (sent) {
                stateHolder.updateDebugState(JSONObject().apply {
                    put("audio_last_upload", "success")
                    put("audio_size", bytes.size.toLong())
                    put("audio_transport", "webrtc")
                }.toString())
            }
            sent
        } catch (e: Exception) {
            Timber.w("WebRTC 音频发送失败: ${e.javaClass.simpleName}")
            false
        }
    }

    /**
     * 上传一条缓存的 JSON+WAV 到后端。
     *
     * @return true 上传成功
     */
    private fun sendCachedData(jsonStr: String, wavFile: File?): Boolean {
        return try {
            val cachedJson = JSONObject(jsonStr)
            if (trySendCachedViaWebRtc(cachedJson, wavFile)) return true
            val prefs = context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
            val baseUrl = com.xehuri.kinship.config.ServerConfig.BASE_URL
            val url = "$baseUrl/api/screen/stt/voice-session-multipart"
            val token = prefs.getString("auth_token", "") ?: ""

            val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
            builder.addFormDataPart(
                "client_time", cachedJson.getString("client_time")
            )
            // 回传毫秒级起始时间：后端优先使用它推算时间轴，避免 client_time
            // 字符串精度不足导致跨段裁剪多裁真实音频（见后端 _resolve_start）。
            val startWallMs = cachedJson.optLong("start_wall_ms", -1L)
            if (startWallMs >= 0L) {
                builder.addFormDataPart("start_wall_ms", startWallMs.toString())
            }
            builder.addFormDataPart(
                "mode", cachedJson.optString("mode", "listen")
            )
            builder.addFormDataPart("device_name", com.xehuri.kinship.config.ServerConfig.effectiveDeviceName)
            val deviceId = cachedJson.optString("device_id", "").ifBlank { DeviceId.get(context) }
            val sessionId = cachedJson.optString("session_id", "")
            val seq = cachedJson.optInt("seq", -1)
            builder.addFormDataPart("device_id", deviceId)
            builder.addFormDataPart("session_id", sessionId)
            builder.addFormDataPart("seq", seq.toString())
            if (wavFile != null && wavFile.exists()) {
                // T2: 按实体扩展名决定 multipart filename + MIME（后端 magic sniff 亦兜底）
                val isFlac = wavFile.name.endsWith(".flac")
                val (mName, mMime) = if (isFlac) "audio.flac" to "audio/flac"
                else "audio.wav" to "audio/wav"
                builder.addFormDataPart(
                    "file", mName,
                    wavFile.asRequestBody(mMime.toMediaType())
                )
            }
            val requestBody = builder.build()

            val request = Request.Builder()
                .url(url)
                .apply {
                    if (token.isNotEmpty()) {
                        addHeader("Authorization", "Bearer $token")
                    }
                    addHeader("X-Device-Id", DeviceId.get(context))
                }
                .post(requestBody)
                .build()

            val response = httpClient.getClient().newCall(request).execute()
            val code = response.code
            val respBody = response.body?.string() ?: ""
            response.close()
            Timber.i("缓存条上传完成 HTTP $code: ${respBody.take(80)}")
            if (code == 200) {
                // 保持与旧即时上传一致的 UI 反馈：回显 ASR 文本 + 记录上传状态
                try {
                    val text = JSONObject(respBody).optString("text", "")
                    if (text.isNotEmpty()) {
                        stateHolder.updateLastResponseText(text)
                    }
                } catch (_: Exception) {
                    // 响应体不是 JSON 时忽略
                }
                stateHolder.updateDebugState(JSONObject().apply {
                    put("audio_last_upload", "success")
                    put("audio_size", wavFile?.length() ?: 0L)
                }.toString())
                true
            } else {
                false
            }
        } catch (e: Exception) {
            Timber.w("sendCachedData 异常: ${e.message}")
            false
        }
    }

    /**
     * 上传 upload_cache 目录中所有缓存的 JSON+WAV。
     * 按文件名排序（时间戳前缀），先上传最早的。
     * 遇到失败立即停止（服务器可能仍不可用）。
     */
    private fun uploadCachedData() {
        try {
            val cacheDir = File(context.cacheDir, CACHE_DIR_NAME)
            if (!cacheDir.exists()) return
            val jsonFiles = cacheDir.listFiles { f ->
                f.isFile && f.name.endsWith(".json")
            }?.sortedBy { it.name } ?: return
            if (jsonFiles.isEmpty()) return
            Timber.i("找到 ${jsonFiles.size} 个缓存文件，尝试上传...")
            for (jsonFile in jsonFiles) {
                val baseName = jsonFile.nameWithoutExtension
                try {
                    val jsonData = jsonFile.readText()
                    // T2: 按 JSON format 解析音频实体（wav/flac 双后缀，互为兜底）
                    val fmt = try {
                        JSONObject(jsonData).optString("format", PcmCheckpointWriter.FORMAT_WAV)
                    } catch (_: Exception) {
                        PcmCheckpointWriter.FORMAT_WAV
                    }
                    val primary = if (fmt == PcmCheckpointWriter.FORMAT_FLAC) "flac" else "wav"
                    val secondary = if (primary == "flac") "wav" else "flac"
                    val audioFile = File(cacheDir, "$baseName.$primary").takeIf { it.exists() }
                        ?: File(cacheDir, "$baseName.$secondary").takeIf { it.exists() }
                    val success = sendCachedData(jsonData, audioFile)
                    if (success) {
                        jsonFile.delete()
                        if (audioFile != null && audioFile.exists()) audioFile.delete()
                        Timber.i("缓存上传成功: $baseName")
                    } else {
                        Timber.w("缓存上传失败，停止后续尝试: $baseName")
                        break
                    }
                } catch (e: Exception) {
                    Timber.w("缓存上传异常: ${e.message}")
                    break
                }
            }
        } catch (e: Exception) {
            Timber.w("uploadCachedData 异常: ${e.message}")
        }
    }
}
