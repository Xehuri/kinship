package com.xehuri.kinship.ui.settings

import android.content.Intent
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 系统状态设置页（数据采集 → 系统状态）。
 *
 * 四个子开关各自的权限引导放在本页（前台应用需「使用情况访问」、WiFi 需定位、
 * 蓝牙需 BLUETOOTH_CONNECT），整体开关与摘要仍在上一级列表行上。
 */
@Composable
fun SystemStateSettingsPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val context = LocalContext.current

    val foregroundEnabled by viewModel.foregroundEnabled.collectAsState()
    val wifiEnabled by viewModel.wifiEnabled.collectAsState()
    val bluetoothEnabled by viewModel.bluetoothEnabled.collectAsState()
    val screenStateEnabled by viewModel.screenStateEnabled.collectAsState()
    val systemStateIntervalMs by viewModel.systemStateIntervalMs.collectAsState()

    var showUsageStatsDialog by remember { mutableStateOf(false) }

    val usageStatsSettingsLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { /* 从设置页返回后由全局权限轮询刷新 UI */ }

    val locationPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions()
    ) { /* 定位权限：授权后需再次点开关（与既有行为一致） */ }

    val bluetoothPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            viewModel.toggleSensor("bluetooth", true)
            ensureServiceRunning(context, true)
        }
    }

    SettingsSubPageScaffold(title = "系统状态", onBack = onBack) {
        item {
            SettingsGroup(title = "采集项") {
                SettingsSwitchItem(
                    label = "前台应用",
                    description = "当前运行的应用信息（需使用情况访问权限）",
                    checked = foregroundEnabled,
                    onCheckedChange = { enabled ->
                        if (enabled && !hasUsageStatsPermission(context)) {
                            showUsageStatsDialog = true
                        } else {
                            viewModel.toggleSensor("foreground", enabled)
                            ensureServiceRunning(context, enabled)
                        }
                    }
                )
                HorizontalDividerCompact()
                SettingsSwitchItem(
                    label = "WiFi / 移动数据",
                    description = "WiFi 名称、信号强度、网络类型（读取 WiFi 名称需定位权限）",
                    checked = wifiEnabled,
                    onCheckedChange = { enabled ->
                        if (enabled && !hasLocationPermission(context)) {
                            locationPermissionLauncher.launch(
                                arrayOf(
                                    android.Manifest.permission.ACCESS_FINE_LOCATION,
                                    android.Manifest.permission.ACCESS_COARSE_LOCATION
                                )
                            )
                        } else {
                            viewModel.toggleSensor("wifi", enabled)
                            ensureServiceRunning(context, enabled)
                        }
                    }
                )
                HorizontalDividerCompact()
                SettingsSwitchItem(
                    label = "蓝牙",
                    description = "已连接的蓝牙设备列表（Android 12+ 需附近设备权限）",
                    checked = bluetoothEnabled,
                    onCheckedChange = { enabled ->
                        if (enabled && Build.VERSION.SDK_INT >= 31 &&
                            !hasRuntimePermission(context, android.Manifest.permission.BLUETOOTH_CONNECT)
                        ) {
                            bluetoothPermissionLauncher.launch(
                                android.Manifest.permission.BLUETOOTH_CONNECT
                            )
                        } else {
                            viewModel.toggleSensor("bluetooth", enabled)
                            ensureServiceRunning(context, enabled)
                        }
                    }
                )
                HorizontalDividerCompact()
                SettingsSwitchItem(
                    label = "锁屏状态",
                    description = "检测屏幕是否锁定",
                    checked = screenStateEnabled,
                    onCheckedChange = { enabled ->
                        viewModel.toggleSensor("screen", enabled)
                        ensureServiceRunning(context, enabled)
                    }
                )
            }
        }

        item {
            SettingsGroup(title = "采集间隔") {
                SettingsIntervalPicker(
                    label = "系统状态采集间隔",
                    intervalMs = systemStateIntervalMs,
                    presetsMs = listOf(1_000L, 15_000L, 30_000L, 60_000L),
                    onIntervalChange = { viewModel.setSystemStateIntervalMs(it) }
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "间隔越短采集越及时，耗电也越高；前台应用 / 媒体 / WiFi / 蓝牙 / 屏幕共用此间隔。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
            }
        }
    }

    if (showUsageStatsDialog) {
        AlertDialog(
            onDismissRequest = { showUsageStatsDialog = false },
            title = { Text("使用情况访问权限") },
            text = { Text("需要开启「使用情况访问」权限才能读取当前前台应用信息。请在系统设置中为「Kinship」开启此权限。") },
            confirmButton = {
                Button(onClick = {
                    showUsageStatsDialog = false
                    usageStatsSettingsLauncher.launch(Intent(android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS))
                }) { Text("去设置") }
            },
            dismissButton = { TextButton(onClick = { showUsageStatsDialog = false }) { Text("取消") } }
        )
    }
}
