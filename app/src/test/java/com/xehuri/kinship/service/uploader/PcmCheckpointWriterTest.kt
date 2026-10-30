package com.xehuri.kinship.service.uploader

import android.content.Context
import com.google.common.truth.Truth.assertThat
import io.mockk.every
import io.mockk.mockk
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * PcmCheckpointWriter 单元测试。
 *
 * 覆盖：append/flush/finalize 后 WAV 完整可读、sidecar 先于音频落盘、
 * 最终条目命名与 JSON 格式可被 uploadCachedData 重放、abort 清理、并发追加不丢字节。
 *
 * 说明：本仓库未启用 useJUnitPlatform（build.gradle.kts 未显式配置，见 AGENTS.md 的
 * 描述与实际不符），`org.junit.jupiter` 注解的测试不会被发现执行，故此处沿用仓库内
 * 实际可运行的 JUnit4 + Robolectric 组合。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PcmCheckpointWriterTest {

    private lateinit var filesDir: File
    private lateinit var cacheDir: File
    private lateinit var context: Context
    private val tempDirs = mutableListOf<File>()

    private val sessionId = "session-abc"
    private val segSeq = 3
    private val segStartMs = 1_700_000_000_000L
    private val sampleRate = 16000
    private val deviceId = "device-xyz"

    @Before
    fun setup() {
        filesDir = createTempDir("cp_writer_files")
        cacheDir = createTempDir("cp_writer_cache")
        context = mockk(relaxUnitFun = true)
        every { context.filesDir } returns filesDir
        every { context.cacheDir } returns cacheDir
    }

    @After
    fun teardown() {
        tempDirs.forEach { dir -> if (dir.exists()) dir.deleteRecursively() }
    }

    private fun createTempDir(prefix: String): File {
        val dir = File(System.getProperty("java.io.tmpdir"), "${prefix}_${System.nanoTime()}")
        dir.mkdirs()
        tempDirs.add(dir)
        return dir
    }

    /** flushIntervalMs = 0 关闭周期 flush，避免测试受调度线程干扰 */
    private fun newWriter(flushIntervalMs: Long = 0L): PcmCheckpointWriter =
        PcmCheckpointWriter(
            context = context,
            sessionId = sessionId,
            segSeq = segSeq,
            deviceId = deviceId,
            sampleRate = sampleRate,
            segStartMs = segStartMs,
            flushIntervalMs = flushIntervalMs
        )

    private fun pendingSegmentDir(): File = File(
        File(File(filesDir, PcmCheckpointWriter.CHECKPOINT_DIR_NAME), PcmCheckpointWriter.PENDING_DIR_NAME),
        sessionId
    )

    private fun uploadCacheDir(): File = File(cacheDir, PcmCheckpointWriter.CACHE_DIR_NAME)

    private fun readIntLe(bytes: ByteArray, offset: Int): Int =
        ByteBuffer.wrap(bytes, offset, 4).order(ByteOrder.LITTLE_ENDIAN).int

    // ========================================================================
    // append / flush / finalize
    // ========================================================================

    @Test
    fun `should write complete wav after append flush and finalize`() {
        val pcm = ByteArray(2000) { index -> (index % 128).toByte() }
        val writer = newWriter()

        writer.append(pcm)
        writer.flush()
        val wav = writer.finalizeSegment()

        val file = requireNotNull(wav) { "finalizeSegment 应返回 WAV 文件" }
        assertThat(file.exists()).isTrue()
        assertThat(file.length()).isEqualTo(PcmCheckpointFormat.WAV_HEADER_BYTES + pcm.size.toLong())

        val bytes = file.readBytes()
        assertThat(String(bytes.copyOfRange(0, 4), Charsets.US_ASCII)).isEqualTo("RIFF")
        assertThat(String(bytes.copyOfRange(8, 12), Charsets.US_ASCII)).isEqualTo("WAVE")
        assertThat(String(bytes.copyOfRange(36, 40), Charsets.US_ASCII)).isEqualTo("data")
        assertThat(readIntLe(bytes, 40)).isEqualTo(pcm.size)
        assertThat(bytes.copyOfRange(PcmCheckpointFormat.WAV_HEADER_BYTES, bytes.size)).isEqualTo(pcm)
    }

    @Test
    fun `should use upload cache naming convention with start ms and seq`() {
        val writer = newWriter()
        writer.append(ByteArray(320))

        val wav = writer.finalizeSegment()

        assertThat(wav).isNotNull()
        assertThat(wav!!.name).isEqualTo("$segStartMs-$segSeq.wav")
        assertThat(wav.parentFile).isEqualTo(uploadCacheDir())
    }

    @Test
    fun `should write sidecar before audio and delete it after finalize`() {
        val writer = newWriter()
        writer.append(ByteArray(100))

        val partFile = File(pendingSegmentDir(), "$segStartMs${PcmCheckpointWriter.PART_SUFFIX}")
        val sidecar = File(pendingSegmentDir(), "$segStartMs.json")
        assertThat(partFile.exists()).isTrue()
        assertThat(sidecar.exists()).isTrue()

        val meta = JSONObject(sidecar.readText())
        assertThat(meta.getString("session_id")).isEqualTo(sessionId)
        assertThat(meta.getLong("start_wall_ms")).isEqualTo(segStartMs)
        assertThat(meta.getInt("sample_rate")).isEqualTo(sampleRate)
        assertThat(meta.getString("device_id")).isEqualTo(deviceId)
        assertThat(meta.getInt("seg_seq")).isEqualTo(segSeq)

        writer.finalizeSegment()

        assertThat(partFile.exists()).isFalse()
        assertThat(sidecar.exists()).isFalse()
        assertThat(pendingSegmentDir().exists()).isFalse()
    }

    @Test
    fun `should produce upload cache json replayable by cached upload flow`() {
        val pcm = ByteArray(640)
        val writer = newWriter()
        writer.append(pcm)
        writer.finalizeSegment()

        val jsonFile = File(uploadCacheDir(), "$segStartMs-$segSeq.json")
        assertThat(jsonFile.exists()).isTrue()

        val json = JSONObject(jsonFile.readText())
        assertThat(json.getString("mode")).isEqualTo("listen")
        assertThat(json.getInt("sample_count")).isEqualTo(pcm.size / 2)
        assertThat(json.getLong("start_wall_ms")).isEqualTo(segStartMs)
        assertThat(json.getInt("seq")).isEqualTo(segSeq)
        assertThat(json.getString("session_id")).isEqualTo(sessionId)

        // uploadCachedData 直接消费 client_time，且必须携带毫秒精度（避免后端秒级截断）
        val clientTime = json.getString("client_time")
        assertThat(clientTime).contains(".")
        val parsed = SimpleDateFormat(
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.getDefault()
        ).parse(clientTime)
        assertThat(parsed).isNotNull()
        assertThat(parsed!!.time).isEqualTo(segStartMs)
    }

    @Test
    fun `should return null when finalize without any data`() {
        val writer = newWriter()

        val wav = writer.finalizeSegment()

        assertThat(wav).isNull()
        val cacheContents = uploadCacheDir().listFiles()
        assertThat(cacheContents == null || cacheContents.isEmpty()).isTrue()
    }

    @Test
    fun `should ignore empty append`() {
        val writer = newWriter()
        writer.append(ByteArray(0))

        assertThat(pendingSegmentDir().exists()).isFalse()
        assertThat(writer.finalizeSegment()).isNull()
    }

    // ========================================================================
    // abort
    // ========================================================================

    @Test
    fun `should remove pending files after abort`() {
        val writer = newWriter()
        writer.append(ByteArray(256))

        val partFile = File(pendingSegmentDir(), "$segStartMs${PcmCheckpointWriter.PART_SUFFIX}")
        assertThat(partFile.exists()).isTrue()

        writer.abort()

        assertThat(partFile.exists()).isFalse()
        assertThat(File(pendingSegmentDir(), "$segStartMs.json").exists()).isFalse()
        // 未完成的分段不应进入 upload_cache
        val cacheContents = uploadCacheDir().listFiles()
        assertThat(cacheContents == null || cacheContents.isEmpty()).isTrue()
    }

    @Test
    fun `should make append and finalize no-op after abort`() {
        val writer = newWriter()
        writer.abort()

        writer.append(ByteArray(64))
        writer.flush()

        assertThat(writer.finalizeSegment()).isNull()
    }

    // ========================================================================
    // 周期 flush
    // ========================================================================

    @Test
    fun `should keep periodic flush running and still finalize complete wav`() {
        val writer = newWriter(flushIntervalMs = 20L)
        val chunk = ByteArray(128) { 7 }
        repeat(3) {
            writer.append(chunk)
            Thread.sleep(40)
        }

        val wav = writer.finalizeSegment()

        assertThat(wav).isNotNull()
        assertThat(wav!!.length()).isEqualTo(
            PcmCheckpointFormat.WAV_HEADER_BYTES + 3 * chunk.size.toLong()
        )
    }

    // ========================================================================
    // 线程安全
    // ========================================================================

    @Test
    fun `should serialize concurrent appends without losing bytes`() {
        val writer = newWriter()
        val threadCount = 4
        val appendsPerThread = 25
        val bytesPerAppend = 80

        val threads = (0 until threadCount).map { threadIndex ->
            Thread {
                repeat(appendsPerThread) {
                    writer.append(ByteArray(bytesPerAppend) { threadIndex.toByte() })
                }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }

        val wav = writer.finalizeSegment()
        val expected = PcmCheckpointFormat.WAV_HEADER_BYTES +
            threadCount * appendsPerThread * bytesPerAppend.toLong()
        assertThat(wav).isNotNull()
        assertThat(wav!!.length()).isEqualTo(expected)
    }
}
