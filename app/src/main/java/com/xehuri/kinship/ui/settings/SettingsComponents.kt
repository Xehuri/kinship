package com.xehuri.kinship.ui.settings

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.ui.theme.SettingsAnim
import com.xehuri.kinship.ui.theme.SettingsShape
import com.xehuri.kinship.ui.theme.SettingsSpacing

// ─── 通用工具 ──────────────────────────────────────────────────────

/** 将毫秒间隔格式化为中文摘要，用于数据源卡片副标题 */
fun formatIntervalMs(ms: Long): String = when {
    ms <= 0L -> "未设置"
    ms % 60000L == 0L -> "${ms / 60000L} 分钟"
    ms % 1000L == 0L -> "${ms / 1000L} 秒"
    else -> "$ms 毫秒"
}

// ─── 子页面脚手架 ──────────────────────────────────────────────────

/**
 * 子页面脚手架：TopAppBar（含返回）+ LazyColumn。
 *
 * [content] 以 LazyListScope 形式暴露，调用方用 item {} 追加分组，
 * 从而避免在同方向滚动容器内再嵌套滚动容器。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSubPageScaffold(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    snackbarHostState: SnackbarHostState? = null,
    content: LazyListScope.() -> Unit
) {
    Scaffold(
        modifier = modifier,
        snackbarHost = {
            if (snackbarHostState != null) SnackbarHost(snackbarHostState)
        },
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回"
                        )
                    }
                }
            )
        }
    ) { paddingValues ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
            contentPadding = PaddingValues(
                start = SettingsSpacing.lg,
                end = SettingsSpacing.lg,
                top = SettingsSpacing.md,
                bottom = SettingsSpacing.xl
            ),
            verticalArrangement = Arrangement.spacedBy(SettingsSpacing.md)
        ) {
            content()
        }
    }
}

// ─── 间隔选择器 ────────────────────────────────────────────────────

/**
 * 间隔选择器：FilterChip 预设 + 自定义秒数输入。
 *
 * 从旧 SensorControls 的采集间隔实现中抽出，供各数据源复用。
 *
 * @param description 可选的补充说明文案，用于区分同名易混概念（如「分段时长」与「上传频率」）
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsIntervalPicker(
    label: String,
    intervalMs: Long,
    presetsMs: List<Long>,
    onIntervalChange: (Long) -> Unit,
    modifier: Modifier = Modifier,
    description: String? = null
) {
    var customSec by remember { mutableStateOf("") }

    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = label,
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                modifier = Modifier.weight(1f)
            )
            Text(
                text = "当前：${formatIntervalMs(intervalMs)}",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
            )
        }
        if (!description.isNullOrBlank()) {
            Spacer(Modifier.height(SettingsSpacing.xs))
            Text(
                text = description,
                fontSize = 12.sp,
                lineHeight = 16.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
            )
        }
        Spacer(Modifier.height(SettingsSpacing.sm))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(SettingsSpacing.sm),
            verticalArrangement = Arrangement.spacedBy(SettingsSpacing.xs)
        ) {
            presetsMs.forEach { preset ->
                FilterChip(
                    selected = intervalMs == preset,
                    onClick = {
                        customSec = ""
                        onIntervalChange(preset)
                    },
                    label = { Text(formatIntervalMs(preset), fontSize = 13.sp) }
                )
            }
        }
        Spacer(Modifier.height(SettingsSpacing.sm))
        OutlinedTextField(
            value = customSec,
            onValueChange = { value ->
                customSec = value
                val sec = value.toIntOrNull()
                if (sec != null && sec > 0) {
                    onIntervalChange(sec * 1000L)
                }
            },
            label = { Text("自定义秒数") },
            placeholder = { Text("输入秒数（如 10）") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Number,
                imeAction = ImeAction.Done
            ),
            suffix = { Text("秒") }
        )
    }
}

// ─── 通用选项 / 数值选择器 ─────────────────────────────────────────

/**
 * 单选选项选择器：一行 FilterChip，用于枚举型配置（如 GPS 精度优先级）。
 *
 * [options] 为「取值 to 显示文案」列表，[selectedValue] 与取值比较决定选中态。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsChoicePicker(
    label: String,
    options: List<Pair<String, String>>,
    selectedValue: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    description: String? = null
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = label,
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
        )
        if (description != null) {
            Text(
                text = description,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
            )
        }
        Spacer(Modifier.height(SettingsSpacing.sm))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(SettingsSpacing.sm),
            verticalArrangement = Arrangement.spacedBy(SettingsSpacing.xs)
        ) {
            options.forEach { (value, text) ->
                FilterChip(
                    selected = selectedValue == value,
                    onClick = { onSelect(value) },
                    label = { Text(text, fontSize = 13.sp) }
                )
            }
        }
    }
}

/**
 * 单选列表的一个选项：稳定取值 + 标题 + 可选副标题，可单独禁用。
 */
