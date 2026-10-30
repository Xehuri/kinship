package com.xehuri.kinship.service.collectors

import android.content.Context
import android.content.SharedPreferences
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.state.SensorStateHolder
import com.xehuri.kinship.service.uploader.PcmCheckpointFormat
import com.xehuri.kinship.service.uploader.PcmCheckpointWriter
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
import java.util.UUID

/**
 * AudioCollector 生命周期收尾（不丢已录内容）测试。
 *
 * 覆盖：停止 / 关闭「声音」开关时对进行中分段 finalize 到 `upload_cache`、
 * 正常完成路径丢弃 checkpoint 不产生条目、重复 stop 幂等且不损坏文件。
 *
 * 说明：本仓库未启用 useJUnitPlatform（见 [PcmCheckpointWriterTest] 注释），
 * `org.junit.jupiter` 注解的测试不会被发现执行，故沿用仓库内实际可运行的
 * JUnit4 + Robolectric 组合（与 [AudioCollectorTest] 一致）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AudioCollectorCheckpointTest {

    private lateinit var filesDir: File
    private lateinit var cacheDir: File
    private lateinit var context: Context
    private val tempDirs = mutableListOf<File>()

    private val stateHolder = mockk<SensorStateHolder>(relaxed = true)
    private val httpClient = mockk<AppHttpClient>(relaxed = true)

    private val axeuhPrefs = mockk<SharedPreferences>(relaxed = true)
    private val dataPrefs = mockk<SharedPreferences>(relaxed = true)

    private val segStartMs = 1_700_000_200_000L

    @Before
    fun setup() {
        filesDir = createTempDir("ac_cp_files")
        cacheDir = createTempDir("ac_cp_cache")
        context = mockk(relaxUnitFun = true)
        every { context.filesDir } returns filesDir
        every { context.cacheDir } returns cacheDir
        // HintTonePlayer 构造时读取 applicationContext
        every { context.applicationContext } returns context

        every { context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE) } returns axeuhPrefs
        every { context.getSharedPreferences("data_collector", Context.MODE_PRIVATE) } returns dataPrefs
        every { dataPrefs.getBoolean("audio_enabled", false) } returns true

        // 无网络环境：让补传线程直接失败，避免误删刚落盘的条目
        every { httpClient.getClient() } throws IllegalStateException("no network in test")
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

    private fun createCollector(): AudioCollector = AudioCollector(context, stateHolder, httpClient)

    /** 模拟采集线程：开始一个分段并写入若干 PCM。 */
    private fun seedInFlightSegment(collector: AudioCollector, pcm: ByteArray) {
        collector.beginSegmentCheckpoint(segStartMs)
        collector.appendSegmentPcm(pcm)
    }

    private fun uploadCacheDir(): File = File(cacheDir, PcmCheckpointWriter.CACHE_DIR_NAME)

    private fun cacheJsonEntries(): List<File> =
        uploadCacheDir().listFiles { f -> f.isFile && f.name.endsWith(".json") }?.toList() ?: emptyList()

    private fun readIntLe(bytes: ByteArray, offset: Int): Int =
        ByteBuffer.wrap(bytes, offset, 4).order(ByteOrder.LITTLE_ENDIAN).int

    // ========================================================================
    // stop() 落盘
    // ========================================================================

    @Test
    fun `should persist in-flight segment to upload cache when stopped`() {
        val collector = createCollector()
        val pcm = ByteArray(4000) { (it % 100).toByte() }
        seedInFlightSegment(collector, pcm)

        collector.stop()

        val entries = cacheJsonEntries()
        assertThat(entries).hasSize(1)

        val jsonFile = entries.first()
        val base = jsonFile.nameWithoutExtension
        val wavFile = File(uploadCacheDir(), "$base.wav")
        assertThat(wavFile.exists()).isTrue()
        assertThat(wavFile.length()).isEqualTo(PcmCheckpointFormat.WAV_HEADER_BYTES + pcm.size.toLong())

        val json = JSONObject(jsonFile.readText())
        assertThat(json.getString("mode")).isEqualTo("listen")
        assertThat(json.getInt("sample_count")).isEqualTo(pcm.size / 2)
        assertThat(json.getString("client_time")).isNotEmpty()
        assertThat(UUID.fromString(json.getString("device_id"))).isNotNull()
        assertThat(json.has("session_id")).isTrue()
        assertThat(json.has("seq")).isTrue()

        // pending 下的 .part 已清理，不会残留孤儿分片
        val pendingRoot = File(
            File(filesDir, PcmCheckpointWriter.CHECKPOINT_DIR_NAME),
            PcmCheckpointWriter.PENDING_DIR_NAME
        )
        val leftovers = pendingRoot.walkTopDown().filter { it.isFile }.toList()
        assertThat(leftovers).isEmpty()
    }

    // ========================================================================
    // 关闭「声音」采集开关
    // ========================================================================

    @Test
    fun `should persist in-flight segment when audio toggle is turned off`() {
        val collector = createCollector()
        val pcm = ByteArray(2000) { 3 }
        seedInFlightSegment(collector, pcm)

        // 用户在设置页关闭「声音」开关：applyToggle 会调用 stop()
        every { dataPrefs.getBoolean("audio_enabled", false) } returns false
        collector.stop()

        assertThat(collector.isEnabled).isFalse()
        assertThat(cacheJsonEntries()).hasSize(1)
    }

    // ========================================================================
    // 重复 stop 幂等
    // ========================================================================

    @Test
    fun `should not duplicate or corrupt cache entry on repeated stop`() {
        val collector = createCollector()
        val pcm = ByteArray(3000) { (it % 50).toByte() }
        seedInFlightSegment(collector, pcm)

        collector.stop()
        val firstEntries = cacheJsonEntries()
        assertThat(firstEntries).hasSize(1)

        val base = firstEntries.first().nameWithoutExtension
        val wavFile = File(uploadCacheDir(), "$base.wav")
        val lengthAfterFirstStop = wavFile.length()

        collector.stop()
        collector.stop()

        assertThat(cacheJsonEntries()).hasSize(1)
        assertThat(wavFile.exists()).isTrue()
        assertThat(wavFile.length()).isEqualTo(lengthAfterFirstStop)
        // WAV 仍完整可解析：data 段长度等于原始 PCM 字节数
        assertThat(readIntLe(wavFile.readBytes(), 40)).isEqualTo(pcm.size)
    }

    // ========================================================================
    // 正常完成路径：丢弃 checkpoint，不产生 upload_cache 条目
    // ========================================================================

    @Test
    fun `should not create cache entry when segment closes for in-memory upload`() {
        val collector = createCollector()
        seedInFlightSegment(collector, ByteArray(1000) { 1 })

        val claimed = collector.closeCurrentSegment(toCache = false)

        assertThat(claimed).isTrue()
        assertThat(cacheJsonEntries()).isEmpty()
    }

    @Test
    fun `should treat second close as no-op after segment already closed`() {
        val collector = createCollector()
        seedInFlightSegment(collector, ByteArray(512) { 2 })

        assertThat(collector.closeCurrentSegment(toCache = false)).isTrue()
        // 已认领结束：再次结束不认领，也不会误落盘
        assertThat(collector.closeCurrentSegment(toCache = true)).isFalse()
        assertThat(cacheJsonEntries()).isEmpty()
    }
}
