package com.xehuri.kinship.ui.settings

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import com.xehuri.kinship.widget.AiNotifyWidgetReceiver
import com.xehuri.kinship.widget.HealthSummaryWidgetReceiver
import com.xehuri.kinship.widget.HeartRateMiniWidgetReceiver
import com.xehuri.kinship.widget.ReminderWidgetReceiver
import kotlinx.coroutines.launch

/**
 * 桌面组件子页面（概览 → 二级页）。
 *
 * - 开关组：widgets_enabled 总开关——关闭后仅桌面卡片显示受影响（渲染停用占位、
 *   健康快照停更）；系统通知与通知历史全文仍照常记录（历史是 App 功能，不随组件停用）。
 * - 钉选组：经 GlanceAppWidgetManager.requestPinGlanceAppWidget 向 launcher 发起钉选请求。
 *   已知语义（注释即契约）：返回 true 仅表示请求已交给 launcher，launcher 可拒、无拒绝回执；
 *   仅"前台 Activity 或前台服务"可调用（本页在设置页前台内，天然满足）；
 *   钉选路径绕过聚合卡的 configureActivity，档位沿用 prefs 现值。
 * - 卡片背景组：两卡背景图经 PickVisualMedia 图库选择器取图（零权限、无 URI 持久化授权——
 *   ViewModel 落 IO 即时复制降采样副本进私有目录）；行内回显当前显示名，模式沿钉选组内联状态文本。
 * - 卡片颜色组：两卡背景/文字昼夜色对（预置色板 / 自定义 #RRGGBB / 恢复默认，真源
 *   WidgetColorStore 独立 prefs）+ 可读性遮罩开关（关=显式写 false，开=清键回"缺失⇒默认开"）。
 *   hex 校验单一真源 = WidgetColorStore.normalizeHex（UI 零 hex 正则）；store 半对拒写经
 *   组底部内联状态文本反馈（沿钉选组 pinStatus 口径，成功即清空）。
 * - 说明组：静态机制说明，不对未上线能力做过度承诺。
 */
