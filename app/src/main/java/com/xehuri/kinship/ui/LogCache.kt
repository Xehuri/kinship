package com.xehuri.kinship.ui

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 日志缓存 — 内存环形缓冲区，线程安全
 *
 * 最多保留 [MAX_ENTRIES] 条日志，超出时丢弃最旧的。
 * 通过 [logFlow] 对外暴露不可变列表快照供 Compose 订阅。
 */
object LogCache {

    private const val MAX_ENTRIES = 500

    /** 内部有序列表，充当环形缓冲区 */
    private val entries = ArrayList<LogEntry>(MAX_ENTRIES)

    private val _logFlow = MutableStateFlow<List<LogEntry>>(emptyList())
    val logFlow: StateFlow<List<LogEntry>> = _logFlow.asStateFlow()

    /**
     * 添加日志条目。线程安全（调用方需保证同步）。
     */
    @Synchronized
    fun add(entry: LogEntry) {
        if (entries.size >= MAX_ENTRIES) {
            entries.removeAt(0)
        }
        entries.add(entry)
        _logFlow.value = ArrayList(entries)
    }

    /**
     * 清空所有日志。
     */
    @Synchronized
    fun clear() {
        entries.clear()
        _logFlow.value = emptyList()
    }

    /**
     * 将当前所有日志导出为 JSON 数组字符串。
     *
     * 格式:
     * ```json
     * [{"epochMs":123,"tag":"Tag","message":"Msg","level":"INFO"}, ...]
     * ```
     */
    @Synchronized
    fun toJson(): String {
        val sb = StringBuilder()
        sb.append("[")
        for (i in entries.indices) {
            if (i > 0) sb.append(",")
            val e = entries[i]
            sb.append("""{"epochMs":${e.epochMs},"tag":${jsonEscape(e.tag)},"message":${jsonEscape(e.message)},"level":"${e.level.name}"}""")
        }
        sb.append("]")
        return sb.toString()
    }

    private fun jsonEscape(s: String): String {
        val escaped = s
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        return "\"$escaped\""
    }
}
