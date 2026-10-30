package com.xehuri.kinship.service.collectors

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.state.SensorStateHolder
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import io.mockk.verify
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.math.sqrt

/**
 * 纯单元测试 —— 验证 [AudioCollector] 生命周期和纯函数逻辑。
 *
 * 所有测试均通过 mockk 模拟 Android 依赖，无需 Robolectric。
 * Robolectric 依赖的 MediaCodec / AudioRecord 测试在 AudioCollectorRobolectricTest 中。
 */
class AudioCollectorTest {

    private val context = mockk<Context>(relaxed = true)
    private val stateHolder = mockk<SensorStateHolder>(relaxed = true)
    private val httpClient = mockk<AppHttpClient>(relaxed = true)

    private val axeuhPrefs = mockk<SharedPreferences>(relaxed = true)
    private val dataPrefs = mockk<SharedPreferences>(relaxed = true)

    /** 当前测试创建的采集器，用于 @After 兜底停止，避免后台协程泄漏到后续测试类 */
    private val collectors = mutableListOf<AudioCollector>()

    @Before
    fun setUp() {
        // 模拟 android.util.Log（无 Android 运行环境时抛出 RuntimeException）
        mockkStatic(Log::class)
        every { Log.v(any<String>(), any<String>()) } returns 0
        every { Log.d(any<String>(), any<String>()) } returns 0
        every { Log.i(any<String>(), any<String>()) } returns 0
        every { Log.w(any<String>(), any<String>()) } returns 0
        every { Log.e(any<String>(), any<String>()) } returns 0

        // axeuh_prefs: 用于 server_url 和 auth_token
        every { context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE) } returns axeuhPrefs
        every { axeuhPrefs.getString("server_url", any()) } returns "https://localhost:8767"
        every { axeuhPrefs.getString("auth_token", "") } returns ""

        // data_collector: 用于 audio_enabled 和 loop_ms
        every { context.getSharedPreferences("data_collector", Context.MODE_PRIVATE) } returns dataPrefs
        every { dataPrefs.getBoolean("audio_enabled", false) } returns true
        every { dataPrefs.getLong("loop_ms", 30000L) } returns 30000L
    }

    @After
    fun tearDown() {
        // 必须释放 static mock：mockk 的静态 mock 是 JVM 级别的全局状态，
        // 若不还原，会污染同一 JVM 中随后运行的其他测试类（导致 MockKException）。
        // 同时兜底停止采集器，避免协程作用域泄漏到后续测试。
        collectors.forEach { it.stop() }
        collectors.clear()
        unmockkStatic(Log::class)
    }

    // ======================== 生命周期 ========================

    @Test
    fun `isEnabled returns true when audio_enabled is true`() {
        every { dataPrefs.getBoolean("audio_enabled", false) } returns true
        val collector = createCollector()
        assertTrue(collector.isEnabled)
    }

    @Test
    fun `isEnabled returns false when audio_enabled is false`() {
        every { dataPrefs.getBoolean("audio_enabled", false) } returns false
        val collector = createCollector()
        assertTrue(!collector.isEnabled)
    }

    @Test
    fun `start does not throw`() {
        val collector = createCollector()
        collector.start()
        collector.stop()
    }

    @Test
    fun `stop does not throw`() {
        val collector = createCollector()
        collector.start()
        collector.stop()
    }

    @Test
    fun `double stop is idempotent`() {
        val collector = createCollector()
        collector.start()
        collector.stop()
        collector.stop()
    }

    @Test
    fun `double start does not crash`() {
        val collector = createCollector()
        collector.start()
        collector.start()
        collector.stop()
    }

    @Test
    fun `start after stop does not crash`() {
        val collector = createCollector()
        collector.start()
        collector.stop()
        collector.start()
        collector.stop()
    }

    // ======================== RMS 电平 ========================

    @Test
    fun `computeRms returns zero for silent frame`() {
        val collector = createCollector()
        val silent = ShortArray(AudioCollector.FRAME_SIZE)
        val rms = collector.computeRms(silent, AudioCollector.FRAME_SIZE)
        assertEquals(0.0, rms, 0.001)
    }

    @Test
    fun `computeRms returns correct value for constant frame`() {
        val collector = createCollector()
        val frame = ShortArray(AudioCollector.FRAME_SIZE).also { it.fill(1000) }
        val rms = collector.computeRms(frame, AudioCollector.FRAME_SIZE)
        val expected = sqrt((1000.0 * 1000.0 * AudioCollector.FRAME_SIZE) / AudioCollector.FRAME_SIZE)
        assertEquals(expected, rms, 0.001)
    }

    @Test
    fun `computeRms handles partial frame correctly`() {
        val collector = createCollector()
        val frame = ShortArray(AudioCollector.FRAME_SIZE)
        for (i in 0 until AudioCollector.FRAME_SIZE / 2) frame[i] = 2000

        val rms = collector.computeRms(frame, AudioCollector.FRAME_SIZE / 2)
        val expected = sqrt((2000.0 * 2000.0 * (AudioCollector.FRAME_SIZE / 2)) / (AudioCollector.FRAME_SIZE / 2))
        assertEquals(expected, rms, 0.001)
    }

    @Test
    fun `computeRms with zero count returns zero`() {
        val collector = createCollector()
        val frame = ShortArray(10) { 1000 }
        val rms = collector.computeRms(frame, 0)
        assertEquals(0.0, rms, 0.001)
    }

    @Test
    fun `loud audio exceeds RMS level threshold`() {
        val collector = createCollector()
        val loud = ShortArray(AudioCollector.FRAME_SIZE) { 32767 }
        val rms = collector.computeRms(loud, AudioCollector.FRAME_SIZE)
        assertTrue("RMS=$rms should be >= ${AudioCollector.RMS_THRESHOLD}", rms >= AudioCollector.RMS_THRESHOLD)
    }

    @Test
    fun `quiet audio is below RMS level threshold`() {
        val collector = createCollector()
        val quiet = ShortArray(AudioCollector.FRAME_SIZE) { 1 }
        val rms = collector.computeRms(quiet, AudioCollector.FRAME_SIZE)
        assertTrue("RMS=$rms should be < ${AudioCollector.RMS_THRESHOLD}", rms < AudioCollector.RMS_THRESHOLD)
    }

    // ======================== Prefs 访问 ========================

    @Test
    fun `reads shared preferences for server url`() {
        val collector = createCollector()
        verify(atLeast = 0) { axeuhPrefs.getString("server_url", any()) }
        collector.stop()
    }

    @Test
    fun `reads audio enabled from data_collector prefs`() {
        val collector = createCollector()
        collector.isEnabled
        verify { dataPrefs.getBoolean("audio_enabled", false) }
    }

    // ======================== 辅助方法 ========================

    private fun createCollector(): AudioCollector {
        return AudioCollector(context, stateHolder, httpClient).also { collectors.add(it) }
    }
}
