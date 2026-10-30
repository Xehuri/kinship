package com.xehuri.kinship.ui.settings

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 健康数据子页面。
 *
 * 包含上传模式（定时时段 | 间隔）、间隔/时段配置，以及 Gadgetbridge 手环数据库路径选择。
 */
@Composable
fun HealthDataPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val context = LocalContext.current

    val healthUploadMode by viewModel.healthUploadMode.collectAsState()
    val healthScheduleTimes by viewModel.healthScheduleTimes.collectAsState()
    val healthIntervalMs by viewModel.healthIntervalMs.collectAsState()
    val dbFilePath by viewModel.dbFilePath.collectAsState()

    var showBandKeyDialog by remember { mutableStateOf(false) }
    var storageGranted by remember { mutableStateOf(hasHealthDataAccess(context)) }

    val manageStorageLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) {
        storageGranted = hasHealthDataAccess(context)
    }

    val dbFilePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            try {
                // 持久化 content URI 权限（Android 11+ SAF 需要）
                try {
                    context.contentResolver.takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (_: Exception) { }
                viewModel.setDbUri(uri.toString())
                storageGranted = hasHealthDataAccess(context)
                // 尝试提取 internal storage 路径（仅 primary 分区可靠）
                try {
                    val docId = android.provider.DocumentsContract.getDocumentId(uri)
                    val parts = docId.split(":")
                    if (parts.size >= 2 && "primary".equals(parts[0], ignoreCase = true)) {
                        val realPath = "/storage/emulated/0/${parts.subList(1, parts.size).joinToString(":")}"
                        viewModel.setDbPath(realPath)
                    }
                } catch (_: Exception) { }
            } catch (_: Exception) { }
        }
    }

    SettingsSubPageScaffold(title = "健康数据", onBack = onBack) {
        // ── 采集开关（只读说明：开关在概览行内） ──────────────────
        item {
            SettingsGroup(title = "采集开关") {
                Text(
                    text = "采集开关在概览「采集与上传 → 健康与手环」中切换。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                )
            }
        }

        // ── 存储权限 ──────────────────────────────────────────────
        if (!storageGranted) {
            item {
                SettingsGroup(title = "存储权限") {
                    Text(
                        text = "未授予「所有文件访问权限」，可能无法直接读取手环数据库。",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.error.copy(alpha = 0.8f)
                    )
                    Spacer(Modifier.height(4.dp))
                    OutlinedButton(
                        onClick = {
                            if (Build.VERSION.SDK_INT >= 30) {
                                manageStorageLauncher.launch(
                                    Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                                        .apply { data = Uri.parse("package:${context.packageName}") }
                                )
                            } else {
                                manageStorageLauncher.launch(
                                    Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                                        .apply { data = Uri.parse("package:${context.packageName}") }
                                )
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("去授予存储权限")
                    }
                }
            }
        }

        // ── 上传模式 ──────────────────────────────────────────────
        item {
            SettingsGroup(title = "上传模式") {
                Text(
                    text = "定时时段用于减少同步次数，不要求精确时刻（服务内按主循环判断）。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                )
                Spacer(Modifier.height(8.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    FilterChip(
                        selected = healthUploadMode == "schedule",
                        onClick = { viewModel.setHealthUploadMode("schedule") },
                        label = { Text("定时时段", fontSize = 13.sp) }
                    )
                    FilterChip(
                        selected = healthUploadMode == "interval",
                        onClick = { viewModel.setHealthUploadMode("interval") },
                        label = { Text("间隔", fontSize = 13.sp) }
                    )
                }
                Spacer(Modifier.height(12.dp))
                if (healthUploadMode == "schedule") {
                    SettingsTimeListPicker(
                        times = healthScheduleTimes.split(",").map { it.trim() }.filter { it.isNotEmpty() },
                        onTimesChange = { viewModel.setHealthScheduleTimes(it.joinToString(",")) }
                    )
                } else {
                    SettingsIntervalPicker(
                        label = "健康数据上传间隔",
                        intervalMs = healthIntervalMs,
                        presetsMs = listOf(600_000L, 1_800_000L, 3_600_000L),
                        onIntervalChange = { viewModel.setHealthIntervalMs(it) }
                    )
                }
            }
        }

        // ── 手环数据库 ────────────────────────────────────────────
        item {
            SettingsGroup(title = "手环数据库") {
                Text(
                    text = "当前路径",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = dbFilePath,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                    maxLines = 2
                )
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = { dbFilePickerLauncher.launch(arrayOf("*/*")) },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("选择数据库文件")
                }
                TextButton(
                    onClick = { showBandKeyDialog = true },
                    modifier = Modifier.padding(top = 2.dp)
                ) {
                    Text(
                        text = "如何获取手环 Auth Key？",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.7f)
                    )
                }
            }
        }
    }

    if (showBandKeyDialog) {
        BandKeyGuideDialog(onDismiss = { showBandKeyDialog = false })
    }
}

/**
 * 手环数据采集设置指南弹窗（从旧 SensorControls 原样迁移）。
 */
@Composable
private fun BandKeyGuideDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("手环数据采集设置") },
        text = {
            Column(modifier = Modifier.padding(vertical = 4.dp)) {
                Text("首次使用按以下步骤操作：", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Spacer(Modifier.height(8.dp))
                Text("1. Gadgetbridge 设置 -> 自动化 -> 自动导出数据库 -> 开启", fontSize = 13.sp)
                Text("2. 导出间隔设为一小时（不改也行）", fontSize = 13.sp)
                Text("3. 点击「立即运行自动导出」", fontSize = 13.sp)
                Spacer(Modifier.height(4.dp))
                Text("4. 返回 Kinship -> 选择数据库文件", fontSize = 13.sp)
                Text("5. 选中 Gadgetbridge 导出的 .db 文件", fontSize = 13.sp)
                Text("6. 下方健康数据区域验证是否能读到数据", fontSize = 13.sp)
                Spacer(Modifier.height(8.dp))
                Text(
                    "确认数据可读后，开启蓝牙 Intent API：",
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp
                )
                Spacer(Modifier.height(4.dp))
                Text("7. Gadgetbridge 设置 -> 开发者选项", fontSize = 13.sp)
                Text("8. 意图接口 -> 蓝牙 Intent API -> 开启", fontSize = 13.sp)
                Text("9. 允许数据库导出 -> 开启", fontSize = 13.sp)
                Text("10. 数据库导出时广播 -> 开启", fontSize = 13.sp)
                Spacer(Modifier.height(8.dp))
                Text(
                    "打开后 App 后台 Service 可自动触发 Gadgetbridge 导出，实现自动采集。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                )
                Spacer(Modifier.height(8.dp))
                HorizontalDividerCompact()
                Spacer(Modifier.height(8.dp))
                Text("手环 Auth Key 获取步骤：", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Spacer(Modifier.height(4.dp))
                Text("1. 安装小米运动健康 App，连接手环正常使用", fontSize = 12.sp)
                Text("2. 用 MT 文件管理器打开 /sdcard/Android/data/com.mi.health/files/log/", fontSize = 12.sp)
                Text("3. 找到 Transfer.device.log，搜索 token", fontSize = 12.sp)
                Text("4. 能找到两种 token：小米账号 token 和手环 Auth Key，都试试", fontSize = 12.sp)
                Text("5. Auth Key 是 32 位十六进制字符串（纯 0-9 a-f）", fontSize = 12.sp)
                Spacer(Modifier.height(8.dp))
                Text(
                    "连接 Gadgetbridge 后务必关闭小米运动健康后台：",
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.error.copy(alpha = 0.8f)
                )
                Spacer(Modifier.height(2.dp))
                Text("设置 -> 应用管理 -> 小米运动健康 -> 关闭自启动、禁止后台、禁止获取设备列表", fontSize = 12.sp)
                Spacer(Modifier.height(4.dp))
                Text(
                    "详细说明见 app/docs/band_data_collection_guide.md",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                )
            }
        },
        confirmButton = {
            Button(onClick = onDismiss) { Text("知道了") }
        }
    )
}
