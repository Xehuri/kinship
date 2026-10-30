package com.xehuri.kinship.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 通知子页面。
 *
 * 包含三块：
 * 1. 通知采集开关（复用既有 notification_enabled）；
 * 2. 通知上行开关 + 上行间隔（新增，默认关闭）；
 * 3. 敏感应用黑名单编辑器（命中黑名单的应用只上传 package + 时间戳元数据）。
 */
@Composable
fun NotificationPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val context = LocalContext.current
    val notificationEnabled by viewModel.notificationEnabled.collectAsState()
    val notifyUploadEnabled by viewModel.notifyUploadEnabled.collectAsState()
    val notifyInterval by viewModel.notifyInterval.collectAsState()
    val sensitiveApps by viewModel.sensitiveApps.collectAsState()
    val installedApps by viewModel.installedApps.collectAsState()
    val installedAppsLoading by viewModel.installedAppsLoading.collectAsState()

    // 黑名单兼容逗号/换行/分号分隔（与 NotificationCollector 解析口径一致）
    val packages = remember(sensitiveApps) {
        sensitiveApps.split(',', '\n', ';')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
    }
    var newPackage by remember { mutableStateOf("") }
    var showAppPicker by remember { mutableStateOf(false) }

    SettingsSubPageScaffold(title = "通知", onBack = onBack) {
        // ── 总开关（读取 + 上传合并为一个）─────────────────────────
        item {
            SettingsGroup(title = "通知") {
                SettingsSwitchItem(
                    label = "读取并上传通知",
                    description = "读取系统通知（需通知监听权限），按 sbn.key 去重更新后写入感知数据流供 AI 读取",
                    checked = notificationEnabled && notifyUploadEnabled,
                    onCheckedChange = { enabled ->
                        if (enabled && !hasNotificationListenerPermission(context)) {
                            // 权限引导由全局 PermissionDialogs 统一弹出（授权后自动回填开关）
                            viewModel.showNotificationListenerDialog()
                        } else {
                            viewModel.setNotificationEnabled(enabled)
                            ensureServiceRunning(context, enabled)
                        }
                    }
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "关闭后既不读取本机通知也不上传；此前已上传的数据不受影响。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "发送时机由主循环统一决定（「采集总控 → 上传与调度间隔」，默认 30 秒）：" +
                        "采集到的通知先入队，到点与其他感知事件一并上传。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
            }
        }

        // ── 通知检查（notify_ms：计数/内容轮询间隔，与上传循环解耦）────
        item {
            SettingsGroup(title = "通知检查") {
                SettingsIntervalPicker(
                    label = "通知检查间隔",
                    intervalMs = notifyInterval.toLong(),
                    presetsMs = listOf(3000L, 5000L, 10000L, 30000L),
                    onIntervalChange = { viewModel.setNotifyInterval(it.toInt()) },
                    description = "控制通知数量与内容变化的轮询频率（notify_ms）；" +
                        "与主循环的上传间隔相互独立——检查到的新通知先入队，仍由主循环统一上传。"
                )
            }
        }

        // ── 敏感应用黑名单 ────────────────────────────────────────
        item {
            SettingsGroup(title = "敏感应用（黑名单）") {
                Text(
                    text = "命中黑名单的应用，通知只上传 package 与时间戳元数据，不上传标题和正文。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                )
                Spacer(Modifier.height(8.dp))

                // 主入口：从已安装应用中选择
                Button(
                    onClick = { showAppPicker = true },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("从已安装应用中选择（已选 ${packages.size}）")
                }
                Spacer(Modifier.height(8.dp))

                if (packages.isEmpty()) {
                    Text(
                        text = "尚未添加敏感应用",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                    )
                } else {
                    packages.forEach { pkg ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = pkg,
                                fontSize = 13.sp,
                                fontFamily = FontFamily.Monospace,
                                modifier = Modifier.weight(1f)
                            )
                            IconButton(
                                onClick = {
                                    viewModel.setSensitiveApps(
                                        packages.filter { it != pkg }.joinToString(",")
                                    )
                                }
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Close,
                                    contentDescription = "移出黑名单 $pkg"
                                )
                            }
                        }
                    }
                }

                HorizontalDividerCompact()
                Spacer(Modifier.height(4.dp))
                // 次入口：枚举不到的应用仍可按包名手动添加
                Text(
                    text = "手动添加包名（选择器未列出的应用）",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                )
                Spacer(Modifier.height(4.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedTextField(
                        value = newPackage,
                        onValueChange = { newPackage = it },
                        label = { Text("应用包名") },
                        placeholder = { Text("com.example.app") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Text,
                            imeAction = ImeAction.Done
                        ),
                        keyboardActions = KeyboardActions(
                            onDone = {
                                val pkg = newPackage.trim()
                                if (pkg.isNotEmpty() && pkg !in packages) {
                                    viewModel.setSensitiveApps(
                                        (packages + pkg).joinToString(",")
                                    )
                                    newPackage = ""
                                }
                            }
                        )
                    )
                    Spacer(Modifier.width(0.dp))
                    Button(
                        onClick = {
                            val pkg = newPackage.trim()
                            if (pkg.isNotEmpty() && pkg !in packages) {
                                viewModel.setSensitiveApps(
                                    (packages + pkg).joinToString(",")
                                )
                                newPackage = ""
                            }
                        }
                    ) {
                        Text("添加")
                    }
                }
            }
        }
    }

    // ── 敏感应用选择器（全屏对话框） ──────────────────────────────
    if (showAppPicker) {
        SensitiveAppPickerDialog(
            apps = installedApps,
            loading = installedAppsLoading,
            preselected = packages.toSet(),
            onRequestLoad = { viewModel.loadInstalledApps() },
            onDismiss = { showAppPicker = false },
            onConfirm = { selected ->
                // 统一回写为逗号分隔包名，保持既有存储格式（NotificationCollector 无需迁移）
                viewModel.setSensitiveApps(selected.sorted().joinToString(","))
                showAppPicker = false
            }
        )
    }
}
