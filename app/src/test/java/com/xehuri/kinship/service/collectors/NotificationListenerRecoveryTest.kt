package com.xehuri.kinship.service.collectors

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 验证 [NotificationListenerRecovery] 的宽限期、重绑节流与告警节流语义。
 *
 * 全部使用显式时间戳（不读系统时钟），无需 Robolectric。
 */
class NotificationListenerRecoveryTest {

    @Test
    fun `no actions during grace period`() {
        val policy = policy(
            graceMs = 10_000L,
            rebindIntervalMs = 60_000L,
            alertAfterMs = 120_000L,
            alertIntervalMs = 900_000L,
        )
        val t0 = 1_000L

        assertEquals(
            NotificationListenerRecovery.Decision(),
            policy.onDisconnected(t0, permissionGranted = true)
        )
        assertEquals(
            NotificationListenerRecovery.Decision(),
            policy.onDisconnected(t0 + 9_999L, permissionGranted = true)
        )
        assertEquals(
            NotificationListenerRecovery.Decision(),
            policy.onDisconnected(t0 + 9_999L, permissionGranted = false)
        )
    }

    @Test
    fun `rebind exactly at grace when permission granted`() {
        val policy = policy(
            graceMs = 10_000L,
            rebindIntervalMs = 60_000L,
            alertAfterMs = 120_000L,
            alertIntervalMs = 900_000L,
        )
        val t0 = 1_000L

        policy.onDisconnected(t0, permissionGranted = true)
        val decision = policy.onDisconnected(t0 + 10_000L, permissionGranted = true)

        assertTrue(decision.requestRebind)
        assertFalse(decision.showAlert)
    }

    @Test
    fun `rebind after grace when permission granted`() {
        val policy = policy(
            graceMs = 10_000L,
            rebindIntervalMs = 60_000L,
            alertAfterMs = 120_000L,
            alertIntervalMs = 900_000L,
        )
        val t0 = 1_000L

        policy.onDisconnected(t0, permissionGranted = true)
        val decision = policy.onDisconnected(t0 + 10_001L, permissionGranted = true)

        assertTrue(decision.requestRebind)
        assertFalse(decision.showAlert)
    }

    @Test
    fun `rebind throttled within interval and repeated after interval`() {
        val policy = policy(
            graceMs = 1_000L,
            rebindIntervalMs = 5_000L,
            alertAfterMs = 1_000_000L,
            alertIntervalMs = 900_000L,
        )
        val t0 = 1_000L

        policy.onDisconnected(t0, permissionGranted = true)
        assertTrue(policy.onDisconnected(t0 + 1_000L, permissionGranted = true).requestRebind)

        val throttled = policy.onDisconnected(t0 + 5_999L, permissionGranted = true)
        assertFalse(throttled.requestRebind)

        val repeated = policy.onDisconnected(t0 + 6_000L, permissionGranted = true)
        assertTrue(repeated.requestRebind)
    }

    @Test
    fun `no rebind when permission missing but alert fires after grace`() {
        val policy = policy(
            graceMs = 1_000L,
            rebindIntervalMs = 5_000L,
            alertAfterMs = 100_000L,
            alertIntervalMs = 900_000L,
        )
        val t0 = 1_000L

        assertEquals(
            NotificationListenerRecovery.Decision(),
            policy.onDisconnected(t0, permissionGranted = false)
        )

        val decision = policy.onDisconnected(t0 + 1_000L, permissionGranted = false)
        assertFalse(decision.requestRebind)
        assertTrue(decision.showAlert)

        val later = policy.onDisconnected(t0 + 50_000L, permissionGranted = false)
        assertFalse(later.requestRebind)
        assertFalse(later.showAlert)
    }

    @Test
    fun `alert throttled by alert interval`() {
        val policy = policy(
            graceMs = 1_000L,
            rebindIntervalMs = 1_000_000L,
            alertAfterMs = 100_000L,
            alertIntervalMs = 30_000L,
        )
        val t0 = 1_000L

        policy.onDisconnected(t0, permissionGranted = false)
        assertTrue(policy.onDisconnected(t0 + 1_000L, permissionGranted = false).showAlert)

        assertFalse(policy.onDisconnected(t0 + 30_999L, permissionGranted = false).showAlert)
        assertTrue(policy.onDisconnected(t0 + 31_000L, permissionGranted = false).showAlert)
    }

    @Test
    fun `alert fires past alert threshold when permission granted`() {
        val policy = policy(
            graceMs = 1_000L,
            rebindIntervalMs = 10_000_000L,
            alertAfterMs = 10_000L,
            alertIntervalMs = 900_000L,
        )
        val t0 = 1_000L

        policy.onDisconnected(t0, permissionGranted = true)
        assertFalse(policy.onDisconnected(t0 + 1_000L, permissionGranted = true).showAlert)
        assertFalse(policy.onDisconnected(t0 + 9_999L, permissionGranted = true).showAlert)

        val decision = policy.onDisconnected(t0 + 11_000L, permissionGranted = true)
        assertTrue(decision.showAlert)
        assertFalse(decision.requestRebind)
    }

    @Test
    fun `onConnected returns true once after broken episode and resets grace`() {
        val policy = policy(
            graceMs = 5_000L,
            rebindIntervalMs = 60_000L,
            alertAfterMs = 120_000L,
            alertIntervalMs = 900_000L,
        )

        assertFalse(policy.onConnected(0L))

        policy.onDisconnected(1_000L, permissionGranted = true)
        assertTrue(policy.onConnected(2_000L))
        assertFalse(policy.onConnected(3_000L))

        assertEquals(
            NotificationListenerRecovery.Decision(),
            policy.onDisconnected(3_000L, permissionGranted = true)
        )
        assertEquals(
            NotificationListenerRecovery.Decision(),
            policy.onDisconnected(7_999L, permissionGranted = true)
        )
        assertTrue(policy.onDisconnected(8_000L, permissionGranted = true).requestRebind)
    }

    @Test
    fun `both actions can fire in one decision when thresholds coincide`() {
        val policy = policy(
            graceMs = 1_000L,
            rebindIntervalMs = 5_000L,
            alertAfterMs = 5_000L,
            alertIntervalMs = 900_000L,
        )
        val t0 = 1_000L

        policy.onDisconnected(t0, permissionGranted = true)
        val decision = policy.onDisconnected(t0 + 5_000L, permissionGranted = true)

        assertTrue(decision.requestRebind)
        assertTrue(decision.showAlert)

        val next = policy.onDisconnected(t0 + 5_001L, permissionGranted = true)
        assertFalse(next.requestRebind)
        assertFalse(next.showAlert)
    }

    private fun policy(
        graceMs: Long,
        rebindIntervalMs: Long,
        alertAfterMs: Long,
        alertIntervalMs: Long,
    ) = NotificationListenerRecovery(
        graceMs = graceMs,
        rebindIntervalMs = rebindIntervalMs,
        alertAfterMs = alertAfterMs,
        alertIntervalMs = alertIntervalMs,
    )
}
