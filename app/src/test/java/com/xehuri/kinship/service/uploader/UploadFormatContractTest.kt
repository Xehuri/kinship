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
 * T2: 上传格式（wav/flac）双档契约测试。
 *
 * 覆盖：
 *  1. PcmCheckpointWriter uploadFormat=flac 时 finalize 产出 .flac + JSON format 字段；
 *  2. uploadFormat=wav（默认）行为回归：.wav + format=wav；
 *  3. flac 编码失败时降级回 WAV（绝不丢数据）；
 *  4. CheckpointRecovery 按 sidecar format 恢复对应后缀条目；
 *  5. CheckpointCleanup 扫描/删除 .flac 配对；
 *  6. FlacFinalizer 纯函数 STREAMINFO patch 契约。
 *
 * MediaCodec 在 JVM 单测不可用：编码经可注入 [FlacEncoder] 缝，
 * 测试注入假编码器，生产默认 [FlacFinalizer]（MediaCodec + java-flac-encoder 兜底）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UploadFormatContractTest {

    private lateinit var filesDir: File
    private lateinit var cacheDir: File
    private lateinit var context: Context
    private val tempDirs = mutableListOf<File>()

    private val sessionId = "fmt-session"
    private val segSeq = 1
    private val segStartMs = 1_700_000_500_000L
    private val sampleRate = 16000
    private val deviceId = "device-fmt"

    /** 假 FLAC 编码器：产出带 fLaC 魔数的伪字节（含 STREAMINFO 头便于断言） */
    private val fakeFlacEncoder = FlacEncoder { pcm, _ ->
        // 伪 FLAC：fLaC 魔数 + 最小 metadata 头 + PCM 指纹（长度可辨）
        "fLaC".toByteArray(Charsets.US_ASCII) +
            byteArrayOf(0x80.toByte(), 0x00, 0x00, 0x22) + // STREAMINFO 块头（last+type0, len34）
            ByteArray(34) + pcm.copyOf(minOf(pcm.size, 64))
    }

    @Before
    fun setup() {
        filesDir = createTempDir("fmt_files")
        cacheDir = createTempDir("fmt_cache")
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

    private fun newWriter(
        uploadFormat: String,
        encoder: FlacEncoder = fakeFlacEncoder
    ): PcmCheckpointWriter = PcmCheckpointWriter(
        context = context,
        sessionId = sessionId,
        segSeq = segSeq,
        deviceId = deviceId,
        sampleRate = sampleRate,
        segStartMs = segStartMs,
        flushIntervalMs = 0L,
        uploadFormat = uploadFormat,
        flacEncoder = encoder
    )

    private fun uploadCacheDir(): File = File(cacheDir, PcmCheckpointWriter.CACHE_DIR_NAME)

    // ============================================================
    // 1. PcmCheckpointWriter flac 产出
    // ============================================================

    @Test
    fun `finalize with uploadFormat flac produces flac file and format field`() {
        val pcm = ByteArray(2000) { (it % 127).toByte() }
        val writer = newWriter(uploadFormat = "flac")
        writer.append(pcm)

        val out = writer.finalizeSegment()

        assertThat(out).isNotNull()
        assertThat(out!!.name).isEqualTo("$segStartMs-$segSeq.flac")
        assertThat(out.exists()).isTrue()
        val bytes = out.readBytes()
        assertThat(String(bytes.copyOfRange(0, 4), Charsets.US_ASCII)).isEqualTo("fLaC")

        val json = JSONObject(File(uploadCacheDir(), "$segStartMs-$segSeq.json").readText())
        assertThat(json.getString("format")).isEqualTo("flac")
        assertThat(json.getInt("sample_count")).isEqualTo(pcm.size / 2)
    }

    @Test
    fun `finalize default wav keeps backward compatible naming and format field`() {
        val pcm = ByteArray(640)
        val writer = newWriter(uploadFormat = "wav")
        writer.append(pcm)

        val out = writer.finalizeSegment()

        assertThat(out).isNotNull()
        assertThat(out!!.name).isEqualTo("$segStartMs-$segSeq.wav")
        val head = out.readBytes().copyOfRange(0, 4)
        assertThat(String(head, Charsets.US_ASCII)).isEqualTo("RIFF")

        val json = JSONObject(File(uploadCacheDir(), "$segStartMs-$segSeq.json").readText())
        assertThat(json.getString("format")).isEqualTo("wav")
    }

    @Test
    fun `flac encode failure falls back to wav without losing data`() {
        val pcm = ByteArray(1024) { 3 }
        val failing = FlacEncoder { _, _ -> null }
        val writer = newWriter(uploadFormat = "flac", encoder = failing)
        writer.append(pcm)

        val out = writer.finalizeSegment()

        assertThat(out).isNotNull()
        assertThat(out!!.name).isEqualTo("$segStartMs-$segSeq.wav")
        val bytes = out.readBytes()
        assertThat(String(bytes.copyOfRange(0, 4), Charsets.US_ASCII)).isEqualTo("RIFF")
        // PCM 全量保留在 WAV data 区
        assertThat(bytes.copyOfRange(PcmCheckpointFormat.WAV_HEADER_BYTES, bytes.size))
            .isEqualTo(pcm)

        val json = JSONObject(File(uploadCacheDir(), "$segStartMs-$segSeq.json").readText())
        assertThat(json.getString("format")).isEqualTo("wav")
    }

    // ============================================================
    // 2. CheckpointRecovery 按 sidecar format 恢复
    // ============================================================

    @Test
    fun `recovery honors sidecar format flac and writes flac pair`() {
        val sessionDir = File(
            File(File(filesDir, PcmCheckpointWriter.CHECKPOINT_DIR_NAME),
                PcmCheckpointWriter.PENDING_DIR_NAME),
            sessionId
        ).apply { mkdirs() }
        val pcm = ByteArray(480) { 1 }
        File(sessionDir, "$segStartMs${PcmCheckpointWriter.PART_SUFFIX}").writeBytes(pcm)
        File(sessionDir, "$segStartMs.json").writeText(
            JSONObject().apply {
                put("session_id", sessionId)
                put("start_wall_ms", segStartMs)
                put("sample_rate", sampleRate)
                put("device_id", deviceId)
                put("seg_seq", segSeq)
                put("format", "flac")
            }.toString()
        )

        val converted = CheckpointRecovery.recover(
            context, flacEncoder = fakeFlacEncoder
        )

        assertThat(converted).isEqualTo(1)
        val flac = File(uploadCacheDir(), "$segStartMs-$segSeq.flac")
        assertThat(flac.exists()).isTrue()
        assertThat(String(flac.readBytes().copyOfRange(0, 4), Charsets.US_ASCII))
            .isEqualTo("fLaC")
        val json = JSONObject(File(uploadCacheDir(), "$segStartMs-$segSeq.json").readText())
        assertThat(json.getString("format")).isEqualTo("flac")
    }

    @Test
    fun `recovery without sidecar format defaults to wav`() {
        val sessionDir = File(
            File(File(filesDir, PcmCheckpointWriter.CHECKPOINT_DIR_NAME),
                PcmCheckpointWriter.PENDING_DIR_NAME),
            "no-fmt"
        ).apply { mkdirs() }
        File(sessionDir, "$segStartMs${PcmCheckpointWriter.PART_SUFFIX}")
            .writeBytes(ByteArray(64))

        val converted = CheckpointRecovery.recover(context)

        assertThat(converted).isEqualTo(1)
        assertThat(File(uploadCacheDir(), "$segStartMs-0.wav").exists()).isTrue()
    }

    // ============================================================
    // 3. CheckpointCleanup 双后缀配对
    // ============================================================

    @Test
    fun `cleanup scans flac pair with correct size and ack`() {
        val cdir = File(cacheDir, "cleanup_flac").apply { mkdirs() }
        File(cdir, "1000-0.json").writeText("{}")
        File(cdir, "1000-0.flac").writeBytes(ByteArray(48))
        File(cdir, "1000-0${CheckpointCleanup.ACK_SUFFIX}").writeText("")

        val entries = CheckpointCleanup().scanCacheEntries(cdir)

        assertThat(entries).hasSize(1)
        assertThat(entries[0].uploaded).isTrue()
        assertThat(entries[0].sizeBytes).isEqualTo(2L + 48L)
    }

    @Test
    fun `cleanup deletes flac pair together with json`() {
        val cdir = File(cacheDir, "cleanup_del").apply { mkdirs() }
        val jsonFile = File(cdir, "2000-1.json").apply { writeText("{}") }
        val flacFile = File(cdir, "2000-1.flac").apply { writeBytes(ByteArray(16)) }
        val cleanup = CheckpointCleanup(ttlMs = 1L, maxBytes = Long.MAX_VALUE)
        val entry = CheckpointEntry(jsonFile, 2, 0L, uploaded = true)

        val removed = cleanup.cleanup(listOf(entry), System.currentTimeMillis())

        assertThat(removed).isEqualTo(1)
        assertThat(jsonFile.exists()).isFalse()
        assertThat(flacFile.exists()).isFalse()
    }

    // ============================================================
    // 4. FlacFinalizer 纯函数（STREAMINFO patch）
    // ============================================================

    @Test
    fun `patchTotalSamples writes 36-bit little field at offset 21`() {
        // 最小合法 FLAC 头：fLaC + STREAMINFO 块（last+type0, len34）+ 34 字节零
        val header = "fLaC".toByteArray(Charsets.US_ASCII) +
            byteArrayOf(0x80.toByte(), 0x00, 0x00, 0x22) + ByteArray(34)

        val patched = FlacFinalizer.patchTotalSamples(header, totalSamples = 0x1_2345_6789L)

        assertThat(patched.size).isEqualTo(header.size)
        // offset 21 起 5 字节承载 36-bit total samples（低 4 位在 offset21 高 nibble 之外的布局）
        // 按 BCR 布局：total samples 位于 STREAMINFO 内 bytes[13..17]（file offset 8+13=21）
        val b0 = patched[21].toInt() and 0x0F
        val value = (b0.toLong() shl 32) or
            ((patched[22].toLong() and 0xFF) shl 24) or
            ((patched[23].toLong() and 0xFF) shl 16) or
            ((patched[24].toLong() and 0xFF) shl 8) or
            (patched[25].toLong() and 0xFF)
        assertThat(value).isEqualTo(0x1_2345_6789L)
    }

    @Test
    fun `patchTotalSamples rejects non flac magic`() {
        val notFlac = ByteArray(42)
        val result = FlacFinalizer.patchTotalSamples(notFlac, totalSamples = 100L)
        // 非 fLaC 魔数：原样返回（未 patch 仍合法/可诊断），不抛异常
        assertThat(result).isEqualTo(notFlac)
    }
}
