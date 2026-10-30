package com.xehuri.kinship.ui.settings

import com.xehuri.kinship.transport.SelectionMode
import com.xehuri.kinship.transport.TierConfig
import com.xehuri.kinship.transport.displayLabel
import java.util.Locale

/** 单项权限/系统能力检查：granted 对电池优化表示「已忽略」。 */
data class PermissionCheck(
    val key: String,
    val label: String,
    val granted: Boolean,
    val required: Boolean,
)

/** 运行状态页的完整快照（网络部分来自 TierStore，权限部分来自系统检查）。 */
data class RunStatusState(
    val serviceRunning: Boolean,
    val uploadEnabled: Boolean,
    val cacheEnabled: Boolean,
    val networkLabel: String,
    val networkMode: String,
    val syncText: String,
    val batteryOptimized: Boolean,
    val permissions: List<PermissionCheck>,
)

/** [RunStatusModel.permissions] 的输入：功能开关 + 系统授权结果，不依赖 Android 类型。 */
data class PermissionInputs(
    val notificationEnabled: Boolean = false,
    val foregroundEnabled: Boolean = false,
    val inputContentEnabled: Boolean = false,
    val gpsEnabled: Boolean = false,
    val wifiEnabled: Boolean = false,
    val healthEnabled: Boolean = false,
    val audioEnabled: Boolean = false,
    val bluetoothEnabled: Boolean = false,
    val notificationGranted: Boolean = false,
    val usageStatsGranted: Boolean = false,
    val accessibilityGranted: Boolean = false,
    val locationGranted: Boolean = false,
    val storageGranted: Boolean = false,
    val microphoneGranted: Boolean = false,
    val bluetoothGranted: Boolean = false,
    val uploadEnabled: Boolean = false,
    val batteryOptimized: Boolean = false,
)

/** 运行状态文案与权限矩阵的纯 Kotlin 真源。 */
object RunStatusModel {

    const val KEY_NOTIFICATION_LISTENER = "notification_listener"
    const val KEY_USAGE_STATS = "usage_stats"
    const val KEY_ACCESSIBILITY = "accessibility"
    const val KEY_LOCATION = "location"
    const val KEY_STORAGE = "storage"
    const val KEY_MICROPHONE = "microphone"
    const val KEY_BLUETOOTH = "bluetooth"
    const val KEY_BATTERY = "battery"

    fun permissions(inputs: PermissionInputs): List<PermissionCheck> = listOf(
        PermissionCheck(
            key = KEY_NOTIFICATION_LISTENER,
            label = "通知读取",
            granted = inputs.notificationGranted,
            required = inputs.notificationEnabled,
        ),
        PermissionCheck(
            key = KEY_USAGE_STATS,
            label = "使用情况访问",
            granted = inputs.usageStatsGranted,
            required = inputs.foregroundEnabled,
        ),
        PermissionCheck(
            key = KEY_ACCESSIBILITY,
            label = "无障碍服务",
            granted = inputs.accessibilityGranted,
            required = inputs.inputContentEnabled,
        ),
        PermissionCheck(
            key = KEY_LOCATION,
            label = "位置信息",
            granted = inputs.locationGranted,
            required = inputs.gpsEnabled || inputs.wifiEnabled,
        ),
        PermissionCheck(
            key = KEY_STORAGE,
            label = "存储权限",
            granted = inputs.storageGranted,
            required = inputs.healthEnabled,
        ),
        PermissionCheck(
            key = KEY_MICROPHONE,
            label = "麦克风",
            granted = inputs.microphoneGranted,
            required = inputs.audioEnabled,
        ),
        PermissionCheck(
            key = KEY_BLUETOOTH,
            label = "蓝牙连接",
            granted = inputs.bluetoothGranted,
            required = inputs.bluetoothEnabled,
        ),
        PermissionCheck(
            key = KEY_BATTERY,
            label = "电池优化",
            granted = inputs.batteryOptimized,
            required = inputs.uploadEnabled,
        ),
    )

    fun pendingRequired(state: RunStatusState): List<PermissionCheck> =
        state.permissions.filter { it.required && !it.granted }

    fun pendingRequiredCount(permissions: List<PermissionCheck>): Int =
        permissions.count { it.required && !it.granted }

    fun summary(state: RunStatusState): String = summaryOf(
        serviceRunning = state.serviceRunning,
        networkMode = state.networkMode,
        networkLabel = state.networkLabel,
        pendingCount = pendingRequired(state).size,
    )

    fun networkModeLabel(mode: String): String = when (mode.trim().uppercase(Locale.ROOT)) {
        SelectionMode.AUTO_CHAIN.name -> "自动选择"
        SelectionMode.PINNED.name -> "只用指定连接层"
        else -> mode.trim()
    }

    fun activeTierLabel(config: TierConfig): String =
        config.tiers.firstOrNull { it.id == config.selection.activeTierId }
            ?.displayLabel()
            .orEmpty()

    internal fun summaryOf(
        serviceRunning: Boolean,
        networkMode: String,
        networkLabel: String,
        pendingCount: Int,
    ): String {
        val service = if (serviceRunning) "采集服务运行中" else "采集服务已停止"
        val connection = networkModeLabel(networkMode).ifBlank {
            networkLabel.trim().ifBlank { "未配置连接层" }
        }
        val pending = if (pendingCount > 0) "$pendingCount 项待处理" else "状态正常"
        return "$service · 当前连接 $connection · $pending"
    }
}
