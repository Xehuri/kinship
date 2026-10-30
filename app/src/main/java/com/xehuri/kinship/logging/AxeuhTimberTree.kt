package com.xehuri.kinship.logging

import android.util.Log
import com.xehuri.kinship.ui.LogCache
import com.xehuri.kinship.ui.LogEntry
import com.xehuri.kinship.ui.LogLevel
import timber.log.Timber

/**
 * 自定义 Timber.DebugTree — 将日志写入 [LogCache] 内存缓冲区。
 *
 * [Timber.DebugTree.log] 被 [AxeuhTimberTree.log] 拦截，构造 [LogEntry] 并
 * 同步添加到 [LogCache]。异常堆栈会被转换为字符串附加到 message 尾部。
 */
class AxeuhTimberTree : Timber.DebugTree() {

    // 公开四参 log：Timber 5 另有公开三参 vararg log，若保持 protected 则调用会落到
    // vararg 重载（自行推导 tag），无法表现「tag 为 null 时用默认值」的语义。
    public override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
        val level = when (priority) {
            Log.VERBOSE, Log.DEBUG -> LogLevel.DEBUG
            Log.INFO -> LogLevel.INFO
            Log.WARN -> LogLevel.WARN
            Log.ERROR, Log.ASSERT -> LogLevel.ERROR
            else -> LogLevel.DEBUG
        }

        val displayTag = tag ?: "Axeuh"
        val displayMessage = if (t != null) {
            "$message\n${Log.getStackTraceString(t)}"
        } else {
            message
        }

        val entry = LogEntry(
            epochMs = System.currentTimeMillis(),
            tag = displayTag,
            message = displayMessage,
            level = level
        )
        LogCache.add(entry)
    }
}
