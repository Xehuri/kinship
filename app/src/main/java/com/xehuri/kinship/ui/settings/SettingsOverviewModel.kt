package com.xehuri.kinship.ui.settings

/**
 * 概览页导航目标。
 *
 * 每个目标对应一个二级页面、Dialog 入口或行内动作；VOICEPRINT 无导航回调，
 * 由概览页单独渲染为声纹管理行（点击弹 Dialog）。
 */
enum class OverviewTarget {
    COLLECTION_CONTROL,
    HEALTH_DATA,
    AUDIO,
    WAKE_WORD,
    GPS,
    SYSTEM_STATE,
    NOTIFICATIONS,
    WIDGETS,
    NOTIFICATION_HISTORY,
    ACCOUNT,
    NETWORK,
    DEVICE,
    BACKGROUND,
    SOUND,
    SECURITY,
    VOICEPRINT,
    ADVANCED,
    SYNC,
}

/** 概览页行内开关的稳定键；界面据此执行对应的权限引导与持久化。 */
enum class OverviewSwitchKey {
    HEALTH,
    AUDIO,
    WAKE_WORD,
    GPS,
    SYSTEM_STATE,
    INPUT_CONTENT,
    BATTERY,
    NOTIFICATION,
}

/** 概览页行内开关快照。 */
data class OverviewSwitch(
    val key: OverviewSwitchKey,
    val checked: Boolean,
    val enabled: Boolean = true,
)

/** 概览页单行：稳定 id + 标题 + 动态摘要 + 可选目标页 + 可选行内开关。 */
data class OverviewRow(
    val id: String,
    val title: String,
    val subtitle: String,
    val target: OverviewTarget? = null,
    val switch: OverviewSwitch? = null,
)

/** 概览页分组：分组标题 + 行列表。 */
data class OverviewSection(
    val title: String,
    val rows: List<OverviewRow>,
)

/** 概览页顶部运行状态卡：标题 + 摘要 + 是否健康（待处理/停止时标警示色）。 */
data class OverviewStatusCard(
    val title: String,
    val subtitle: String,
    val healthy: Boolean,
)

/**
 * 概览页渲染所需的全部状态快照。
 *
 * 网络摘要只消费 [networkMode]（SelectionMode 名）与 [networkLabel]（Tier.displayLabel()），
 * 不再读取 legacy `transport_mode`；[pendingPermissionCount] 来自 RunStatusModel 的必需权限矩阵。
 */
data class OverviewState(
    val uploadEnabled: Boolean,
    val healthEnabled: Boolean,
    val notificationEnabled: Boolean,
    val widgetsEnabled: Boolean,
    val isLoggedIn: Boolean,
    val username: String,
    val serverUrl: String,
    val sslVerify: Boolean,
    val serviceRunning: Boolean = false,
    val networkLabel: String = "",
    val networkMode: String = "",
    val pendingPermissionCount: Int = 0,
    val batteryOptimized: Boolean = false,
    val cacheEnabled: Boolean = true,
    val audioEnabled: Boolean = false,
    val wakeWordEnabled: Boolean = false,
    val gpsEnabled: Boolean = false,
    val systemStateEnabled: Boolean = false,
    val inputContentEnabled: Boolean = false,
    val batteryEnabled: Boolean = true,
    val syncText: String = "",
    val collectionIntervalMs: Long = 30_000L,
)

/**
 * 概览页信息架构与摘要文案的唯一真源。
 *
 * 纯 Kotlin（无 Compose / Android 依赖），可单测；界面只负责按 [sections] 渲染。
 * 分组顺序、行顺序与行 id 均为稳定契约，测试逐项锁定。
 */
object SettingsOverviewModel {

    private const val ROW_COLLECTION_CONTROL = "collection_control"
    private const val ROW_HEALTH = "health"
    private const val ROW_AUDIO = "audio"
    private const val ROW_WAKE_WORD = "wake_word"
    private const val ROW_GPS = "gps"
    private const val ROW_SYSTEM_STATE = "system_state"
    private const val ROW_INPUT_CONTENT = "input_content"
    private const val ROW_BATTERY_SENSOR = "battery_sensor"
    private const val ROW_ACCOUNT = "account"
    private const val ROW_NETWORK = "network"
    private const val ROW_SYNC = "sync"
    private const val ROW_NOTIFICATIONS = "notifications"
    private const val ROW_WIDGETS = "widgets"
    private const val ROW_NOTIFICATION_HISTORY = "notification_history"
    private const val ROW_DEVICE = "device"
    private const val ROW_BACKGROUND = "background"
    private const val ROW_SOUND = "sound"
    private const val ROW_VOICEPRINT = "voiceprint"
    private const val ROW_SECURITY = "security"
    private const val ROW_MAINTENANCE = "maintenance"

