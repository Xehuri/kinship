package com.xehuri.kinship.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.ui.theme.SettingsSpacing
import com.xehuri.kinship.widget.WidgetColorPreset
import com.xehuri.kinship.widget.WidgetColorStore

/**
 * 昼夜色对选择器：卡片背景/文字两个槽位共用（T6 卡片颜色组）。
 *
 * 三模式一组：
 * - 恢复默认：[onClear]（store 双删键回代码色板）；currentPair=null 时置灰。
 * - 预置色板：FlowRow + FilterChip，每个预置带四段两色调色块（背景日/文字日/背景夜/
 *   文字夜各一段、16dp 高、描边防白底不可见），中文名即 chip 标签；
 *   选中态 = [currentPair] 与 [presetToPair] 对本预置的投影相等。
 * - 自定义 hex：日/夜两个输入框，内联错误口径克隆 SettingsTimeListPicker——
 *   合法性只经 [WidgetColorStore.normalizeHex] 判定（校验单一真源，UI 零 hex 正则复制），
 *   两组都填且都合法才走 [onApply]；半填只显示「两组都填色才可保存」提示，绝不写入。
 *
 * @param presetToPair 槽位投影：从预置取出本选择器关心的昼夜对
 *   （背景槽 = bgDay/bgNight，文字槽 = textDay/textNight）；选择器不自带槽位语义。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsColorPairPicker(
    label: String,
    currentPair: Pair<Int?, Int?>?,
    presetToPair: (WidgetColorPreset) -> Pair<Int, Int>,
    onApply: (dayArgb: Int, nightArgb: Int) -> Unit,
    onClear: () -> Unit,
    modifier: Modifier = Modifier,
    presets: List<WidgetColorPreset> = WidgetColorStore.PRESETS,
) {
    var dayText by remember { mutableStateOf("") }
    var nightText by remember { mutableStateOf("") }
    var dayError by remember { mutableStateOf("") }
    var nightError by remember { mutableStateOf("") }
    var pairHint by remember { mutableStateOf("") }

    val statusText = when {
        currentPair == null -> "未设置（默认色板）"
        else -> presets.firstOrNull { presetToPair(it) == currentPair }?.name
            ?.let { "预置：$it" } ?: "自定义"
    }

    fun commitCustom() {
        val dayRaw = dayText.trim()
        val nightRaw = nightText.trim()
        if (dayRaw.isEmpty() || nightRaw.isEmpty()) {
            dayError = if (dayRaw.isEmpty()) "必填" else ""
            nightError = if (nightRaw.isEmpty()) "必填" else ""
            pairHint = "两组都填色才可保存"
            return
        }
        val dayArgb = WidgetColorStore.normalizeHex(dayRaw)
        val nightArgb = WidgetColorStore.normalizeHex(nightRaw)
        dayError = if (dayArgb == null) "格式应为 #RRGGBB" else ""
        nightError = if (nightArgb == null) "格式应为 #RRGGBB" else ""
        pairHint = ""
        if (dayArgb != null && nightArgb != null) onApply(dayArgb, nightArgb)
    }

    Column(modifier = modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                modifier = Modifier.weight(1f),
            )
            Text(
                text = "当前：$statusText",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
            )
            TextButton(onClick = onClear, enabled = currentPair != null) {
                Text("恢复默认", fontSize = 13.sp)
            }
        }
        Spacer(Modifier.height(SettingsSpacing.sm))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(SettingsSpacing.sm),
            verticalArrangement = Arrangement.spacedBy(SettingsSpacing.xs),
        ) {
            presets.forEach { preset ->
                val slotPair = presetToPair(preset)
                FilterChip(
                    selected = currentPair == slotPair,
                    onClick = { onApply(slotPair.first, slotPair.second) },
                    label = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            PresetSwatch(preset)
                            Spacer(Modifier.width(SettingsSpacing.sm))
                            Text(preset.name, fontSize = 12.sp)
                        }
                    },
                )
            }
        }
        Spacer(Modifier.height(SettingsSpacing.sm))
        Row(horizontalArrangement = Arrangement.spacedBy(SettingsSpacing.sm)) {
            OutlinedTextField(
                value = dayText,
                onValueChange = {
                    dayText = it
                    dayError = ""
                    pairHint = ""
                },
                label = { Text("日间色") },
                placeholder = { Text("#RRGGBB") },
                singleLine = true,
                isError = dayError.isNotEmpty(),
                supportingText = { if (dayError.isNotEmpty()) Text(dayError) },
                modifier = Modifier.weight(1f),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { commitCustom() }),
            )
            OutlinedTextField(
                value = nightText,
                onValueChange = {
                    nightText = it
                    nightError = ""
                    pairHint = ""
                },
                label = { Text("夜间色") },
                placeholder = { Text("#RRGGBB") },
                singleLine = true,
                isError = nightError.isNotEmpty(),
                supportingText = { if (nightError.isNotEmpty()) Text(nightError) },
                modifier = Modifier.weight(1f),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { commitCustom() }),
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = pairHint,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.error.copy(alpha = 0.8f),
                modifier = Modifier.weight(1f),
            )
            Button(onClick = { commitCustom() }) {
                Text("保存", fontSize = 13.sp)
            }
        }
    }
}

/** 预置四段调色块：背景日/文字日/背景夜/文字夜各 10dp 宽、16dp 高；纯装饰，名称在 chip 标签 */
@Composable
private fun PresetSwatch(preset: WidgetColorPreset) {
    val shape = RoundedCornerShape(3.dp)
    Row(
        modifier = Modifier
            .clip(shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .height(16.dp),
    ) {
        Box(Modifier.width(10.dp).fillMaxHeight().background(Color(preset.bgDay)))
        Box(Modifier.width(10.dp).fillMaxHeight().background(Color(preset.textDay)))
        Box(Modifier.width(10.dp).fillMaxHeight().background(Color(preset.bgNight)))
        Box(Modifier.width(10.dp).fillMaxHeight().background(Color(preset.textNight)))
    }
}
