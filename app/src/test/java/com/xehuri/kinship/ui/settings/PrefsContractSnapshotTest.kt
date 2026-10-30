package com.xehuri.kinship.ui.settings

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.config.EndpointCandidate
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.config.TransportMode
import com.xehuri.kinship.service.DataCollectorService
import com.xehuri.kinship.widget.WidgetBackgroundStore
import com.xehuri.kinship.widget.WidgetColorStore
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * SharedPreferences 契约快照：键名 + 默认值的回归探测器。
 *
 * 只经生产访问器读写（不构造影子实现），覆盖设置页 loadInitialState() 使用的
 * 全部开关/间隔档与 ServerConfig 的持久化字段。任何键被重命名或默认值被改动，
 * 本测试必须失败；生产代码不得为通过本测试而修改。
 *
 * 说明：`axeuh_secure_prefs` 由 EncryptedSharedPreferences 承载（依赖 AndroidKeyStore），
 * Robolectric 下不可用，故本测试不触碰它，也不清除它。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrefsContractSnapshotTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        listOf(
            "axeuh_prefs",
            "sensor_toggles",
            "data_collector",
            "widget_background_store",
            "widget_color_store",
        ).forEach { name ->
            context.getSharedPreferences(name, Context.MODE_PRIVATE)
                .edit().clear().commit()
        }
    }

    // ========================================================================
    // A. 默认值契约（用生产访问器读取缺键态）
    // ========================================================================

    @Test
    fun `defaults match the documented contract`() {
        ServerConfig.init(context)
        // axeuh_prefs: "server_url" 缺键 -> DEFAULT_SERVER_URL（私有常量，按字面量钉死）
        assertThat(ServerConfig.BASE_URL).isEqualTo("https://localhost:8767")
        // axeuh_prefs: "endpoint_candidates" 缺键 -> 空列表
        assertThat(ServerConfig.endpointCandidates).isEmpty()
        // axeuh_prefs: "transport_mode" 缺键 -> AUTO
        assertThat(ServerConfig.transportMode).isEqualTo(TransportMode.AUTO)
        // axeuh_prefs: "device_name" 缺键 -> 非自定义名
        assertThat(ServerConfig.HAS_CUSTOM_DEVICE_NAME).isFalse()

        // data_collector: "audio_enabled"
        assertThat(DataCollectorService.isAudioEnabled(context)).isFalse()
        // sensor_toggles: "foreground_enabled"
        assertThat(DataCollectorService.isForegroundEnabled(context)).isFalse()
        // sensor_toggles: "notification_enabled"
        assertThat(DataCollectorService.isNotificationEnabled(context)).isFalse()
        // sensor_toggles: "health_enabled"
        assertThat(DataCollectorService.isHealthEnabled(context)).isFalse()
        // sensor_toggles: "gps_enabled"
        assertThat(DataCollectorService.isGpsEnabled(context)).isFalse()
        // sensor_toggles: "wifi_enabled"
        assertThat(DataCollectorService.isWifiEnabled(context)).isFalse()
        // sensor_toggles: "bluetooth_enabled"
        assertThat(DataCollectorService.isBluetoothEnabled(context)).isFalse()
        // sensor_toggles: "screen_state_enabled"
        assertThat(DataCollectorService.isScreenStateEnabled(context)).isFalse()
        // sensor_toggles: "input_content_enabled"
        assertThat(DataCollectorService.isInputContentEnabled(context)).isFalse()
        // sensor_toggles: "battery_enabled" 默认开
        assertThat(DataCollectorService.isBatteryEnabled(context)).isTrue()
        // data_collector: "upload_enabled" 默认开
        assertThat(DataCollectorService.isUploadEnabled(context)).isTrue()
        // data_collector: "cache_enabled" 默认开
        assertThat(DataCollectorService.isCacheEnabled(context)).isTrue()
        // data_collector: "widgets_enabled" 默认开
        assertThat(DataCollectorService.isWidgetsEnabled(context)).isTrue()
        // data_collector: "local_kws_enabled"
        assertThat(DataCollectorService.isLocalKwsEnabled(context)).isFalse()

        // data_collector: "loop_ms" 默认 30000
        assertThat(DataCollectorService.getLoopInterval(context)).isEqualTo(30_000L)
        // data_collector: "notify_ms" 默认 5000
        assertThat(DataCollectorService.getNotifyInterval(context)).isEqualTo(5_000L)
        // data_collector: "health_interval_ms" 默认 3600000
        assertThat(DataCollectorService.getHealthIntervalMs(context)).isEqualTo(3_600_000L)
        // data_collector: "gps_interval_ms" 默认 300000
        assertThat(DataCollectorService.getGpsIntervalMs(context)).isEqualTo(300_000L)
        // data_collector: "system_state_interval_ms" 默认 1000
        assertThat(DataCollectorService.getSystemStateIntervalMs(context)).isEqualTo(1_000L)
        // data_collector: "audio_segment_ms" 默认 60000
        assertThat(DataCollectorService.getAudioSegmentMs(context)).isEqualTo(60_000L)
        // data_collector: "audio_upload_batch_ms" 默认 600000
        assertThat(DataCollectorService.getAudioUploadBatchMs(context)).isEqualTo(600_000L)
        // data_collector: "hint_tone_volume" 默认 90
        assertThat(DataCollectorService.getHintToneVolume(context)).isEqualTo(90)
        // data_collector: "tts_volume" 默认 100
        assertThat(DataCollectorService.getTtsVolume(context)).isEqualTo(100)

        // widget_color_store: "{card}_scrim" 缺键 -> true（双卡）
        assertThat(WidgetColorStore.readScrim(context, WidgetColorStore.KEY_AI_NOTIFY)).isTrue()
        assertThat(WidgetColorStore.readScrim(context, WidgetColorStore.KEY_AI_REMINDER)).isTrue()
        // widget_background_store: 卡键缺键 -> null（双卡）
        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_NOTIFY))
            .isNull()
        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_REMINDER))
            .isNull()
    }

    // ========================================================================
    // B. 键名契约（直接写文档化键，断言生产访问器读得到 = 改名即红）
    // ========================================================================

    @Test
    fun `critical keys keep their names`() {
        // 全量写入非默认值，commit 保证同进程可见
        context.getSharedPreferences("data_collector", Context.MODE_PRIVATE).edit()
            .putBoolean("audio_enabled", true)
            .putBoolean("upload_enabled", false)
            .putBoolean("cache_enabled", false)
            .putLong("loop_ms", 60_000L)
            .putLong("health_interval_ms", 1_800_000L)
            .putLong("gps_interval_ms", 600_000L)
            .putLong("audio_segment_ms", 30_000L)
            .putBoolean("local_kws_enabled", true)
            .putLong("tts_volume", 55L)
            .commit()
        context.getSharedPreferences("sensor_toggles", Context.MODE_PRIVATE).edit()
            .putBoolean("notification_enabled", true)
            .commit()
        context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE).edit()
            .putString("transport_mode", "FORCE_FRP")
            .putString("server_url", "https://alt.example:9443")
            .commit()

        // data_collector: "audio_enabled"
        assertThat(DataCollectorService.isAudioEnabled(context)).isTrue()
        // data_collector: "upload_enabled"
        assertThat(DataCollectorService.isUploadEnabled(context)).isFalse()
        // data_collector: "cache_enabled"
        assertThat(DataCollectorService.isCacheEnabled(context)).isFalse()
        // data_collector: "loop_ms"
        assertThat(DataCollectorService.getLoopInterval(context)).isEqualTo(60_000L)
        // data_collector: "health_interval_ms"
        assertThat(DataCollectorService.getHealthIntervalMs(context)).isEqualTo(1_800_000L)
        // data_collector: "gps_interval_ms"
        assertThat(DataCollectorService.getGpsIntervalMs(context)).isEqualTo(600_000L)
        // data_collector: "audio_segment_ms"
        assertThat(DataCollectorService.getAudioSegmentMs(context)).isEqualTo(30_000L)
        // data_collector: "local_kws_enabled"
        assertThat(DataCollectorService.isLocalKwsEnabled(context)).isTrue()
        // data_collector: "tts_volume"
        assertThat(DataCollectorService.getTtsVolume(context)).isEqualTo(55)
        // sensor_toggles: "notification_enabled"
        assertThat(DataCollectorService.isNotificationEnabled(context)).isTrue()

        // axeuh_prefs: "server_url" 经生产初始化读入 BASE_URL
        ServerConfig.init(context)
        assertThat(ServerConfig.BASE_URL).isEqualTo("https://alt.example:9443")
        // axeuh_prefs: "transport_mode" 经生产初始化解析
        assertThat(ServerConfig.transportMode).isEqualTo(TransportMode.FORCE_FRP)

        // axeuh_prefs: "endpoint_candidates" 经生产写入口径落盘、再由 init 解析回读
        ServerConfig.updateEndpointCandidates(
            listOf(EndpointCandidate(EndpointCandidate.NAME_FRP, "https://frp.example"))
        )
        ServerConfig.init(context)
        assertThat(ServerConfig.endpointCandidates).hasSize(1)
        assertThat(ServerConfig.endpointCandidates[0].name)
            .isEqualTo(EndpointCandidate.NAME_FRP)
        assertThat(ServerConfig.endpointCandidates[0].url).isEqualTo("https://frp.example")
    }
}
