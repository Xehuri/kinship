package com.xehuri.kinship.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.AppWidgetId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.background
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.xehuri.kinship.NotificationHistoryActivity
import com.xehuri.kinship.service.DataCollectorService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import timber.log.Timber

/**
 * AiNotifyWidget - 4x2 AI 通知镜像卡（文本形态，无交互控件）
 *
 * 数据链路：DataCollectorService.showSystemNotification() 每条 AI 推送全文写 [NotificationStore]
 * （新→旧封顶 50 条）后，总开关开启时显式 updateAll 直更；本组件只读 store 最近 10 条渲染，
 * 正文展示侧截断 200 字（全文见 NotificationHistoryActivity，卡片不追求完整呈现）。
 * 与另两卡同经"写侧显式直更"约定（无事件总线，组合只活约 45 秒不自动感知数据变化）。
 *
 * 渲染形态：标题/正文两行形态，每项 = 「标题 + HH:mm」一行 + 正文 2 行，LazyColumn 卡内滚动
 * （形态与提醒卡同款，滚动解锁条目上限后不再追求"可见即全部"）；
 * 存储层保留标题与全文（历史页消费），卡片渲染标题 + 截断正文。
 *
 * 溢出策略：Glance 1.2.0 的 Text 仅暴露 maxLines（无 overflow 参数），标题 1 行 / 正文 2 行
 * 截行即本卡在 RemoteViews 天花板下的 sanctioned 溢出方案。
 *
 * 背景图语义：每次组合在 IO 线程读一次自选背景位图；坏图自愈由 store 侧 bitmapFile 处理，
 * 解码失败静默回退纯色底，绝不崩卡/绝不空白。
 *
 * 配色语义：卡片底色/文字色/遮罩开关经 [WidgetColorStore] 同次 IO 现读（[WidgetCardColors]
 * 穿线进内容），未设置键时渲染与文件私有色板现状逐字节一致。
 */
class AiNotifyWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // HyperOS 首帧守卫：尺寸未就绪时本轮不组合真实内容，但必须经 provideContent 产出
        // 加载骨架再 return——空 return 会让 channelFlow 零发射完成 → IgnoreResult
        // （AppWidgetSession.kt:169）→ uiReady 永不 emit、worker 永挂（SessionWorker.kt:230-233,
        // :244），首会话死锁后所有更新入队无人消费（旧"空 RemoteViews"假说已被 crash-audit.md 证伪；
        // 机制与 glance 1.2.0 API 考证见文件末 isWidgetSizeNotReady）
        if (isWidgetSizeNotReady(context, id)) {
            provideContent { WidgetLoadingPlaceholder() }
            return
        }
        // prefs 读取走 IO 线程；取数在组合之外完成（组合内不做阻塞 IO）。
        // widgets_enabled 总开关同处读取：停用即渲染占位卡，跳过取数、背景图与配色解析——
        // 全文历史写入不受开关影响（见 DataCollectorService.showSystemNotification）。
        // 背景图、三配色槽位（底色对/文字对/遮罩开关）与数据同次 IO 读解析：解码失败/文件坏件一律置 null，渲染端回纯色底。
        val data = withContext(Dispatchers.IO) {
            if (!DataCollectorService.isWidgetsEnabled(context)) return@withContext null
            val items = NotificationStore.readRecent(context, 10)
            val bgFile = WidgetBackgroundStore.bitmapFile(context, WidgetBackgroundStore.KEY_AI_NOTIFY)
            val bgBitmap = if (bgFile != null) {
                val decoded = runCatching {
                    bgFile.inputStream().use { decodeDownsampled(it) }
                }.getOrNull()
                // 载荷护栏：RemoteViews 位图原始像素不压缩直进 binder parcel，判据是字节数。
                // 正常路径最坏单卡 448×448×2B(RGB_565) ≈ 401KB < 0.8MB parcel 上限；
                // 篡改文件绕过降采样致 byteCount 超 MAX_BG_BYTE_COUNT 一律回收、按无图降级
                if (decoded != null && decoded.byteCount > MAX_BG_BYTE_COUNT) {
                    decoded.recycle()
                    null
                } else decoded
            } else null
            // 配色槽位现读打包。API26-30 塌缩警示见 WidgetCardColors 头注（daynight-colors.md §Q1：
            // 31+ 成对序列化由宿主解析，≤30 翻译期按 App 进程 uiMode 选一色、翻转靠 T2 的 uiMode receiver 重发）
            val colors = WidgetCardColors(
                background = WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY),
                text = WidgetColorStore.readText(context, WidgetColorStore.KEY_AI_NOTIFY),
                scrim = WidgetColorStore.readScrim(context, WidgetColorStore.KEY_AI_NOTIFY),
            )
            Triple(items, bgBitmap, colors)
        }
        provideContent {
            if (data == null) {
                WidgetDisabledPlaceholder()
            } else {
                AiNotifyContent(items = data.first, background = data.second, colors = data.third)
            }
        }
    }

    /**
     * 组合错误可观测（crash-audit.md 修复 5 简化版）：默认实现静默换发 glance_error_layout，
     * 用户只见"错卡"无痕迹；这里先 Timber.e 留现场再交回 super 走默认错误卡，行为零变化。
     * 签名按 glance-appwidget 1.2.0 源（GlanceAppWidget.kt:213-217 四参 + Throwable）。
     */
    override fun onCompositionError(
        context: Context,
        glanceId: GlanceId,
        appWidgetId: Int,
        throwable: Throwable,
    ) {
        Timber.e(throwable, "AiNotifyWidget 组合失败（appWidgetId=%d）: %s", appWidgetId, throwable.message)
        super.onCompositionError(context, glanceId, appWidgetId, throwable)
    }
}

