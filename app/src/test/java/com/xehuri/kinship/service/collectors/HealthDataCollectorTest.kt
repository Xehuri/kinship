package com.xehuri.kinship.service.collectors

import android.content.Context
import android.content.SharedPreferences
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.state.SensorStateHolder
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

import java.io.File

/**
 * 验证 [HealthDataCollector] 的生命周期、启停行为和数据采集逻辑。
 *
 * 数据读取逻辑通过直接调用 [HealthDataCollector.processHealthData] 验证
 * （internal suspend 方法，通过 runBlocking 调用），传入 mock SQLiteDatabase 和 Cursor。
 *
 * 关键测试设计：
 * - 每个数据字段（HR/steps/stress/spo2）有独立的测试方法
 * - 使用 mockk<Cursor>(relaxed = true) 确保所有 Cursor 方法（包括 close()）不会抛异常
 * - 增量上传通过记录 HTTP 调用来验证
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HealthDataCollectorTest {

    private val context = mockk<Context>(relaxed = true)
    private val stateHolder = mockk<SensorStateHolder>(relaxed = true)
    private val httpClient = mockk<AppHttpClient>(relaxed = true)
    private val prefs = mockk<SharedPreferences>(relaxed = true)
    private val dataPrefs = mockk<SharedPreferences>(relaxed = true)
    private val prefsEditor = mockk<SharedPreferences.Editor>(relaxed = true)
    private val sensorPrefs = mockk<SharedPreferences>(relaxed = true)

    /** 当前测试创建的采集器，用于 @After 兜底停止，避免后台协程泄漏到后续测试类 */
    private var collector: HealthDataCollector? = null

    @Before
    fun setUp() {
        // 模拟 android.util.Log（纯 JVM 测试环境无 Android 运行环境）
        mockkStatic(Log::class)
        // Log 2-param String variants
        every { Log.d(any(), any<String>()) } returns 0
        every { Log.i(any(), any<String>()) } returns 0
        every { Log.w(any(), any<String>()) } returns 0
        every { Log.e(any(), any<String>()) } returns 0
        // Log.w 和 Log.wtf 有 (String, Throwable) 2-param 特化
        every { Log.w(any(), any<Throwable>()) } returns 0

        // server_url
        every { context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE) } returns prefs
        every { prefs.getString("server_url", any()) } returns "https://localhost:8767"
        // last_sync_ts
        every { context.getSharedPreferences("data_collector", Context.MODE_PRIVATE) } returns dataPrefs
        every { dataPrefs.getLong("last_sync_ts", 0L) } returns 0L
        // 采集间隔不能为 0：relaxed mock 的 getLong 默认返回 0，会导致 delay(0) 不挂起而形成热自旋
        every { dataPrefs.getLong("health_interval_ms", any()) } returns 1_800_000L
        every { dataPrefs.edit() } returns prefsEditor
        every { prefsEditor.putLong(any(), any()) } returns prefsEditor
        // db path
        every { context.getSharedPreferences("sensor_toggles", Context.MODE_PRIVATE) } returns sensorPrefs
        every { sensorPrefs.getString("gadgetbridge_db_path", any()) } returns "/test/path/Gadgetbridge.db"
        // isEnabled 读取 sensor_toggles/health_enabled（默认 false），开启态置为 true
        every { sensorPrefs.getBoolean("health_enabled", false) } returns true
        // relaxed mock 的 cacheDir 返回 mock File（path 为 null）会导致 NPE，这里指向真实临时目录
        every { context.cacheDir } returns File(System.getProperty("java.io.tmpdir"), "axeuh_test")
    }

    @org.junit.After
    fun tearDown() {
        // 先停采集器（幂等），确保后台协程结束，再解除静态 Mock，防止污染后续测试类
        collector?.stop()
        collector = null
        unmockkStatic(Log::class)
    }

    // ======================== 生命周期 ========================

    @Test
    fun `isEnabled returns true`() {
        val collector = createCollector()
        assertTrue(collector.isEnabled)
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
    fun `double start only creates one scope`() {
        val collector = createCollector()
        collector.start()
        collector.start()
        collector.stop()
    }

    @Test
    fun `start after stop creates new scope`() {
        val collector = createCollector()
        collector.start()
        collector.stop()
        collector.start()
        collector.stop()
    }

    @Test
    fun `collectNow returns false when db unavailable`() = runBlocking {
        // DB 路径不存在 → 采集失败返回 false；验证服务调度器可直接调用该入口
        val collector = createCollector()
        assertFalse(collector.collectNow())
    }

    // ======================== 心率采集 ========================

    @Test
    fun `processHealthData reads heart rate and updates state`() = runBlocking {
        val db = mockDbWithHr(75)

        val collector = createCollector()
        collector.processHealthData(db)

        verify(exactly = 1) { stateHolder.updateHeartRate(75) }
        verify(exactly = 0) { stateHolder.updateSteps(any()) }
        verify(exactly = 0) { stateHolder.updateStress(any()) }
        verify(exactly = 0) { stateHolder.updateSpo2(any()) }
    }

    @Test
    fun `processHealthData skips heart rate when cursor is empty`() = runBlocking {
        val db = mockDbWithNoData()

        val collector = createCollector()
        collector.processHealthData(db)

        verify(exactly = 0) { stateHolder.updateHeartRate(any()) }
    }

    // ======================== 步数采集 ========================

    @Test
    fun `processHealthData reads steps and updates state`() = runBlocking {
        val db = mockDbWithSteps(5000)

        val collector = createCollector()
        collector.processHealthData(db)

        verify(exactly = 1) { stateHolder.updateSteps(5000) }
        verify(exactly = 0) { stateHolder.updateHeartRate(any()) }
        verify(exactly = 0) { stateHolder.updateStress(any()) }
        verify(exactly = 0) { stateHolder.updateSpo2(any()) }
    }

    @Test
    fun `processHealthData skips steps when total is zero`() = runBlocking {
        val db = mockDbWithSteps(0)

        val collector = createCollector()
        collector.processHealthData(db)

        verify(exactly = 0) { stateHolder.updateSteps(any()) }
    }

    // ======================== 压力采集 ========================

    @Test
    fun `processHealthData reads stress and updates state`() = runBlocking {
        val db = mockDbWithStress(45)

        val collector = createCollector()
        collector.processHealthData(db)

        verify(exactly = 1) { stateHolder.updateStress(45) }
        verify(exactly = 0) { stateHolder.updateHeartRate(any()) }
        verify(exactly = 0) { stateHolder.updateSteps(any()) }
        verify(exactly = 0) { stateHolder.updateSpo2(any()) }
    }

    // ======================== 血氧采集 ========================

    @Test
    fun `processHealthData reads spo2 and updates state`() = runBlocking {
        val db = mockDbWithSpo2(98)

        val collector = createCollector()
        collector.processHealthData(db)

        verify(exactly = 1) { stateHolder.updateSpo2(98) }
        verify(exactly = 0) { stateHolder.updateHeartRate(any()) }
        verify(exactly = 0) { stateHolder.updateSteps(any()) }
        verify(exactly = 0) { stateHolder.updateStress(any()) }
    }

    // ======================== 全部数据采集 ========================

    @Test
    fun `processHealthData reads all data and updates state`() = runBlocking {
        val db = mockDbWithAllData(hr = 72, steps = 4000, stress = 35, spo2 = 97)

        val collector = createCollector()
        collector.processHealthData(db)

        verify(exactly = 1) { stateHolder.updateHeartRate(72) }
        verify(exactly = 1) { stateHolder.updateSteps(4000) }
        verify(exactly = 1) { stateHolder.updateStress(35) }
        verify(exactly = 1) { stateHolder.updateSpo2(97) }
    }

    @Test
    fun `processHealthData does not update state when no data`() = runBlocking {
        val db = mockDbWithNoData()

        val collector = createCollector()
        collector.processHealthData(db)

        verify(exactly = 0) { stateHolder.updateHeartRate(any()) }
        verify(exactly = 0) { stateHolder.updateSteps(any()) }
        verify(exactly = 0) { stateHolder.updateStress(any()) }
        verify(exactly = 0) { stateHolder.updateSpo2(any()) }
    }

    // ======================== 增量上传 ========================

    @Test
    fun `processHealthData uploads incremental data via httpClient`() = runBlocking {
        val db = mockDbWithIncrementalData(ts = 1710000000L, hr = 75, steps = 100, stress = 30, spo2 = 96)

        val collector = createCollector()
        collector.processHealthData(db)

        // 验证 httpClient.post 被调用（url 包含 health/sync）
        coVerify(exactly = 1) { httpClient.post(match { it.contains("health/sync") }, any()) }
    }

    @Test
    fun `processHealthData does not upload when no incremental data`() = runBlocking {
        val db = mockDbWithAllData(hr = 72, steps = 4000, stress = 35, spo2 = 97)
        // Incremental cursor returns no data (default mock in mockDbWithAllData)

        val collector = createCollector()
        collector.processHealthData(db)

        // 只有 state update，没有增量上传（incremental cursor 无数据）
        verify(exactly = 1) { stateHolder.updateHeartRate(72) }
        coVerify(exactly = 0) { httpClient.post(any(), any()) }
    }

    // ======================== 辅助方法 ========================

    private fun createCollector(): HealthDataCollector {
        return HealthDataCollector(context, stateHolder, httpClient).also { collector = it }
    }

    /** 创建 moveToFirst 返回 false 的空游标 */
    private fun emptyCursor(): Cursor {
        val c = mockk<Cursor>(relaxed = true)
        every { c.moveToFirst() } returns false
        every { c.moveToNext() } returns false
        return c
    }

    /**
     * 创建仅 HR 有数据的 mock DB。
     * 基于 processHealthData 中 rawQuery 的调用顺序：HR -> Steps -> Stress -> SPO2 -> Incremental
     */
    private fun mockDbWithHr(hrValue: Int): SQLiteDatabase {
        val db = mockk<SQLiteDatabase>(relaxed = true)

        // HR：有数据
        val hrCursor = mockk<Cursor>(relaxed = true)
        every { hrCursor.moveToFirst() } returns true
        every { hrCursor.getInt(1) } returns hrValue
        every { hrCursor.getLong(0) } returns 1710000000L

        every { db.rawQuery(any(), any()) } returnsMany listOf(
            hrCursor,        // 1. HR
            emptyCursor(),   // 2. Steps
            emptyCursor(),   // 3. Stress
            emptyCursor(),   // 4. SPO2
            emptyCursor()    // 5. Incremental
        )

        return db
    }

    /**
     * 创建仅 Steps 有数据的 mock DB。
     */
    private fun mockDbWithSteps(stepsValue: Int): SQLiteDatabase {
        val db = mockk<SQLiteDatabase>(relaxed = true)

        // Steps
        val stepsCursor = mockk<Cursor>(relaxed = true)
        every { stepsCursor.moveToFirst() } returns (stepsValue > 0)
        every { stepsCursor.getInt(0) } returns stepsValue

        every { db.rawQuery(any(), any()) } returnsMany listOf(
            emptyCursor(),   // 1. HR
            stepsCursor,     // 2. Steps
            emptyCursor(),   // 3. Stress
            emptyCursor(),   // 4. SPO2
            emptyCursor()    // 5. Incremental
        )

        return db
    }

    /**
     * 创建仅 Stress 有数据的 mock DB。
     */
    private fun mockDbWithStress(stressValue: Int): SQLiteDatabase {
        val db = mockk<SQLiteDatabase>(relaxed = true)

        // Stress
        val stressCursor = mockk<Cursor>(relaxed = true)
        every { stressCursor.moveToFirst() } returns true
        every { stressCursor.getInt(1) } returns stressValue
        every { stressCursor.getLong(0) } returns 1710000000L

        every { db.rawQuery(any(), any()) } returnsMany listOf(
            emptyCursor(),   // 1. HR
            emptyCursor(),   // 2. Steps
            stressCursor,    // 3. Stress
            emptyCursor(),   // 4. SPO2
            emptyCursor()    // 5. Incremental
        )

        return db
    }

    /**
     * 创建仅 SPO2 有数据的 mock DB。
     */
    private fun mockDbWithSpo2(spo2Value: Int): SQLiteDatabase {
        val db = mockk<SQLiteDatabase>(relaxed = true)

        // SPO2
        val spo2Cursor = mockk<Cursor>(relaxed = true)
        every { spo2Cursor.moveToFirst() } returns true
        every { spo2Cursor.getInt(1) } returns spo2Value
        every { spo2Cursor.getLong(0) } returns 1710000000L

        every { db.rawQuery(any(), any()) } returnsMany listOf(
            emptyCursor(),   // 1. HR
            emptyCursor(),   // 2. Steps
            emptyCursor(),   // 3. Stress
            spo2Cursor,      // 4. SPO2
            emptyCursor()    // 5. Incremental
        )

        return db
    }

    /**
     * 创建所有 4 类数据都有值的 mock DB。
     */
    private fun mockDbWithAllData(
        hr: Int,
        steps: Int,
        stress: Int,
        spo2: Int
    ): SQLiteDatabase {
        val db = mockk<SQLiteDatabase>(relaxed = true)

        // HR
        val hrCursor = mockk<Cursor>(relaxed = true)
        every { hrCursor.moveToFirst() } returns (hr > 0)
        every { hrCursor.getInt(1) } returns hr
        every { hrCursor.getLong(0) } returns 1710000000L

        // Steps
        val stepsCursor = mockk<Cursor>(relaxed = true)
        every { stepsCursor.moveToFirst() } returns (steps > 0)
        every { stepsCursor.getInt(0) } returns steps

        // Stress
        val stressCursor = mockk<Cursor>(relaxed = true)
        every { stressCursor.moveToFirst() } returns (stress > 0)
        every { stressCursor.getInt(1) } returns stress
        every { stressCursor.getLong(0) } returns 1710000000L

        // SPO2
        val spo2Cursor = mockk<Cursor>(relaxed = true)
        every { spo2Cursor.moveToFirst() } returns (spo2 > 0)
        every { spo2Cursor.getInt(1) } returns spo2
        every { spo2Cursor.getLong(0) } returns 1710000000L

        every { db.rawQuery(any(), any()) } returnsMany listOf(
            hrCursor,        // 1. HR
            stepsCursor,     // 2. Steps
            stressCursor,    // 3. Stress
            spo2Cursor,      // 4. SPO2
            emptyCursor()    // 5. Incremental
        )

        return db
    }

    /**
     * 创建所有数据都无值的 mock DB（所有 moveToFirst 返回 false）。
     */
    private fun mockDbWithNoData(): SQLiteDatabase {
        val db = mockk<SQLiteDatabase>(relaxed = true)

        every { db.rawQuery(any(), any()) } returnsMany listOf(
            emptyCursor(),   // 1. HR
            emptyCursor(),   // 2. Steps
            emptyCursor(),   // 3. Stress
            emptyCursor(),   // 4. SPO2
            emptyCursor()    // 5. Incremental
        )

        return db
    }

    /**
     * 创建有增量数据的 mock DB。
     */
    private fun mockDbWithIncrementalData(
        ts: Long,
        hr: Int,
        steps: Int,
        stress: Int,
        spo2: Int
    ): SQLiteDatabase {
        val db = mockk<SQLiteDatabase>(relaxed = true)

        // HR
        val hrCursor = mockk<Cursor>(relaxed = true)
        every { hrCursor.moveToFirst() } returns (hr > 0)
        every { hrCursor.getInt(1) } returns hr
        every { hrCursor.getLong(0) } returns 1710000000L

        // Steps
        val stepsCursor = mockk<Cursor>(relaxed = true)
        every { stepsCursor.moveToFirst() } returns (steps > 0)
        every { stepsCursor.getInt(0) } returns steps

        // Stress
        val stressCursor = mockk<Cursor>(relaxed = true)
        every { stressCursor.moveToFirst() } returns (stress > 0)
        every { stressCursor.getInt(1) } returns stress
        every { stressCursor.getLong(0) } returns 1710000000L

        // SPO2
        val spo2Cursor = mockk<Cursor>(relaxed = true)
        every { spo2Cursor.moveToFirst() } returns (spo2 > 0)
        every { spo2Cursor.getInt(1) } returns spo2
        every { spo2Cursor.getLong(0) } returns 1710000000L

        // Incremental：有 1 条数据
        val incCursor = mockk<Cursor>(relaxed = true)
        var callCount = 0
        every { incCursor.moveToNext() } answers {
            callCount++
            callCount <= 1  // 第一次 true，之后 false
        }
        every { incCursor.getLong(0) } returns ts
        every { incCursor.getInt(1) } returns hr
        every { incCursor.getInt(2) } returns steps
        every { incCursor.getInt(3) } returns stress
        every { incCursor.getInt(4) } returns spo2

        every { db.rawQuery(any(), any()) } returnsMany listOf(
            hrCursor,        // 1. HR
            stepsCursor,     // 2. Steps
            stressCursor,    // 3. Stress
            spo2Cursor,      // 4. SPO2
            incCursor        // 5. Incremental（有数据）
        )

        return db
    }
}
