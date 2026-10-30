package com.xehuri.kinship.service.collectors

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * 音频分段（前滚重叠）与批量上传调度的单元测试。
 *
 * 全部基于纯 Kotlin 策略类（[SegmentSpeechTracker] / [PcmRing] / [AudioSegmentPolicy]），
 * 不依赖 Android 运行时。App 端只按 `audio_segment_ms` 固定封段，**不含 VAD 端点切段逻辑**，
 * 故无用例覆盖端点判定。
 *
 * 说明：本仓库未启用 useJUnitPlatform（见 `PcmCheckpointWriterTest` 注释），
 * `org.junit.jupiter` 注解的测试不会被发现执行，故沿用仓库内实际可运行的 JUnit4。
 */
class AudioSegmentPolicyTest {

    // ========================================================================
    // 说话/静音统计：只累计时长与刷新 UI 状态，不触发切段
    // ========================================================================

    @Test
    fun `should accumulate speech and silence stats without cutting`() {
        val tracker = SegmentSpeechTracker(AudioCollector.RMS_THRESHOLD)
        var elapsed = 0L

        // 40 帧语音 = 1200ms
        repeat(40) { elapsed += 30L; tracker.onFrame(1000.0, elapsed) }
        // 20 帧静音 = 600ms
        repeat(20) { elapsed += 30L; tracker.onFrame(0.0, elapsed) }

        assertThat(tracker.hasSpoken).isTrue()
        assertThat(tracker.speechMs).isEqualTo(1200L)
        assertThat(tracker.silenceMs).isEqualTo(600L)
        // 静音未达 UI idle 阈值（1200ms）时仍展示 speaking
        assertThat(tracker.uiStatus()).isEqualTo("speaking")
    }

    @Test
    fun `should report idle after sustained silence and reset on resumed speech`() {
        val tracker = SegmentSpeechTracker(AudioCollector.RMS_THRESHOLD)
        var elapsed = 0L
        repeat(40) { elapsed += 30L; tracker.onFrame(1000.0, elapsed) }

        // 静音累计 1200ms：UI 展示 idle
        repeat(40) { elapsed += 30L; tracker.onFrame(0.0, elapsed) }
        assertThat(tracker.silenceMs).isEqualTo(1200L)
        assertThat(tracker.uiStatus()).isEqualTo("idle")

        // 再次说话：静音计时清零
        elapsed += 30L
        tracker.onFrame(1000.0, elapsed)
        assertThat(tracker.silenceMs).isEqualTo(0L)
        assertThat(tracker.uiStatus()).isEqualTo("speaking")
    }

    @Test
    fun `should report listening before any speech`() {
        val tracker = SegmentSpeechTracker(AudioCollector.RMS_THRESHOLD)
        tracker.onFrame(0.0, 30L)
        assertThat(tracker.hasSpoken).isFalse()
        assertThat(tracker.uiStatus()).isEqualTo("listening")
    }

    // ========================================================================
    // 前滚重叠：存在且不重复计入时间轴
    // ========================================================================

    @Test
    fun `should carry 500ms tail overlap into next segment without double counting`() {
        val sampleRate = AudioCollector.SR
        val overlapSamples = AudioCollector.SEGMENT_OVERLAP_SAMPLES
        assertThat(overlapSamples).isEqualTo(sampleRate * AudioSegmentPolicy.OVERLAP_MS / 1000)

        // 模拟 10s 分段 PCM，尾部 [overlapSamples] 个采样填 0x7F 便于识别
        val totalSamples = sampleRate * 10
        val pcm = ByteArray(totalSamples * 2)
        val tailStartByte = (totalSamples - overlapSamples) * 2
        for (i in tailStartByte until pcm.size) pcm[i] = 0x7F

        val overlap = AudioSegmentPolicy.overlapTail(pcm, overlapSamples * 2)
        assertThat(overlap.size).isEqualTo(overlapSamples * 2)
        assertThat(overlap.all { it == 0x7F.toByte() }).isTrue()

        // 下一段起点回退重叠时长：10s - 0.5s = 9.5s
        val segStart = 1_700_000_000_000L
        val nextStart = AudioSegmentPolicy.nextSegmentStartMs(
            segStart, totalSamples, sampleRate, overlapSamples
        )
        assertThat(nextStart - segStart).isEqualTo(9_500L)
        // 重叠被复用而非重复计时：起点只回退一次
        assertThat(nextStart).isEqualTo(segStart + (totalSamples - overlapSamples) * 1000L / sampleRate)

        // PcmRing 增量写入后一次性取尾，应与直接取尾完全一致
        val ring = PcmRing(overlapSamples * 2)
        var offset = 0
        val frameBytes = AudioCollector.FRAME_SIZE * 2
        while (offset < pcm.size) {
            val end = minOf(offset + frameBytes, pcm.size)
            ring.append(pcm.copyOfRange(offset, end))
            offset = end
        }
        assertThat(ring.drain(overlapSamples * 2)).isEqualTo(overlap)
    }

    @Test
    fun `should return empty overlap for empty or shorter than overlap pitch`() {
        assertThat(AudioSegmentPolicy.overlapTail(ByteArray(0), 16000)).isEmpty()
        // 不足重叠长度时返回整段
        val short = ByteArray(100) { 1 }
        assertThat(AudioSegmentPolicy.overlapTail(short, 16000)).isEqualTo(short)
    }

    // ========================================================================
    // 上传调度：只在达到 batch 间隔（或累计超阈值）时触发
    // ========================================================================

    @Test
    fun `should only trigger upload at batch interval unless pending threshold exceeded`() {
        val batch = 600_000L
        val pending = 60_000L
        val last = 1_000_000L

        // 未到间隔：不触发
        assertThat(AudioSegmentPolicy.isBatchUploadDue(last, last + batch - 1, pending, batch)).isFalse()
        // 恰好达到间隔：触发
        assertThat(AudioSegmentPolicy.isBatchUploadDue(last, last + batch, pending, batch)).isTrue()
        // 超过间隔：触发
        assertThat(AudioSegmentPolicy.isBatchUploadDue(last, last + batch + 5_000L, pending, batch)).isTrue()
        // 无待上传内容：即使超过间隔也不触发
        assertThat(AudioSegmentPolicy.isBatchUploadDue(last, last + batch * 2, 0L, batch)).isFalse()
        // 待上传累计达到阈值：无视间隔立即触发
        assertThat(
            AudioSegmentPolicy.isBatchUploadDue(
                last, last + 1_000L, AudioSegmentPolicy.PENDING_UPLOAD_THRESHOLD_MS, batch
            )
        ).isTrue()
    }

    @Test
    fun `should not trigger upload before first schedule anchor is established`() {
        // 未建立锚点（lastUploadMs<=0）且未达累计阈值：不触发，由启动锚点/停止强制上传兜底
        assertThat(AudioSegmentPolicy.isBatchUploadDue(0L, 1_000_000L, 60_000L, 600_000L)).isFalse()
    }
}
