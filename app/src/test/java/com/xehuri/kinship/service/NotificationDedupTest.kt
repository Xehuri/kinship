package com.xehuri.kinship.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 验证 [NotificationDedup] 的 key 去重与内容变化判定（纯逻辑，无需 Android 环境）。
 */
class NotificationDedupTest {

    @Test
    fun `first occurrence emits`() {
        val dedup = NotificationDedup()
        assertTrue(dedup.shouldEmit("k1", "fp1"))
    }

    @Test
    fun `unchanged content does not emit again`() {
        val dedup = NotificationDedup()
        assertTrue(dedup.shouldEmit("k1", "fp1"))
        assertFalse(dedup.shouldEmit("k1", "fp1"))
    }

    @Test
    fun `changed content emits again`() {
        val dedup = NotificationDedup()
        assertTrue(dedup.shouldEmit("k1", "fp1"))
        assertTrue(dedup.shouldEmit("k1", "fp2"))
    }

    @Test
    fun `different keys emit independently`() {
        val dedup = NotificationDedup()
        assertTrue(dedup.shouldEmit("k1", "fp1"))
        assertTrue(dedup.shouldEmit("k2", "fp1"))
    }

    @Test
    fun `evicts oldest beyond limit`() {
        val dedup = NotificationDedup(limit = 2)
        assertTrue(dedup.shouldEmit("a", "1"))
        assertTrue(dedup.shouldEmit("b", "1"))
        assertTrue(dedup.shouldEmit("c", "1")) // 淘汰 a
        // a 已被淘汰 → 再次出现视为新建
        assertTrue(dedup.shouldEmit("a", "1"))
    }
}
