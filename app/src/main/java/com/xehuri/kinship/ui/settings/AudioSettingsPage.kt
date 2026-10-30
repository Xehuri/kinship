package com.xehuri.kinship.ui.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 环境音频设置页（数据采集 → 环境音频）。
 *
 * 只包含「固定分段 + 批量上传」这条链路的两个参数：分段时长与上传频率。
 * 语音唤醒是完全独立的链路，其参数见 [WakeWordSettingsPage]。
 *
 * 开关不在这里 —— 位于上一级「数据采集」页的列表行上（可原地快速开关）。
 */
@Composable
fun AudioSettingsPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val audioSegmentMs by viewModel.audioSegmentMs.collectAsState()
    val audioUploadBatchMs by viewModel.audioUploadBatchMs.collectAsState()
    val audioUploadFormat by viewModel.audioUploadFormat.collectAsState()

    SettingsSubPageScaffold(title = "环境音频", onBack = onBack) {
        item {
            SettingsGroup(title = "分段与上传") {
                SettingsIntervalPicker(
                    label = "分段时长",
                    intervalMs = audioSegmentMs,
                    presetsMs = listOf(
                        60_000L, 300_000L, 600_000L, 1_800_000L
                    ),
                    onIntervalChange = { viewModel.setAudioSegmentMs(it) },
                    description = "每段的固定长度：录满即封段落盘，App 内不做语义切分；" +
                        "跨段的一句话由后端无缝流拼接后整体识别（改动立即生效，无需重启）"
                )
                Spacer(Modifier.height(8.dp))
                SettingsIntervalPicker(
                    label = "上传频率",
                    intervalMs = audioUploadBatchMs,
                    presetsMs = listOf(60_000L, 300_000L, 600_000L, 1_800_000L),
                    onIntervalChange = { viewModel.setAudioUploadBatchMs(it) },
                    description = "已封段先落盘保存，按此频率批量上传；" +
                        "停止采集或待上传过多时会立即上传，不会丢已录内容"
                )
                Spacer(Modifier.height(8.dp))
                SettingsChoicePicker(
                    label = "上传格式",
                    options = listOf(
                        "wav" to "WAV 原始",
                        "flac" to "FLAC 无损 -46%流量"
                    ),
                    selectedValue = audioUploadFormat,
                    onSelect = { viewModel.setAudioUploadFormat(it) },
                    description = "流量参考：WAV 约 2.76 GB/天，FLAC 约 1.50 GB/天（省 46%）。" +
                        "两档均为无损，FLAC 分析结果与 WAV 完全一致（改动下一段生效，无需重启）"
                )
            }
        }

        item {
            SettingsGroup(title = "说明") {
                Text(
                    text = "环境音频会写入按日增量数据（perception.jsonl），是 AI 分析日常的音频来源。" +
                        "语音唤醒是另一条独立链路，唤醒音频不进增量数据，只把识别结果作为语音指令发给 AI —— " +
                        "详见「语音唤醒」页。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                )
            }
        }
    }
}
