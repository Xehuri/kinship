package com.xehuri.kinship.ui.settings

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import com.xehuri.kinship.service.DataCollectorService

/**
 * 设置页共享权限检查与前台服务拉起工具。
 *
 * 这些函数原位于 SensorControls.kt，重构后供 数据采集 / 健康数据 子页面复用。
 */

/** 检查运行时权限是否已授予 */
internal fun hasRuntimePermission(context: Context, permission: String): Boolean =
    context.checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED

/** 检查 Usage Stats 权限是否已开启 */
internal fun hasUsageStatsPermission(context: Context): Boolean {
    return try {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
        val mode = appOps.checkOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            context.packageName
        )
        if (mode == AppOpsManager.MODE_ALLOWED) return true

        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return false
        val now = System.currentTimeMillis()
        val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - 86400000, now)
        stats != null && stats.isNotEmpty()
    } catch (_: Exception) {
        false
    }
}

/** 检查 Notification Listener 权限是否已开启 */
internal fun hasNotificationListenerPermission(context: Context): Boolean {
    val cn = android.provider.Settings.Secure.getString(
        context.contentResolver, "enabled_notification_listeners"
    ) ?: return false
    return cn.contains("com.xehuri.kinship.service.NotificationListenerService")
}

/** 检查存储权限（API 30+ 用 MANAGE_EXTERNAL_STORAGE，旧版用 READ_EXTERNAL_STORAGE） */
internal fun hasStoragePermission(context: Context): Boolean {
    return if (Build.VERSION.SDK_INT >= 30) {
        try {
            android.os.Environment.isExternalStorageManager()
        } catch (_: Exception) {
            false
        }
    } else {
        hasRuntimePermission(context, android.Manifest.permission.READ_EXTERNAL_STORAGE)
    }
}

/**
 * 检查健康数据是否可读：所有文件访问权限，或已配置 SAF 数据库 URI。
 *
 * 配置了 SAF URI 时无需「所有文件访问权限」也能读手环数据库，
 * 故设置页与运行状态卡统一用该口径判定「存储」是否已就绪。
 */
internal fun hasHealthDataAccess(context: Context): Boolean =
    hasStoragePermission(context) || DataCollectorService.getDbUri(context) != null

/** 检查是否已授予任一精度定位权限（GPS 采集与 WiFi 名称读取都需要） */
internal fun hasLocationPermission(context: Context): Boolean {
    val fine = context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
    val coarse = context.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
    return fine == android.content.pm.PackageManager.PERMISSION_GRANTED ||
        coarse == android.content.pm.PackageManager.PERMISSION_GRANTED
}

/** 检查无障碍服务是否已开启 */
internal fun hasAccessibilityServiceEnabled(context: Context): Boolean {
    val cn = android.provider.Settings.Secure.getString(
        context.contentResolver,
        android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
    ) ?: return false
    return cn.contains(".service.AxeuhAccessibilityService")
}

/** 确保 DataCollectorService 在开启传感器时正在运行 */
internal fun ensureServiceRunning(context: Context, enabled: Boolean) {
    if (!enabled) return
    try {
        val intent = Intent(context, DataCollectorService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
        android.util.Log.d("SettingsPermission", "DataCollectorService 已启动（传感器开启）")
    } catch (_: Exception) {
    }
}
