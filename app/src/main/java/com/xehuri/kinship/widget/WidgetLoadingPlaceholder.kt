package com.xehuri.kinship.widget

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.appwidget.background
import androidx.glance.appwidget.cornerRadius
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.text.Text
import androidx.glance.text.TextStyle

/**
 * 首帧守卫命中时产出的加载骨架（四卡 provideGlance 共用单实现）。
 *
 * 存在理由 = crash-audit.md（.sisyphus/reports/2026-10-13-r2/）修复 1
 * 「永不未 provideContent 就 return」：守卫命中若直接 return，runGlance 的 channelFlow
 * 零发射完成 → 组合树落 IgnoreResult（AppWidgetSession.kt:169）→ processEmittableTree
 * 返回 false → uiReady 永不 emit（SessionWorker.kt:230-233）→ worker 永挂在
 * uiReady.first（SessionWorker.kt:244），此后全部更新事件入队无人消费——首会话死锁。
 * 守卫命中时必须经 provideContent 产出本骨架：channelFlow 存活、uiReady 置真、
 * 会话进入 receiveEvents，尺寸就绪后的下一次 update 经事件重组为真实内容。
 *
 * 结构克隆自 WidgetDisabledPlaceholder（同底色、同圆角、居中灰字），仅文案换为
 * 加载提示；不加 clickable——骨架是瞬态，不给它挂交互通道。
 */
@Composable
fun WidgetLoadingPlaceholder() {
    Box(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(day = LoadingBackgroundDay, night = LoadingBackgroundNight)
            .cornerRadius(16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "正在准备卡片…",
            modifier = GlanceModifier.padding(horizontal = 12.dp),
            style = TextStyle(
                color = ColorProvider(day = LoadingTextGrayDay, night = LoadingTextGrayNight),
                fontSize = 12.sp,
            ),
            maxLines = 1,
        )
    }
}

// 骨架配色：底色/文字灰度沿用停用占位卡同一色板（白 / 深灰底 + 中间灰字，深浅色皆可读）
private val LoadingBackgroundDay = Color(0xFFFFFFFF)
private val LoadingBackgroundNight = Color(0xFF2B2930)
private val LoadingTextGrayDay = Color(0xFF49454F)
private val LoadingTextGrayNight = Color(0xFFCAC4D0)
