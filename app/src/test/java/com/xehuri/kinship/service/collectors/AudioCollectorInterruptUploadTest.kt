package com.xehuri.kinship.service.collectors

import android.content.Context
import android.content.SharedPreferences
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.state.SensorStateHolder
import com.xehuri.kinship.service.uploader.PcmCheckpointWriter
import com.google.common.truth.Truth.assertThat
import io.mockk.every
import io.mockk.mockk
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.ResponseBody
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 「可感知的中断 → 当场直接上传」测试。
 *
 * 覆盖与 [AudioCollectorCheckpointTest] 互补的行为维度：中断路径不仅要 finalize 到
 * `upload_cache`，还必须**立即触发上传**（不等 `audio_upload_batch_ms` 批次），且**不重复上传**。
 *
 * 被验证的关键行为：
 * 1. `stop()`（含关采集开关 / `onTaskRemoved` / `onDestroy` 均经此路径）有进行中分段时立即上传；
 * 2. `stop()` 时若无进行中分段，仍需补传此前正常切段留下的待上传条目；
 * 3. 重复中断不会重复上传同一条（上传成功后条目即删除，批次调度读不到待传内容）；
 * 4. 补传线程 in-flight 时新落盘条目会被排队补跑一轮，不并发、不重复。
 *
 * 说明：本仓库未启用 `useJUnitPlatform`（见 [PcmCheckpointWriterTest] 注释），
 * `org.junit.jupiter` 注解不会被发现执行，故沿用仓库内实际可运行的 JUnit4 + Robolectric 组合。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AudioCollectorInterruptUploadTest {

    private lateinit var filesDir: File
    private lateinit var cacheDir: File
    private lateinit var context: Context
    private val tempDirs = mutableListOf<File>()

    private val stateHolder = mockk<SensorStateHolder>(relaxed = true)
    private val httpClient = mockk<AppHttpClient>(relaxed = true)

    private val axeuhPrefs = mockk<SharedPreferences>(relaxed = true)
    private val dataPrefs = mockk<SharedPreferences>(relaxed = true)

    // ── OkHttp 打桩：真实走 sendCachedData 的请求构建，仅拦截网络执行 ──
    private val okHttpClient = mockk<OkHttpClient>()
    private val call = mockk<Call>()
    private val responseBody = mockk<ResponseBody>(relaxed = true)
    private val response = mockk<Response>(relaxed = true)

    /** execute() 实际被调用次数（即实际上传次数） */
    private val executeCount = AtomicInteger(0)

    /** 首次 execute() 完成信号 */
    private lateinit var uploadedLatch: CountDownLatch

    private val segStartMs = 1_700_000_500_000L

    @Before
    fun setup() {
        filesDir = createTempDir("ac_int_files")
        cacheDir = createTempDir("ac_int_cache")
        context = mockk(relaxUnitFun = true)
        every { context.filesDir } returns filesDir
        every { context.cacheDir } returns cacheDir
        // HintTonePlayer 构造时读取 applicationContext
        every { context.applicationContext } returns context
        every { context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE) } returns axeuhPrefs
        every { context.getSharedPreferences("data_collector", Context.MODE_PRIVATE) } returns dataPrefs
        every { dataPrefs.getBoolean("audio_enabled", false) } returns true
        every { axeuhPrefs.getString("auth_token", "") } returns ""

        executeCount.set(0)
        uploadedLatch = CountDownLatch(1)

        every { response.code } returns 200
        every { response.body } returns responseBody
        every { responseBody.string() } returns "{}"

        every { httpClient.getClient() } returns okHttpClient
        every { okHttpClient.newCall(any()) } returns call
        every { call.execute() } answers {
            executeCount.incrementAndGet()
            uploadedLatch.countDown()
            response
        }
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

    /** 轮询等待 execute 次数达到期望值 */
    private fun awaitExecuteCount(expected: Int, timeoutMs: Long = 5_000L) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (executeCount.get() >= expected) return
            Thread.sleep(20)
        }
    }

    /**
     * 轮询等待 upload_cache 清空。
     *
     * execute() 返回后补传线程还要解析响应并删除文件，故不能用「execute 被调用」作为
     * 「上传完成」的信号，需再等条目落空。
     */
    private fun awaitCacheEmpty(timeoutMs: Long = 5_000L) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (cacheJsonEntries().isEmpty()) return
            Thread.sleep(20)
        }
    }

    // ========================================================================
    // 中断 → 立即上传
    // ========================================================================

    @Test
    fun `should upload immediately when stopped with in-flight segment`() {
        val collector = createCollector()
        seedInFlightSegment(collector, ByteArray(4000) { (it % 100).toByte() })

        collector.stop()

        assertThat(uploadedLatch.await(5, TimeUnit.SECONDS)).isTrue()
        awaitCacheEmpty()
        assertThat(executeCount.get()).isEqualTo(1)
        // 上传成功后条目被删除，批次调度读不到待传内容
        assertThat(cacheJsonEntries()).isEmpty()
        assertThat(collector.pendingCacheDurationMs()).isEqualTo(0L)
    }

    /**
     * 关键回归：正常切段（forceUpload=false）留下的条目，在随后 stop() 时若没有进行中分段，
     * 也必须被立即补传——停止后不会再有任何批次调度。
     */
    @Test
    fun `should upload pending cache when stopped without in-flight segment`() {
        val collector = createCollector()
        seedInFlightSegment(collector, ByteArray(2000) { 3 })

        // 正常切段：落盘但不触发上传（等价于音频循环里 forceUpload=false 的路径）
        assertThat(collector.closeCurrentSegment(toCache = true, triggerUpload = false)).isTrue()
        assertThat(cacheJsonEntries()).hasSize(1)
        assertThat(executeCount.get()).isEqualTo(0)

        collector.stop()

        assertThat(uploadedLatch.await(5, TimeUnit.SECONDS)).isTrue()
        awaitCacheEmpty()
        assertThat(executeCount.get()).isEqualTo(1)
        assertThat(cacheJsonEntries()).isEmpty()
    }

    // ========================================================================
    // 不重复上传
    // ========================================================================

    @Test
    fun `should not upload the same entry twice across repeated stops`() {
        val collector = createCollector()
        seedInFlightSegment(collector, ByteArray(3000) { (it % 50).toByte() })

        collector.stop()
        assertThat(uploadedLatch.await(5, TimeUnit.SECONDS)).isTrue()
        assertThat(executeCount.get()).isEqualTo(1)

        // 再次中断：无进行中分段、无待上传条目，不应再发一次
        collector.stop()
        Thread.sleep(300)
        assertThat(executeCount.get()).isEqualTo(1)
        assertThat(cacheJsonEntries()).isEmpty()
    }

    /**
     * 补传线程 in-flight 时中断产生新条目：应排队补跑一轮（不丢新条目），
     * 且第一轮已上传的条目不会被重复发送。
     */
    @Test
    fun `should upload new segment without duplicating when upload already in flight`() {
        val firstExecuteEntered = CountDownLatch(1)
        val releaseFirstExecute = CountDownLatch(1)
        every { call.execute() } answers {
            val n = executeCount.incrementAndGet()
            if (n == 1) {
                firstExecuteEntered.countDown()
                releaseFirstExecute.await(5, TimeUnit.SECONDS)
            }
            response
        }

        val collector = createCollector()

        // 条目 A：触发补传，第一轮阻塞在 execute 中（模拟慢网络）
        seedInFlightSegment(collector, ByteArray(1600) { 1 })
        assertThat(collector.closeCurrentSegment(toCache = true, triggerUpload = true)).isTrue()
        assertThat(firstExecuteEntered.await(5, TimeUnit.SECONDS)).isTrue()
        assertThat(executeCount.get()).isEqualTo(1)

        // 补传进行中发生中断，产生条目 B；此时新触发应排队而不是并发
        seedInFlightSegment(collector, ByteArray(1600) { 2 })
        collector.stop()

        // 放行第一轮：条目 A 成功后应接着补跑一轮上传条目 B
        releaseFirstExecute.countDown()
        awaitExecuteCount(2)
        awaitCacheEmpty()

        assertThat(executeCount.get()).isEqualTo(2)
        assertThat(cacheJsonEntries()).isEmpty()
    }
}
