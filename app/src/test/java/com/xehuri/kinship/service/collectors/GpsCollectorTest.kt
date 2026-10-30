package com.xehuri.kinship.service.collectors

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.state.SensorStateHolder
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 验证 [GpsCollector] 的生命周期、启停行为和 GPS 采集逻辑。
 *
 * 使用 Robolectric 提供 Android 运行时环境，系统服务通过 MockK 模拟。
 * [Location] 对象使用真实构造器创建（而非 MockK mock），以避免
 * Robolectric 类加载器与 MockK 之间的 android.location.Location 类加载冲突。
 *
 * 关注点：
 * 1. 构造器和生命周期不抛异常
 * 2. isEnabled 状态正确
 * 3. GPS 采集正确读取 [LocationManager.getLastKnownLocation]
 * 4. Provider 回退顺序：PASSIVE → GPS → NETWORK
 * 5. 无权限时清除 GPS 状态
 * 6. LocationManager 不可用时安全跳过
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GpsCollectorTest {

    private val context = mockk<Context>(relaxed = true)
    private val stateHolder = mockk<SensorStateHolder>(relaxed = true)
    private val httpClient = mockk<AppHttpClient>(relaxed = true)
    private val locationManager = mockk<LocationManager>(relaxed = true)
    private val sharedPrefs = mockk<android.content.SharedPreferences>(relaxed = true)

    @Before
    fun setUp() {
        every { context.getSystemService(Context.LOCATION_SERVICE) } returns locationManager
        every {
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        } returns PackageManager.PERMISSION_GRANTED
        // Mock SharedPreferences for gps_enabled to return true
        every { sharedPrefs.getBoolean("gps_enabled", false) } returns true
        // 采样间隔非 0，避免测试中采集循环空转
        every { sharedPrefs.getLong(any(), any()) } returns 300_000L
        // 新增选项默认关闭主动定位，保持既有用例「仅读缓存」的语义（须在通配 stub 之后声明）
        every { sharedPrefs.getLong("gps_fix_timeout_ms", any()) } returns 0L
        every { context.getSharedPreferences(any(), any()) } returns sharedPrefs
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
        // second start should be ignored (scope already exists)
        collector.start()
        collector.stop()
    }

    @Test
    fun `start after stop creates new scope`() {
        val collector = createCollector()
        collector.start()
        collector.stop()
        // restart should work
        collector.start()
        collector.stop()
    }

    @Test
    fun `locationManager is accessed lazily`() {
        // 不设置 locationManager mock — 验证不会在构造时崩溃
        val nullContext = mockk<Context>(relaxed = true)
        val collector = GpsCollector(nullContext, stateHolder, httpClient)
        collector.start()
        runBlocking { delay(100) }
        collector.stop()
        // 所有 getSystemService 返回 null，采集器应安全跳过
    }

    // ======================== GPS 采集逻辑 ========================

    @Test
    fun `collectLocation uses PASSIVE provider when available`() = runBlocking {
        // 安排：PASSIVE provider 返回一个有效位置
        val mockLocation = Location(LocationManager.PASSIVE_PROVIDER).apply {
            latitude = 39.9042
            longitude = 116.4074
            accuracy = 10f
        }
        every { locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) } returns mockLocation

        val collector = createCollector()
        collector.collectLocation()

        // 验证 stateHolder.updateLastGps 被正确调用（三元组格式）
        verify { stateHolder.updateLastGps("39.9042,116.4074,10.0") }
    }

    @Test
    fun `collectLocation falls through to GPS when PASSIVE returns null`() = runBlocking {
        // 安排：PASSIVE 返回 null，GPS 返回位置
        every { locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) } returns null
        val mockLocation = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = 31.2304
            longitude = 121.4737
            accuracy = 15f
        }
        every { locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER) } returns mockLocation

        val collector = createCollector()
        collector.collectLocation()

        verify { stateHolder.updateLastGps("31.2304,121.4737,15.0") }
    }

    @Test
    fun `collectLocation falls through to NETWORK when PASSIVE and GPS return null`() = runBlocking {
        // 安排：PASSIVE 和 GPS 都返回 null，NETWORK 返回位置
        every { locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) } returns null
        every { locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER) } returns null
        val mockLocation = Location(LocationManager.NETWORK_PROVIDER).apply {
            latitude = 22.5431
            longitude = 114.0579
            accuracy = 20f
        }
        every { locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER) } returns mockLocation

        val collector = createCollector()
        collector.collectLocation()

        verify { stateHolder.updateLastGps("22.5431,114.0579,20.0") }
    }

    @Test
    fun `collectLocation clears gps when permission denied`() = runBlocking {
        // 安排：权限未授予
        every {
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        } returns PackageManager.PERMISSION_DENIED

        val collector = createCollector()
        collector.collectLocation()

        // 权限不足时应清除 GPS 状态
        verify { stateHolder.updateLastGps("") }
        // 不应尝试读取位置
        verify(exactly = 0) { locationManager.getLastKnownLocation(any()) }
    }

    @Test
    fun `collectLocation does nothing when LocationManager is null`() = runBlocking {
        // 安排：LocationManager 不可用
        val nullContext = mockk<Context>(relaxed = true)
        every { nullContext.getSystemService(Context.LOCATION_SERVICE) } returns null
        val testStateHolder = mockk<SensorStateHolder>(relaxed = true)
        val collector = GpsCollector(nullContext, testStateHolder, httpClient)

        collector.collectLocation()

        // 不应有任何状态更新
        verify(exactly = 0) { testStateHolder.updateLastGps(any()) }
    }

    @Test
    fun `collectLocation handles all providers returning null`() = runBlocking {
        // 安排：所有 provider 都返回 null
        every { locationManager.getLastKnownLocation(any()) } returns null

        val collector = createCollector()
        collector.collectLocation()

        // 没有任何 provider 返回位置时，不应更新 GPS 状态
        verify(exactly = 0) { stateHolder.updateLastGps(match { it.isNotEmpty() && it.contains(",") }) }
    }

    @Test
    fun `collectLocation uses first available provider and stops`() = runBlocking {
        // 安排：所有 provider 都返回位置 — 应使用第一个（PASSIVE）
        val passiveLoc = Location(LocationManager.PASSIVE_PROVIDER).apply {
            latitude = 39.9
            longitude = 116.4
            accuracy = 5f
        }
        val gpsLoc = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = 31.2
            longitude = 121.5
            accuracy = 8f
        }
        every { locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) } returns passiveLoc
        every { locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER) } returns gpsLoc

        val collector = createCollector()
        collector.collectLocation()

        // 应使用 PASSIVE provider 的结果，不应再查询 GPS
        verify(exactly = 1) { locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) }
        verify(exactly = 0) { locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER) }
        verify { stateHolder.updateLastGps("39.9,116.4,5.0") }
    }

    @Test
    fun `collectLocation handles SecurityException from provider`() = runBlocking {
        // 安排：PASSIVE provider 抛出 SecurityException，GPS 正常返回
        every { locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) } throws SecurityException("no permission")
        val mockLocation = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = 31.2
            longitude = 121.5
            accuracy = 8f
        }
        every { locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER) } returns mockLocation

        val collector = createCollector()
        collector.collectLocation()

        // 应回退到 GPS provider
        verify { stateHolder.updateLastGps("31.2,121.5,8.0") }
    }

    // ======================== 新增行为选项 ========================

    @Test
    fun `collectLocation clears gps address when reverse geocode disabled`() = runBlocking {
        val mockLocation = Location(LocationManager.PASSIVE_PROVIDER).apply {
            latitude = 39.9042
            longitude = 116.4074
            accuracy = 10f
        }
        every { locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) } returns mockLocation

        val collector = createCollector()
        collector.collectLocation()

        // 坐标格式不变；逆地理编码关闭时地址被清空
        verify { stateHolder.updateLastGps("39.9042,116.4074,10.0") }
        verify { stateHolder.updateLastGpsAddress("") }
    }

    @Test
    fun `collectLocation falls back to cache when active fix times out`() = runBlocking {
        every { sharedPrefs.getLong("gps_fix_timeout_ms", any()) } returns 50L
        val cached = Location(LocationManager.PASSIVE_PROVIDER).apply {
            latitude = 39.9042
            longitude = 116.4074
            accuracy = 10f
        }
        every { locationManager.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER) } returns cached

        val collector = createCollector()
        collector.collectLocation()

        // 主动定位回调始终不触发 -> 超时后应回退并采纳缓存值
        verify { stateHolder.updateLastGps("39.9042,116.4074,10.0") }
    }

    // ======================== 辅助方法 ========================

    private fun createCollector(): GpsCollector {
        return GpsCollector(context, stateHolder, httpClient)
    }
}
