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
 * 声音与播报（概览 → 设备与运行 → 二级页）。
 *
 * 从「语音唤醒」页拆出的独立声音入口，只负责两件事：
 * 1. 提示音音量（唤醒确认 / 录制结束双音，由本机 HintTonePlayer 播放）；
 * 2. TTS 语音音量（后端合成，网页播放器与本地试听共用同一 prefs 值）。
 *
 * 两个 prefs 键保持不变（hint_tone_volume / tts_volume），消费方无需迁移。
 */
@Composable
fun SoundPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val hintToneVolume by viewModel.hintToneVolume.collectAsState()
    val ttsVolume by viewModel.ttsVolume.collectAsState()
    val ttsTestStatus by viewModel.ttsTestStatus.collectAsState()
    val ttsTestLoading by viewModel.ttsTestLoading.collectAsState()

    SettingsSubPageScaffold(title = "声音与播报", onBack = onBack) {
        item {
            SettingsGroup(title = "提示音") {
                SettingsVolumeSlider(
                    label = "提示音音量",
                    description = "唤醒确认 / 录制结束双音提示音的响度",
                    value = hintToneVolume,
                    onValueChange = { viewModel.setHintToneVolume(it) },
                    onTest = { viewModel.testHintTone() }
                )
            }
        }

        item {
            SettingsGroup(title = "AI 语音回复") {
                SettingsVolumeSlider(
                    label = "TTS 语音音量",
                    description = "AI 语音回复的播放响度（网页播放器与本地试听）",
                    value = ttsVolume,
                    onValueChange = { viewModel.setTtsVolume(it) },
                    onTest = { viewModel.testTts() },
                    testEnabled = !ttsTestLoading
                )
                if (ttsTestStatus.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = ttsTestStatus,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                    )
                }
            }
        }

        item {
            SettingsGroup(title = "说明") {
                Text(
                    text = "提示音是本机唤醒/录制双音；TTS 由后端合成，" +
                        "网页播放器与本地试听共用同一音量。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                )
            }
        }
    }
}