    fun sections(state: OverviewState): List<OverviewSection> = listOf(
        OverviewSection(
            title = "采集与上传",
            rows = listOf(
                row(
                    id = ROW_COLLECTION_CONTROL,
                    title = "采集总控",
                    subtitle = collectionSubtitle(state),
                    target = OverviewTarget.COLLECTION_CONTROL,
                ),
                row(
                    id = ROW_NOTIFICATIONS,
                    title = "通知",
                    subtitle = toggleSubtitle(
                        enabled = state.notificationEnabled,
                        detail = "敏感应用过滤",
                    ),
                    target = OverviewTarget.NOTIFICATIONS,
                    switch = toggle(OverviewSwitchKey.NOTIFICATION, state.notificationEnabled),
                ),
                row(
                    id = ROW_HEALTH,
                    title = "健康与手环",
                    subtitle = toggleSubtitle(
                        enabled = state.healthEnabled,
                        detail = "上传模式与手环数据库",
                    ),
                    target = OverviewTarget.HEALTH_DATA,
                    switch = toggle(OverviewSwitchKey.HEALTH, state.healthEnabled),
                ),
                row(
                    id = ROW_AUDIO,
                    title = "环境音频",
                    subtitle = toggleSubtitle(
                        enabled = state.audioEnabled,
                        detail = "分段时长与上传频率",
                    ),
                    target = OverviewTarget.AUDIO,
                    switch = toggle(OverviewSwitchKey.AUDIO, state.audioEnabled),
                ),
                row(
                    id = ROW_WAKE_WORD,
                    title = "语音唤醒",
                    subtitle = toggleSubtitle(
                        enabled = state.wakeWordEnabled,
                        detail = "端侧识别参数",
                    ),
                    target = OverviewTarget.WAKE_WORD,
                    switch = toggle(OverviewSwitchKey.WAKE_WORD, state.wakeWordEnabled),
                ),
                row(
                    id = ROW_GPS,
                    title = "位置",
                    subtitle = toggleSubtitle(
                        enabled = state.gpsEnabled,
                        detail = "间隔与定位行为",
                    ),
                    target = OverviewTarget.GPS,
                    switch = toggle(OverviewSwitchKey.GPS, state.gpsEnabled),
                ),
                row(
                    id = ROW_SYSTEM_STATE,
                    title = "系统状态",
                    subtitle = toggleSubtitle(
                        enabled = state.systemStateEnabled,
                        detail = "前台/网络/蓝牙/屏幕",
                    ),
                    target = OverviewTarget.SYSTEM_STATE,
                    switch = toggle(OverviewSwitchKey.SYSTEM_STATE, state.systemStateEnabled),
                ),
                row(
                    id = ROW_INPUT_CONTENT,
                    title = "输入内容",
                    subtitle = toggleSubtitle(
                        enabled = state.inputContentEnabled,
                        detail = "需无障碍权限",
                    ),
                    switch = toggle(OverviewSwitchKey.INPUT_CONTENT, state.inputContentEnabled),
                ),
                row(
                    id = ROW_BATTERY_SENSOR,
                    title = "电量与充电",
                    subtitle = toggleSubtitle(
                        enabled = state.batteryEnabled,
                        detail = "随主循环采集",
                    ),
                    switch = toggle(OverviewSwitchKey.BATTERY, state.batteryEnabled),
                ),
            ),
        ),
        OverviewSection(
            title = "连接与账号",
            rows = listOf(
                row(
                    id = ROW_ACCOUNT,
                    title = "账号与登录",
                    subtitle = if (state.isLoggedIn) "已登录：${state.username}" else "未登录 · 点击登录",
                    target = OverviewTarget.ACCOUNT,
                ),
                row(
                    id = ROW_NETWORK,
                    title = "网络",
                    subtitle = networkSubtitle(state),
                    target = OverviewTarget.NETWORK,
                ),
                row(
                    id = ROW_SYNC,
                    title = "立即同步",
                    subtitle = state.syncText.trim().ifBlank { "触发一次同步" },
                    target = OverviewTarget.SYNC,
                ),
            ),
        ),
        OverviewSection(
            title = "桌面与历史",
            rows = listOf(
                row(
                    id = ROW_WIDGETS,
                    title = "桌面组件",
                    subtitle = if (state.widgetsEnabled) {
                        "已开启 · 总开关与钉选入口"
                    } else {
                        "已停用 · 卡片显示停用占位"
                    },
                    target = OverviewTarget.WIDGETS,
                ),
                row(
                    id = ROW_NOTIFICATION_HISTORY,
                    title = "通知历史",
                    subtitle = "本机最近 50 条通知记录",
                    target = OverviewTarget.NOTIFICATION_HISTORY,
                ),
            ),
        ),
        OverviewSection(
            title = "设备与运行",
            rows = listOf(
                row(
                    id = ROW_DEVICE,
                    title = "设备信息与名称",
                    subtitle = "设备信息 · 设备名称 · 设备 ID",
                    target = OverviewTarget.DEVICE,
                ),
                row(
                    id = ROW_BACKGROUND,
                    title = "后台运行与权限",
                    subtitle = "电池优化 · 权限检查 · 厂商限制",
                    target = OverviewTarget.BACKGROUND,
                ),
                row(
                    id = ROW_SOUND,
                    title = "声音与播报",
                    subtitle = "提示音 · TTS 语音音量",
                    target = OverviewTarget.SOUND,
                ),
            ),
        ),
        OverviewSection(
            title = "隐私与维护",
            rows = listOf(
                row(
                    id = ROW_VOICEPRINT,
                    title = "声纹管理",
                    subtitle = "查看与管理已注册的声纹样本",
                    target = OverviewTarget.VOICEPRINT,
                ),
                row(
                    id = ROW_SECURITY,
                    title = "安全与证书",
                    subtitle = if (state.sslVerify) "SSL 证书验证已开启" else "SSL 证书验证已关闭",
                    target = OverviewTarget.SECURITY,
                ),
                row(
                    id = ROW_MAINTENANCE,
                    title = "更新与诊断",
                    subtitle = "OTA 更新 · 服务日志",
                    target = OverviewTarget.ADVANCED,
                ),
            ),
        ),
    )

