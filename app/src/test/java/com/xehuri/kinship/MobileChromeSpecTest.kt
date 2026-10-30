package com.xehuri.kinship

import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.ui.web.MobileChromeSpec
import org.junit.Test

/**
 * MobileChromeSpec 纯 JVM 测试：颜色取值、图标明暗、API 分支与网页主题解析。
 */
class MobileChromeSpecTest {

    @Test
    fun `day chrome uses warm paper background with dark system icons`() {
        val chrome = MobileChromeSpec.resolve(isNight = false, apiLevel = 34)

        assertThat(chrome.windowBackgroundArgb).isEqualTo(0xFFF7F2E8.toInt())
        assertThat(chrome.statusBarArgb).isEqualTo(0xFFF7F2E8.toInt())
        assertThat(chrome.navigationBarArgb).isEqualTo(0xFFF7F2E8.toInt())
        assertThat(chrome.lightStatusBars).isTrue()
        assertThat(chrome.lightNavigationBars).isTrue()
    }

    @Test
    fun `night chrome uses warm charcoal background with light system icons`() {
        val chrome = MobileChromeSpec.resolve(isNight = true, apiLevel = 34)

        assertThat(chrome.windowBackgroundArgb).isEqualTo(0xFF171512.toInt())
        assertThat(chrome.statusBarArgb).isEqualTo(0xFF171512.toInt())
        assertThat(chrome.navigationBarArgb).isEqualTo(0xFF171512.toInt())
        assertThat(chrome.lightStatusBars).isFalse()
        assertThat(chrome.lightNavigationBars).isFalse()
    }

    @Test
    fun `navigation bar contrast is never enforced so bar matches page`() {
        assertThat(MobileChromeSpec.resolve(isNight = false, apiLevel = 34).navigationBarContrastEnforced)
            .isFalse()
        assertThat(MobileChromeSpec.resolve(isNight = true, apiLevel = 34).navigationBarContrastEnforced)
            .isFalse()
    }

    @Test
    fun `api 26 day theme falls back to dark navigation bar with light icons`() {
        val chrome = MobileChromeSpec.resolve(isNight = false, apiLevel = 26)

        assertThat(chrome.statusBarArgb).isEqualTo(MobileChromeSpec.DAY_BACKGROUND)
        assertThat(chrome.lightStatusBars).isTrue()
        assertThat(chrome.navigationBarArgb).isEqualTo(MobileChromeSpec.NIGHT_BACKGROUND)
        assertThat(chrome.lightNavigationBars).isFalse()
    }

    @Test
    fun `api 27 day theme keeps warm navigation bar with dark icons`() {
        val chrome = MobileChromeSpec.resolve(isNight = false, apiLevel = 27)

        assertThat(chrome.navigationBarArgb).isEqualTo(MobileChromeSpec.DAY_BACKGROUND)
        assertThat(chrome.lightNavigationBars).isTrue()
    }

    @Test
    fun `night theme is unchanged by the api 26 fallback`() {
        val chrome = MobileChromeSpec.resolve(isNight = true, apiLevel = 26)

        assertThat(chrome.navigationBarArgb).isEqualTo(MobileChromeSpec.NIGHT_BACKGROUND)
        assertThat(chrome.lightNavigationBars).isFalse()
    }

    @Test
    fun `light navigation bar theme attribute requires api 27`() {
        assertThat(MobileChromeSpec.apiPolicy(26).themeSupportsLightNavigationBar).isFalse()
        assertThat(MobileChromeSpec.apiPolicy(27).themeSupportsLightNavigationBar).isTrue()
    }

    @Test
    fun `dark navigation icons are supported from api 26`() {
        assertThat(MobileChromeSpec.apiPolicy(26).supportsDarkNavigationIcons).isTrue()
    }

    @Test
    fun `cutout handling starts at api 28 and always mode at api 30`() {
        assertThat(MobileChromeSpec.apiPolicy(27).cutoutShortEdges).isFalse()
        assertThat(MobileChromeSpec.apiPolicy(28).cutoutShortEdges).isTrue()
        assertThat(MobileChromeSpec.apiPolicy(29).cutoutAlways).isFalse()
        assertThat(MobileChromeSpec.apiPolicy(30).cutoutAlways).isTrue()
    }

    @Test
    fun `navigation bar contrast switch starts at api 29`() {
        assertThat(MobileChromeSpec.apiPolicy(28).supportsNavigationBarContrastSwitch).isFalse()
        assertThat(MobileChromeSpec.apiPolicy(29).supportsNavigationBarContrastSwitch).isTrue()
    }

    @Test
    fun `dataset theme parses quoted and plain values`() {
        assertThat(MobileChromeSpec.fromDatasetTheme("\"dark\"")).isEqualTo(MobileChromeSpec.WebTheme.NIGHT)
        assertThat(MobileChromeSpec.fromDatasetTheme("light")).isEqualTo(MobileChromeSpec.WebTheme.DAY)
        assertThat(MobileChromeSpec.fromDatasetTheme("  \"light\"  ")).isEqualTo(MobileChromeSpec.WebTheme.DAY)
    }

    @Test
    fun `dataset theme ignores missing or unknown values`() {
        assertThat(MobileChromeSpec.fromDatasetTheme(null)).isNull()
        assertThat(MobileChromeSpec.fromDatasetTheme("")).isNull()
        assertThat(MobileChromeSpec.fromDatasetTheme("\"system\"")).isNull()
        assertThat(MobileChromeSpec.fromDatasetTheme("null")).isNull()
    }

    @Test
    fun `web theme resolves to its chrome`() {
        assertThat(MobileChromeSpec.resolve(MobileChromeSpec.WebTheme.DAY, 34).windowBackgroundArgb)
            .isEqualTo(MobileChromeSpec.DAY_BACKGROUND)
        assertThat(MobileChromeSpec.resolve(MobileChromeSpec.WebTheme.NIGHT, 34).windowBackgroundArgb)
            .isEqualTo(MobileChromeSpec.NIGHT_BACKGROUND)
    }
}
