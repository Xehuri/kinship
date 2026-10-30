package com.xehuri.kinship.widget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.background
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
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
 * HealthSummaryWidget - 4x2 健康聚合卡（桌面组件 demo 第一波 + 采集切换胶囊）
 *
 * 数据链路（docs/archive/research/research-android-widget-2026-10-12.md §5 首选方案）：
 * DataCollectorService.updateSnapshot() 每轮写 [WidgetSnapshot] prefs -> 显式 updateAll 直更；
 * 组合只活约 45 秒，外部数据变化不会自动重放，冷启动渲染同样只读落盘快照。
 *
 * 交互：标题行右端一枚「开始/停止」胶囊（[CollectionToggleActionCallback]），
 * 复刻设置页总开关的 prefs 写 + 服务启停机制，让采集开关无需进 App 即可切换。
 *
 * 注意：Glance 与 Jetpack Compose UI 零互操作，此处 Text/Column 等均为 androidx.glance 系。
 */
class HealthSummaryWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // HyperOS 首帧守卫：钉选瞬间尺寸未就绪（options 里 MIN_WIDTH 缺省 0）时本轮不组合真实内容，
        // 但**必须经 provideContent 产出加载骨架再 return**——空 return 会让 runGlance 的
        // channelFlow 零发射完成 → IgnoreResult（AppWidgetSession.kt:169）→ uiReady 永不 emit
        // （SessionWorker.kt:230-233）→ worker 永挂（SessionWorker.kt:244），首会话就此死锁、
        // 之后所有 update 入队无人消费（旧注释"产出空 RemoteViews 致桌面重启"系 1.1.1 时代假说，
        // 已被 crash-audit.md 证伪，机制与 glance 1.2.0 API 考证见 AiNotifyWidget.kt 的 isWidgetSizeNotReady）
        if (isWidgetSizeNotReady(context, id)) {
            provideContent { WidgetLoadingPlaceholder() }
            return
        }
        // prefs 读取走 IO 线程；取数在组合之外完成（组合内不做阻塞 IO）。
        // widgets_enabled 总开关同处读取：停用即渲染占位卡，跳过快照取数。
        val snapshot = withContext(Dispatchers.IO) {
            if (DataCollectorService.isWidgetsEnabled(context)) WidgetSnapshot.readView(context) else null
        }
        provideContent {
            if (snapshot == null) {
                WidgetDisabledPlaceholder()
            } else {
                HealthSummaryContent(
                    heartRate = snapshot.heartRate,
                    steps = snapshot.steps,
                    collecting = snapshot.collecting,
                    updatedText = snapshot.updatedText,
                    // configureActivity 配置档位：hr_only 时步数列隐藏，缺省 full 双指标
                    showSteps = snapshot.summaryMode != WidgetSnapshot.MODE_HR_ONLY,
                )
            }
        }
    }
}

/**
 * 聚合卡内容：标题行（"健康概览" + 采集切换胶囊）+ 心率/步数双列指标（可经配置页收为仅心率）
 * + 底部"采集状态 · 更新于 HH:mm"。
 * 整卡点击打开 MainActivity；胶囊自身的 clickable 优先于整卡点击通道（Glance 子视图点击
 * 各挂各的 PendingIntent，叶节点命中即消费，原 WidgetFormInteractive 演示卡证实控件在卡内可用）。
 */
