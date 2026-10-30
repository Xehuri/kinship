package com.xehuri.kinship.ui.settings

import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.transport.AddressFamily
import com.xehuri.kinship.transport.HttpAddress
import com.xehuri.kinship.transport.Tier
import com.xehuri.kinship.transport.TierConfig
import com.xehuri.kinship.transport.TierKind
import com.xehuri.kinship.transport.TierSelection
import com.xehuri.kinship.transport.TierTarget
import com.xehuri.kinship.transport.TransportHint
import org.junit.Test

class RunStatusModelTest {

    private fun inputs(
        notificationEnabled: Boolean = false,
        foregroundEnabled: Boolean = false,
        inputContentEnabled: Boolean = false,
        gpsEnabled: Boolean = false,
        wifiEnabled: Boolean = false,
        healthEnabled: Boolean = false,
        audioEnabled: Boolean = false,
        bluetoothEnabled: Boolean = false,
        notificationGranted: Boolean = false,
        usageStatsGranted: Boolean = false,
        accessibilityGranted: Boolean = false,
        locationGranted: Boolean = false,
        storageGranted: Boolean = false,
        microphoneGranted: Boolean = false,
        bluetoothGranted: Boolean = false,
        uploadEnabled: Boolean = false,
        batteryOptimized: Boolean = false
    ): PermissionInputs = PermissionInputs(
        notificationEnabled = notificationEnabled,
        foregroundEnabled = foregroundEnabled,
        inputContentEnabled = inputContentEnabled,
        gpsEnabled = gpsEnabled,
        wifiEnabled = wifiEnabled,
        healthEnabled = healthEnabled,
        audioEnabled = audioEnabled,
        bluetoothEnabled = bluetoothEnabled,
        notificationGranted = notificationGranted,
        usageStatsGranted = usageStatsGranted,
        accessibilityGranted = accessibilityGranted,
        locationGranted = locationGranted,
        storageGranted = storageGranted,
        microphoneGranted = microphoneGranted,
        bluetoothGranted = bluetoothGranted,
        uploadEnabled = uploadEnabled,
        batteryOptimized = batteryOptimized
    )

    private fun checkOf(inputs: PermissionInputs, key: String): PermissionCheck =
        RunStatusModel.permissions(inputs).first { it.key == key }

    private fun state(
        serviceRunning: Boolean = true,
        networkMode: String = "AUTO_CHAIN",
        networkLabel: String = "",
        pendingCount: Int = 0
    ): RunStatusState {
        val permissions = if (pendingCount == 0) {
            emptyList()
        } else {
            List(pendingCount) { index ->
                PermissionCheck(
                    key = "pending_$index",
                    label = "待处理 $index",
                    granted = false,
                    required = true
                )
            }
        }
        return RunStatusState(
            serviceRunning = serviceRunning,
            uploadEnabled = true,
            cacheEnabled = true,
            networkLabel = networkLabel,
            networkMode = networkMode,
            syncText = "",
            batteryOptimized = false,
            permissions = permissions
        )
    }

    @Test
    fun `no feature enabled requires no permission`() {
        val checks = RunStatusModel.permissions(inputs())

        assertThat(checks).hasSize(8)
        assertThat(checks.none { it.required }).isTrue()
        assertThat(RunStatusModel.pendingRequired(state())).isEmpty()
    }

    @Test
    fun `each feature toggle marks only its own check required`() {
        val cases = listOf(
            RunStatusModel.KEY_NOTIFICATION_LISTENER to inputs(notificationEnabled = true),
            RunStatusModel.KEY_USAGE_STATS to inputs(foregroundEnabled = true),
            RunStatusModel.KEY_ACCESSIBILITY to inputs(inputContentEnabled = true),
            RunStatusModel.KEY_LOCATION to inputs(gpsEnabled = true),
            RunStatusModel.KEY_STORAGE to inputs(healthEnabled = true),
            RunStatusModel.KEY_MICROPHONE to inputs(audioEnabled = true),
            RunStatusModel.KEY_BLUETOOTH to inputs(bluetoothEnabled = true),
            RunStatusModel.KEY_BATTERY to inputs(uploadEnabled = true)
        )

        for ((key, permissionInputs) in cases) {
            val checks = RunStatusModel.permissions(permissionInputs)
            assertThat(checks.first { it.key == key }.required).isTrue()
            assertThat(checks.filter { it.key != key }.none { it.required }).isTrue()
        }
    }

    @Test
    fun `wifi toggle also requires location`() {
        assertThat(checkOf(inputs(wifiEnabled = true), RunStatusModel.KEY_LOCATION).required).isTrue()
        assertThat(checkOf(inputs(gpsEnabled = true), RunStatusModel.KEY_LOCATION).required).isTrue()
    }

