package com.xehuri.kinship.ui.theme

import android.graphics.Color as AndroidColor
import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * CSS-to-Kotlin 令牌奇偶校验：Kinship 设计令牌必须与 Web 端 tokens.css 逐值一致。
 *
 * 只读 tokens.css，不修改前端。Gradle 单测通常以 app/ 为工作目录，
 * 因此先试 frontend/...，再试 ../frontend/...。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class KinshipTokensTest {

    private val css: String by lazy { locateTokensCss().readText() }

    private val rootBlock: String by lazy {
        Regex(""":root\s*\{(.*?)\}""", RegexOption.DOT_MATCHES_ALL)
            .find(css)
            ?.groupValues
            ?.get(1)
            ?: throw AssertionError("tokens.css 中找不到 :root 块")
    }

    private val darkBlock: String by lazy {
        Regex("""\[data-theme="dark"\]\s*\{(.*?)\}""", RegexOption.DOT_MATCHES_ALL)
            .find(css)
            ?.groupValues
            ?.get(1)
            ?: throw AssertionError("tokens.css 中找不到 [data-theme=\"dark\"] 块")
    }

    @Test
    fun colorTokensMatchCssRoot() {
        val pairs = listOf(
            "bg" to KinshipColors.bg,
            "surface" to KinshipColors.surface,
            "surface-raised" to KinshipColors.surfaceRaised,
            "ink" to KinshipColors.ink,
            "muted" to KinshipColors.muted,
            "hairline" to KinshipColors.hairline,
            "accent" to KinshipColors.accent,
            "accent-ink" to KinshipColors.accentInk,
            "inset" to KinshipColors.inset,
            "danger" to KinshipColors.danger,
            "success" to KinshipColors.success,
            "warning" to KinshipColors.warning,
        )
        pairs.forEach { (name, actual) ->
            assertEquals("--$name 与 KinshipColors 不一致", cssColor(name), actual)
        }
    }

    @Test
    fun darkColorTokensMatchCss() {
        val pairs = listOf(
            "bg" to KinshipColors.darkBg,
            "surface" to KinshipColors.darkSurface,
            "surface-raised" to KinshipColors.darkSurfaceRaised,
            "ink" to KinshipColors.darkInk,
            "muted" to KinshipColors.darkMuted,
            "hairline" to KinshipColors.darkHairline,
            "accent" to KinshipColors.darkAccent,
            "accent-ink" to KinshipColors.darkAccentInk,
            "inset" to KinshipColors.darkInset,
            "danger" to KinshipColors.darkDanger,
            "success" to KinshipColors.darkSuccess,
            "warning" to KinshipColors.darkWarning,
        )
        pairs.forEach { (name, actual) ->
            assertEquals("深色 --$name 与 KinshipColors 不一致", darkColor(name), actual)
        }
    }

    @Test
    fun darkColorSchemeMapsWarmCharcoalRoles() {
        assertEquals(KinshipColors.darkBg, KinshipDarkColorScheme.background)
        assertEquals(KinshipColors.darkAccent, KinshipDarkColorScheme.primary)
        assertEquals(KinshipColors.darkInk, KinshipDarkColorScheme.onSurface)
        assertEquals(KinshipColors.darkInset, KinshipDarkColorScheme.surfaceVariant)
        assertEquals(KinshipColors.darkHairline, KinshipDarkColorScheme.outline)
        assertEquals(KinshipColors.darkDanger, KinshipDarkColorScheme.error)
    }

    @Test
    fun radiusTokensMatchCssRoot() {
        assertEquals("--radius", cssNumber("radius").dp, KinshipRadius.card)
        assertEquals("--radius-sm", cssNumber("radius-sm").dp, KinshipRadius.control)
    }

    @Test
    fun spacingTokensMatchCssRoot() {
        val pairs = listOf(
            "space-1" to KinshipSpacing.x1,
            "space-2" to KinshipSpacing.x2,
            "space-3" to KinshipSpacing.x3,
            "space-4" to KinshipSpacing.x4,
            "space-5" to KinshipSpacing.x5,
            "space-6" to KinshipSpacing.x6,
            "space-7" to KinshipSpacing.x7,
            "space-8" to KinshipSpacing.x8,
        )
        pairs.forEach { (name, actual) ->
            assertEquals("--$name", cssNumber(name).dp, actual)
        }
    }

    @Test
    fun motionTokensMatchCssRoot() {
        assertEquals("--motion-fast", cssNumber("motion-fast").toInt(), KinshipMotion.fast)
        assertEquals("--motion-slow", cssNumber("motion-slow").toInt(), KinshipMotion.slow)
    }

    @Test
    fun lightColorSchemeMapsWarmPaperRoles() {
        assertEquals(KinshipColors.accent, KinshipLightColorScheme.primary)
        assertEquals(KinshipColors.bg, KinshipLightColorScheme.background)
        assertEquals(KinshipColors.ink, KinshipLightColorScheme.onSurface)
        assertEquals(KinshipColors.inset, KinshipLightColorScheme.surfaceVariant)
        assertEquals(KinshipColors.hairline, KinshipLightColorScheme.outline)
        assertEquals(KinshipColors.danger, KinshipLightColorScheme.error)
    }

    @Test
    fun typeAndShapeScalesMatchContract() {
        assertEquals(17.sp, KinshipType.title.fontSize)
        assertEquals(16.sp, KinshipType.rowTitle.fontSize)
        assertEquals(CornerSize(8.dp), (KinshipShapes.medium as CornerBasedShape).topStart)
    }

    private fun cssValue(name: String): String {
        val match = Regex("""--$name\s*:\s*([^;]+);""").find(rootBlock)
            ?: throw AssertionError("tokens.css :root 中缺少 --$name")
        return match.groupValues[1].trim()
    }

    private fun cssColor(name: String): Color =
        Color(AndroidColor.parseColor(cssValue(name)))

    private fun darkValue(name: String): String {
        val match = Regex("""--$name\s*:\s*([^;]+);""").find(darkBlock)
            ?: throw AssertionError("tokens.css 深色块中缺少 --$name")
        return match.groupValues[1].trim()
    }

    private fun darkColor(name: String): Color =
        Color(AndroidColor.parseColor(darkValue(name)))

    private fun cssNumber(name: String): Float {
        val raw = cssValue(name)
        val match = Regex("""^-?\d+(?:\.\d+)?""").find(raw)
            ?: throw AssertionError("--$name 不是数值：$raw")
        return match.value.toFloat()
    }

    private fun locateTokensCss(): File {
        val candidates = listOf(
            File("frontend/mobile/src/styles/tokens.css"),
            File("../frontend/mobile/src/styles/tokens.css"),
        )
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError(
                "找不到 frontend/mobile/src/styles/tokens.css，已尝试：" +
                    candidates.joinToString { it.absolutePath } +
                    "（user.dir=${File(".").absolutePath}）"
            )
    }
}
