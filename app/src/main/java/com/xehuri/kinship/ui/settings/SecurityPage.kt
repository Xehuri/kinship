package com.xehuri.kinship.ui.settings

import androidx.compose.runtime.Composable

/** 安全设置（概览 → 二级页）：SSL 证书验证。 */
@Composable
fun SecurityPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    SettingsSubPageScaffold(title = "安全", onBack = onBack) {
        item {
            SettingsGroup(title = "SSL 证书") {
                SecurityContent(viewModel = viewModel)
            }
        }
    }
}
