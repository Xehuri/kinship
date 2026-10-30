package com.xehuri.kinship.web

import android.content.Context
import android.content.SharedPreferences
import android.os.Looper
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * WebTokenBridge 单元测试（Robolectric 真实 SharedPreferences/Handler/WebView）。
 *
 * 覆盖：脚本转义、按 prefs 注入、空 token 不注入、监听键过滤、后台线程写入
 * 需回主线程、start/stop 幂等、停止后丢弃挂起注入。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WebTokenBridgeTest {

    private lateinit var prefs: SharedPreferences
    private lateinit var webView: WebView
    private lateinit var bridge: WebTokenBridge

    @Before
    fun setUp() {
        val context: Context = ApplicationProvider.getApplicationContext()
        prefs = context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        webView = WebView(context)
        bridge = WebTokenBridge(prefs = prefs, webViewProvider = { webView })
    }

    @After
    fun tearDown() {
        bridge.stop()
        prefs.edit().clear().commit()
        webView.destroy()
    }

    private fun idleMain() {
        repeat(2) { shadowOf(Looper.getMainLooper()).idle() }
    }

    private fun lastJs(): String? = shadowOf(webView).lastEvaluatedJavascript

    @Test
    fun `script writes localStorage and dispatches refresh event with json escaped token`() {
        val hostile = "a'b\"c\\d\ne"

        val script = WebTokenBridge.buildTokenInjectionScript(hostile)

        assertThat(script).contains("window.localStorage.setItem('mobile_token'")
        assertThat(script).contains("new CustomEvent('${WebTokenBridge.TOKEN_REFRESH_EVENT}'")
        assertThat(script).contains("detail: ${JSONObject.quote(hostile)}")
        assertThat(script).contains(JSONObject.quote(hostile))
        // 原始恶意序列不能以未转义形式落进脚本（单引号/双引号/反斜杠/换行都须由 JSON 转义）
        assertThat(script).doesNotContain("'$hostile'")
    }

    @Test
    fun `injectNow evaluates javascript containing stored token`() {
        prefs.edit().putString(WebTokenBridge.KEY_AUTH_TOKEN, "bridge-token").commit()

        bridge.injectNow()
        idleMain()

        val js = lastJs()
        assertThat(js).isNotNull()
        assertThat(js).contains("bridge-token")
        assertThat(js).contains(WebTokenBridge.TOKEN_REFRESH_EVENT)
    }

    @Test
    fun `injectNow skips empty token`() {
        bridge.injectNow()
        idleMain()

        assertThat(lastJs()).isNull()
    }

    @Test
    fun `preference change only reacts to auth token key`() {
        bridge.start()

        prefs.edit().putString("auth_username", "someone").commit()
        idleMain()
        assertThat(lastJs()).isNull()

        prefs.edit().putString(WebTokenBridge.KEY_AUTH_TOKEN, "changed-token").commit()
        idleMain()
        assertThat(lastJs()).contains("changed-token")
    }

    @Test
    fun `background thread commit is marshaled to main thread`() {
        bridge.start()

        val writer = Thread {
            prefs.edit().putString(WebTokenBridge.KEY_AUTH_TOKEN, "thread-token").commit()
        }
        writer.start()
        writer.join()

        assertThat(lastJs()).isNull()

        idleMain()
        assertThat(lastJs()).contains("thread-token")
    }

    @Test
    fun `start and stop are idempotent and stop disables later injections`() {
        bridge.start()
        bridge.start()
        bridge.stop()

        prefs.edit().putString(WebTokenBridge.KEY_AUTH_TOKEN, "after-stop-token").commit()
        idleMain()

        assertThat(lastJs()).isNull()
    }

    @Test
    fun `stop before main looper idle drops pending injection`() {
        prefs.edit().putString(WebTokenBridge.KEY_AUTH_TOKEN, "pending-token").commit()

        bridge.injectNow()
        bridge.stop()
        idleMain()

        assertThat(lastJs()).isNull()
    }
}