data class SettingsRadioOption(
    val value: String,
    val title: String,
    val subtitle: String? = null,
    val enabled: Boolean = true
)

/**
 * 单选列表：Material3 RadioButton 行，适合「模式 / 目标层」这类互斥语义。
 *
 * 整行 [selectable] 负责点击，RadioButton 自身不接 onClick，避免行与按钮
 * 各触发一次。副标题用于展示第二行说明（如地址或行为差异）。
 */
@Composable
fun SettingsRadioList(
    options: List<SettingsRadioOption>,
    selectedValue: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    description: String? = null
) {
    Column(modifier = modifier.fillMaxWidth()) {
        if (label != null) {
            Text(
                text = label,
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
            )
        }
        if (description != null) {
            Text(
                text = description,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
            )
        }
        if (label != null || description != null) {
            Spacer(Modifier.height(SettingsSpacing.sm))
        }
        options.forEach { option ->
            val selected = option.value == selectedValue
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .selectable(
                        selected = selected,
                        enabled = option.enabled,
                        role = Role.RadioButton,
                        onClick = { onSelect(option.value) }
                    )
                    .padding(vertical = SettingsSpacing.xs),
                verticalAlignment = Alignment.CenterVertically
            ) {
                RadioButton(
                    selected = selected,
                    onClick = null,
                    enabled = option.enabled
                )
                Spacer(Modifier.width(SettingsSpacing.sm))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = option.title,
                        fontSize = 14.sp,
                        color = if (option.enabled) MaterialTheme.colorScheme.onSurface
                        else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                    )
                    option.subtitle?.let { subtitle ->
                        Text(
                            text = subtitle,
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                        )
                    }
                }
            }
        }
    }
}

/**
 * 数值选择器：FilterChip 预设 + 自定义数值输入，用于非时间单位（如「米」）。
 *
 * 与 [SettingsIntervalPicker] 的区别：单位与展示方式可定制，不做毫秒格式化。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsNumberPicker(
    label: String,
    value: Long,
    presets: List<Long>,
    unit: String,
    onValueChange: (Long) -> Unit,
    modifier: Modifier = Modifier,
    description: String? = null
) {
    var customText by remember { mutableStateOf("") }

    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = label,
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                modifier = Modifier.weight(1f)
            )
            Text(
                text = "当前：$value$unit",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
            )
        }
        if (description != null) {
            Text(
                text = description,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
            )
        }
        Spacer(Modifier.height(SettingsSpacing.sm))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(SettingsSpacing.sm),
            verticalArrangement = Arrangement.spacedBy(SettingsSpacing.xs)
        ) {
            presets.forEach { preset ->
                FilterChip(
                    selected = value == preset,
                    onClick = {
                        customText = ""
                        onValueChange(preset)
                    },
                    label = {
                        Text(
                            if (preset == 0L) "不限" else "$preset$unit",
                            fontSize = 13.sp
                        )
                    }
                )
            }
        }
        Spacer(Modifier.height(SettingsSpacing.sm))
        OutlinedTextField(
            value = customText,
            onValueChange = { raw ->
                customText = raw
                raw.toLongOrNull()?.let { if (it >= 0L) onValueChange(it) }
            },
            label = { Text("自定义数值") },
            placeholder = { Text("输入${unit}数值（如 50）") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Number,
                imeAction = ImeAction.Done
            ),
            suffix = { Text(unit) }
        )
    }
}

// ─── 音量滑块 ──────────────────────────────────────────────────

/**
 * 音量滑块：0-100 的整数音量，可选附带一个「试听」按钮。
 *
 * 用于提示音音量与 TTS 语音音量。值以百分比展示，拖动即时回调（由调用方负责持久化）。
 */
