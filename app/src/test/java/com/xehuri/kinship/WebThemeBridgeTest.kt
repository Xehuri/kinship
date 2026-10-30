package com.xehuri.kinship

import android.os.Handler
import android.os.Looper
import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.ui.web.MobileChromeSpec
import com.xehuri.kinship.web.WebThemeBridge
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * WebThemeBridge 单元测试（Robolectric 主线程 Handler）。
 *
 * 覆盖：不可信 URL 拒绝、非法主题拒绝、light/dark 解析并回主线程、
 * 观察器脚本契约、stop() 丢弃挂起回调。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WebThemeBridgeTest {

    private lateinit var themes: MutableList<MobileChromeSpec.WebTheme>
    private lateinit var deliveredOnMainThread: MutableList<Boolean>
    private var trusted = true

    @Before
    fun setUp() {
        themes = mutableListOf()
        deliveredOnMainThread = mutableListOf()
        trusted = true
    }

    private fun bridge(): WebThemeBridge = WebThemeBridge(
        isTrustedUrl = { trusted },
        onTheme = {
            themes += it
            deliveredOnMainThread += Looper.myLooper() == Looper.getMainLooper()
        },
        mainHandler = Handler(Looper.getMainLooper()),
    )

    private fun idleMain() {
        repeat(2) { shadowOf(Looper.getMainLooper()).idle() }
    }

    @Test
    fun `untrusted url is ignored`() {
        trusted = false
        val bridge = bridge()

        bridge.onThemeChanged("dark")
        idleMain()

        assertThat(themes).isEmpty()
    }

    @Test
    fun `invalid or blank theme is ignored`() {
        val bridge = bridge()

        bridge.onThemeChanged(null)
        bridge.onThemeChanged("")
        bridge.onThemeChanged("   ")
        bridge.onThemeChanged("system")
        bridge.onThemeChanged("sepia")
        idleMain()

        assertThat(themes).isEmpty()
    }

    @Test
    fun `light theme is parsed and delivered on main thread`() {
        val bridge = bridge()

        bridge.onThemeChanged("light")
        idleMain()

        assertThat(themes).containsExactly(MobileChromeSpec.WebTheme.DAY)
        assertThat(deliveredOnMainThread).containsExactly(true)
    }

    @Test
    fun `dark theme accepts quoted dataset value`() {
        val bridge = bridge()

        bridge.onThemeChanged("\"dark\"")
        idleMain()

        assertThat(themes).containsExactly(MobileChromeSpec.WebTheme.NIGHT)
        assertThat(deliveredOnMainThread).containsExactly(true)
    }

    @Test
    fun `stop drops pending theme delivery`() {
        val bridge = bridge()

        bridge.onThemeChanged("dark")
        bridge.stop()
        idleMain()

        assertThat(themes).isEmpty()
    }

    @Test
    fun `observer script watches data-theme and reports through bridge`() {
        val script = bridge().observerScript()

        assertThat(script).contains("window.__axeuhThemeObserver")
        assertThat(script).contains("MutationObserver")
        assertThat(script).contains("data-theme")
        assertThat(script).contains("${WebThemeBridge.INTERFACE_NAME}.onThemeChanged")
        assertThat(script).contains("root.dataset.theme")
    }
}
