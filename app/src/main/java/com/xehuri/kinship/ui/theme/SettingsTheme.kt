package com.xehuri.kinship.ui.theme

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.tween
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp

/**
 * 设置页间距令牌，全部委托 [KinshipSpacing]（4dp 基准栅格）。
 *
 * 新增 Settings UI 组件一律引用这些令牌，避免出现随手写的 13px / 7dp 之类魔数。
 */
object SettingsSpacing {
    val xs: Dp = KinshipSpacing.x1
    val sm: Dp = KinshipSpacing.x2
    val md: Dp = KinshipSpacing.x3
    val lg: Dp = KinshipSpacing.x4
    val xl: Dp = KinshipSpacing.x5

    /** 可点击行的最小点击区域高度 */
    val tapTarget: Dp = 48.dp
}

/** 设置页圆角令牌，委托 [KinshipRadius]。 */
object SettingsShape {
    val card: Dp = KinshipRadius.card
}

/**
 * 设置页统一动画令牌：短时长 + 标准缓动，让页面转场干脆利落。
 *
 * 时长取 [KinshipMotion.slow]（180ms），与 Web 端 --motion-slow 一致。
 * 需要统一调速时只改令牌一处。
 */
object SettingsAnim {
    const val DURATION_MS = KinshipMotion.slow

    /** 位移动画规格（NavHost 子页面转场） */
    val slideSpec: FiniteAnimationSpec<IntOffset> =
        tween(durationMillis = DURATION_MS, easing = FastOutSlowInEasing)
}

/**
 * 设置页主题：接线 Kinship 设计令牌，跟随系统明暗切换。
 *
 * 不提供动态取色。
 */
@Composable
fun AxeuhSettingsTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) KinshipDarkColorScheme else KinshipLightColorScheme,
        typography = KinshipTypography,
        shapes = KinshipShapes,
        content = content
    )
}