@Composable
fun SettingsVolumeSlider(
    label: String,
    value: Int,
    onValueChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
    description: String? = null,
    onTest: (() -> Unit)? = null,
    testLabel: String = "试听",
    testEnabled: Boolean = true
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = label,
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                modifier = Modifier.weight(1f)
            )
            Text(
                text = "$value%",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
            )
        }
        if (description != null) {
            Text(
                text = description,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
            )
        }
        Spacer(Modifier.height(SettingsSpacing.sm))
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Slider(
                value = value.toFloat(),
                onValueChange = { onValueChange(it.toInt().coerceIn(0, 100)) },
                valueRange = 0f..100f,
                steps = 99,
                modifier = Modifier.weight(1f)
            )
            if (onTest != null) {
                Spacer(Modifier.width(SettingsSpacing.md))
                OutlinedButton(onClick = onTest, enabled = testEnabled) {
                    Text(testLabel, fontSize = 13.sp)
                }
            }
        }
    }
}

// ─── 时刻列表编辑器 ────────────────────────────────────────────────

/** HH:mm 格式校验（24 小时制） */
private val TIME_HHMM_PATTERN = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")

/**
 * 时刻列表编辑器：增删每天的具体时刻（HH:mm）。
 *
 * 用于健康数据「定时时段」上传模式。输入非法格式时给出内联错误提示。
 */
@Composable
fun SettingsTimeListPicker(
    times: List<String>,
    onTimesChange: (List<String>) -> Unit,
    modifier: Modifier = Modifier
) {
    var input by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }

    fun addTime() {
        val candidate = input.trim()
        when {
            candidate.isEmpty() -> error = "请输入时刻，例如 08:00"
            !TIME_HHMM_PATTERN.matches(candidate) -> error = "格式应为 HH:mm（24 小时制）"
            else -> {
                onTimesChange((times + candidate).distinct().sorted())
                input = ""
                error = ""
            }
        }
    }

    Column(modifier = modifier.fillMaxWidth()) {
        if (times.isEmpty()) {
            Text(
                text = "尚未添加时刻",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
            )
        } else {
            times.forEach { time ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .minimumInteractiveComponentSize(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = time,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.weight(1f)
                    )
                    IconButton(onClick = { onTimesChange(times - time) }) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = "删除时刻 $time"
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(SettingsSpacing.sm))
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = {
                    input = it
                    error = ""
                },
                label = { Text("添加时刻 (HH:mm)") },
                placeholder = { Text("08:00") },
                singleLine = true,
                isError = error.isNotEmpty(),
                supportingText = { if (error.isNotEmpty()) Text(error) },
                modifier = Modifier.weight(1f),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Done
                ),
                keyboardActions = KeyboardActions(onDone = { addTime() })
            )
            Spacer(Modifier.width(SettingsSpacing.sm))
            Button(onClick = { addTime() }) {
                Text("添加")
            }
        }
    }
}

// ─── 子页面导航行 ──────────────────────────────────────────────────

/**
 * 概览页的子页面入口行：标题 + 副标题 + 右箭头。
 *
 * 发丝行形态：无卡片、无圆角、无底色，由外层 [SettingsSection] 提供表面与分隔线。
 * 整行可点击，最小点击区域 48dp。
 */
@Composable
fun SettingsNavRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .minimumInteractiveComponentSize()
            .clickable(onClick = onClick)
            .padding(horizontal = SettingsSpacing.lg, vertical = SettingsSpacing.md),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(Modifier.height(SettingsSpacing.xs / 2))
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = "进入$title",
            tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/**
 * 概览页「开关 + 子页面入口」行：标题 + 副标题 + 开关 + 可选右箭头。
 *
 * 与 [SettingsNavRow] 同为发丝行（无卡片、无圆角），由外层 [SettingsSection] 提供表面
 * 与分隔线；点击整行进入子页面，点击开关只切换开关（Switch 自带点击语义会消费事件，
 * 不会同时触发行点击）。
 */
