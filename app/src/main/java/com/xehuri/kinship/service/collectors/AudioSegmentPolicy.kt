package com.xehuri.kinship.service.collectors

/**
 * 音频分段与批量上传的纯策略实现（无 Android 依赖，便于单元测试）。
 *
 * 设计要点：**分段时长**（采集器读取的 `audio_segment_ms`，单段固定时长）与**上传频率**
 * （`audio_upload_batch_ms`，多久发一次）相互独立。App 端按固定时长封段并落盘，上传再按
 * 固定节奏批量发送，从而在「崩溃最多丢一个 checkpoint flush 周期」与「省电省流量」之间取得平衡。
 *
 * 语义连续性由后端无缝流负责（时间连续的上传分段当一条流，在流内静音端点切分后整体送 ASR），
 * App 端**不做**语义/端点切分。
 */
internal object AudioSegmentPolicy {

    /** 分段前滚重叠时长（ms）：切段时把上一段尾部该时长作为下一段开头，避免首字被切掉 */
    const val OVERLAP_MS = 500

    /** 待上传音频累计阈值（ms）：超过该值无视批次间隔立即上传，避免离线时无限堆积 */
    const val PENDING_UPLOAD_THRESHOLD_MS = 30 * 60 * 1000L

    /**
     * 取 PCM 尾部用于下一段前滚重叠。
     *
     * @param pcm 本段完整 PCM（s16le 单声道）
     * @param overlapBytes 重叠字节数
     * @return 尾部 [overlapBytes] 字节；不足则返回整段；空输入返回空数组
     */
    fun overlapTail(pcm: ByteArray, overlapBytes: Int): ByteArray {
        if (pcm.isEmpty() || overlapBytes <= 0) return ByteArray(0)
        val n = minOf(overlapBytes, pcm.size)
        return pcm.copyOfRange(pcm.size - n, pcm.size)
    }

    /**
     * 计算下一分段的起始墙钟。
     *
     * 下一段开头复用上一段尾部 [overlapSamples] 个采样，故起点需回退重叠时长；重叠音频
     * 不重复计入时间轴（[totalSamples] 减去重叠样本数），保证两段在时间上无缝衔接且不重叠计时。
     *
     * @param segStartMs 本段起始墙钟（ms）
     * @param totalSamples 本段样本总数（含重叠前缀）
     * @param sampleRate 采样率
     * @param overlapSamples 前滚重叠样本数
     */
    fun nextSegmentStartMs(
        segStartMs: Long,
        totalSamples: Int,
        sampleRate: Int,
        overlapSamples: Int
    ): Long {
        if (sampleRate <= 0) return segStartMs
        val overlap = minOf(totalSamples, overlapSamples).coerceAtLeast(0)
        return segStartMs + (totalSamples - overlap) * 1000L / sampleRate
    }

    /**
     * 是否应触发一次批量上传。
     *
     * 触发条件（任一成立）：
     * 1. 待上传音频累计达到 [PENDING_UPLOAD_THRESHOLD_MS]；
     * 2. [batchMs] <= 0（禁用节流，退化成立即上传）；
     * 3. 距上次上传调度达到 [batchMs]。
     *
     * 无待上传内容（[pendingMs] <= 0）时恒不触发；[lastUploadMs] <= 0（尚未建立调度锚点）
     * 时也不触发，由采集器在启动时建立锚点、停止/中断时强制上传兜底。
     *
     * @param lastUploadMs 上次上传调度的墙钟（ms）
     * @param nowMs 当前墙钟（ms）
     * @param pendingMs 当前待上传音频总时长（ms）
     * @param batchMs 配置的批次上传间隔（ms）
     */
    fun isBatchUploadDue(lastUploadMs: Long, nowMs: Long, pendingMs: Long, batchMs: Long): Boolean {
        if (pendingMs <= 0L) return false
        if (pendingMs >= PENDING_UPLOAD_THRESHOLD_MS) return true
        if (batchMs <= 0L) return true
        if (lastUploadMs <= 0L) return false
        return nowMs - lastUploadMs >= batchMs
    }
}

