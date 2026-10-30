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

/**
 * CheckpointRecovery 单元测试。
 *
 * 覆盖：孤儿 `.part` 转成 upload_cache 条目（可被 uploadCachedData 重放）、
 * 空文件与损坏 sidecar 不导致崩溃且被清理、缺失 sidecar 时按文件名兜底恢复。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CheckpointRecoveryTest {

    private lateinit var filesDir: File
    private lateinit var cacheDir: File
    private lateinit var context: Context
    private val tempDirs = mutableListOf<File>()

    private val startWallMs = 1_700_000_100_000L

    @Before
    fun setup() {
        filesDir = createTempDir("cp_recovery_files")
        cacheDir = createTempDir("cp_recovery_cache")
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

    private fun pendingSegmentDir(session: String): File = File(
        File(File(filesDir, PcmCheckpointWriter.CHECKPOINT_DIR_NAME), PcmCheckpointWriter.PENDING_DIR_NAME),
        session
    ).apply { mkdirs() }

    private fun uploadCacheDir(): File = File(cacheDir, PcmCheckpointWriter.CACHE_DIR_NAME)

    private fun writeSidecar(dir: File, segStartMs: Long, session: String, seq: Int) {
        File(dir, "$segStartMs.json").writeText(
            JSONObject().apply {
                put("session_id", session)
                put("start_wall_ms", segStartMs)
                put("sample_rate", 16000)
                put("device_id", "device-xyz")
                put("seg_seq", seq)
            }.toString()
        )
    }

    // ========================================================================
    // 正常恢复
    // ========================================================================

    @Test
    fun `should convert orphan part into replayable upload cache entry`() {
        val dir = pendingSegmentDir("s1")
        val pcm = ByteArray(320) { 1 }
        File(dir, "$startWallMs${PcmCheckpointWriter.PART_SUFFIX}").writeBytes(pcm)
        writeSidecar(dir, startWallMs, "s1", seq = 5)

        val converted = CheckpointRecovery.recover(context)

        assertThat(converted).isEqualTo(1)
        val wav = File(uploadCacheDir(), "$startWallMs-5.wav")
        val jsonFile = File(uploadCacheDir(), "$startWallMs-5.json")
        assertThat(wav.exists()).isTrue()
        assertThat(wav.length()).isEqualTo(PcmCheckpointFormat.WAV_HEADER_BYTES + pcm.size.toLong())
        assertThat(String(wav.readBytes().copyOfRange(0, 4), Charsets.US_ASCII)).isEqualTo("RIFF")

        assertThat(jsonFile.exists()).isTrue()
        val json = JSONObject(jsonFile.readText())
        assertThat(json.getString("mode")).isEqualTo("listen")
        assertThat(json.getLong("start_wall_ms")).isEqualTo(startWallMs)
        assertThat(json.getInt("sample_count")).isEqualTo(pcm.size / 2)
        assertThat(json.getString("client_time")).isNotEmpty()

        // pending 已清理干净
        val leftovers = dir.listFiles()
        assertThat(leftovers == null || leftovers.isEmpty()).isTrue()
        assertThat(dir.exists()).isFalse()
    }

    @Test
    fun `should recover multiple orphans across sessions`() {
        val first = pendingSegmentDir("s1")
        File(first, "$startWallMs${PcmCheckpointWriter.PART_SUFFIX}").writeBytes(ByteArray(100))
        writeSidecar(first, startWallMs, "s1", 0)

        val second = pendingSegmentDir("s2")
        val secondStart = startWallMs + 60_000L
        File(second, "$secondStart${PcmCheckpointWriter.PART_SUFFIX}").writeBytes(ByteArray(200))
        writeSidecar(second, secondStart, "s2", 1)

        val converted = CheckpointRecovery.recover(context)

        assertThat(converted).isEqualTo(2)
        assertThat(File(uploadCacheDir(), "$startWallMs-0.wav").exists()).isTrue()
        assertThat(File(uploadCacheDir(), "$secondStart-1.wav").exists()).isTrue()
    }

    @Test
    fun `should salvage part when sidecar is missing using file name`() {
        val dir = pendingSegmentDir("s3")
        val pcm = ByteArray(64)
        File(dir, "$startWallMs${PcmCheckpointWriter.PART_SUFFIX}").writeBytes(pcm)

        val converted = CheckpointRecovery.recover(context)

        assertThat(converted).isEqualTo(1)
        // 缺 sidecar 时 seq 兜底为 0
        assertThat(File(uploadCacheDir(), "$startWallMs-0.wav").exists()).isTrue()
    }

    @Test
    fun `should return zero when pending directory absent`() {
        val converted = CheckpointRecovery.recover(context)

        assertThat(converted).isEqualTo(0)
    }

    // ========================================================================
    // 容错：空文件 / 损坏 JSON
    // ========================================================================

    @Test
    fun `should discard empty part without crashing`() {
        val dir = pendingSegmentDir("s4")
        File(dir, "$startWallMs${PcmCheckpointWriter.PART_SUFFIX}").writeBytes(ByteArray(0))
        writeSidecar(dir, startWallMs, "s4", 0)

        val converted = CheckpointRecovery.recover(context)

        assertThat(converted).isEqualTo(0)
        val leftovers = dir.listFiles()
        assertThat(leftovers == null || leftovers.isEmpty()).isTrue()
    }

    @Test
    fun `should discard part with corrupt sidecar without crashing`() {
        val dir = pendingSegmentDir("s5")
        File(dir, "$startWallMs${PcmCheckpointWriter.PART_SUFFIX}").writeBytes(ByteArray(128))
        File(dir, "$startWallMs.json").writeText("this is not json {{{")

        val converted = CheckpointRecovery.recover(context)

        assertThat(converted).isEqualTo(0)
        val leftovers = dir.listFiles()
        assertThat(leftovers == null || leftovers.isEmpty()).isTrue()
    }

    @Test
    fun `should skip doomed part but keep healthy one`() {
        val dir = pendingSegmentDir("s6")
        File(dir, "$startWallMs${PcmCheckpointWriter.PART_SUFFIX}").writeBytes(ByteArray(0))
        writeSidecar(dir, startWallMs, "s6", 0)

        val healthyStart = startWallMs + 1000L
        File(dir, "$healthyStart${PcmCheckpointWriter.PART_SUFFIX}").writeBytes(ByteArray(96))
        writeSidecar(dir, healthyStart, "s6", 1)

        val converted = CheckpointRecovery.recover(context)

        assertThat(converted).isEqualTo(1)
        assertThat(File(uploadCacheDir(), "$healthyStart-1.wav").exists()).isTrue()
    }
}
