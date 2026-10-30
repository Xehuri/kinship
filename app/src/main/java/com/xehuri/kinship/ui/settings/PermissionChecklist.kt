package com.xehuri.kinship.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.ui.theme.SettingsSpacing

/**
 * 权限检查清单：运行状态页与后台运行页共用的纯展示组件。
 *
 * 行之间用紧凑分隔线连接；已授权项不可点击，待处理或未启用项点击后经 [onOpen]
 * 拉起对应系统设置页（由调用方负责 launcher 与返回后刷新）。
 */
@Composable
fun PermissionChecklist(
    checks: List<PermissionCheck>,
    onOpen: (PermissionCheck) -> Unit,
) {
    checks.forEachIndexed { index, check ->
        if (index > 0) HorizontalDividerCompact()
        PermissionStatusRow(check = check, onClick = { onOpen(check) })
    }
}

/** 单条权限行：名称 + 状态文案，未授权时带箭头且整行可点。 */
@Composable
private fun PermissionStatusRow(check: PermissionCheck, onClick: () -> Unit) {
    val warning = !check.granted && check.required
    val statusText = when {
        check.granted -> "已授权"
        check.required -> "待处理"
        else -> "未启用所需"
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .minimumInteractiveComponentSize()
            .then(if (check.granted) Modifier else Modifier.clickable(onClick = onClick))
            .padding(vertical = SettingsSpacing.xs),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = check.label,
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f)
        )
        Text(
            text = statusText,
            fontSize = 12.sp,
            fontWeight = if (warning) FontWeight.Medium else FontWeight.Normal,
            color = when {
                check.granted -> MaterialTheme.colorScheme.primary
                check.required -> MaterialTheme.colorScheme.error
                else -> MaterialTheme.colorScheme.onSurfaceVariant
            }
        )
        if (!check.granted) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = "打开${check.label}设置",
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** 权限键映射到对应系统设置页；无专属页面的权限回退到应用详情页。 */
internal fun permissionSettingsIntent(context: Context, key: String): Intent = when (key) {
    RunStatusModel.KEY_NOTIFICATION_LISTENER -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
    RunStatusModel.KEY_USAGE_STATS -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
    RunStatusModel.KEY_ACCESSIBILITY -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
    RunStatusModel.KEY_BATTERY -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
    else -> appDetailsIntent(context)
}

/** 应用详情页 Intent（权限专属设置页缺失时的统一兜底）。 */
internal fun appDetailsIntent(context: Context): Intent =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.parse("package:${context.packageName}")
    }
