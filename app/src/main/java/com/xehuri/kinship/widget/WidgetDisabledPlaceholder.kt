package com.xehuri.kinship.widget

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.background
import androidx.glance.appwidget.cornerRadius
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.xehuri.kinship.MainActivity

/**
 * 桌面组件总开关停用态的占位卡（三卡 provideGlance 共用单实现）。
 *
 * 与启用态同底色、同点击去向（MainActivity），仅内容换为灰色 12sp 停用提示两行；
 * 停用时不读快照数据——写入端已停更，读了也只是陈旧值，占位文案才是诚实状态。
 */
@Composable
fun WidgetDisabledPlaceholder() {
    Box(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(day = DisabledBackgroundDay, night = DisabledBackgroundNight)
            .cornerRadius(16.dp)
            .clickable(actionStartActivity<MainActivity>()),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "桌面组件已停用\n可在 设置 → 桌面组件 重新开启",
            modifier = GlanceModifier.padding(horizontal = 12.dp),
            style = TextStyle(
                color = ColorProvider(day = DisabledTextGrayDay, night = DisabledTextGrayNight),
                fontSize = 12.sp,
            ),
            maxLines = 2,
        )
    }
}

// 占位卡配色：底色沿用三卡共用色板（白 / 深灰），文字取中间灰保证深浅色下都可读
private val DisabledBackgroundDay = Color(0xFFFFFFFF)
private val DisabledBackgroundNight = Color(0xFF2B2930)
private val DisabledTextGrayDay = Color(0xFF49454F)
private val DisabledTextGrayNight = Color(0xFFCAC4D0)
