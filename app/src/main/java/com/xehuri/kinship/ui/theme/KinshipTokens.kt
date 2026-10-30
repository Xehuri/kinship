package com.xehuri.kinship.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Kinship 设计令牌，与 frontend/mobile/src/styles/tokens.css 保持逐值一致。
 *
 * 颜色、间距、圆角、动效与字号是 Web 端与原生端共用的契约，改动必须同步两端。
 * 浅色与深色方案均由同一组常量派生，跟随系统明暗切换。
 */
object KinshipColors {
    // 浅色（生产生效）
    val bg = Color(0xFFF7F2E8)
    val surface = Color(0xFFFCF8F0)
    val surfaceRaised = Color(0xFFFFFAF1)
    val ink = Color(0xFF1F1C18)
    val muted = Color(0xFF6F685D)
    val hairline = Color(0xFFDDD5C7)
    val accent = Color(0xFFA34B2B)
    val accentInk = Color(0xFFFFFAF1)
    val inset = Color(0xFFEFE8DB)
    val danger = Color(0xFF9B3A2E)
    val success = Color(0xFF3F6B4F)
    val warning = Color(0xFF8A5A1F)

    // 强调色预设（浅色）
    val jade = Color(0xFF2F6B52)
    val indigo = Color(0xFF3F4C8A)
    val rose = Color(0xFF9B3F5E)

    /** danger 以 10% 混入 surface 的柔和底，仅用于 errorContainer。 */
    val dangerSoft = Color(0xFFF2E5DD)

    /** danger 以 10% 混入 darkSurface 的柔和底，仅用于 errorContainer。 */
    val darkDangerSoft = Color(0xFF312621)

    // 深色
    val darkBg = Color(0xFF171512)
    val darkSurface = Color(0xFF1E1B17)
    val darkSurfaceRaised = Color(0xFF24201B)
    val darkInk = Color(0xFFEEE8DC)
    val darkMuted = Color(0xFFA29A8C)
    val darkHairline = Color(0xFF332E27)
    val darkAccent = Color(0xFFD07A52)
    val darkAccentInk = Color(0xFF171512)
    val darkInset = Color(0xFF211D18)
    val darkDanger = Color(0xFFD98A7A)
    val darkSuccess = Color(0xFF8FB49A)
    val darkWarning = Color(0xFFD3A15F)
    val darkJade = Color(0xFF7FB79A)
    val darkIndigo = Color(0xFF9AA7E0)
    val darkRose = Color(0xFFDFA0B4)
}

/** 4dp 基准间距栅格，对应 tokens.css 的 --space-1..8。 */
object KinshipSpacing {
    val x1: Dp = 4.dp
    val x2: Dp = 8.dp
    val x3: Dp = 12.dp
    val x4: Dp = 16.dp
    val x5: Dp = 24.dp
    val x6: Dp = 32.dp
    val x7: Dp = 48.dp
    val x8: Dp = 64.dp
}

/** 圆角令牌，对应 tokens.css 的 --radius / --radius-sm。 */
object KinshipRadius {
    val card: Dp = 8.dp
    val control: Dp = 6.dp
}

/** 动效时长（毫秒），对应 tokens.css 的 --motion-fast / --motion-slow。 */
object KinshipMotion {
    const val fast = 120
    const val slow = 180
}

/** 字号角色，仅使用系统字体，不打包任何字体文件。 */
object KinshipType {
    private val serif = FontFamily.Serif
    private val sans = FontFamily.SansSerif
    private val monoFamily = FontFamily.Monospace

    val display = TextStyle(
        fontFamily = serif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 24.sp,
        lineHeight = 32.sp,
    )

    val title = TextStyle(
        fontFamily = serif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 17.sp,
        lineHeight = 24.sp,
    )

    val rowTitle = TextStyle(
        fontFamily = sans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    )

    val body = TextStyle(
        fontFamily = sans,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    )

    val caption = TextStyle(
        fontFamily = sans,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 17.sp,
    )

    val micro = TextStyle(
        fontFamily = sans,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 15.sp,
    )

    val mono = TextStyle(
        fontFamily = monoFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 17.sp,
    )
}

