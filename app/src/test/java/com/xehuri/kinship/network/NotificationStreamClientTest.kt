package com.xehuri.kinship.network

import android.content.Context
import android.content.SharedPreferences
import com.xehuri.kinship.config.ServerConfig
import com.google.common.truth.Truth.assertThat
import io.mockk.every
import io.mockk.mockk
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 验证 [NotificationStreamClient] 的 URL 构造与通知下行消息解析。
 * 不建立真实 WebSocket 连接（仅测纯逻辑）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationStreamClientTest {

    private val prefs = mockk<SharedPreferences>(relaxed = true)
    private val context = mockk<Context>(relaxed = true)
    private val httpClient = mockk<AppHttpClient>(relaxed = true)

    private var client: NotificationStreamClient? = null

    @Before
    fun setUp() {
        every { context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE) } returns prefs
        ServerConfig.update("https://example.com")
    }

    @After
    fun tearDown() {
        client?.close()
        client = null
    }

    // ======================== 消息解析 ========================

    @Test
    fun `parse notification message`() {
        val c = createClient("tok")
        val p = c.parseNotificationMessage(
            """{"type":"notification","data":{"id":7,"title":"标题","content":"正文","ts":"12:00:00"}}"""
        )
        assertThat(p).isNotNull()
        assertThat(p!!.id).isEqualTo(7)
        assertThat(p.title).isEqualTo("标题")
        assertThat(p.content).isEqualTo("正文")
    }

    @Test
    fun `parse non-notification returns null`() {
        val c = createClient("tok")
        assertThat(c.parseNotificationMessage("""{"type":"pong"}""")).isNull()
        assertThat(c.parseNotificationMessage("""{"type":"notification"}""")).isNull()
        assertThat(c.parseNotificationMessage("not json")).isNull()
    }

    // ======================== 帧 ts 直通回调（B1 回归） ========================

    @Test
    fun `notification frame threads epoch-second ts through callback`() {
        val c = createClient("tok")
        val received = mutableListOf<List<Any?>>()
        // 回调签名须为 (Int, String, String, Long)：仍为 3 参时此 lambda 编译即失败——
        // 这正是 B1 缺陷（实时路丢帧 ts、live/回补双路 (id,ts) 不同值生孪生行）的 red 证据
        c.onNotification = { id, title, content, tsSec -> received += listOf(id, title, content, tsSec) }
        injectFrame(c, """{"type":"notification","data":{"id":5,"title":"标题","content":"正文","ts":1791892859}}""")
        assertThat(received).containsExactly(listOf(5, "标题", "正文", 1791892859L))
    }

    @Test
    fun `notification frame without ts yields zero and is never swallowed`() {
        val c = createClient("tok")
        val received = mutableListOf<List<Any?>>()
        c.onNotification = { id, title, content, tsSec -> received += listOf(id, title, content, tsSec) }
        injectFrame(c, """{"type":"notification","data":{"id":6,"title":"t","content":"c"}}""")
        // 缺 ts ⇒ 0：回调必须照常收到（绝不吞推送），0 由消费方回落毫秒兜底
        assertThat(received).containsExactly(listOf(6, "t", "c", 0L))
    }

    // ======================== URL 构造 ========================

    @Test
    fun `buildUrl uses token query param`() {
        val c = createClient("abc123")
        val url = c.buildUrl()
        assertThat(url).isNotNull()
        assertThat(url!!).startsWith("wss://example.com")
        assertThat(url).contains("/ws?token=abc123")
    }

    @Test
    fun `buildUrl null when token missing`() {
        val c = createClient("")
        assertThat(c.buildUrl()).isNull()
    }

    // ======================== 辅助 ========================

    /** 不建真实连接，直接经内部 WebSocketListener 收一条文本帧（驱动 onMessage 解析+回调路）。 */
    private fun injectFrame(c: NotificationStreamClient, text: String) {
        val field = NotificationStreamClient::class.java.getDeclaredField("listener")
        field.isAccessible = true
        val listener = field.get(c) as okhttp3.WebSocketListener
        listener.onMessage(mockk<okhttp3.WebSocket>(relaxed = true), text)
    }

    private fun createClient(token: String): NotificationStreamClient {
        every { prefs.getString("auth_token", "") } returns token
        val created = NotificationStreamClient(context, httpClient)
        client = created
        return created
    }
}
