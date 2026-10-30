package com.xehuri.kinship.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.window.Dialog
import com.xehuri.kinship.ui.VoiceprintPanel

/**
 * 声纹管理：一级列表行，点击打开管理 Dialog。
 *
 * 2026-09-16 交互统一：由「分组卡片 + 按钮」改为列表行，与其他一级入口一致。
 * 行形态与概览页发丝行一致（[SettingsNavRow]），Dialog 行为不变。
 */
@Composable
fun VoiceprintSection(viewModel: SettingsViewModel) {
    val showVoiceprintPanel by viewModel.showVoiceprintPanel.collectAsState()
    val serverUrl by viewModel.serverUrl.collectAsState()

    SettingsNavRow(
        title = "声纹管理",
        subtitle = "查看与管理已注册的声纹样本（用于多说话人识别）",
        onClick = { viewModel.showVoiceprintPanel() }
    )

    if (showVoiceprintPanel) {
        Dialog(onDismissRequest = { viewModel.dismissVoiceprintPanel() }) {
            VoiceprintPanel(
                onClose = { viewModel.dismissVoiceprintPanel() },
                serverUrl = serverUrl
            )
        }
    }
}