@Composable
fun WidgetsSettingsPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val context = LocalContext.current
    val widgetsEnabled by viewModel.widgetsEnabled.collectAsState()
    val notifyBgName by viewModel.notifyBgName.collectAsState()
    val reminderBgName by viewModel.reminderBgName.collectAsState()
    val notifyBgPair by viewModel.notifyBgPair.collectAsState()
    val notifyTextPair by viewModel.notifyTextPair.collectAsState()
    val notifyScrimOn by viewModel.notifyScrimOn.collectAsState()
    val reminderBgPair by viewModel.reminderBgPair.collectAsState()
    val reminderTextPair by viewModel.reminderTextPair.collectAsState()
    val reminderScrimOn by viewModel.reminderScrimOn.collectAsState()
    var pinStatus by remember { mutableStateOf("钉选状态待操作") }
    var colorStatus by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    // 图库单选选择器（PickVisualMedia，activity 1.9.3 内置=系统照片选择器，零权限）；
    // 结果 URI 交 ViewModel 即时降采样复制进私有目录，不申请持久化读取权限
    val notifyBgPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri != null) viewModel.setNotifyBackground(context, uri, queryImageDisplayName(context, uri))
    }
    val reminderBgPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri != null) viewModel.setReminderBackground(context, uri, queryImageDisplayName(context, uri))
    }

    // 一键钉选（模式源自原组件演示页，演示页已删除、能力收进本页）：
    // runCatching 包裹 + 内联状态文本回显，launcher 拒绝/异常均不弹 Toast
    fun pin(receiver: Class<out GlanceAppWidgetReceiver>, label: String) {
        scope.launch {
            val result = runCatching {
                GlanceAppWidgetManager(context.applicationContext).requestPinGlanceAppWidget(receiver)
            }
            pinStatus = result.fold(
                onSuccess = { ok ->
                    if (ok) "已向 launcher 发起$label 钉选请求（launcher 可拒，无拒绝回执）"
                    else "$label：launcher 未受理钉选请求"
                },
                onFailure = { "$label：钉选调用被拒（需前台，${it.message}）" },
            )
        }
    }

    // 配色提交统一入口：store 半对拒写=false（选择器已前置守卫成对输入，此为兜底反馈），
    // 失败经组底部内联状态文本回显、成功清空（沿 pinStatus 口径；回显流由 ViewModel 以 store 真值刷新）
    fun applyColorPair(slotDesc: String, save: suspend () -> Boolean) {
        scope.launch {
            colorStatus = if (save()) "" else "$slotDesc：昼夜两色必须成对提交，本次未写入任何持久化"
        }
    }

    SettingsSubPageScaffold(title = "桌面组件", onBack = onBack) {
        // ── 开关 ──────────────────────────────────────────────────
        item {
            SettingsGroup(title = "开关") {
                SettingsSwitchItem(
                    label = "桌面组件总开关",
                    description = "关闭后桌面卡片显示停用占位；系统通知与通知历史仍照常记录",
                    checked = widgetsEnabled,
                    onCheckedChange = { enabled -> viewModel.setWidgetsEnabled(enabled) }
                )
            }
        }

        // ── 钉选组件 ──────────────────────────────────────────────
        item {
            SettingsGroup(title = "钉选组件") {
                PinButton(
                    label = "钉选健康聚合卡（4x2）",
                    enabled = widgetsEnabled,
                    onClick = { pin(HealthSummaryWidgetReceiver::class.java, "健康聚合卡") },
                )
                PinButton(
                    label = "钉选心率小卡（2x1）",
                    enabled = widgetsEnabled,
                    onClick = { pin(HeartRateMiniWidgetReceiver::class.java, "心率小卡") },
                )
                PinButton(
                    label = "钉选 AI 通知卡（4x2）",
                    enabled = widgetsEnabled,
                    onClick = { pin(AiNotifyWidgetReceiver::class.java, "AI 通知卡") },
                )
                PinButton(
                    label = "钉选AI提醒卡（4x2，全文）",
                    enabled = widgetsEnabled,
                    onClick = { pin(ReminderWidgetReceiver::class.java, "AI 提醒卡") },
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    text = pinStatus,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                )
                if (!widgetsEnabled) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "总开关已停用：新钉选卡片只会显示停用占位，请先重新开启",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.error.copy(alpha = 0.8f)
                    )
                }
            }
        }

        // ── 卡片背景 ──────────────────────────────────────────────
        item {
            SettingsGroup(title = "卡片背景") {
                BackgroundPickRow(
                    label = "AI 通知卡",
                    currentName = notifyBgName,
                    onPick = {
                        notifyBgPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    },
                    onClear = { viewModel.clearNotifyBackground(context) },
                )
                BackgroundPickRow(
                    label = "AI 提醒卡",
                    currentName = reminderBgName,
                    onPick = {
                        reminderBgPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    },
                    onClear = { viewModel.clearReminderBackground(context) },
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "背景图选自本机相册，App 只保留降采样后的本地副本；选图即时生效于对应卡片，卡片以降采样副本垫底渲染+可读性遮罩，解码失败/坏图自动回退纯色",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                )
            }
        }

        // ── 卡片颜色 ──────────────────────────────────────────────
        item {
            SettingsGroup(title = "卡片颜色") {
                ColorSlotSubtitle("AI 通知卡")
                SettingsColorPairPicker(
                    label = "背景色",
                    currentPair = notifyBgPair,
                    presetToPair = { it.bgDay to it.bgNight },
                    onApply = { day, night ->
                        applyColorPair("通知卡背景色") { viewModel.setNotifyBackgroundColors(context, day, night) }
                    },
                    onClear = { viewModel.clearNotifyBackgroundColors(context) },
                )
                Spacer(Modifier.height(10.dp))
                SettingsColorPairPicker(
                    label = "文字色",
                    currentPair = notifyTextPair,
                    presetToPair = { it.textDay to it.textNight },
                    onApply = { day, night ->
                        applyColorPair("通知卡文字色") { viewModel.setNotifyTextColors(context, day, night) }
                    },
                    onClear = { viewModel.clearNotifyTextColors(context) },
                )
                SettingsSwitchItem(
                    label = "可读性遮罩",
                    description = "图片背景上压一层半透明遮罩保证文字清晰；关闭后图片直接垫底",
                    checked = notifyScrimOn,
                    onCheckedChange = { on -> viewModel.setNotifyScrim(context, on) },
                )

                ColorSlotSubtitle("AI 提醒卡")
                SettingsColorPairPicker(
                    label = "背景色",
                    currentPair = reminderBgPair,
                    presetToPair = { it.bgDay to it.bgNight },
                    onApply = { day, night ->
                        applyColorPair("提醒卡背景色") { viewModel.setReminderBackgroundColors(context, day, night) }
                    },
                    onClear = { viewModel.clearReminderBackgroundColors(context) },
                )
                Spacer(Modifier.height(10.dp))
                SettingsColorPairPicker(
                    label = "文字色",
                    currentPair = reminderTextPair,
                    presetToPair = { it.textDay to it.textNight },
                    onApply = { day, night ->
                        applyColorPair("提醒卡文字色") { viewModel.setReminderTextColors(context, day, night) }
                    },
                    onClear = { viewModel.clearReminderTextColors(context) },
                )
                SettingsSwitchItem(
                    label = "可读性遮罩",
                    description = "图片背景上压一层半透明遮罩保证文字清晰；关闭后图片直接垫底",
                    checked = reminderScrimOn,
                    onCheckedChange = { on -> viewModel.setReminderScrim(context, on) },
                )

                if (colorStatus.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = colorStatus,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.error.copy(alpha = 0.8f)
                    )
                }
                Spacer(Modifier.height(6.dp))
                InfoText(
                    title = "生效方式",
                    body = "颜色为昼夜成对（日间/夜间各一色，系统深浅色切换时由卡片就地取对应档）；" +
                        "点预置色板或填 #RRGGBB 保存后对应卡片即时重绘，「恢复默认」回代码色板。",
                )
            }
        }

        // ── 说明 ──────────────────────────────────────────────────
        item {
            SettingsGroup(title = "说明") {
                InfoText(
                    title = "AI 通知卡",
                    body = "卡片显示最近 5 条摘要（正文截 200 字）；全文本地保存最近 50 条，可在「通知历史」查看。",
                )
                InfoText(
                    title = "AI 提醒卡",
                    body = "桌面公告板：AI 维护的一整块提醒文字，先读后整块覆写，卡片内滚动看全文；运行期每轮主循环同步，进程被杀 WorkManager 15 分钟兜底",
                )
                InfoText(
                    title = "更新机制",
                    body = "卡片数据由采集服务在每轮快照时写入并直更；采集服务未运行时，卡片兜底显示最后一次落盘的快照。",
                )
            }
        }
    }
}

