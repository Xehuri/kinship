package com.xehuri.kinship.ui.settings

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class SettingsOverviewModelTest {

    private fun state(
        uploadEnabled: Boolean = true,
        cacheEnabled: Boolean = true,
        healthEnabled: Boolean = true,
        audioEnabled: Boolean = true,
        wakeWordEnabled: Boolean = true,
        gpsEnabled: Boolean = true,
        systemStateEnabled: Boolean = true,
        inputContentEnabled: Boolean = true,
        batteryEnabled: Boolean = true,
        notificationEnabled: Boolean = true,
        widgetsEnabled: Boolean = true,
        isLoggedIn: Boolean = false,
        username: String = "",
        serverUrl: String = "",
        networkLabel: String = "",
        networkMode: String = "AUTO_CHAIN",
        pendingPermissionCount: Int = 0,
        serviceRunning: Boolean = true,
        batteryOptimized: Boolean = false,
        sslVerify: Boolean = false,
        syncText: String = "",
        collectionIntervalMs: Long = 30_000L
    ): OverviewState = OverviewState(
        uploadEnabled = uploadEnabled,
        healthEnabled = healthEnabled,
        notificationEnabled = notificationEnabled,
        widgetsEnabled = widgetsEnabled,
        isLoggedIn = isLoggedIn,
        username = username,
        serverUrl = serverUrl,
        sslVerify = sslVerify,
        serviceRunning = serviceRunning,
        networkLabel = networkLabel,
        networkMode = networkMode,
        pendingPermissionCount = pendingPermissionCount,
        batteryOptimized = batteryOptimized,
        cacheEnabled = cacheEnabled,
        audioEnabled = audioEnabled,
        wakeWordEnabled = wakeWordEnabled,
        gpsEnabled = gpsEnabled,
        systemStateEnabled = systemStateEnabled,
        inputContentEnabled = inputContentEnabled,
        batteryEnabled = batteryEnabled,
        syncText = syncText,
        collectionIntervalMs = collectionIntervalMs
    )

    private fun rowsOf(state: OverviewState): List<OverviewRow> =
        SettingsOverviewModel.sections(state).flatMap { it.rows }

    private fun rowOf(target: OverviewTarget, state: OverviewState = state()): OverviewRow =
        rowsOf(state).first { it.target == target }

    private fun rowOfId(id: String, state: OverviewState = state()): OverviewRow =
        rowsOf(state).first { it.id == id }

    @Test
    fun `sections keep exact five groups and order`() {
        val sections = SettingsOverviewModel.sections(state())

        assertThat(sections.map { it.title }).containsExactly(
            "采集与上传",
            "连接与账号",
            "桌面与历史",
            "设备与运行",
            "隐私与维护"
        ).inOrder()
    }

    @Test
    fun `all twenty rows keep stable ids in order`() {
        listOf(state(), state(isLoggedIn = true, username = "alice")).forEach { snapshot ->
            val rows = rowsOf(snapshot)

            assertThat(rows).hasSize(20)
            assertThat(rows.map { it.id }).containsExactly(
                "collection_control",
                "notifications",
                "health",
                "audio",
                "wake_word",
                "gps",
                "system_state",
                "input_content",
                "battery_sensor",
                "account",
                "network",
                "sync",
                "widgets",
                "notification_history",
                "device",
                "background",
                "sound",
                "voiceprint",
                "security",
                "maintenance"
            ).inOrder()
        }
    }

    @Test
    fun `group one switches mirror their sensor state`() {
        val enabled = SettingsOverviewModel.sections(state()).first().rows
        assertThat(enabled.mapNotNull { row ->
            row.switch?.let { it.key to it.checked }
        }).containsExactly(
            OverviewSwitchKey.NOTIFICATION to true,
            OverviewSwitchKey.HEALTH to true,
            OverviewSwitchKey.AUDIO to true,
            OverviewSwitchKey.WAKE_WORD to true,
            OverviewSwitchKey.GPS to true,
            OverviewSwitchKey.SYSTEM_STATE to true,
            OverviewSwitchKey.INPUT_CONTENT to true,
            OverviewSwitchKey.BATTERY to true
        ).inOrder()

        val disabled = SettingsOverviewModel.sections(
            state(
                notificationEnabled = false,
                healthEnabled = false,
                audioEnabled = false,
                wakeWordEnabled = false,
                gpsEnabled = false,
                systemStateEnabled = false,
                inputContentEnabled = false,
                batteryEnabled = false
            )
        ).first().rows
        assertThat(disabled.mapNotNull { it.switch?.checked }).containsExactly(
            false, false, false, false, false, false, false, false
        ).inOrder()
    }

    @Test
    fun `notification switch mirrors notification state`() {
        val on = rowOfId("notifications", state(notificationEnabled = true)).switch
        assertThat(on?.key).isEqualTo(OverviewSwitchKey.NOTIFICATION)
        assertThat(on?.checked).isTrue()

        val off = rowOfId("notifications", state(notificationEnabled = false)).switch
        assertThat(off?.checked).isFalse()
    }

    @Test
    fun `every switch key is used exactly once in overview order`() {
        val keys = rowsOf(state()).mapNotNull { it.switch?.key }

        assertThat(keys).containsExactly(
            OverviewSwitchKey.NOTIFICATION,
            OverviewSwitchKey.HEALTH,
            OverviewSwitchKey.AUDIO,
            OverviewSwitchKey.WAKE_WORD,
            OverviewSwitchKey.GPS,
            OverviewSwitchKey.SYSTEM_STATE,
            OverviewSwitchKey.INPUT_CONTENT,
            OverviewSwitchKey.BATTERY
        ).inOrder()
    }

    @Test
    fun `targets map each row to its destination`() {
        val targets = rowsOf(state()).map { it.id to it.target }

        assertThat(targets).containsExactly(
            "collection_control" to OverviewTarget.COLLECTION_CONTROL,
            "notifications" to OverviewTarget.NOTIFICATIONS,
            "health" to OverviewTarget.HEALTH_DATA,
            "audio" to OverviewTarget.AUDIO,
            "wake_word" to OverviewTarget.WAKE_WORD,
            "gps" to OverviewTarget.GPS,
            "system_state" to OverviewTarget.SYSTEM_STATE,
            "input_content" to null,
            "battery_sensor" to null,
            "account" to OverviewTarget.ACCOUNT,
            "network" to OverviewTarget.NETWORK,
            "sync" to OverviewTarget.SYNC,
            "widgets" to OverviewTarget.WIDGETS,
            "notification_history" to OverviewTarget.NOTIFICATION_HISTORY,
            "device" to OverviewTarget.DEVICE,
            "background" to OverviewTarget.BACKGROUND,
            "sound" to OverviewTarget.SOUND,
            "voiceprint" to OverviewTarget.VOICEPRINT,
            "security" to OverviewTarget.SECURITY,
            "maintenance" to OverviewTarget.ADVANCED
        ).inOrder()
    }

    @Test
    fun `collection control subtitle reflects upload cache and interval`() {
        assertThat(rowOfId("collection_control", state()).subtitle)
            .isEqualTo("上传已开启 · 缓存开 · 调度 30 秒")

        assertThat(
            rowOfId(
                "collection_control",
                state(
                    uploadEnabled = false,
                    cacheEnabled = false,
                    collectionIntervalMs = 60_000L
                )
            ).subtitle
        ).isEqualTo("上传已停用 · 缓存关 · 调度 1 分钟")
    }

    @Test
    fun `account subtitle reflects login state`() {
        assertThat(rowOf(OverviewTarget.ACCOUNT, state(isLoggedIn = false)).subtitle)
            .isEqualTo("未登录 · 点击登录")

        assertThat(
            rowOf(
                OverviewTarget.ACCOUNT,
                state(isLoggedIn = true, username = "alice")
            ).subtitle
        ).isEqualTo("已登录：alice")
    }

    @Test
    fun `network subtitle uses selection mode and tier label`() {
        val auto = rowOf(
            OverviewTarget.NETWORK,
            state(networkMode = "AUTO_CHAIN", networkLabel = "家庭 FRP")
        )
        assertThat(auto.subtitle).isEqualTo("自动选择 · 家庭 FRP · P2P 未接入")

        val pinned = rowOf(
            OverviewTarget.NETWORK,
            state(networkMode = "PINNED", networkLabel = "公司直连")
        )
        assertThat(pinned.subtitle).isEqualTo("只用指定连接层 · 公司直连 · P2P 未接入")

        val unconfigured = rowOf(OverviewTarget.NETWORK, state(networkLabel = ""))
        assertThat(unconfigured.subtitle).contains("未配置连接层")
    }

    @Test
    fun `network subtitle never falls back to legacy server url`() {
        val row = rowOf(
            OverviewTarget.NETWORK,
            state(serverUrl = "https://health.example:8768/mobile/")
        )

        assertThat(row.subtitle).doesNotContain("health.example")
        assertThat(row.subtitle).doesNotContain("https://")
        assertThat(row.subtitle).doesNotContain("自动回退")
        assertThat(row.subtitle).doesNotContain("强制 FRP")
    }

    @Test
    fun `sync row shows sync status text with fallback`() {
        assertThat(rowOf(OverviewTarget.SYNC, state(syncText = "同步完成")).subtitle)
            .isEqualTo("同步完成")
        assertThat(rowOf(OverviewTarget.SYNC, state(syncText = "   ")).subtitle)
            .isEqualTo("触发一次同步")
    }

    @Test
    fun `device background maintenance rows use new IA titles and subtitles`() {
        assertThat(rowOfId("sync").title).isEqualTo("立即同步")
        assertThat(rowOfId("device").title).isEqualTo("设备信息与名称")
        assertThat(rowOfId("device").subtitle).isEqualTo("设备信息 · 设备名称 · 设备 ID")
        assertThat(rowOfId("background").title).isEqualTo("后台运行与权限")
        assertThat(rowOfId("background").subtitle).isEqualTo("电池优化 · 权限检查 · 厂商限制")
        assertThat(rowOfId("maintenance").title).isEqualTo("更新与诊断")
    }

    @Test
    fun `sound row sits in device group`() {
        val sections = SettingsOverviewModel.sections(state())

        val deviceGroup = sections.first { it.title == "设备与运行" }
        assertThat(deviceGroup.rows.map { it.id })
            .containsExactly("device", "background", "sound").inOrder()

        val sound = rowOfId("sound")
        assertThat(sound.title).isEqualTo("声音与播报")
        assertThat(sound.subtitle).isEqualTo("提示音 · TTS 语音音量")
        assertThat(sound.target).isEqualTo(OverviewTarget.SOUND)
    }

    @Test
    fun `notifications row directly follows collection control in group one`() {
        val collectionGroup = SettingsOverviewModel.sections(state()).first()

        assertThat(collectionGroup.title).isEqualTo("采集与上传")
        assertThat(collectionGroup.rows.first().id).isEqualTo("collection_control")
        assertThat(collectionGroup.rows[1].id).isEqualTo("notifications")
    }

    @Test
    fun `desktop group contains only widgets and notification history`() {
        val desktopGroup = SettingsOverviewModel.sections(state())
            .first { it.title == "桌面与历史" }

        assertThat(desktopGroup.rows.map { it.id })
            .containsExactly("widgets", "notification_history").inOrder()
    }

    @Test
    fun `notifications keeps switch target title and subtitle after the move`() {
        val enabled = rowOfId("notifications", state(notificationEnabled = true))
        assertThat(enabled.title).isEqualTo("通知")
        assertThat(enabled.subtitle).isEqualTo("已开启 · 敏感应用过滤")
        assertThat(enabled.target).isEqualTo(OverviewTarget.NOTIFICATIONS)
        assertThat(enabled.switch?.key).isEqualTo(OverviewSwitchKey.NOTIFICATION)
        assertThat(enabled.switch?.checked).isTrue()

        val disabled = rowOfId("notifications", state(notificationEnabled = false))
        assertThat(disabled.subtitle).isEqualTo("已停用 · 敏感应用过滤")
        assertThat(disabled.switch?.checked).isFalse()
    }

    @Test
    fun `device and background targets replace legacy system and battery targets`() {
        val targets = rowsOf(state()).mapNotNull { it.target }

        assertThat(targets).contains(OverviewTarget.DEVICE)
        assertThat(targets).contains(OverviewTarget.BACKGROUND)
        assertThat(targets.map { it.name }).doesNotContain("SYSTEM")
        assertThat(targets.map { it.name }).doesNotContain("BATTERY")
    }

    @Test
    fun `status card surfaces pending permissions`() {
        val card = SettingsOverviewModel.statusCard(
            state(
                serviceRunning = true,
                networkMode = "AUTO_CHAIN",
                networkLabel = "家庭 FRP",
                pendingPermissionCount = 1
            )
        )

        assertThat(card.title).isEqualTo("1 项待处理")
        assertThat(card.subtitle).isEqualTo("采集服务运行中 · 当前连接 自动选择 · 1 项待处理")
        assertThat(card.healthy).isFalse()
    }

    @Test
    fun `status card is healthy when service runs with no pending`() {
        val card = SettingsOverviewModel.statusCard(state(serviceRunning = true))

        assertThat(card.title).isEqualTo("状态正常")
        assertThat(card.subtitle).isEqualTo("采集服务运行中 · 当前连接 自动选择 · 状态正常")
        assertThat(card.healthy).isTrue()
    }

    @Test
    fun `status card reports stopped service`() {
        val card = SettingsOverviewModel.statusCard(
            state(serviceRunning = false, networkMode = "PINNED")
        )

        assertThat(card.title).isEqualTo("采集服务已停止")
        assertThat(card.subtitle).isEqualTo("采集服务已停止 · 当前连接 只用指定连接层 · 状态正常")
        assertThat(card.healthy).isFalse()
    }

    @Test
    fun `security subtitle reflects ssl verification`() {
        assertThat(rowOf(OverviewTarget.SECURITY, state(sslVerify = true)).subtitle)
            .isEqualTo("SSL 证书验证已开启")
        assertThat(rowOf(OverviewTarget.SECURITY, state(sslVerify = false)).subtitle)
            .isEqualTo("SSL 证书验证已关闭")
    }

    @Test
    fun `widgets subtitle reflects its master switch`() {
        assertThat(rowOf(OverviewTarget.WIDGETS, state(widgetsEnabled = true)).subtitle)
            .isEqualTo("已开启 · 总开关与钉选入口")
        assertThat(rowOf(OverviewTarget.WIDGETS, state(widgetsEnabled = false)).subtitle)
            .isEqualTo("已停用 · 卡片显示停用占位")
    }
}