    @Test
    fun `granted required check is not pending`() {
        val permissionInputs = inputs(
            notificationEnabled = true,
            notificationGranted = true,
            audioEnabled = true,
            microphoneGranted = true,
            uploadEnabled = true,
            batteryOptimized = true
        )

        assertThat(RunStatusModel.pendingRequired(state())).isEmpty()
        assertThat(RunStatusModel.pendingRequiredCount(RunStatusModel.permissions(permissionInputs)))
            .isEqualTo(0)
    }

    @Test
    fun `pendingRequired only returns enabled but missing checks`() {
        val permissionInputs = inputs(
            notificationEnabled = true,
            notificationGranted = true,
            gpsEnabled = true,
            locationGranted = true,
            audioEnabled = true,
            microphoneGranted = false
        )
        val runState = state().copy(permissions = RunStatusModel.permissions(permissionInputs))

        assertThat(RunStatusModel.pendingRequired(runState).map { it.key })
            .containsExactly(RunStatusModel.KEY_MICROPHONE)
        assertThat(RunStatusModel.pendingRequiredCount(runState.permissions)).isEqualTo(1)
    }

    @Test
    fun `battery optimization granted means ignored`() {
        val ignored = checkOf(
            inputs(uploadEnabled = true, batteryOptimized = true),
            RunStatusModel.KEY_BATTERY
        )
        val notIgnored = checkOf(
            inputs(uploadEnabled = true, batteryOptimized = false),
            RunStatusModel.KEY_BATTERY
        )

        assertThat(ignored.granted).isTrue()
        assertThat(ignored.required).isTrue()
        assertThat(notIgnored.granted).isFalse()
        assertThat(notIgnored.required).isTrue()
    }

    @Test
    fun `bluetooth grant flag marks check granted`() {
        val missing = checkOf(
            inputs(bluetoothEnabled = true, bluetoothGranted = false),
            RunStatusModel.KEY_BLUETOOTH
        )
        val granted = checkOf(
            inputs(bluetoothEnabled = true, bluetoothGranted = true),
            RunStatusModel.KEY_BLUETOOTH
        )

        assertThat(missing.granted).isFalse()
        assertThat(granted.granted).isTrue()
    }

    @Test
    fun `summary reports running and no pending`() {
        assertThat(RunStatusModel.summary(state()))
            .isEqualTo("采集服务运行中 · 当前连接 自动选择 · 状态正常")
    }

    @Test
    fun `summary reports stopped service`() {
        assertThat(RunStatusModel.summary(state(serviceRunning = false)))
            .isEqualTo("采集服务已停止 · 当前连接 自动选择 · 状态正常")
    }

    @Test
    fun `summary reports pending count`() {
        assertThat(RunStatusModel.summary(state(pendingCount = 2)))
            .isEqualTo("采集服务运行中 · 当前连接 自动选择 · 2 项待处理")
    }

    @Test
    fun `summary follows network selection mode`() {
        assertThat(RunStatusModel.summary(state(networkMode = "PINNED")))
            .contains("当前连接 只用指定连接层")
        assertThat(RunStatusModel.summary(state(networkMode = "", networkLabel = "家庭 FRP")))
            .contains("当前连接 家庭 FRP")
    }

    @Test
    fun `network mode label maps known modes and keeps unknown raw`() {
        assertThat(RunStatusModel.networkModeLabel("AUTO_CHAIN")).isEqualTo("自动选择")
        assertThat(RunStatusModel.networkModeLabel("PINNED")).isEqualTo("只用指定连接层")
        assertThat(RunStatusModel.networkModeLabel("CUSTOM")).isEqualTo("CUSTOM")
        assertThat(RunStatusModel.networkModeLabel("")).isEmpty()
    }

    @Test
    fun `active tier label resolves the selected tier display label`() {
        val address = HttpAddress.parse("https://health.example:8768").getOrThrow()
        val tier = Tier(
            id = "tier-a",
            order = 0,
            kind = TierKind.NETWORK_ADDRESS,
            transportHint = TransportHint.FRP,
            target = TierTarget.Network(address),
            family = AddressFamily.AUTO,
            label = "家庭 FRP"
        )
        val config = TierConfig(
            tiers = listOf(tier),
            selection = TierSelection(activeTierId = "tier-a")
        )

        assertThat(RunStatusModel.activeTierLabel(config)).isEqualTo("家庭 FRP")
        assertThat(RunStatusModel.activeTierLabel(TierConfig())).isEmpty()
    }
}
