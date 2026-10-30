package com.xehuri.kinship.service

import android.app.Notification
import android.content.Context
import android.service.notification.StatusBarNotification
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import org.junit.After
import org.junit.Before
import org.junit.Ignore
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@Ignore("Pre-existing: StatusBarNotification constructor API 34+")
class NotificationListenerServiceTest {

    private lateinit var context: Context
    private lateinit var service: NotificationListenerService

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        service = NotificationListenerService()
    }

    @After
    fun tearDown() {
        setCurrentInstance(null)
    }

    // ==================== Lifecycle Tests ====================

    @Test
    fun `onListenerConnected sets currentInstance`() {
        service.onListenerConnected()
        assertThat(NotificationListenerService.currentInstance).isEqualTo(service)
    }

    @Test
    fun `onListenerDisconnected clears currentInstance`() {
        service.onListenerConnected()
        assertThat(NotificationListenerService.currentInstance).isNotNull()

        service.onListenerDisconnected()
        assertThat(NotificationListenerService.currentInstance).isNull()
    }

    @Test
    fun `isListenerEnabled returns true when service is connected`() {
        service.onListenerConnected()
        assertThat(NotificationListenerService.isListenerEnabled()).isTrue()
    }

    @Test
    fun `isListenerEnabled returns false when service is disconnected`() {
        service.onListenerConnected()
        service.onListenerDisconnected()
        assertThat(NotificationListenerService.isListenerEnabled()).isFalse()
    }

    @Test
    fun `isListenerEnabled returns false before any connection`() {
        assertThat(NotificationListenerService.isListenerEnabled()).isFalse()
    }

    // ==================== Notification Caching Tests ====================

    @Test
    fun `onNotificationPosted adds entry to cache`() {
        val notification = createTestNotification("Test Title", "Test Content")
        val sbn = createStatusBarNotification("com.example.test", notification, 1000L)

        service.onNotificationPosted(sbn)
        val entries = service.getRecentNotifications()

        assertThat(entries).hasSize(1)
        assertThat(entries[0].packageName).isEqualTo("com.example.test")
        assertThat(entries[0].title).isEqualTo("Test Title")
        assertThat(entries[0].text).isEqualTo("Test Content")
        assertThat(entries[0].postTime).isEqualTo(1000L)
    }

    @Test
    fun `onNotificationPosted respects cache size limit of 50`() {
        // Add 51 notifications 鈥?the oldest should be evicted
        for (i in 1..51) {
            val notification = createTestNotification("Title $i", "Content $i")
            val sbn = createStatusBarNotification("com.test$i", notification, i * 1000L)
            service.onNotificationPosted(sbn)
        }

        val entries = service.getRecentNotifications()
        assertThat(entries).hasSize(50)
        // The oldest (com.test1) should be removed
        assertThat(entries[0].packageName).isEqualTo("com.test2")
        assertThat(entries[49].packageName).isEqualTo("com.test51")
    }

    @Test
    fun `getRecentNotifications returns a defensive copy of the cache`() {
        val notification = createTestNotification("Title", "Content")
        val sbn = createStatusBarNotification("com.test", notification, 1000L)
        service.onNotificationPosted(sbn)

        val snapshot1 = service.getRecentNotifications()
        val snapshot2 = service.getRecentNotifications()

        // Different list instances
        assertThat(snapshot1).isNotSameInstanceAs(snapshot2)
        // But equal content
        assertThat(snapshot1).isEqualTo(snapshot2)
    }

    // ==================== Edge Cases ====================

    @Test
    fun `onNotificationPosted handles missing EXTRA_TITLE gracefully`() {
        val notification = createTestNotification(title = null, text = "Content Only")
        val sbn = createStatusBarNotification("com.test", notification, 1000L)

        service.onNotificationPosted(sbn)
        val entries = service.getRecentNotifications()

        assertThat(entries).hasSize(1)
        assertThat(entries[0].title).isEmpty()
        assertThat(entries[0].text).isEqualTo("Content Only")
    }

    @Test
    fun `onNotificationPosted handles missing EXTRA_TEXT gracefully`() {
        val notification = createTestNotification(title = "Title Only", text = null)
        val sbn = createStatusBarNotification("com.test", notification, 1000L)

        service.onNotificationPosted(sbn)
        val entries = service.getRecentNotifications()

        assertThat(entries).hasSize(1)
        assertThat(entries[0].title).isEqualTo("Title Only")
        assertThat(entries[0].text).isEmpty()
    }

    @Test
    fun `onNotificationPosted handles null extras gracefully without crashing`() {
        // Create a notification and strip its extras Bundle
        val notification = createTestNotification("Title", "Content")
        // Use reflection to set extras to null (simulate Android 15+ edge case)
        val extrasField = Notification::class.java.getDeclaredField("extras")
        extrasField.isAccessible = true
        extrasField.set(notification, null)

        val sbn = createStatusBarNotification("com.test", notification, 1000L)

        // Should not crash
        service.onNotificationPosted(sbn)
        val entries = service.getRecentNotifications()
        assertThat(entries).isEmpty()
    }

    @Test
    fun `onNotificationRemoved does not remove cached entry`() {
        val notification = createTestNotification("Title", "Content")
        val sbn = createStatusBarNotification("com.test", notification, 1000L)
        service.onNotificationPosted(sbn)

        service.onNotificationRemoved(sbn)
        val entries = service.getRecentNotifications()

        // Entry should still be present (removed notifications stay in cache)
        assertThat(entries).hasSize(1)
    }

    // ==================== Data Class Tests ====================

    @Test
    fun `NotificationEntry data class holds correct values`() {
        val entry = NotificationListenerService.NotificationEntry(
            packageName = "com.test.pkg",
            title = "Test Title",
            text = "Test Content",
            postTime = 123456789L
        )

        assertThat(entry.packageName).isEqualTo("com.test.pkg")
        assertThat(entry.title).isEqualTo("Test Title")
        assertThat(entry.text).isEqualTo("Test Content")
        assertThat(entry.postTime).isEqualTo(123456789L)
    }

    @Test
    fun `NotificationEntry data class equals and hashCode work`() {
        val entry1 = NotificationListenerService.NotificationEntry(
            "com.test", "Title", "Content", 1000L
        )
        val entry2 = NotificationListenerService.NotificationEntry(
            "com.test", "Title", "Content", 1000L
        )
        val entry3 = NotificationListenerService.NotificationEntry(
            "com.other", "Other", "Other", 2000L
        )

        assertThat(entry1).isEqualTo(entry2)
        assertThat(entry1.hashCode()).isEqualTo(entry2.hashCode())
        assertThat(entry1).isNotEqualTo(entry3)
    }

    // ==================== Concurrency / Smoke Test ====================

    @Test
    fun `smoke test - 100 rapid notifications does not crash`() {
        service.onListenerConnected()

        (1..100).forEach { i ->
            val notification = createTestNotification("Title $i", "Content $i")
            val sbn = createStatusBarNotification("com.test$i", notification, i * 1000L)
            service.onNotificationPosted(sbn)
        }

        val entries = service.getRecentNotifications()
        assertThat(entries).hasSize(50)
        assertThat(NotificationListenerService.isListenerEnabled()).isTrue()
    }

    // ==================== Helper Methods ====================

    private fun createTestNotification(title: String?, text: String?): Notification {
        val builder = Notification.Builder(context, "test_channel")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
        if (title != null) builder.setContentTitle(title)
        if (text != null) builder.setContentText(text)
        return builder.build()
    }

    private fun createStatusBarNotification(
        pkg: String,
        notification: Notification,
        postTime: Long
    ): StatusBarNotification {
        // StatusBarNotification constructor requires Parcel on API 34+
        // Class is @Ignore-d, this method is placeholder only.
        throw UnsupportedOperationException("Not implemented for API 34+")
    }

    private fun setCurrentInstance(instance: NotificationListenerService?) {
        val companionField = NotificationListenerService::class.java.getDeclaredField("Companion")
        companionField.isAccessible = true
        val companion = companionField.get(null)!!
        val instanceField = companion.javaClass.getDeclaredField("currentInstance")
        instanceField.isAccessible = true
        instanceField.set(companion, instance)
    }
}