@Composable
fun SettingsSwitchNavRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .minimumInteractiveComponentSize()
            .then(
                if (onClick != null) Modifier.clickable(onClick = onClick)
                else Modifier
            )
            .padding(horizontal = SettingsSpacing.lg, vertical = SettingsSpacing.md),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = if (enabled) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                }
            )
            Spacer(Modifier.height(SettingsSpacing.xs / 2))
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Spacer(Modifier.width(SettingsSpacing.md))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            enabled = enabled
        )
        if (onClick != null) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = "进入$title",
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

// ─── 一级设置行 ────────────────────────────────────────────────────

/**
 * 一级设置行：名称 + 状态摘要 + 可选开关 + 可选右箭头。
 *
 * 取代「可折叠卡片」作为一级页面（概览 / 数据采集）的主交互单元。交互约定：
 * - 传 [onCheckedChange] 时右侧显示开关，可在列表内直接开关；
 * - 传 [onClick] 时整行可点（开关以外的区域）进入二级配置页，并在右侧显示箭头；
 * - 两者都不传时退化为纯信息行。
 *
 * 详细配置一律放二级页，一级页只保留「一眼看清状态 + 快速开关」。
 */
@Composable
fun SettingsRow(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    checked: Boolean? = null,
    onCheckedChange: ((Boolean) -> Unit)? = null,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(SettingsShape.card),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .minimumInteractiveComponentSize()
                .then(
                    if (onClick != null) Modifier.clickable(onClick = onClick)
                    else Modifier
                )
                .padding(SettingsSpacing.lg),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (enabled) MaterialTheme.colorScheme.onSurface
                    else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                )
                Spacer(Modifier.height(SettingsSpacing.xs / 2))
                Text(
                    text = subtitle,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
            }
            if (onCheckedChange != null && checked != null) {
                Spacer(Modifier.width(SettingsSpacing.md))
                Switch(
                    checked = checked,
                    onCheckedChange = onCheckedChange,
                    enabled = enabled
                )
            }
            if (onClick != null) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = "进入$title",
                    tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
            }
        }
    }
}

// ─── VAD 实时电平条 ────────────────────────────────────────────────

/**
 * VAD 实时电平条（「声音」卡片内使用）。
 *
 * 横向展示当前麦克风电平与 VAD 触发阈值的相对位置，用于实测判断当前环境下
 * VAD 的触发难易程度。颜色语义：绿=已越过阈值，橙=低于阈值，灰=采集未运行。
 *
 * 电平范围为 -80 dBFS（静音端）~ 0 dBFS（满量程），阈值以红色竖线标出。
 *
 * @param dbLevel 当前电平（dBFS，-80 ~ 0），由 AudioCollector 每帧写入
 * @param thresholdDbfs VAD 触发阈值（dBFS），由 ViewModel 依 AudioCollector.RMS_THRESHOLD 换算
 * @param vadStatus 采集器上报的 VAD 状态（idle / listening / speaking）
 * @param active 音频采集是否开启；未开启时电平恒为 -80，指示条无参考意义
 */
@Composable
fun VadLevelBar(
    dbLevel: Float,
    thresholdDbfs: Float,
    vadStatus: String,
    active: Boolean,
    modifier: Modifier = Modifier
) {
    val minDb = -80f
    val maxDb = 0f
    val span = maxDb - minDb
    val ratio = ((dbLevel - minDb) / span).coerceIn(0f, 1f)
    val thresholdRatio = ((thresholdDbfs - minDb) / span).coerceIn(0f, 1f)
    val triggered = dbLevel >= thresholdDbfs

    val trackColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f)
    val fillColor = when {
        !active -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.25f)
        triggered -> VadColors.triggered
        else -> VadColors.below
    }
    val statusLabel = when (vadStatus) {
        "speaking" -> "说话"
        "listening" -> "监听"
        "idle" -> "静音"
        else -> vadStatus
    }

    Column(modifier = modifier.fillMaxWidth()) {
        Canvas(
            modifier = Modifier
                .fillMaxWidth()
                .height(16.dp)
        ) {
            val corner = size.height / 2f
            // 轨道
            drawRoundRect(
                color = trackColor,
                cornerRadius = CornerRadius(corner, corner)
            )
            // 当前电平填充（至少一个半圆宽度，避免极小值不可见）
            val fillWidth = size.width * ratio
            if (fillWidth > 0f) {
                drawRoundRect(
                    color = fillColor,
                    size = Size(
                        width = fillWidth.coerceAtLeast(size.height).coerceAtMost(size.width),
                        height = size.height
                    ),
                    cornerRadius = CornerRadius(corner, corner)
                )
            }
            // 阈值参考线
            val thresholdX = size.width * thresholdRatio
            drawLine(
                color = VadColors.threshold,
                start = Offset(thresholdX, 0f),
                end = Offset(thresholdX, size.height),
                strokeWidth = 2.dp.toPx()
            )
        }

        Spacer(Modifier.height(6.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = if (active) "当前 %.1f dBFS".format(dbLevel) else "采集未运行",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
            )
            Text(
                text = "阈值 %.1f dBFS".format(thresholdDbfs),
                fontSize = 11.sp,
                color = VadColors.threshold.copy(alpha = 0.85f)
            )
        }

        Spacer(Modifier.height(2.dp))
        Text(
            text = when {
                !active -> "开启「声音」采集后可查看实时电平"
                triggered -> "已触发 VAD · 状态 $statusLabel"
                else -> "未触发 · 状态 $statusLabel"
            },
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
        )
    }
}

