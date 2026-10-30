package com.xehuri.kinship.ui.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.xehuri.kinship.ui.theme.SettingsSpacing

/** 运行状态页：采集服务 / 上传 / 缓存 / 连接 / 同步 / 电池 + 权限矩阵与快捷操作。 */
@Composable
fun RunStatusPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit,
    onOpenDataCollection: () -> Unit,
    onOpenNetwork: () -> Unit,
    onOpenBackground: () -> Unit,
) {
    val context = LocalContext.current
    val serviceRunning by viewModel.serviceRunning.collectAsState()
    val uploadEnabled by viewModel.uploadEnabled.collectAsState()
    val cacheEnabled by viewModel.cacheEnabled.collectAsState()
    val tierConfig by viewModel.tierConfig.collectAsState()
    val syncText by viewModel.syncStatusText.collectAsState()
    val permissionChecks by viewModel.permissionChecks.collectAsState()
    val batteryOptimized by viewModel.batteryOptimized.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshRunStatus() }

    val state = RunStatusState(
        serviceRunning = serviceRunning,
        uploadEnabled = uploadEnabled,
        cacheEnabled = cacheEnabled,
        networkLabel = RunStatusModel.activeTierLabel(tierConfig),
        networkMode = tierConfig.selection.mode.name,
        syncText = syncText,
        batteryOptimized = batteryOptimized,
        permissions = permissionChecks,
    )
    val pending = RunStatusModel.pendingRequired(state)

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

    SettingsSubPageScaffold(title = "运行状态", onBack = onBack) {
        item {
            RunStatusCard(
                title = "运行状态",
                subtitle = RunStatusModel.summary(state),
                healthy = pending.isEmpty() && state.serviceRunning,
            )
        }

        item {
            SettingsGroup(title = "运行") {
                SettingsInfoItem("采集服务", if (state.serviceRunning) "运行中" else "已停止")
                SettingsInfoItem("上传", if (state.uploadEnabled) "已开启" else "已停用")
                SettingsInfoItem("离线缓存", if (state.cacheEnabled) "已开启" else "已停用")
                SettingsInfoItem("当前连接", connectionText(state))
                SettingsInfoItem("最近同步", state.syncText.ifBlank { "尚未同步" })
                SettingsInfoItem("电池优化", if (state.batteryOptimized) "已忽略" else "未设置")
            }
        }

        item {
            SettingsGroup(title = "权限") {
                PermissionChecklist(checks = state.permissions, onOpen = openPermission)
                Spacer(Modifier.height(SettingsSpacing.sm))
                Button(
                    onClick = { viewModel.refreshRunStatus() },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("重新检查")
                }
            }
        }

        item {
            SettingsGroup(title = "操作") {
                SettingsNavRow(
                    title = "立即同步",
                    subtitle = state.syncText.ifBlank { "触发一次同步" },
                    onClick = { viewModel.syncNow() },
                )
                SettingsSectionDivider()
                SettingsNavRow(
                    title = "打开采集设置",
                    subtitle = "数据源与上传开关",
                    onClick = onOpenDataCollection,
                )
                SettingsSectionDivider()
                SettingsNavRow(
                    title = "打开网络设置",
                    subtitle = "连接层与选择模式",
                    onClick = onOpenNetwork,
                )
                SettingsSectionDivider()
                SettingsNavRow(
                    title = "打开后台运行与权限",
                    subtitle = "电池优化 · 权限检查 · 厂商限制",
                    onClick = onOpenBackground,
                )
            }
        }
    }
}

private fun connectionText(state: RunStatusState): String {
    val label = state.networkLabel.trim().ifBlank { "未配置连接层" }
    val mode = RunStatusModel.networkModeLabel(state.networkMode).ifBlank { "未配置模式" }
    return "$label · $mode"
}