/** 钉选按钮：总开关停用态下置灰不可点（钉进占位卡没有意义） */
@Composable
private fun PinButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) {
        Text(text = label)
    }
}

/**
 * 背景图条目行：整宽按钮（选择/更换，样式沿 PinButton）+ 行内状态回显（沿钉选组 pinStatus 口径）
 * + 「清除」动作（未设置时置灰）。点击即拉起图库单选选择器。
 */
@Composable
private fun BackgroundPickRow(
    label: String,
    currentName: String?,
    onPick: () -> Unit,
    onClear: () -> Unit,
) {
    OutlinedButton(
        onClick = onPick,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) {
        Text(text = if (currentName == null) "选择$label 背景图" else "更换$label 背景图")
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (currentName != null) "已设置：$currentName" else "未设置",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onClear, enabled = currentName != null) {
            Text(text = "清除", fontSize = 13.sp)
        }
    }
}

/** 卡片颜色组内两卡子块的小标题（字面量与节奏沿 InfoText 标题行） */
@Composable
private fun ColorSlotSubtitle(text: String) {
    Text(
        text = text,
        fontSize = 14.sp,
        fontWeight = FontWeight.Medium,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.padding(top = 12.dp),
    )
}

/** 查询图库图片的显示名（仅供设置页回显）；查询失败返回 null，store 侧回退落盘文件名 */
private fun queryImageDisplayName(context: Context, uri: Uri): String? =
    runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
    }.getOrNull()

/** 说明条目：小标题 + 灰色正文 */
@Composable
private fun InfoText(title: String, body: String) {
    Text(
        text = title,
        fontSize = 14.sp,
        fontWeight = FontWeight.Medium,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.padding(top = 8.dp),
    )
    Text(
        text = body,
        fontSize = 12.sp,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
    )
}
