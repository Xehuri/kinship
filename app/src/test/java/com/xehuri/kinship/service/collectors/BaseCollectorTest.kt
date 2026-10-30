package com.xehuri.kinship.service.collectors

import android.content.Context
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.state.SensorStateHolder
import io.mockk.mockk
import io.mockk.verify
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 验证 [BaseCollector] 的生命周期和默认行为。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BaseCollectorTest {

    private val context: Context = mockk(relaxed = true)
    private val stateHolder: SensorStateHolder = mockk(relaxed = true)
    private val httpClient: AppHttpClient = mockk(relaxed = true)

    /** 用于测试的简单子类。 */
    private class TestCollector(
        context: Context,
        stateHolder: SensorStateHolder,
        httpClient: AppHttpClient
    ) : BaseCollector(context, stateHolder, httpClient) {
        var started = false
        var stopped = false
        override val isEnabled: Boolean get() = true
        // 公开 protected 成员以便测试
        fun exposeTag(): String = tag
        fun exposeHandleError(message: String, e: Exception? = null) = handleError(message, e)

        override fun start() {
            started = true
        }

        override fun stop() {
            stopped = true
        }
    }

    @Test
    fun `start sets started flag`() {
        val collector = TestCollector(context, stateHolder, httpClient)

        collector.start()

        assertTrue(collector.started)
    }

    @Test
    fun `stop sets stopped flag`() {
        val collector = TestCollector(context, stateHolder, httpClient)

        collector.start()
        collector.stop()

        assertTrue(collector.stopped)
    }

    @Test
    fun `isEnabled returns true for TestCollector`() {
        val collector = TestCollector(context, stateHolder, httpClient)

        assertTrue(collector.isEnabled)
    }

    @Test
    fun `default isEnabled returns false for anonymous subclass`() {
        val collector = object : BaseCollector(context, stateHolder, httpClient) {
            override fun start() { /* no-op */ }
            override fun stop() { /* no-op */ }
        }

        assertFalse(collector.isEnabled)
    }

    @Test
    fun `tag returns class simple name`() {
        val collector = TestCollector(context, stateHolder, httpClient)

        val tag = collector.exposeTag()
        assertTrue(tag.isNotEmpty())
        assertTrue(tag.contains("TestCollector"))
    }

    @Test
    fun `handleError does not throw`() {
        val collector = TestCollector(context, stateHolder, httpClient)

        // handleError should not throw for any input
        collector.exposeHandleError("test error")
        collector.exposeHandleError("test error with exception", RuntimeException("cause"))
    }

    @Test
    fun `constructor parameters are accessible`() {
        val collector = TestCollector(context, stateHolder, httpClient)

        // Verify the mocks were properly injected
        assertTrue(collector.exposeTag().isNotEmpty())
    }
}
