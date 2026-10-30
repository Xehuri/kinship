package com.xehuri.kinship

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.config.ServerConfig
import io.mockk.every
import io.mockk.mockk
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

/**
 * MobileActivity 与 WebTokenBridge 的接线测试（Robolectric 真实 Activity/WebView）。
 *
 * 覆盖：token 以 prefs 为准、onPageFinished 注入、prefs 续期注入、onResume 补注入、
 * retry/ignore 的抑制语义、destroy 注销监听。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MobileActivityTokenBridgeTest {

    private lateinit var context: Context
    private lateinit var prefs: SharedPreferences
    private lateinit var controller: ActivityController<MobileActivity>
    private lateinit var activity: MobileActivity
    private lateinit var webView: WebView
    private var destroyed = false

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        prefs = context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        context.getSharedPreferences("data_collector", Context.MODE_PRIVATE).edit().clear().commit()
        prefs.edit().putString("auth_token", "fresh-token").commit()
        ServerConfig.init(context)
        launch()
    }

    @After
    fun tearDown() {
        if (::controller.isInitialized && !destroyed) {
            controller.destroy()
            destroyed = true
        }
        prefs.edit().clear().commit()
        context.getSharedPreferences("data_collector", Context.MODE_PRIVATE).edit().clear().commit()
        ServerConfig.init(context)
    }

    private fun launch() {
        if (::controller.isInitialized && !destroyed) {
            controller.destroy()
        }
        val intent = Intent(context, MobileActivity::class.java).apply {
            putExtra("baseUrl", "https://unit.test:8768")
            putExtra("token", "stale-intent-token")
        }
        controller = Robolectric.buildActivity(MobileActivity::class.java, intent).setup()
        destroyed = false
        activity = controller.get()
        webView = activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView
    }

    private fun idleMain() {
        repeat(2) { shadowOf(Looper.getMainLooper()).idle() }
    }

    private fun lastJs(): String? = shadowOf(webView).lastEvaluatedJavascript

    private fun finishPage() {
        val shadow = shadowOf(webView)
        shadow.webViewClient.onPageFinished(webView, shadow.lastLoadedUrl)
        idleMain()
    }

    private fun request(urlString: String): WebResourceRequest = mockk {
        every { url } returns Uri.parse(urlString)
    }

    @Test
    fun `bootstrap url uses prefs token instead of intent extra`() {
        val url = shadowOf(webView).lastLoadedUrl

        assertThat(url).contains("token=fresh-token")
        assertThat(url).doesNotContain("stale-intent-token")
        assertThat(url).contains("client=web")
        assertThat(url).contains("tts_volume=")
    }

    @Test
    fun `bootstrap url omits token when prefs has no token`() {
        prefs.edit().remove("auth_token").commit()

        launch()
        val url = shadowOf(webView).lastLoadedUrl

        assertThat(url).doesNotContain("token=")
        assertThat(url).doesNotContain("stale-intent-token")
        assertThat(url).contains("client=web")
    }

    @Test
    fun `page finished injects current prefs token`() {
        finishPage()

        val js = lastJs()
        assertThat(js).isNotNull()
        assertThat(js).contains("fresh-token")
        assertThat(js).contains("axeuh-token-refresh")
    }

    @Test
    fun `prefs token renewal injects renewed token`() {
        finishPage()
        assertThat(lastJs()).contains("fresh-token")

        prefs.edit().putString("auth_token", "renewed-token").commit()
        idleMain()

        assertThat(lastJs()).contains("renewed-token")
    }

    @Test
    fun `resume re-injects after bridge was stopped`() {
        finishPage()

        activity.tokenBridge.stop()
        prefs.edit().putString("auth_token", "resumed-token").commit()
        idleMain()
        assertThat(lastJs()).doesNotContain("resumed-token")

        controller.pause().resume()
        idleMain()

        assertThat(lastJs()).contains("resumed-token")
    }

    @Test
    fun `retry reloads main url with current prefs token`() {
        val shadow = shadowOf(webView)

        shadow.webViewClient.shouldOverrideUrlLoading(webView, request("axeuh://retry"))

        assertThat(shadow.lastLoadedUrl).contains("token=fresh-token")
        assertThat(shadow.lastLoadedUrl).doesNotContain("stale-intent-token")
    }

    @Test
    fun `ignore suppresses injection until retry`() {
        val shadow = shadowOf(webView)

        shadow.webViewClient.shouldOverrideUrlLoading(webView, request("axeuh://ignore"))
        assertThat(shadow.lastLoadedUrl).doesNotContain("token=")

        prefs.edit().putString("auth_token", "suppressed-token").commit()
        idleMain()
        assertThat(lastJs().orEmpty()).doesNotContain("suppressed-token")

        shadow.webViewClient.onPageFinished(webView, shadow.lastLoadedUrl)
        idleMain()
        assertThat(lastJs().orEmpty()).doesNotContain("suppressed-token")

        shadow.webViewClient.shouldOverrideUrlLoading(webView, request("axeuh://retry"))
        assertThat(shadow.lastLoadedUrl).contains("token=suppressed-token")

        shadow.webViewClient.onPageFinished(webView, shadow.lastLoadedUrl)
        idleMain()
        assertThat(lastJs()).contains("suppressed-token")
    }

    @Test
    fun `destroy unregisters bridge so later prefs changes do not inject`() {
        finishPage()
        val before = lastJs()
        assertThat(before).contains("fresh-token")

        controller.destroy()
        destroyed = true

        prefs.edit().putString("auth_token", "after-destroy-token").commit()
        idleMain()

        assertThat(lastJs()).isEqualTo(before)
    }
}
