package com.xehuri.kinship.ui.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.ui.theme.SettingsSpacing

/**
 * 后台运行与权限（概览 → 二级页）。
 *
 * 电池优化与厂商限制（[BatteryOptimizationContent]）和权限检查清单合并为一页；
 * 权限项点击后跳系统设置，返回或点「重新检查」时刷新权限矩阵。
 */
@Composable
fun BackgroundPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val permissionChecks by viewModel.permissionChecks.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshRunStatus() }

    val settingsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        viewModel.refreshRunStatus()
    }
    val openPermission: (PermissionCheck) -> Unit = { check ->
        try {
            settingsLauncher.launch(permissionSettingsIntent(context, check.key))
        } catch (_: Exception) {
            try {
                settingsLauncher.launch(appDetailsIntent(context))
            } catch (_: Exception) {
            }
        }
    }

    SettingsSubPageScaffold(title = "后台运行与权限", onBack = onBack) {
        item {
            SettingsGroup(title = "电池优化") {
                BatteryOptimizationContent()
            }
        }

        item {
            SettingsGroup(title = "权限检查") {
                PermissionChecklist(checks = permissionChecks, onOpen = openPermission)
                Spacer(Modifier.height(SettingsSpacing.sm))
                Button(
                    onClick = { viewModel.refreshRunStatus() },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("重新检查")
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "只列出与已开启数据源相关的权限，未启用的数据源显示「未启用所需」",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
            }
        }
    }
}
