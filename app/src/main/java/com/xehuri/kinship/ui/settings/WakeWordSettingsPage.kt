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
 * 语音唤醒设置页（数据采集 → 语音唤醒）。
 *
 * 端侧 KWS（`LocalKwsEngine`）在录音线程持续推理，命中后按需把音频推给后端做
 * 声纹进门验证 → 录制 → ASR，产出是投递给主会话的语音指令。
 *
 * 与环境音频是**两条独立链路**：唤醒音频不进增量数据，也不会写 perception.jsonl。
 *
 * 总开关不在这里 —— 位于上一级「数据采集」页的列表行上（可原地快速开关）。
 */
@Composable
fun WakeWordSettingsPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val audioEnabled by viewModel.audioEnabled.collectAsState()
    val localKwsEnabled by viewModel.localKwsEnabled.collectAsState()
    val kwsStatus by viewModel.kwsStatus.collectAsState()
    val kwsHitCount by viewModel.kwsHitCount.collectAsState()
    val kwsLastHit by viewModel.kwsLastHit.collectAsState()
    val kwsScore by viewModel.kwsScore.collectAsState()
    val kwsThreshold by viewModel.kwsThreshold.collectAsState()
    val kwsKeywordsInput by viewModel.kwsKeywordsInput.collectAsState()
    val kwsKeywordsToken by viewModel.kwsKeywordsToken.collectAsState()
    val kwsEncodeStatus by viewModel.kwsEncodeStatus.collectAsState()
    val kwsEncoding by viewModel.kwsEncoding.collectAsState()
    val kwsCloudTestEnabled by viewModel.kwsCloudTestEnabled.collectAsState()
    val kwsCloudTestResult by viewModel.kwsCloudTestResult.collectAsState()
    val kwsIntervalMs by viewModel.kwsIntervalMs.collectAsState()

    SettingsSubPageScaffold(title = "语音唤醒", onBack = onBack) {
        if (!audioEnabled) {
            item {
                SettingsGroup(title = "前置条件") {
                    Text(
                        text = "语音唤醒依赖麦克风。请先在「概览 → 采集与上传 → 环境音频」中开启采集，否则唤醒不会生效。",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.error.copy(alpha = 0.85f)
                    )
                }
            }
        }

        item {
            SettingsGroup(title = "唤醒状态") {
                KwsTestPanel(
                    status = kwsStatus,
                    hitCount = kwsHitCount,
                    lastHit = kwsLastHit,
                    active = audioEnabled && localKwsEnabled,
                    cloudTestResult = kwsCloudTestResult
                )
            }
        }

        item {
            SettingsGroup(title = "识别参数") {
                Text(
                    text = "改动会立即重建唤醒引擎生效（约 1 秒空档，不影响环境音频的连续录制）。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
                Spacer(Modifier.height(10.dp))
                KwsSettingsPanel(
                    enabled = localKwsEnabled,
                    score = kwsScore,
                    threshold = kwsThreshold,
                    keywordsInput = kwsKeywordsInput,
                    keywordsToken = kwsKeywordsToken,
                    encodeStatus = kwsEncodeStatus,
                    encoding = kwsEncoding,
                    onEnabledChange = { viewModel.setLocalKwsEnabled(it) },
                    onScoreChange = { viewModel.setKwsScore(it) },
                    onThresholdChange = { viewModel.setKwsThreshold(it) },
                    onKeywordsInputChange = { viewModel.setKwsKeywordsInput(it) },
                    onEncode = { viewModel.encodeKwsKeywords() },
                    onClear = { viewModel.clearKwsKeywords() },
                    cloudTestEnabled = kwsCloudTestEnabled,
                    onCloudTestChange = { viewModel.setKwsCloudTestEnabled(it) },
                    intervalMs = kwsIntervalMs,
                    onIntervalChange = { viewModel.setKwsIntervalMs(it) },
                    // 总开关已提到上一级列表行，这里不重复显示
                    showMasterSwitch = false
                )
            }
        }

    }
}
