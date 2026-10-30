package com.xehuri.kinship.widget

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
import com.xehuri.kinship.MainActivity
import com.xehuri.kinship.service.DataCollectorService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import timber.log.Timber

/**
 * ReminderWidget - 4x2 AI 提醒卡（公告板：一块文本，卡内滚动看全文）
 *
 * 公告板模型：AI 维护的一整块文本、每次整块覆写（先读后编辑再写回），App 只读，
 * 全文滚动展示，**无条目生命周期**——没有勾选/删除/过期，板面就是服务端当前全文。
 * 与通知卡的本质差异：通知卡是"最近 10 条摘要镜像"（卡内滚动、正文展示侧截 200 字），
 * 本卡渲染整板的**完整文本**、卡内滚动不截断（用户硬需求「必须完整显示」）。
 * LazyColumn 在 RemoteViews 层翻译为 ListView，滚动可用、parcel 上限约 0.8MB，
 * 契约封顶 2000 字仅几 KB，远在天花板内；换行由 RemoteViews TextView 原生兑现。
 *
 * 数据链路：真源服务端（reminders v2 通道，持久化重启不丢）；
 * 同步两条通道——采集服务主循环每轮（默认 30s）[ReminderStore.syncFromServer]，
 * 进程被杀时 [WidgetSyncWorker] 15 分钟周期兜底。本组件只读 [ReminderStore] 落盘缓存渲染，
 * 与另三卡同"写侧显式直更"约定（组合只活约 45 秒不自动感知数据变化）。
 *
 * 背景图语义：每次组合在 IO 线程读一次自选背景位图；坏图自愈由 store 侧 bitmapFile 处理，
 * 解码失败静默回退纯色底，绝不崩卡/绝不空白。
 *
 * 配色语义：卡片底色/文字色/遮罩开关经 [WidgetColorStore] 同次 IO 现读（[WidgetCardColors]
 * 穿线进内容），未设置键时渲染与文件私有色板现状逐字节一致。
 */
class ReminderWidget : GlanceAppWidget() {

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
        // prefs 读取走 IO 线程；widgets_enabled 总开关同处读取：停用即渲染占位卡（与另三卡对等），
        // 跳过背景图与配色解析。背景图、三配色槽位（底色对/文字对/遮罩开关）与数据同次 IO 读解析：解码失败/文件坏件一律置 null，渲染端回纯色底。
        val data = withContext(Dispatchers.IO) {
            if (!DataCollectorService.isWidgetsEnabled(context)) return@withContext null
            val board = ReminderStore.readBoard(context)
            val bgFile = WidgetBackgroundStore.bitmapFile(context, WidgetBackgroundStore.KEY_AI_REMINDER)
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
                background = WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_REMINDER),
                text = WidgetColorStore.readText(context, WidgetColorStore.KEY_AI_REMINDER),
                scrim = WidgetColorStore.readScrim(context, WidgetColorStore.KEY_AI_REMINDER),
            )
            Triple(board, bgBitmap, colors)
        }
        provideContent {
            if (data == null) {
                WidgetDisabledPlaceholder()
            } else {
                ReminderContent(text = data.first.first, updatedAt = data.first.second, background = data.second, colors = data.third)
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
        Timber.e(throwable, "ReminderWidget 组合失败（appWidgetId=%d）: %s", appWidgetId, throwable.message)
        super.onCompositionError(context, glanceId, appWidgetId, throwable)
    }
}

/**
 * 提醒卡内容：头部"AI 提醒 + 更新于 HH:mm"（取整板 updated_at，从未写入显示 --:--），
 * 空板居中灰色两行提示；非空 LazyColumn 单条目 = 整板全文（无 maxLines、不截断）。
 * 整卡点击打开 MainActivity。
 * background 非空时在内容之下垫一层背景图 + 可读性遮罩（解码在组合外的 IO 段完成）；
 * 遮罩仅在 colors.scrim 为 true 时产出（开关只控制产出与否，两色字面量恒不变）。
 * colors 三槽位均"未设即透传现行文件私有常量"，无键态渲染逐字节等于现状；
 * 文字槽位一旦设置，单一色同时压过主要/次要两角色（unset 保持两档）。
 */
@Composable
private fun ReminderContent(text: String, updatedAt: Long, background: Bitmap?, colors: WidgetCardColors) {
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
            .clickable(actionStartActivity<MainActivity>()),
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
                // 结构消毒：权重恒挂包裹 Column、绝不直接挂 Text（对齐已验证可用的通知卡头部结构；
                // HyperOS/RemoteViews 对直挂 Text 的权重存在擦除风险）
                Column(modifier = GlanceModifier.defaultWeight()) {
                    Text(
                        text = "AI 提醒",
                        style = TextStyle(
                            color = ColorProvider(day = textSecondaryDay, night = textSecondaryNight),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                        ),
                        maxLines = 1,
                    )
                }
                Text(
                    text = "更新于 " + ReminderStore.formatTime(updatedAt).takeLast(5),
                    style = TextStyle(
                        color = ColorProvider(day = textSecondaryDay, night = textSecondaryNight),
                        fontSize = 10.sp,
                    ),
                    maxLines = 1,
                )
            }
            if (text.isBlank()) {
                // 空板：居中两行提示（"\n" 用法与停用占位卡一致）
                Box(
                    modifier = GlanceModifier.defaultWeight(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "暂无提醒\n对 AI 说「记得…随时提醒我」",
                        style = TextStyle(
                            color = ColorProvider(day = textSecondaryDay, night = textSecondaryNight),
                            fontSize = 12.sp,
                        ),
                        maxLines = 2,
                    )
                }
            } else {
                // defaultWeight 让滚动区吃掉头部以外的全部高度，整板单条目内部滚动；
                // 顶间距 8dp 与通知卡竖向节奏统一
                LazyColumn(
                    modifier = GlanceModifier.padding(top = 8.dp).defaultWeight(),
                ) {
                    // 沿用既有无显式 key 的 items(list) 调用形态（显式 key 签名在 RemoteViews
                    // 擦除路径有风险，单板也不需要 key）
                    items(listOf(text)) { boardText ->
                        // 全文展示是差异化核心：不设 maxLines、不截断；换行原样渲染；
                        // 横向边距收敛到外层 Column 的 12dp（与通知卡同口径）
                        Text(
                            text = boardText,
                            modifier = GlanceModifier.fillMaxWidth(),
                            style = TextStyle(
                                color = ColorProvider(day = textPrimaryDay, night = textPrimaryNight),
                                fontSize = 12.sp,
                            ),
                        )
                    }
                }
            }
        }
    }
}

// 卡片配色：深浅色各一套（与另三卡及停用占位卡同色板；widget 由 launcher 环境渲染，
// 双值防止深色模式刺眼。顶层色值为文件私有，两展示卡采用同一组统一命名便于对照）
private val BgDay = Color(0xFFFFFFFF)
private val BgNight = Color(0xFF2B2930)
private val TextPrimaryDay = Color(0xFF1D1B20)
private val TextPrimaryNight = Color(0xFFE6E1E5)
private val TextSecondaryDay = Color(0xFF49454F)
private val TextSecondaryNight = Color(0xFFCAC4D0)

/** 组件注册 receiver：系统定向投递 APPWIDGET_UPDATE（官方样例 exported=false，同另三卡） */
class ReminderWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = ReminderWidget()
}