@Composable
private fun HealthSummaryContent(
    heartRate: Int,
    steps: Int,
    collecting: Boolean,
    updatedText: String,
    showSteps: Boolean = true,
) {
    Box(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(day = CardBackgroundDay, night = CardBackgroundNight)
            .cornerRadius(16.dp)
            .clickable(actionStartActivity<MainActivity>()),
    ) {
        Column(modifier = GlanceModifier.padding(12.dp).fillMaxWidth()) {
            Row(
                modifier = GlanceModifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // 标题 defaultWeight 吃满余量，把切换胶囊推到行尾
                Text(
                    text = "健康概览",
                    modifier = GlanceModifier.defaultWeight(),
                    style = TextStyle(
                        color = ColorProvider(day = TextSecondaryDay, night = TextSecondaryNight),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                    ),
                    maxLines = 1,
                )
                CollectionTogglePill(collecting = collecting)
            }
            Row(
                modifier = GlanceModifier.padding(top = 8.dp).fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SummaryMetric(
                    label = "心率 (bpm)",
                    value = if (heartRate < 0) "--" else heartRate.toString(),
                )
                if (showSteps) {
                    SummaryMetric(
                        label = "步数",
                        value = if (steps < 0) "--" else steps.toString(),
                    )
                }
            }
            Text(
                text = (if (collecting) "采集中" else "已停止") + " · " + updatedText,
                modifier = GlanceModifier.padding(top = 8.dp),
                style = TextStyle(
                    color = ColorProvider(day = TextSecondaryDay, night = TextSecondaryNight),
                    fontSize = 11.sp,
                ),
                maxLines = 1,
            )
        }
    }
}

/**
 * 采集切换胶囊：采集中显示「停止」、已停止显示「开始」（13sp，半透明灰底轻量样式）。
 * clickable 挂在胶囊自身——Glance 子视图点击通道优先于祖先 clickable，
 * 点胶囊走 actionRunCallback、点卡片其余区域仍是 actionStartActivity<MainActivity>。
 */
@Composable
private fun CollectionTogglePill(collecting: Boolean) {
    Text(
        text = if (collecting) "停止" else "开始",
        modifier = GlanceModifier
            .background(day = TogglePillBackgroundDay, night = TogglePillBackgroundNight)
            .cornerRadius(12.dp)
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .clickable(actionRunCallback<CollectionToggleActionCallback>()),
        style = TextStyle(
            color = ColorProvider(day = TextPrimaryDay, night = TextPrimaryNight),
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
        ),
        maxLines = 1,
    )
}

/** 单列指标：小字标签 + 大字数值，Row 内均分宽度 */
@Composable
private fun androidx.glance.layout.RowScope.SummaryMetric(label: String, value: String) {
    Column(modifier = GlanceModifier.defaultWeight()) {
        Text(
            text = label,
            style = TextStyle(
                color = ColorProvider(day = TextSecondaryDay, night = TextSecondaryNight),
                fontSize = 11.sp,
            ),
            maxLines = 1,
        )
        Text(
            text = value,
            style = TextStyle(
                color = ColorProvider(day = TextPrimaryDay, night = TextPrimaryNight),
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold,
            ),
            maxLines = 1,
        )
    }
}

// 卡片配色：深浅色各一套（widget 由 launcher 主题环境渲染，day/night 双值防止深色模式下白底黑字刺眼）
private val CardBackgroundDay = Color(0xFFFFFFFF)
private val CardBackgroundNight = Color(0xFF2B2930)
private val TextPrimaryDay = Color(0xFF1D1B20)
private val TextPrimaryNight = Color(0xFFE6E1E5)
private val TextSecondaryDay = Color(0xFF49454F)
private val TextSecondaryNight = Color(0xFFCAC4D0)
// 切换胶囊底色：次要色的低透明度版（日间约 12%、夜间约 20%），视觉轻量不抢指标主文本
private val TogglePillBackgroundDay = Color(0x1F49454F)
private val TogglePillBackgroundNight = Color(0x33CAC4D0)

