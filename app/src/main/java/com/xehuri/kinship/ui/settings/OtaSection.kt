package com.xehuri.kinship.ui.settings

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * OTA 更新区域组件
 *
 * 显示当前版本、更新状态、更新日志、下载进度，提供检查更新和下载更新按钮。
 * 从 SettingsViewModel 读取 OTA 相关 StateFlow。
 *
 * @param viewModel SettingsViewModel 实例，提供 OTA 状态和操作方法
 */
@Composable
fun OtaSection(viewModel: SettingsViewModel) {
    val context = LocalContext.current

    // 从 ViewModel 收集 OTA 状态
    val otaStatusText by viewModel.otaStatusText.collectAsState()
    val otaChecking by viewModel.otaChecking.collectAsState()
    val otaChangelog by viewModel.otaChangelog.collectAsState()
    val otaDownloadUrl by viewModel.otaDownloadUrl.collectAsState()
    val otaProgress by viewModel.otaProgress.collectAsState()

    // 当前版本号
    val currentVersion = remember {
        try {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "未知"
        } catch (_: Exception) {
            "未知"
        }
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("OTA 更新", fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(2.dp))
            Text(
                "${otaStatusText}（当前 v$currentVersion）",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
            )
            if (otaChangelog.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    otaChangelog,
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    maxLines = 3
                )
            }
            if (otaProgress > 0 && otaProgress < 100) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "下载中… ${otaProgress}%",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.tertiary
                )
            }
        }
        Button(
            onClick = {
                if (otaDownloadUrl.isNotEmpty()) {
                    // 下载更新
                    viewModel.downloadUpdate()
                } else {
                    // 检查更新
                    viewModel.checkUpdate()
                }
            },
            enabled = if (otaDownloadUrl.isEmpty()) !otaChecking else true
        ) {
            if (otaChecking) {
                CircularProgressIndicator(
                    Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary
                )
                Spacer(Modifier.width(4.dp))
            }
            Text(if (otaDownloadUrl.isNotEmpty()) "下载更新" else "检查更新")
        }
    }
}
