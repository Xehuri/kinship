package com.xehuri.kinship.ui.settings

import androidx.compose.runtime.Composable

/** 高级（概览 → 二级页）：OTA 更新 + 服务日志。 */
@Composable
fun AdvancedPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    SettingsSubPageScaffold(title = "高级", onBack = onBack) {
        item {
            SettingsGroup(title = "系统更新与日志") {
                AdvancedSection(viewModel = viewModel)
            }
        }
    }
}