/** VAD 电平条配色（集中定义，避免散落魔法值）。 */
private object VadColors {
    /** 已越过阈值 */
    val triggered = Color(0xFF4CAF50)

    /** 低于阈值 */
    val below = Color(0xFFFFA726)

    /** 阈值参考线 */
    val threshold = Color(0xFFE53935)
}

// ─── 端侧唤醒词测试面板 ────────────────────────────────────────────

/**
 * 端侧唤醒词（KWS）测试面板，用于实测模型在真机上的效果。
 *
 * 与 [VadLevelBar] 同源：数据来自 AudioCollector 的录音循环，经 SensorStateHolder 暴露。
 * 展示状态、累计命中次数与最近一次命中时刻；不参与任何推流决策。
 *
 * @param status KWS 状态（未启用 / 模型不可用 / 监听中 / 已命中）
 * @param hitCount 本次运行累计命中次数
 * @param lastHit 最近一次命中（唤醒词 · HH:mm:ss），空串表示尚未命中
 * @param active 音频采集是否开启；未开启时 KWS 不运行
 */
@Composable
fun KwsTestPanel(
    status: String,
    hitCount: Int,
    lastHit: String,
    active: Boolean,
    cloudTestResult: String = "",
    modifier: Modifier = Modifier
) {
    val accent = when {
        !active -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.25f)
        hitCount > 0 -> VadColors.triggered
        else -> VadColors.below
    }

    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "唤醒词测试",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = if (active) status else "未启用",
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = accent
            )
        }
        Spacer(Modifier.height(4.dp))
        Text(
            text = if (hitCount > 0) "命中 $hitCount 次" else "尚未命中",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
        )
        if (lastHit.isNotBlank()) {
            Spacer(Modifier.height(2.dp))
            Text(
                text = "最近：$lastHit",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
            )
        }
        Spacer(Modifier.height(2.dp))
        Text(
            text = if (active) "对着手机说出唤醒词即可测试端侧模型" else "开启「声音」采集后可用",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
        )
        if (cloudTestResult.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(
                text = "云端测试：$cloudTestResult",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
            )
        }
    }
}

// ─── 端侧唤醒设置面板 ──────────────────────────────────────────────

/**
 * 端侧唤醒（KWS）设置面板：开关 + 检测参数 + 自定义唤醒词。
 *
 * 唤醒词需为拼音 token，中文由服务端 `POST /api/screen/wake_word/encode` 转换，
 * 因此输入框收中文、点击「转换并应用」后落盘生效。
 */