    /** 采集总控摘要：上传 / 缓存 / 调度三项一眼可见。 */
    private fun collectionSubtitle(state: OverviewState): String {
        val upload = if (state.uploadEnabled) "上传已开启" else "上传已停用"
        val cache = if (state.cacheEnabled) "缓存开" else "缓存关"
        return "$upload · $cache · 调度 ${intervalText(state.collectionIntervalMs)}"
    }

    private fun toggleSubtitle(enabled: Boolean, detail: String): String =
        (if (enabled) "已开启 · " else "已停用 · ") + detail

    private fun toggle(key: OverviewSwitchKey, checked: Boolean): OverviewSwitch =
        OverviewSwitch(key = key, checked = checked)

    /** 网络行摘要：<选择模式> · <连接层名称或未配置> · P2P 未接入 */
    private fun networkSubtitle(state: OverviewState): String {
        val mode = RunStatusModel.networkModeLabel(state.networkMode)
            .ifBlank { "未配置模式" }
        val label = state.networkLabel.trim().ifBlank { "未配置连接层" }
        return "$mode · $label · P2P 未接入"
    }

    /** 纯 Kotlin 的间隔摘要（与界面层 formatIntervalMs 同口径，避免依赖 Compose）。 */
    private fun intervalText(ms: Long): String = when {
        ms <= 0L -> "未设置"
        ms % 60_000L == 0L -> "${ms / 60_000L} 分钟"
        ms % 1_000L == 0L -> "${ms / 1_000L} 秒"
        else -> "$ms 毫秒"
    }

    /** 顶部状态卡：优先暴露待处理项，其次暴露采集服务停止。 */
    fun statusCard(state: OverviewState): OverviewStatusCard {
        val title = when {
            state.pendingPermissionCount > 0 -> "${state.pendingPermissionCount} 项待处理"
            !state.serviceRunning -> "采集服务已停止"
            else -> "状态正常"
        }
        return OverviewStatusCard(
            title = title,
            subtitle = RunStatusModel.summaryOf(
                serviceRunning = state.serviceRunning,
                networkMode = state.networkMode,
                networkLabel = state.networkLabel,
                pendingCount = state.pendingPermissionCount,
            ),
            healthy = state.serviceRunning && state.pendingPermissionCount == 0,
        )
    }

    private fun row(
        id: String,
        title: String,
        subtitle: String,
        target: OverviewTarget? = null,
        switch: OverviewSwitch? = null,
    ): OverviewRow = OverviewRow(
        id = id,
        title = title,
        subtitle = subtitle,
        target = target,
        switch = switch,
    )
}