/**
 * 采集切换胶囊回调：复刻设置页「感知数据上传」总开关的同一机制启停 DataCollectorService。
 *
 * 单一真源：翻转的就是设置页总开关写的同一个 prefs 键（data_collector / upload_enabled，
 * 见「采集总控」页总开关 → SettingsViewModel.toggleSensor("upload") →
 * DataCollectorService.setUploadEnabled）；设置页约定改动即时生效，这里不另造第二状态源。
 * 启停路径同样逐一对齐设置页：开 = ensureServiceRunning 的裸 Intent
 * startForegroundService（+ triggerCycle 立刻推一轮，与设置页开启分支一致）；
 * 关 = 「采集总控」页的 stopService（服务自行收尾，绝不从胶囊起 FGS）。
 *
 * 运行约束：回调活在异步 receiver 上下文（约 10 秒窗口，研究报告 §1.1 动作约束）——
 * 窗口内只做快 prefs 读写 + binder 级 updateAll；采集重活全部交还服务机制本身
 * （startForegroundService 拉起后由服务主循环执行），回调现场零网络/零 IO 重负担。
 *
 * 判定口径（两真值源）：用户意图 = prefs upload_enabled（设置页真值）；运行态 =
 * WidgetSnapshot collecting 旗标（服务 updateSnapshot 每轮以 isRunning 写入，胶囊文案真值）。
 * 仅"意图开 且 运行中"才执行停止；其余一切状态（意图关，或意图开但服务已死——
 * 如被系统杀进程）一律走启动分支，保证胶囊"开始"即真正开始采集；服务已活着时
 * 不再重复起 FGS（只补一次 triggerCycle 即时反馈）。启动失败（Android 12+ 后台
 * FGS 限制）时 prefs 已置开，下次打开 App 由 MainActivity 的自动拉起路径兜底。
 *
 * ActionCallback 实现类必须公开零参构造器（系统反射实例化），故声明为无参 class。
 */
class CollectionToggleActionCallback : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        val intentOn = runCatching { DataCollectorService.isUploadEnabled(context) }.getOrDefault(false)
        val running = runCatching { WidgetSnapshot.readCollecting(context) }.getOrDefault(false)
        // 停的唯一条件 = 意图开且确在运行；否则一律开（覆盖"意图开但服务死"的僵尸态）
        val turnOn = !intentOn || !running
        if (turnOn) {
            runCatching { DataCollectorService.setUploadEnabled(context, true) }
            // 服务已活（意图关但没停干净的边角）则跳过起 FGS，只补 triggerCycle，绝不双起
            val started = running || runCatching {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, DataCollectorService::class.java),
                )
            }.isSuccess
            if (started) {
                // 与设置页开启分支同款：triggerCycle 内部自带 try/catch，立即推进一轮采集与快照
                runCatching { DataCollectorService.triggerCycle(context) }
                // 乐观写快照让胶囊立刻翻「停止」；服务起稳后 updateSnapshot 以 isRunning 真值覆盖
                runCatching { writeCollectingToSnapshot(context, true) }
            }
        } else {
            runCatching { DataCollectorService.setUploadEnabled(context, false) }
            // 复刻「采集总控」关闭分支：stopService，服务 onDestroy 收尾（含音频补传）
            runCatching { context.stopService(Intent(context, DataCollectorService::class.java)) }
            // 服务停了不会再写快照，运行态旗标必须在此落 false，否则胶囊翻不回「开始」
            runCatching { writeCollectingToSnapshot(context, false) }
        }
        // 切换状态是全 App 级（非单实例交互），updateAll 让全部聚合卡实例的胶囊文案同步翻转
        runCatching { HealthSummaryWidget().updateAll(context) }
    }

    /** 仅改快照 collecting 旗标（hr/steps 原值回写，与 WidgetSnapshot.touch 同款轻活口径） */
    private fun writeCollectingToSnapshot(context: Context, collecting: Boolean) {
        WidgetSnapshot.write(
            context,
            WidgetSnapshot.readHeartRate(context),
            WidgetSnapshot.readSteps(context),
            collecting,
        )
    }
}

/** 组件注册 receiver：系统定向投递 APPWIDGET_UPDATE（官方样例 exported=false，见研究报告 §2.4） */
class HealthSummaryWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = HealthSummaryWidget()
}