@Composable
fun KwsSettingsPanel(
    enabled: Boolean,
    score: Float,
    threshold: Float,
    keywordsInput: String,
    keywordsToken: String,
    encodeStatus: String,
    encoding: Boolean,
    cloudTestEnabled: Boolean,
    intervalMs: Int,
    onEnabledChange: (Boolean) -> Unit,
    onScoreChange: (Float) -> Unit,
    onThresholdChange: (Float) -> Unit,
    onKeywordsInputChange: (String) -> Unit,
    onEncode: () -> Unit,
    onClear: () -> Unit,
    onCloudTestChange: (Boolean) -> Unit,
    onIntervalChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
    showMasterSwitch: Boolean = true
) {
    Column(modifier = modifier.fillMaxWidth()) {
        if (showMasterSwitch) {
            SettingsSwitchItem(
                label = "端侧唤醒",
                description = "在本机运行唤醒词模型；开启后录音线程持续推理，会增加耗电",
                checked = enabled,
                onCheckedChange = onEnabledChange
            )
            Spacer(Modifier.height(8.dp))
        }
        SettingsSwitchItem(
            label = "云端唤醒测试",
            description = "推流时携带 test 参数：命中后云端只回推结果，不投递 AI、不落盘",
            checked = cloudTestEnabled,
            onCheckedChange = onCloudTestChange
        )
        if (!enabled) {
            if (!showMasterSwitch) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "先开启上一级的「语音唤醒」开关，这里的参数才会生效。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
            }
            return@Column
        }
        Spacer(Modifier.height(10.dp))
        KwsIntervalRow(intervalMs = intervalMs, onChange = onIntervalChange)

        Spacer(Modifier.height(10.dp))
        KwsParamSlider(
            label = "唤醒灵敏度（加权分）",
            hint = "越大越难触发",
            value = score,
            range = 1.0f..3.5f,
            onChange = onScoreChange
        )
        Spacer(Modifier.height(6.dp))
        KwsParamSlider(
            label = "判定阈值",
            hint = "越大越严格",
            value = threshold,
            range = 0.05f..0.90f,
            onChange = onThresholdChange
        )

        Spacer(Modifier.height(12.dp))
        Text(
            text = "唤醒词（中文，留空则用内置词表）",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = "可输入多个唤醒词，用逗号或换行分隔",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
        )
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(
            value = keywordsInput,
            onValueChange = onKeywordsInputChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = false,
            maxLines = 3,
            placeholder = { Text("例如：你好小飞、小飞小飞", fontSize = 13.sp) },
            textStyle = TextStyle(fontSize = 13.sp)
        )
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = onEncode, enabled = !encoding) {
                Text(if (encoding) "转换中..." else "转换并应用", fontSize = 13.sp)
            }
            Spacer(Modifier.width(8.dp))
            OutlinedButton(onClick = onClear, enabled = !encoding) {
                Text("恢复内置", fontSize = 13.sp)
            }
        }
        if (encodeStatus.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(
                text = encodeStatus,
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
            )
        }
        if (keywordsToken.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(
                text = "当前词表：\n$keywordsToken",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
            )
        }
        Spacer(Modifier.height(8.dp))
        Text(
            text = "修改以上参数后，需关闭再打开「声音」采集才能生效",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
        )
    }
}

/** 单个 KWS 数值参数：标签 + 提示 + 当前值 + 滑块。 */
/**
 * 端侧唤醒推理间隔选择（100 / 200 / 300 ms）。
 *
 * 间隔越长，每秒推理次数越少、越省电，唤醒延迟同量级增加（感知不明显）。
 * 引擎内部是**累积**而非跳帧采样，因此不会因间隔变长而丢音。
 */
@Composable
private fun KwsIntervalRow(
    intervalMs: Int,
    onChange: (Int) -> Unit
) {
    val options = listOf(100, 200, 300)
    Column(Modifier.fillMaxWidth()) {
        Text(
            text = "推理间隔 · 越短越灵敏，越长越省电",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
        )
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { ms ->
                val selected = intervalMs == ms
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .background(
                            if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                            else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f)
                        )
                        .clickable { onChange(ms) }
                        .padding(vertical = 9.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "${ms}ms",
                        fontSize = 12.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                        color = if (selected) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                    )
                }
            }
        }
    }
}

@Composable
private fun KwsParamSlider(
    label: String,
    hint: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    onChange: (Float) -> Unit
) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "$label · $hint",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
            )
            Text(
                text = "%.2f".format(value),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f)
            )
        }
        Slider(
            value = value,
            onValueChange = onChange,
            valueRange = range,
            modifier = Modifier.fillMaxWidth()
        )
    }
}
