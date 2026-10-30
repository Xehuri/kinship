package com.xehuri.kinship

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.ColorDrawable
import android.view.ContextThemeWrapper
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.core.view.WindowCompat
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.ui.web.MobileChromeSpec
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

/**
 * MobileActivity 窗口 chrome 的 Robolectric 测试（SDK 34）。
 *
 * API 35/36 的 edge-to-edge 强制行为在 Robolectric 中不可信，列为待真机验收。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MobileActivityChromeTest {

    private var controller: ActivityController<MobileActivity>? = null

    @After
    fun tearDown() {
        controller?.destroy()
        controller = null
    }

    private fun launch(): Pair<MobileActivity, WebView> {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("data_collector", Context.MODE_PRIVATE).edit().clear().commit()
        ServerConfig.init(context)
        val intent = Intent(context, MobileActivity::class.java).apply {
            putExtra("baseUrl", "https://unit.test:8768")
        }
        val created = Robolectric.buildActivity(MobileActivity::class.java, intent).setup()
        controller = created
        val activity = created.get()
        val webView = activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView
        return activity to webView
    }

    private fun windowBackgroundColor(context: Context): Int {
        val themed = ContextThemeWrapper(context, R.style.Theme_KinshipWeb)
        val attrs = themed.obtainStyledAttributes(intArrayOf(android.R.attr.windowBackground))
        return try {
            (attrs.getDrawable(0) as ColorDrawable).color
        } finally {
            attrs.recycle()
        }
    }

    private fun webViewBackground(webView: WebView): Int =
        shadowOf(webView).backgroundColor

    private fun finishPage(activity: MobileActivity, webView: WebView) {
        val shadow = shadowOf(webView)
        shadow.webViewClient.onPageFinished(webView, shadow.lastLoadedUrl)
        ShadowLooper.idleMainLooper()
    }

    @Test
    fun `manifest assigns web theme to mobile activity only`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val info = context.packageManager.getActivityInfo(
            ComponentName(context, MobileActivity::class.java),
            0,
        )

        assertThat(info.themeResource).isEqualTo(R.style.Theme_KinshipWeb)
    }

    @Test
    fun `day theme resolves warm paper window background`() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        assertThat(windowBackgroundColor(context)).isEqualTo(0xFFF7F2E8.toInt())
        assertThat(context.resources.getColor(R.color.kinship_web_bg, context.theme))
            .isEqualTo(MobileChromeSpec.DAY_BACKGROUND)
        assertThat(context.resources.getBoolean(R.bool.kinship_web_light_bars)).isTrue()
    }

    @Test
    @Config(sdk = [34], qualifiers = "night")
    fun `night theme resolves warm charcoal window background`() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        assertThat(windowBackgroundColor(context)).isEqualTo(0xFF171512.toInt())
        assertThat(context.resources.getColor(R.color.kinship_web_bg, context.theme))
            .isEqualTo(MobileChromeSpec.NIGHT_BACKGROUND)
        assertThat(context.resources.getBoolean(R.bool.kinship_web_light_bars)).isFalse()
    }

    @Test
    fun `day launch paints status navigation and webview with paper color`() {
        val (activity, webView) = launch()

        assertThat(activity.window.statusBarColor).isEqualTo(MobileChromeSpec.DAY_BACKGROUND)
        assertThat(activity.window.navigationBarColor).isEqualTo(MobileChromeSpec.DAY_BACKGROUND)
        assertThat(webViewBackground(webView)).isEqualTo(MobileChromeSpec.DAY_BACKGROUND)
    }

    @Test
    @Config(sdk = [34], qualifiers = "night")
    fun `night launch paints status navigation and webview with charcoal color`() {
        val (activity, webView) = launch()

        assertThat(activity.window.statusBarColor).isEqualTo(MobileChromeSpec.NIGHT_BACKGROUND)
        assertThat(activity.window.navigationBarColor).isEqualTo(MobileChromeSpec.NIGHT_BACKGROUND)
        assertThat(webViewBackground(webView)).isEqualTo(MobileChromeSpec.NIGHT_BACKGROUND)
    }

    @Test
    fun `day launch requests dark system icons and disables nav bar contrast`() {
        val (activity, _) = launch()
        val insets = WindowCompat.getInsetsController(activity.window, activity.window.decorView)

        assertThat(insets.isAppearanceLightStatusBars).isTrue()
        assertThat(insets.isAppearanceLightNavigationBars).isTrue()
        assertThat(activity.window.isNavigationBarContrastEnforced).isFalse()
    }

    @Test
    @Config(sdk = [34], qualifiers = "night")
    fun `night launch requests light system icons`() {
        val (activity, _) = launch()
        val insets = WindowCompat.getInsetsController(activity.window, activity.window.decorView)

        assertThat(insets.isAppearanceLightStatusBars).isFalse()
        assertThat(insets.isAppearanceLightNavigationBars).isFalse()
    }

    @Test
    fun `api 34 launch extends into display cutout`() {
        val (activity, _) = launch()

        assertThat(activity.window.attributes.layoutInDisplayCutoutMode)
            .isEqualTo(WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS)
    }

    @Test
    fun `page finished asks spa for its theme`() {
        val (activity, webView) = launch()

        finishPage(activity, webView)

        assertThat(shadowOf(webView).lastEvaluatedJavascript).contains("dataset.theme")
    }

    @Test
    fun `page finished installs live theme observer`() {
        val (activity, webView) = launch()

        finishPage(activity, webView)

        assertThat(shadowOf(webView).lastEvaluatedJavascript).contains("MutationObserver")
        assertThat(shadowOf(webView).lastEvaluatedJavascript).contains("AxeuhTheme")
    }

    @Test
    fun `error page does not query web theme`() {
        val (_, webView) = launch()
        val shadow = shadowOf(webView)

        shadow.webViewClient.onPageFinished(
            webView,
            "file:///android_asset/error_page.html?code=-2",
        )

        assertThat(shadow.lastEvaluatedJavascript).doesNotContain("dataset.theme")
    }

    @Test
    fun `page finished keeps chrome when web theme is unavailable`() {
        val (activity, webView) = launch()

        finishPage(activity, webView)

        assertThat(activity.window.statusBarColor).isEqualTo(MobileChromeSpec.DAY_BACKGROUND)
        assertThat(webViewBackground(webView)).isEqualTo(MobileChromeSpec.DAY_BACKGROUND)
    }
}