/**
 * 通知卡内容：头部"AI 通知 + 更新于 HH:mm"（取最新一条 ts，缓冲为空显示 --:--），
 * 空态一行灰色提示（原位替列表）；非空态 LazyColumn 滚动列表（取数封顶 10 条），
 * 每项 = 标题/时间一行 + 正文两行、项间距 8dp
 * （标题 13sp Medium 主要色 defaultWeight 吃满余量把时间推到行尾，时间 10sp 次要色，
 * 正文 12sp 次要色 2 行、展示侧截 200 字）。
 * 整卡点击打开 NotificationHistoryActivity（全文历史页）。
 * background 非空时在内容之下垫一层背景图 + 可读性遮罩（解码在组合外的 IO 段完成）；
 * 遮罩仅在 colors.scrim 为 true 时产出（开关只控制产出与否，两色字面量恒不变）。
 * colors 三槽位均"未设即透传现行文件私有常量"，无键态渲染逐字节等于现状；
 * 文字槽位一旦设置，单一色同时压过主要/次要两角色（unset 保持两档）。
 */
@Composable
private fun AiNotifyContent(items: List<NotifyItem>, background: Bitmap?, colors: WidgetCardColors) {
    // 用户覆写解析（读侧保证成对或全空，半对永不可达）：?.let 未设即取文件私有色板原常量
    val (customBgDay, customBgNight) = colors.background
    val (customTextDay, customTextNight) = colors.text
    val baseDay = customBgDay?.let { Color(it) } ?: BgDay
    val baseNight = customBgNight?.let { Color(it) } ?: BgNight
    val textPrimaryDay = customTextDay?.let { Color(it) } ?: TextPrimaryDay
    val textPrimaryNight = customTextNight?.let { Color(it) } ?: TextPrimaryNight
    val textSecondaryDay = customTextDay?.let { Color(it) } ?: TextSecondaryDay
    val textSecondaryNight = customTextNight?.let { Color(it) } ?: TextSecondaryNight
    Box(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(day = baseDay, night = baseNight)
            .cornerRadius(16.dp)
            .clickable(actionStartActivity<NotificationHistoryActivity>()),
    ) {
        // Box 修饰符链的 cornerRadius 不裁剪 Box 子节点（RemoteViews 无 clip 语义），图与遮罩各自带圆角。
        // 子节点顺序 = 叠放顺序：背景图垫底、遮罩居中压可读性、原内容 Column 恒在最上层。
        // background 为 null 时不产出图/遮罩，渲染与纯色底现状逐字节一致。
        if (background != null) {
            Image(
                provider = ImageProvider(background),
                contentDescription = null,
                modifier = GlanceModifier.fillMaxSize().cornerRadius(16.dp),
                contentScale = ContentScale.Crop,
            )
            // 可读性遮罩：日间白 60% / 夜间深色 60%，垫在图文之间（glance Box 的 content 为必传，空闭包即纯色块）；
            // scrim 开关 OFF 时整块跳过（图片直接垫内容之下），字面量恒不受开关影响
            if (colors.scrim) {
                Box(
                    modifier = GlanceModifier
                        .fillMaxSize()
                        .cornerRadius(16.dp)
                        .background(day = Color(0x99FFFFFF), night = Color(0x992B2930)),
                ) { }
            }
        }
        Column(modifier = GlanceModifier.padding(12.dp).fillMaxWidth()) {
            Row(
                modifier = GlanceModifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // 结构消毒：权重恒挂包裹 Column、绝不直接挂 Text（对齐已验证可用的心率小卡行结构）
                Column(modifier = GlanceModifier.defaultWeight()) {
                    Text(
                        text = "AI 通知",
                        style = TextStyle(
                            color = ColorProvider(day = textSecondaryDay, night = textSecondaryNight),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                        ),
                        maxLines = 1,
                    )
                }
                // 头部时间取最新一条 ts；空缓冲显示占位（口径同 NotificationStore.formatTime 的非正值分支）
                Text(
                    text = "更新于 " + (items.firstOrNull()?.let { NotificationStore.formatTime(it.ts) } ?: "--:--"),
                    style = TextStyle(
                        color = ColorProvider(day = textSecondaryDay, night = textSecondaryNight),
                        fontSize = 10.sp,
                    ),
                    maxLines = 1,
                )
            }
            if (items.isEmpty()) {
                Text(
                    text = "暂无 AI 通知，AI 推送后自动显示",
                    modifier = GlanceModifier.padding(top = 8.dp),
                    style = TextStyle(
                        color = ColorProvider(day = textSecondaryDay, night = textSecondaryNight),
                        fontSize = 12.sp,
                    ),
                    maxLines = 1,
                )
            } else {
                // LazyColumn 在 RemoteViews 层翻译为 ListView、卡内可滚动（提醒卡同款已验证形态）；
                // defaultWeight 让滚动区吃掉头部以外的全部高度，头部 Row 恒在其外上方
                LazyColumn(
                    modifier = GlanceModifier.defaultWeight(),
                ) {
                    // 沿用既有无显式 key 的 items(list) 调用形态（显式 key 签名在 RemoteViews
                    // 擦除路径有风险，定长列表也不需要 key）；取数已封顶 10 条，滚动兜住不再二次裁剪
                    items(items) { item ->
                        // 标题/正文两行形态：标题+时间一行、正文最多两行；项间距 8dp（两卡竖向节奏统一）
                        Column(modifier = GlanceModifier.padding(top = 8.dp).fillMaxWidth()) {
                            Row(
                                modifier = GlanceModifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                // 标题吃满余量把时间推到行尾：权重挂 Column（等效原 Text defaultWeight 推挤，视觉零变化）
                                Column(modifier = GlanceModifier.defaultWeight()) {
                                    Text(
                                        text = item.title,
                                        style = TextStyle(
                                            color = ColorProvider(day = textPrimaryDay, night = textPrimaryNight),
                                            fontSize = 13.sp,
                                            fontWeight = FontWeight.Medium,
                                        ),
                                        maxLines = 1,
                                    )
                                }
                                Text(
                                    text = NotificationStore.formatTime(item.ts),
                                    style = TextStyle(
                                        color = ColorProvider(day = textSecondaryDay, night = textSecondaryNight),
                                        fontSize = 10.sp,
                                    ),
                                    maxLines = 1,
                                )
                            }
                            Text(
                                // 展示侧截断 200 字，再按 2 行截尾（全文见 NotificationHistoryActivity）
                                text = item.body.take(200),
                                style = TextStyle(
                                    color = ColorProvider(day = textSecondaryDay, night = textSecondaryNight),
                                    fontSize = 12.sp,
                                ),
                                maxLines = 2,
                            )
                        }
                    }
                }
            }
        }
    }
}

