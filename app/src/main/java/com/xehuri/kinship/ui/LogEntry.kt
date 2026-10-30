package com.xehuri.kinship.ui

/**
 * 日志条目数据类
 */
data class LogEntry(
    val epochMs: Long,
    val tag: String,
    val message: String,
    val level: LogLevel
)

enum class LogLevel {
    DEBUG,
    INFO,
    WARN,
    ERROR
}
