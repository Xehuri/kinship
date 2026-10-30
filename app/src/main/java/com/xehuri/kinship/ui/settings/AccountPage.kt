package com.xehuri.kinship.ui.settings

import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/** 账号与登录（概览 → 二级页）。登录区通过 Snackbar 反馈结果。 */
@Composable
fun AccountPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val snackbarHostState = remember { SnackbarHostState() }

    SettingsSubPageScaffold(
        title = "账号与登录",
        onBack = onBack,
        snackbarHostState = snackbarHostState
    ) {
        item {
            SettingsGroup(title = "登录") {
                LoginSection(
                    viewModel = viewModel,
                    snackbarHostState = snackbarHostState
                )
            }
        }
    }
}
