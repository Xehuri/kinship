package com.xehuri.kinship.ui.web

/**
 * MobileActivity 窗口 chrome 的纯计算规格。
 *
 * 不依赖 Android 框架，便于 JVM 单测；颜色值与 `res/values/themes.xml` 及
 * `res/values-night/themes.xml` 的 `kinship_web_bg` 保持一致（Robolectric 资源测试会校验两者不漂移）。
 */
object MobileChromeSpec {

    /** 浅色 Web 主题的暖纸底色，与 `tokens.css` 的 `--bg` 对齐。 */
    const val DAY_BACKGROUND: Int = 0xFFF7F2E8.toInt()

    /** 深色 Web 主题的暖炭底色，与 `tokens.css` 的 dark `--bg` 对齐。 */
    const val NIGHT_BACKGROUND: Int = 0xFF171512.toInt()

    private const val API_O = 26
    private const val API_P = 28
    private const val API_Q = 29
    private const val API_R = 30

    /** 页面实际主题。 */
    enum class WebTheme { DAY, NIGHT }

    /**
     * 窗口 chrome 的解析结果。
     *
     * `lightStatusBars` / `lightNavigationBars` 直接对应
     * `WindowInsetsControllerCompat.isAppearanceLight*`：true = 深色图标（浅色底）。
     */
    data class Chrome(
        val windowBackgroundArgb: Int,
        val statusBarArgb: Int,
        val navigationBarArgb: Int,
        val lightStatusBars: Boolean,
        val lightNavigationBars: Boolean,
        val navigationBarContrastEnforced: Boolean,
    )

    /** 与 API 级别相关的窗口能力。 */
    data class ApiPolicy(
        /** 主题属性 `android:windowLightNavigationBar` 自 API 27 起可用。 */
        val themeSupportsLightNavigationBar: Boolean,
        /** 系统 UI 标志 `LIGHT_NAVIGATION_BAR` 自 API 26 起可用。 */
        val supportsDarkNavigationIcons: Boolean,
        /** API 28+ 可以声明刘海短边布局。 */
        val cutoutShortEdges: Boolean,
        /** API 30+ 可以要求内容进入刘海区。 */
        val cutoutAlways: Boolean,
        /** API 29+ 支持 `isNavigationBarContrastEnforced`。 */
        val supportsNavigationBarContrastSwitch: Boolean,
    )

    fun forNight(isNight: Boolean): Chrome = if (isNight) nightChrome() else dayChrome()

    fun apiPolicy(apiLevel: Int): ApiPolicy = ApiPolicy(
        themeSupportsLightNavigationBar = apiLevel >= 27,
        supportsDarkNavigationIcons = apiLevel >= API_O,
        cutoutShortEdges = apiLevel >= API_P,
        cutoutAlways = apiLevel >= API_R,
        supportsNavigationBarContrastSwitch = apiLevel >= API_Q,
    )

    /**
     * 按主题与 API 级别解析窗口 chrome。
     *
     * API 26 没有 `android:windowLightNavigationBar` 主题属性，部分 ROM 也不识别深色
     * 导航图标，故白天主题回退为深色导航栏 + 浅色图标（暗色导航栏兜底），避免
     * 白色图标叠在暖纸底色上不可见。
     */
    fun resolve(theme: WebTheme, apiLevel: Int): Chrome {
        val base = when (theme) {
            WebTheme.DAY -> dayChrome()
            WebTheme.NIGHT -> nightChrome()
        }
        return if (apiLevel < 27 && theme == WebTheme.DAY) {
            base.copy(
                navigationBarArgb = NIGHT_BACKGROUND,
                lightNavigationBars = false,
            )
        } else {
            base
        }
    }

    fun resolve(isNight: Boolean, apiLevel: Int): Chrome =
        resolve(if (isNight) WebTheme.NIGHT else WebTheme.DAY, apiLevel)

    /** 解析 SPA 注入的 `<html data-theme>`；`evaluateJavascript` 返回带引号的 JSON 字符串。 */
    fun fromDatasetTheme(raw: String?): WebTheme? = when (raw?.trim()?.trim('"')?.lowercase()) {
        "dark" -> WebTheme.NIGHT
        "light" -> WebTheme.DAY
        else -> null
    }

    private fun dayChrome() = Chrome(
        windowBackgroundArgb = DAY_BACKGROUND,
        statusBarArgb = DAY_BACKGROUND,
        navigationBarArgb = DAY_BACKGROUND,
        lightStatusBars = true,
        lightNavigationBars = true,
        navigationBarContrastEnforced = false,
    )

    private fun nightChrome() = Chrome(
        windowBackgroundArgb = NIGHT_BACKGROUND,
        statusBarArgb = NIGHT_BACKGROUND,
        navigationBarArgb = NIGHT_BACKGROUND,
        lightStatusBars = false,
        lightNavigationBars = false,
        navigationBarContrastEnforced = false,
    )
}