// 卡片配色：深浅色各一套（与另两展示卡及停用占位卡同色板；widget 由 launcher 环境渲染，
// 双值防止深色模式刺眼。顶层色值为文件私有，两展示卡采用同一组统一命名便于对照）
private val BgDay = Color(0xFFFFFFFF)
private val BgNight = Color(0xFF2B2930)
private val TextPrimaryDay = Color(0xFF1D1B20)
private val TextPrimaryNight = Color(0xFFE6E1E5)
private val TextSecondaryDay = Color(0xFF49454F)
private val TextSecondaryNight = Color(0xFFCAC4D0)

/** 组件注册 receiver：系统定向投递 APPWIDGET_UPDATE（官方样例 exported=false，见研究报告 §2.4） */
class AiNotifyWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = AiNotifyWidget()
}

/**
 * HyperOS/MIUI 首帧守卫判定：钉选/分配瞬间 AppWidgetManager 可能尚未写入组件尺寸
 * （options Bundle 里 OPTION_APPWIDGET_MIN_WIDTH 缺失，读到缺省 0）。Glance 1.2.0 起
 * provideGlance 在 WorkManager 异步会话中执行、不等尺寸就绪，此窗口内组合会按未就绪
 * 尺寸产出空 RemoteViews——宿主 launcher 对空内容敏感，表现为钉选瞬间桌面整体重启。
 * 返回 true 表示尺寸未就绪、应跳过本轮组合；尺寸就绪后系统经
 * onAppWidgetOptionsChanged / 重发 APPWIDGET_UPDATE 触发重组，数据无损失。
 *
 * API 考证（glance-appwidget 1.2.0 aar classes.jar javap 核实）：不存在
 * isPartiallyVisible 扩展，故走框架源数据直读；id 为预览假 id
 * （AppWidgetUtilsKt.createFakeAppWidgetId 取 [-2147483648, -2] 负数区间）或
 * 非 AppWidgetId 实现时返回 false 恒放行——真实组件 id 恒为正数，预览行为零变化。
 */
internal fun isWidgetSizeNotReady(context: Context, id: GlanceId): Boolean {
    val appWidgetId = (id as? AppWidgetId)?.appWidgetId ?: 0
    if (appWidgetId <= 0) return false
    return AppWidgetManager.getInstance(context)
        .getAppWidgetOptions(appWidgetId)
        .getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) <= 0
}
