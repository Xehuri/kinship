package com.xehuri.kinship.logging

import android.util.Log
import com.xehuri.kinship.ui.LogCache
import com.xehuri.kinship.ui.LogLevel
import com.google.common.truth.Truth.assertThat
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [AxeuhTimberTree] 鍗曞厓娴嬭瘯 鈥?楠岃瘉鏃ュ織姝ｇ‘鍐欏叆 [LogCache]銆? *
 * 渚濊禆 Robolectric 鎻愪緵 Android SDK (android.util.Log)銆? */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AxeuhTimberTreeTest {

    private lateinit var tree: AxeuhTimberTree

    @Before
    fun setUp() {
        LogCache.clear()
        tree = AxeuhTimberTree()
    }

    @After
    fun tearDown() {
        LogCache.clear()
    }

    @Test
    fun `log adds entry to LogCache`() {
        tree.log(Log.INFO, "TestTag", "hello world", null)
        val logs = LogCache.logFlow.value
        assertThat(logs).hasSize(1)
        assertThat(logs[0].tag).isEqualTo("TestTag")
        assertThat(logs[0].message).isEqualTo("hello world")
        assertThat(logs[0].level).isEqualTo(LogLevel.INFO)
    }

    @Test
    fun `log maps priority correctly`() {
        tree.log(Log.DEBUG, "T", "debug", null)
        tree.log(Log.INFO, "T", "info", null)
        tree.log(Log.WARN, "T", "warn", null)
        tree.log(Log.ERROR, "T", "error", null)
        val logs = LogCache.logFlow.value
        assertThat(logs.find { it.message == "debug" }?.level).isEqualTo(LogLevel.DEBUG)
        assertThat(logs.find { it.message == "info" }?.level).isEqualTo(LogLevel.INFO)
        assertThat(logs.find { it.message == "warn" }?.level).isEqualTo(LogLevel.WARN)
        assertThat(logs.find { it.message == "error" }?.level).isEqualTo(LogLevel.ERROR)
    }

    @Test
    fun `log uses default tag when tag is null`() {
        tree.log(Log.INFO, null as String?, "no tag", null)
        val logs = LogCache.logFlow.value
        assertThat(logs[0].tag).isEqualTo("Axeuh")
    }

    @Test
    fun `log includes stack trace when throwable is present`() {
        val exception = RuntimeException("test failure")
        tree.log(Log.ERROR, "T", "error occurred", exception)
        val logs = LogCache.logFlow.value
        assertThat(logs[0].message).contains("error occurred")
        assertThat(logs[0].message).contains("test failure")
    }
}
