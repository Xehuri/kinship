package com.xehuri.kinship.service.uploader

import com.google.common.truth.Truth.assertThat
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * CheckpointCleanup 单元测试。
 *
 * 覆盖：字节上限下按最旧优先淘汰、TTL 淘汰、绝不淘汰未上传成功条目、
 * 扫描 upload_cache 时按 `.ack` 标记识别已上传条目。
 *
 * 纯文件策略测试，不依赖 Android 框架，无需 Robolectric。
 */
class CheckpointCleanupTest {

    private lateinit var dir: File
    private val now = 1_700_000_000_000L
    private val oneDay = 24L * 60 * 60 * 1000

    @Before
    fun setup() {
        dir = File(System.getProperty("java.io.tmpdir"), "cp_cleanup_${System.nanoTime()}")
        dir.mkdirs()
    }

    @After
    fun teardown() {
        if (dir.exists()) dir.deleteRecursively()
    }

    /** 创建实体文件并构造条目（sizeBytes 与文件实际大小一致） */
    private fun entry(
        name: String,
        sizeBytes: Int,
        lastTouchedMs: Long,
        uploaded: Boolean
    ): CheckpointEntry {
        val file = File(dir, name)
        file.writeBytes(ByteArray(sizeBytes))
        file.setLastModified(lastTouchedMs)
        return CheckpointEntry(
            file = file,
            sizeBytes = sizeBytes.toLong(),
            lastTouchedMs = lastTouchedMs,
            uploaded = uploaded
        )
    }

    // ========================================================================
    // 字节上限
    // ========================================================================

    @Test
    fun `should evict oldest uploaded first over byte cap and keep un-uploaded`() {
        val cleanup = CheckpointCleanup(ttlMs = 365 * oneDay, maxBytes = 10)
        val oldest = entry("old.json", 6, now - 2000, uploaded = true)
        val newer = entry("newer.json", 6, now - 1000, uploaded = true)
        val protectedEntry = entry("protected.json", 6, now - 3000, uploaded = false)

        val evicted = cleanup.planEvictions(listOf(oldest, newer, protectedEntry), now)

        assertThat(evicted).containsExactly(oldest, newer)
        assertThat(evicted).doesNotContain(protectedEntry)

        val removed = cleanup.cleanup(listOf(oldest, newer, protectedEntry), now)

        assertThat(removed).isEqualTo(2)
        assertThat(oldest.file.exists()).isFalse()
        assertThat(newer.file.exists()).isFalse()
        assertThat(protectedEntry.file.exists()).isTrue()
    }

    @Test
    fun `should never evict un-uploaded entries even when they alone exceed cap`() {
        val cleanup = CheckpointCleanup(ttlMs = 365 * oneDay, maxBytes = 1)
        val protectedEntry = entry("waiting.json", 100, now - 10 * oneDay, uploaded = false)

        val evicted = cleanup.planEvictions(listOf(protectedEntry), now)

        assertThat(evicted).isEmpty()
        assertThat(cleanup.cleanup(listOf(protectedEntry), now)).isEqualTo(0)
        assertThat(protectedEntry.file.exists()).isTrue()
    }

    @Test
    fun `should evict nothing when under cap`() {
        val cleanup = CheckpointCleanup(ttlMs = 365 * oneDay, maxBytes = 1000)
        val a = entry("a.json", 10, now - oneDay, uploaded = true)
        val b = entry("b.json", 10, now - oneDay, uploaded = false)

        val evicted = cleanup.planEvictions(listOf(a, b), now)

        assertThat(evicted).isEmpty()
    }

    // ========================================================================
    // TTL
    // ========================================================================

    @Test
    fun `should evict uploaded entry older than ttl`() {
        val cleanup = CheckpointCleanup(ttlMs = oneDay, maxBytes = 1024)
        val stale = entry("stale.json", 10, now - 2 * oneDay, uploaded = true)
        val fresh = entry("fresh.json", 10, now - 1000, uploaded = true)

        val evicted = cleanup.planEvictions(listOf(stale, fresh), now)

        assertThat(evicted).containsExactly(stale)
    }

    @Test
    fun `should not evict stale entry that is not uploaded`() {
        val cleanup = CheckpointCleanup(ttlMs = oneDay, maxBytes = 1024)
        val staleButWaiting = entry("waiting.json", 10, now - 30 * oneDay, uploaded = false)

        val evicted = cleanup.planEvictions(listOf(staleButWaiting), now)

        assertThat(evicted).isEmpty()
    }

    // ========================================================================
    // 扫描 upload_cache
    // ========================================================================

    @Test
    fun `should scan cache entries and detect ack marker`() {
        val cacheDir = File(dir, "upload_cache").apply { mkdirs() }
        File(cacheDir, "1000-0.json").writeText("{}")
        File(cacheDir, "1000-0.wav").writeBytes(ByteArray(64))
        File(cacheDir, "1000-0${CheckpointCleanup.ACK_SUFFIX}").writeText("")

        File(cacheDir, "2000-1.json").writeText("{}")
        File(cacheDir, "2000-1.wav").writeBytes(ByteArray(32))

        val entries = CheckpointCleanup().scanCacheEntries(cacheDir)

        assertThat(entries).hasSize(2)
        val acked = entries.first { it.file.name == "1000-0.json" }
        val waiting = entries.first { it.file.name == "2000-1.json" }
        assertThat(acked.uploaded).isTrue()
        assertThat(acked.sizeBytes).isEqualTo(2L + 64L)
        assertThat(waiting.uploaded).isFalse()
    }

    @Test
    fun `should return empty scan for missing directory`() {
        val entries = CheckpointCleanup().scanCacheEntries(File(dir, "does-not-exist"))

        assertThat(entries).isEmpty()
    }

    @Test
    fun `should delete wav pair together with json on eviction`() {
        val cacheDir = File(dir, "pair").apply { mkdirs() }
        val jsonFile = File(cacheDir, "1000-0.json").apply { writeText("{}") }
        val wavFile = File(cacheDir, "1000-0.wav").apply { writeBytes(ByteArray(8)) }
        val cleanup = CheckpointCleanup(ttlMs = oneDay, maxBytes = Long.MAX_VALUE)
        val entry = CheckpointEntry(jsonFile, 2, now - 2 * oneDay, uploaded = true)

        val removed = cleanup.cleanup(listOf(entry), now)

        assertThat(removed).isEqualTo(1)
        assertThat(jsonFile.exists()).isFalse()
        assertThat(wavFile.exists()).isFalse()
    }
}
