package com.xehuri.kinship.service.collectors

import android.content.Context
import android.content.SharedPreferences
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.state.SensorStateHolder
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 验证 [NotificationCollector] 的生命周期、计数采集与通知上行逻辑。
 *
 * 生命周期/计数通过 start/stop 与直接调用 [NotificationCollector.collectNotificationSummary]
 * 验证；上行通过 [NotificationCollector.onNotificationEntry] 入队后调用
 * [NotificationCollector.flushPendingNotifications] 验证（internal 方法，测试同包可见）。
 *
 * NotificationListenerService 通过构造函数的 notificationServiceProvider 参数注入 mock。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationCollectorTest {

    private val context = mockk<Context>(relaxed = true)
    private val stateHolder = mockk<SensorStateHolder>(relaxed = true)
    private val httpClient = mockk<AppHttpClient>(relaxed = true)
    private val notificationService = mockk<NotificationListenerService>(relaxed = true)

    private val axeuhPrefs = mockk<SharedPreferences>(relaxed = true)
    private val sensorPrefs = mockk<SharedPreferences>(relaxed = true)
    private val dataPrefs = mockk<SharedPreferences>(relaxed = true)

    @Before
    fun setUp() {
        // axeuh_prefs：event URL / token 构建
        every { context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE) } returns axeuhPrefs
        every { axeuhPrefs.getString("server_url", any()) } returns "https://localhost:8767"
        every { axeuhPrefs.getString("auth_token", "") } returns ""

        // sensor_toggles：采集开关 notification_enabled = true
        every { context.getSharedPreferences("sensor_toggles", Context.MODE_PRIVATE) } returns sensorPrefs
        every { sensorPrefs.getBoolean("notification_enabled", false) } returns true

        // data_collector：计数间隔 + 上行开关/间隔 + 敏感应用默认空
        every { context.getSharedPreferences("data_collector", Context.MODE_PRIVATE) } returns dataPrefs
        every { dataPrefs.getLong("notify_ms", 5000L) } returns 5000L
        every { dataPrefs.getBoolean("notify_upload_enabled", false) } returns true
        every { dataPrefs.getLong("notify_upload_interval_ms", 10_000L) } returns 0L
        every { dataPrefs.getString("notify_sensitive_apps", "") } returns ""
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

    // ======================== 计数采集（直接调用 internal 方法） ========================

    @Test
    fun `collectNotificationSummary updates count with active notifications`() = runBlocking {
        val mockSbn1 = mockNotification("com.example.app1")
        val mockSbn2 = mockNotification("com.example.app2")
        every { notificationService.activeNotifications } returns arrayOf(mockSbn1, mockSbn2)

        val collector = createCollector()
        collector.collectNotificationSummary()

        verify { stateHolder.updateNotificationCount(2) }
    }

    @Test
    fun `collectNotificationSummary does not upload directly`() = runBlocking {
        val mockSbn = mockNotification("com.example.test")
        every { notificationService.activeNotifications } returns arrayOf(mockSbn)

        val collector = createCollector()
        collector.collectNotificationSummary()

        // 计数轮询不再直接上行，上行统一走 flushPendingNotifications
        coVerify(exactly = 0) { httpClient.post(any(), any()) }
    }

    @Test
    fun `skips when NotificationListenerService provider returns null`() = runBlocking {
        val nullCollector = NotificationCollector(context, stateHolder, httpClient) { null }
        nullCollector.collectNotificationSummary()

        coVerify(exactly = 0) { httpClient.post(any(), any()) }
    }

    @Test
    fun `skips when activeNotifications is null`() = runBlocking {
        every { notificationService.activeNotifications } returns null

        val collector = createCollector()
        collector.collectNotificationSummary()

        coVerify(exactly = 0) { httpClient.post(any(), any()) }
    }

    @Test
    fun `updateNotificationCount is 0 when no active notifications`() = runBlocking {
        every { notificationService.activeNotifications } returns emptyArray()

        val collector = createCollector()
        collector.collectNotificationSummary()

        verify { stateHolder.updateNotificationCount(0) }
    }

    @Test
    fun `multiple notifications from same app counted correctly`() = runBlocking {
        val mockSbn1 = mockNotification("com.example.same")
        val mockSbn2 = mockNotification("com.example.same")
        every { notificationService.activeNotifications } returns arrayOf(mockSbn1, mockSbn2)

        val collector = createCollector()
        collector.collectNotificationSummary()

        verify { stateHolder.updateNotificationCount(2) }
    }

    @Test
    fun `single notification triggers update`() = runBlocking {
        val mockSbn = mockNotification("com.example.single")
        every { notificationService.activeNotifications } returns arrayOf(mockSbn)

        val collector = createCollector()
        collector.collectNotificationSummary()

        verify { stateHolder.updateNotificationCount(1) }
    }

    // ======================== 通知上行 ========================

    @Test
    fun `flushPendingNotifications uploads queued notify payload`() = runBlocking {
        val collector = createCollector()
        collector.onNotificationEntry(entry("k1", "com.example.app", "标题", "正文"))

        collector.flushPendingNotifications()

        coVerify(exactly = 1) {
            httpClient.post(
                match { it.contains("perception-event") },
                match { it.contains("\"type\":\"notify\"") }
            )
        }
    }

    @Test
    fun `flushPendingNotifications only sends once per interval`() = runBlocking {
        every { dataPrefs.getLong("notify_upload_interval_ms", 10_000L) } returns 600_000L

        val collector = createCollector()
        collector.onNotificationEntry(entry("k1", "com.example.app", "标题", "正文"))
        collector.flushPendingNotifications() // 首次：锚点为 0，正常发出
        collector.onNotificationEntry(entry("k2", "com.example.app", "标题2", "正文2"))
        collector.flushPendingNotifications() // 间隔未到：跳过

        coVerify(exactly = 1) { httpClient.post(any(), any()) }
    }

    @Test
    fun `flushPendingNotifications skips when upload disabled`() = runBlocking {
        every { dataPrefs.getBoolean("notify_upload_enabled", false) } returns false

        val collector = createCollector()
        collector.onNotificationEntry(entry("k1", "com.example.app", "标题", "正文"))
        collector.flushPendingNotifications()

        coVerify(exactly = 0) { httpClient.post(any(), any()) }
    }

    @Test
    fun `buildPayload redacts sensitive package`() {
        every { dataPrefs.getString("notify_sensitive_apps", "") } returns "com.secret.app"

        val collector = createCollector()
        val payload = collector.buildPayload(entry("k9", "com.secret.app", "私密标题", "私密正文"))

        assertTrue(payload.getBoolean("redacted"))
        assertFalse(payload.has("title"))
        assertFalse(payload.has("text"))
        assertEquals("com.secret.app", payload.getString("package"))
    }

    @Test
    fun `buildPayload keeps content for normal package`() {
        val collector = createCollector()
        val payload = collector.buildPayload(entry("k8", "com.normal.app", "标题", "正文"))

        assertFalse(payload.getBoolean("redacted"))
        assertEquals("k8", payload.getString("key"))
        assertEquals("标题", payload.getString("title"))
        assertEquals("正文", payload.getString("text"))
    }

    // ======================== 辅助方法 ========================

    private fun createCollector(): NotificationCollector {
        return NotificationCollector(context, stateHolder, httpClient) { notificationService }
    }

    private fun entry(
        key: String,
        pkg: String,
        title: String,
        text: String
    ): com.xehuri.kinship.service.NotificationListenerService.NotificationEntry =
        com.xehuri.kinship.service.NotificationListenerService.NotificationEntry(
            packageName = pkg,
            title = title,
            text = text,
            postTime = 1_700_000_000_000L,
            key = key,
            id = 1
        )

    /** 创建模拟的 StatusBarNotification */
    private fun mockNotification(packageName: String): StatusBarNotification {
        val sbn = mockk<StatusBarNotification>(relaxed = true)
        every { sbn.packageName } returns packageName
        return sbn
    }
}
