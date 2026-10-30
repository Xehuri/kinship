package com.xehuri.kinship.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.background
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.xehuri.kinship.MainActivity
import com.xehuri.kinship.service.DataCollectorService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * HeartRateMiniWidget - 2x1 心率单指标卡（桌面组件 demo 第一波，纯展示形态）
 *
 * 与 [HealthSummaryWidget] 共用 [WidgetSnapshot] 数据桥：写侧在 DataCollectorService 主循环，
 * 本组件只读落盘快照并渲染心率数值 + 小字"更新于"，整卡点击打开 MainActivity。
 */
class HeartRateMiniWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // HyperOS 首帧守卫：尺寸未就绪时本轮不组合真实内容，但必须经 provideContent 产出
        // 加载骨架再 return——空 return 会让 channelFlow 零发射完成 → IgnoreResult
        // （AppWidgetSession.kt:169）→ uiReady 永不 emit、worker 永挂（SessionWorker.kt:230-233,
        // :244），首会话死锁后所有更新入队无人消费（旧"空 RemoteViews"假说已被 crash-audit.md 证伪；
        // 机制与 glance 1.2.0 API 考证见 AiNotifyWidget.kt 的 isWidgetSizeNotReady）
        if (isWidgetSizeNotReady(context, id)) {
            provideContent { WidgetLoadingPlaceholder() }
            return
        }
        // widgets_enabled 总开关与快照读取同走 IO：停用即渲染占位卡，跳过快照取数
        val snapshot = withContext(Dispatchers.IO) {
            if (DataCollectorService.isWidgetsEnabled(context)) WidgetSnapshot.readView(context) else null
        }
        provideContent {
            if (snapshot == null) {
                WidgetDisabledPlaceholder()
            } else {
                HeartRateMiniContent(heartRate = snapshot.heartRate, updatedText = snapshot.updatedText)
            }
        }
    }
}

/** 小卡内容：左侧大字心率，右侧小字更新时间 */
@Composable
private fun HeartRateMiniContent(heartRate: Int, updatedText: String) {
    Box(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(day = MiniBackgroundDay, night = MiniBackgroundNight)
            .cornerRadius(12.dp)
            .clickable(actionStartActivity<MainActivity>()),
    ) {
        Row(
            modifier = GlanceModifier.padding(horizontal = 10.dp, vertical = 6.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = GlanceModifier.defaultWeight()) {
                Text(
                    text = "心率 (bpm)",
                    style = TextStyle(
                        color = ColorProvider(day = MiniSecondaryDay, night = MiniSecondaryNight),
                        fontSize = 9.sp,
                    ),
                    maxLines = 1,
                )
                Text(
                    text = if (heartRate < 0) "--" else heartRate.toString(),
                    style = TextStyle(
                        color = ColorProvider(day = MiniPrimaryDay, night = MiniPrimaryNight),
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                    ),
                    maxLines = 1,
                )
            }
            Text(
                text = updatedText,
                style = TextStyle(
                    color = ColorProvider(day = MiniSecondaryDay, night = MiniSecondaryNight),
                    fontSize = 9.sp,
                ),
                maxLines = 1,
            )
        }
    }
}

// 卡片配色：深浅色各一套（与聚合卡同色板；widget 由 launcher 环境渲染，双值防止深色模式刺眼）
private val MiniBackgroundDay = Color(0xFFFFFFFF)
private val MiniBackgroundNight = Color(0xFF2B2930)
private val MiniPrimaryDay = Color(0xFF1D1B20)
private val MiniPrimaryNight = Color(0xFFE6E1E5)
private val MiniSecondaryDay = Color(0xFF49454F)
private val MiniSecondaryNight = Color(0xFFCAC4D0)

/** 组件注册 receiver：系统定向投递 APPWIDGET_UPDATE（官方样例 exported=false，见研究报告 §2.4） */
class HeartRateMiniWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = HeartRateMiniWidget()
}
