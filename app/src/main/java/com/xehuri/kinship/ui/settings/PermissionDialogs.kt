package com.xehuri.kinship.ui.settings

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.service.DataCollectorService

/**
 * 权限引导弹窗容器组件
 *
 * 包含 5 个权限引导弹窗，当用户启用对应传感器但权限缺失时弹出：
 * 1. 使用情况访问权限（前台应用感知）
 * 2. 通知监听权限（通知感知）
 * 3. 无障碍服务权限（输入内容感知）
 * 4. 存储权限（健康数据感知）
 * 5. 手环数据采集设置指南（Gadgetbridge）
 *
 * @param viewModel SettingsViewModel 实例，提供弹窗状态和操作方法
 */
@Composable
fun PermissionDialogs(viewModel: SettingsViewModel) {
    val context = LocalContext.current

    // ── AN-M6: 周期复核运行时权限，撤销后自动关闭对应传感器开关 ──
    // 后台采集器由 DataCollectorService 主循环同步停用；此处保证设置页 UI 状态一致。
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(3000)
            if (viewModel.audioEnabled.value &&
                !hasRuntimePermission(context, android.Manifest.permission.RECORD_AUDIO)
            ) {
                viewModel.toggleSensor("audio", false)
            }
            if (viewModel.gpsEnabled.value &&
                !hasRuntimePermission(context, android.Manifest.permission.ACCESS_FINE_LOCATION)
            ) {
                viewModel.toggleSensor("gps", false)
            }
            val healthAllowed = hasStoragePermission(context) ||
                DataCollectorService.getDbUri(context) != null
            if (viewModel.healthEnabled.value && !healthAllowed) {
                viewModel.toggleSensor("health", false)
            }
        }
    }

    // ── 权限设置页面启动器 ──

    // 通知监听设置页面
    val notificationListenerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) {
        // 从系统设置返回后，重新检查权限并自动开启开关
        if (hasNotificationListenerPermission(context)) {
            viewModel.toggleSensor("notification", true)
        }
    }

    // 文件选择器（手环数据库路径）
    val dbFilePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            try {
                // 持久化 content URI 权限（Android 11+ SAF 需要）
                try {
                    val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION
                    context.contentResolver.takePersistableUriPermission(uri, takeFlags)
                } catch (_: Exception) { }
                // 保存 content URI（用于 Android 11+ 实际读取文件）
                viewModel.setDbUri(uri.toString())
                // 尝试提取文件路径（仅 internal storage 的 primary 分区才能提取成功）
                try {
                    val docId = android.provider.DocumentsContract.getDocumentId(uri)
                    val parts = docId.split(":")
                    if (parts.size >= 2 && "primary".equals(parts[0], ignoreCase = true)) {
                        val realPath = "/storage/emulated/0/${parts.subList(1, parts.size).joinToString(":")}"
                        viewModel.setDbPath(realPath)
                        android.util.Log.d("PermissionDialogs", "手环 DB 路径已设置为: $realPath")
                    }
                    // 非 primary 分区无法可靠提取路径，保持默认路径不变
                } catch (_: Exception) { }
            } catch (_: Exception) { }
        }
    }

    // ── 通知监听权限弹窗 ──
    if (viewModel.showNotificationListenerDialog.collectAsState().value) {
        NotificationListenerPermissionDialog(
            onDismiss = { viewModel.dismissNotificationListenerDialog() },
            onGoToSettings = {
                viewModel.dismissNotificationListenerDialog()
                val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                notificationListenerLauncher.launch(intent)
            }
        )
    }
}

// ─── 单个弹窗组件 ─────────────────────────────────────────────────

/**
 * 通知监听权限引导弹窗
 *
 * 引导用户开启「通知监听」权限，用于读取系统通知内容。
 */
@Composable
private fun NotificationListenerPermissionDialog(
    onDismiss: () -> Unit,
    onGoToSettings: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("通知监听权限") },
        text = {
            Text(
                "需要开启「通知监听」权限才能读取系统通知内容。" +
                        "请在系统设置中为「Kinship」开启此权限。"
            )
        },
        confirmButton = {
            Button(onClick = onGoToSettings) { Text("去设置") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        }
    )
}

/**
 * 手环数据采集设置指南弹窗
 *
 * 显示 Gadgetbridge 数据库导出配置步骤和手环 Auth Key 获取方法。
 */
@Composable
private fun BandKeyGuideDialog(
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("手环数据采集设置") },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    "首次使用按以下步骤操作：",
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp
                )
                Spacer(Modifier.height(8.dp))
                Text("1. Gadgetbridge 设置 → 自动化 → 自动导出数据库 → 开启", fontSize = 13.sp)
                Text("2. 导出间隔设为一小时（不改也行）", fontSize = 13.sp)
                Text("3. 点击「立即运行自动导出」", fontSize = 13.sp)
                Spacer(Modifier.height(4.dp))
                Text("4. 返回 Kinship → 选择数据库文件", fontSize = 13.sp)
                Text("5. 选中 Gadgetbridge 导出的 .db 文件", fontSize = 13.sp)
                Text("6. 下方健康数据区域验证是否能读到数据", fontSize = 13.sp)
                Spacer(Modifier.height(8.dp))
                Text(
                    "确认数据可读后，开启蓝牙 Intent API：",
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp
                )
                Spacer(Modifier.height(4.dp))
                Text("7. Gadgetbridge 设置 → 开发者选项", fontSize = 13.sp)
                Text("8. 意图接口 → 蓝牙 Intent API → 开启", fontSize = 13.sp)
                Text("9. 允许数据库导出 → 开启", fontSize = 13.sp)
                Text("10. 数据库导出时广播 → 开启", fontSize = 13.sp)
                Spacer(Modifier.height(8.dp))
                Text(
                    "打开后 App 后台 Service 可自动触发 Gadgetbridge 导出，实现自动采集。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                )
                Spacer(Modifier.height(8.dp))
                HorizontalDividerCompact()
                Spacer(Modifier.height(8.dp))
                Text(
                    "手环 Auth Key 获取步骤：",
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp
                )
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
                Text("设置 → 应用管理 → 小米运动健康 → 关闭自启动、禁止后台、禁止获取设备列表", fontSize = 12.sp)
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

// 权限检查与前台服务拉起工具已统一到 SettingsPermissionUtils.kt（同包 internal 函数），
// 此处不再重复定义，避免同包重载冲突。