/** 浅色 Material3 方案：全部由 KinshipColors 派生，不引入动态取色。 */
val KinshipLightColorScheme: ColorScheme = lightColorScheme(
    primary = KinshipColors.accent,
    onPrimary = KinshipColors.accentInk,
    primaryContainer = KinshipColors.inset,
    onPrimaryContainer = KinshipColors.ink,
    secondary = KinshipColors.success,
    onSecondary = Color.White,
    secondaryContainer = KinshipColors.inset,
    onSecondaryContainer = KinshipColors.ink,
    tertiary = KinshipColors.warning,
    onTertiary = Color.White,
    background = KinshipColors.bg,
    onBackground = KinshipColors.ink,
    surface = KinshipColors.surface,
    onSurface = KinshipColors.ink,
    surfaceVariant = KinshipColors.inset,
    onSurfaceVariant = KinshipColors.muted,
    outline = KinshipColors.hairline,
    outlineVariant = KinshipColors.hairline,
    error = KinshipColors.danger,
    onError = Color.White,
    errorContainer = KinshipColors.dangerSoft,
    onErrorContainer = KinshipColors.danger,
    inverseSurface = KinshipColors.ink,
    inverseOnSurface = KinshipColors.bg,
    scrim = Color.Black,
    surfaceBright = KinshipColors.surfaceRaised,
    surfaceDim = KinshipColors.inset,
    surfaceContainer = KinshipColors.surface,
    surfaceContainerHigh = KinshipColors.surfaceRaised,
    surfaceContainerHighest = KinshipColors.surfaceRaised,
    surfaceContainerLow = KinshipColors.bg,
    surfaceContainerLowest = KinshipColors.surface,
)

/** 深色 Material3 方案：与 tokens.css 的 [data-theme="dark"] 块逐值对应。 */
val KinshipDarkColorScheme: ColorScheme = darkColorScheme(
    primary = KinshipColors.darkAccent,
    onPrimary = KinshipColors.darkAccentInk,
    primaryContainer = KinshipColors.darkInset,
    onPrimaryContainer = KinshipColors.darkInk,
    secondary = KinshipColors.darkSuccess,
    onSecondary = KinshipColors.darkBg,
    secondaryContainer = KinshipColors.darkInset,
    onSecondaryContainer = KinshipColors.darkInk,
    tertiary = KinshipColors.darkWarning,
    onTertiary = KinshipColors.darkBg,
    background = KinshipColors.darkBg,
    onBackground = KinshipColors.darkInk,
    surface = KinshipColors.darkSurface,
    onSurface = KinshipColors.darkInk,
    surfaceVariant = KinshipColors.darkInset,
    onSurfaceVariant = KinshipColors.darkMuted,
    outline = KinshipColors.darkHairline,
    outlineVariant = KinshipColors.darkHairline,
    error = KinshipColors.darkDanger,
    onError = KinshipColors.darkBg,
    errorContainer = KinshipColors.darkDangerSoft,
    onErrorContainer = KinshipColors.darkDanger,
    inverseSurface = KinshipColors.darkInk,
    inverseOnSurface = KinshipColors.darkBg,
    scrim = Color.Black,
    surfaceBright = KinshipColors.darkSurfaceRaised,
    surfaceDim = KinshipColors.darkInset,
    surfaceContainer = KinshipColors.darkSurface,
    surfaceContainerHigh = KinshipColors.darkSurfaceRaised,
    surfaceContainerHighest = KinshipColors.darkSurfaceRaised,
    surfaceContainerLow = KinshipColors.darkBg,
    surfaceContainerLowest = KinshipColors.darkSurface,
)

/** Material3 排版映射；未列出的角色保留 Material3 默认值。 */
val KinshipTypography: Typography = Typography(
    displaySmall = KinshipType.display,
    titleLarge = KinshipType.title,
    titleMedium = KinshipType.rowTitle,
    titleSmall = KinshipType.body.copy(fontWeight = FontWeight.Medium),
    bodyLarge = KinshipType.body.copy(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = KinshipType.body,
    bodySmall = KinshipType.caption,
    labelLarge = KinshipType.body.copy(fontWeight = FontWeight.Medium),
    labelMedium = KinshipType.caption.copy(fontWeight = FontWeight.Medium),
    labelSmall = KinshipType.micro,
)

/** Material3 形状映射。 */
val KinshipShapes: Shapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(KinshipRadius.control),
    medium = RoundedCornerShape(KinshipRadius.card),
    large = RoundedCornerShape(8.dp),
    extraLarge = RoundedCornerShape(12.dp),
)