/**
 * 分段内的语音统计（纯 Kotlin，无 Android 依赖）。
 *
 * 逐帧喂入 RMS 与相对时间，累计本段的说话/静音时长，供 [AudioCollector] 输出分段日志
 * （`说话 xxxx ms`）与刷新 UI 的 VAD 展示状态。
 *
 * **不做端点判定**：App 端只按 `audio_segment_ms` 固定时长封段，不提前切段；语义连续性由
 * 后端无缝流负责。
 */
internal class SegmentSpeechTracker(
    private val rmsThreshold: Double
) {

    /** 本段是否出现过语音 */
    var hasSpoken: Boolean = false
        private set

    /** 本段累计说话时长（ms） */
    var speechMs: Long = 0L
        private set

    /** 当前连续静音时长（ms），说话时为 0 */
    var silenceMs: Long = 0L
        private set

    /** 上一帧的相对时间（ms），用于按帧间隔累加时长 */
    private var lastElapsedMs: Long = 0L

    /** 当前是否处于说话状态 */
    private var speaking: Boolean = false

    /**
     * 喂入一帧，更新说话/静音统计。
     *
     * @param rms 帧均方根能量
     * @param elapsedMs 相对本段开始的毫秒数
     */
    fun onFrame(rms: Double, elapsedMs: Long) {
        val delta = (elapsedMs - lastElapsedMs).coerceAtLeast(0L)
        lastElapsedMs = elapsedMs
        if (rms >= rmsThreshold) {
            hasSpoken = true
            speaking = true
            silenceMs = 0L
            speechMs += delta
        } else {
            speaking = false
            silenceMs += delta
        }
    }

    /** VAD 展示状态：idle / listening / speaking（仅用于 UI 展示，不参与切段） */
    fun uiStatus(): String = when {
        speaking -> "speaking"
        !hasSpoken -> "listening"
        silenceMs >= UI_IDLE_SILENCE_MS -> "idle"
        else -> "speaking"
    }

    companion object {
        /**
         * UI 展示为「静音」所需的连续静音时长（ms）。
         *
         * 仅影响 [uiStatus] 的文案，不参与任何切段判定。
         */
        private const val UI_IDLE_SILENCE_MS = 1200L
    }
}

/**
 * 定长 PCM 环形缓冲（s16le 单声道），保留最近 [capacity] 字节。
 *
 * 用于按 30ms 帧增量写入、在分段结束时一次性取出尾部作为下一段的前滚重叠，避免为整段音频
 * 额外保留内存副本（30 分钟段可达数十 MB）。
 */
internal class PcmRing(private val capacity: Int) {

    /** 环形存储 */
    private val buffer = ByteArray(capacity)

    /** 写指针 */
    private var writePos = 0

    /** 有效字节数（不超过 [capacity]） */
    private var filled = 0

    /** 追加一段 PCM；单帧超过容量时只保留帧尾 */
    fun append(pcm: ByteArray) {
        if (pcm.isEmpty() || capacity <= 0) return
        val src = if (pcm.size >= capacity) pcm.copyOfRange(pcm.size - capacity, pcm.size) else pcm
        val first = (capacity - writePos).coerceAtMost(src.size)
        System.arraycopy(src, 0, buffer, writePos, first)
        if (src.size > first) {
            System.arraycopy(src, first, buffer, 0, src.size - first)
        }
        writePos = (writePos + src.size) % capacity
        filled = if (filled + src.size >= capacity) capacity else filled + src.size
    }

    /**
     * 取出最近 [bytes] 字节（由旧到新）并清空缓冲。
     *
     * @return 有效字节不足 [bytes] 时返回全部有效字节；空缓冲返回空数组
     */
    fun drain(bytes: Int): ByteArray {
        if (filled <= 0 || bytes <= 0) return ByteArray(0)
        val n = minOf(bytes, filled)
        val out = ByteArray(n)
        val start = (writePos - n + capacity) % capacity
        val first = (capacity - start).coerceAtMost(n)
        System.arraycopy(buffer, start, out, 0, first)
        if (n > first) {
            System.arraycopy(buffer, 0, out, first, n - first)
        }
        writePos = 0
        filled = 0
        return out
    }
}
