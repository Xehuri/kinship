package com.xehuri.kinship.ui

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test

/**
 * [LogCache] 鍗曞厓娴嬭瘯 鈥?鐜舰缂撳啿鍖鸿涓?+ JSON 瀵煎嚭
 */
class LogCacheTest {

    @AfterEach
    fun tearDown() {
        LogCache.clear()
    }

    @Test
    fun `add stores entry and emits via flow`() {
        val entry = LogEntry(
            epochMs = 1000L,
            tag = "Test",
            message = "hello",
            level = LogLevel.INFO
        )
        LogCache.add(entry)
        val logs = LogCache.logFlow.value
        assertThat(logs).hasSize(1)
        assertThat(logs[0].message).isEqualTo("hello")
        assertThat(logs[0].level).isEqualTo(LogLevel.INFO)
    }

    @Test
    fun `cache trims at 500 entries`() {
        for (i in 0 until 501) {
            LogCache.add(
                LogEntry(
                    epochMs = i.toLong(),
                    tag = "T",
                    message = "msg_$i",
                    level = LogLevel.DEBUG
                )
            )
        }
        val logs = LogCache.logFlow.value
        assertThat(logs).hasSize(500)
        // 绗?0 鏉¤绉婚櫎锛岀 1 鏉℃垚涓虹涓€鏉?        assertThat(logs[0].message).isEqualTo("msg_1")
        assertThat(logs[499].message).isEqualTo("msg_500")
    }

    @Test
    fun `clear removes all entries`() {
        LogCache.add(LogEntry(1L, "T", "a", LogLevel.INFO))
        LogCache.add(LogEntry(2L, "T", "b", LogLevel.INFO))
        LogCache.clear()
        assertThat(LogCache.logFlow.value).isEmpty()
    }

    @Test
    fun `toJson returns valid JSON array`() {
        LogCache.add(LogEntry(100L, "Tag1", "msg1", LogLevel.WARN))
        LogCache.add(LogEntry(200L, "Tag2", "msg2", LogLevel.ERROR))
        val json = LogCache.toJson()
        assertThat(json).startsWith("[")
        assertThat(json).endsWith("]")
        assertThat(json).contains("Tag1")
        assertThat(json).contains("ERROR")
        assertThat(json).contains("100")
    }

    @Test
    fun `toJson escapes special characters`() {
        LogCache.add(LogEntry(1L, "T", "line1\nline2", LogLevel.DEBUG))
        val json = LogCache.toJson()
        assertThat(json).contains("line1\\nline2")
    }

    @Test
    fun `toJson escapes quotes and backslashes`() {
        LogCache.add(LogEntry(1L, "T", """say "hello" """, LogLevel.DEBUG))
        val json = LogCache.toJson()
        assertThat(json).contains("say \\\"hello\\\"")
    }

    @Test
    fun `flow emits updated list on each add`() {
        val flow = LogCache.logFlow
        assertThat(flow.value).isEmpty()

        LogCache.add(LogEntry(1L, "T", "first", LogLevel.INFO))
        assertThat(flow.value).hasSize(1)

        LogCache.add(LogEntry(2L, "T", "second", LogLevel.WARN))
        assertThat(flow.value).hasSize(2)
    }
}
