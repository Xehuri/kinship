package com.xehuri.kinship.widget

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * WidgetColorStore 单元测试（Robolectric 真实 prefs，TDD 先红后绿）。
 *
 * 覆盖：未设态默认（(null,null) 配色 + scrim 恒 true）、半对拒写不留任何持久化、
 * 成对写入两键齐备可读回、0x00000000 全透明色值不被哨兵吞掉（contains 守卫口径）、
 * clear 回默认、双卡隔离、normalizeHex 合法/非法矩阵、PRESETS 元数据（8 对、命名唯一、
 * 全 0xFF 不透明、默认纸感与内置色板逐值相等）。
 *
 * scrim 写侧按冻结 API 走原生 prefs 键（"${cardKey}_scrim"），测试直接钉住键名与
 * 缺省语义——T6 设置页写入同源键。
 * 说明：仓库沿用 JUnit4 + Robolectric 可运行组合（见 WidgetBackgroundStoreTest 头注）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WidgetColorStoreTest {

    private lateinit var context: Context

    private val prefs get() =
        context.getSharedPreferences(WidgetColorStore.PREFS_NAME, Context.MODE_PRIVATE)

    @Before
    fun setup() {
        context = ApplicationProvider.getApplicationContext()
    }

    // ========================================================================
    // 常量与键名口径（T6 依赖字面量，测试钉死）
    // ========================================================================

    @Test
    fun `prefs file and card key literals match locked naming`() {
        assertThat(WidgetColorStore.PREFS_NAME).isEqualTo("widget_color_store")
        assertThat(WidgetColorStore.KEY_AI_NOTIFY).isEqualTo("ai_notify")
        assertThat(WidgetColorStore.KEY_AI_REMINDER).isEqualTo("ai_reminder")
    }

    // ========================================================================
    // 未设态（默认回退）
    // ========================================================================

    @Test
    fun `readBackground and readText return null pair when nothing stored`() {
        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(null to null)
        assertThat(WidgetColorStore.readText(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(null to null)
        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_REMINDER))
            .isEqualTo(null to null)
    }

    @Test
    fun `readScrim defaults true when scrim key missing`() {
        assertThat(WidgetColorStore.readScrim(context, WidgetColorStore.KEY_AI_NOTIFY)).isTrue()
        assertThat(WidgetColorStore.readScrim(context, WidgetColorStore.KEY_AI_REMINDER)).isTrue()
    }

    // ========================================================================
    // scrim 键（写侧 = 原生 prefs "${cardKey}_scrim"，T6 同源）
    // ========================================================================

    @Test
    fun `readScrim returns false when scrim key persisted false`() {
        prefs.edit().putBoolean("ai_notify_scrim", false).apply()

        assertThat(WidgetColorStore.readScrim(context, WidgetColorStore.KEY_AI_NOTIFY)).isFalse()
        // 双卡隔离：提醒卡不受通知卡开关牵连
        assertThat(WidgetColorStore.readScrim(context, WidgetColorStore.KEY_AI_REMINDER)).isTrue()
    }

    @Test
    fun `readScrim returns true when scrim key persisted true`() {
        prefs.edit().putBoolean("ai_reminder_scrim", true).apply()

        assertThat(WidgetColorStore.readScrim(context, WidgetColorStore.KEY_AI_REMINDER)).isTrue()
    }

    // ========================================================================
    // 成对读写与半对拒绝
    // ========================================================================

    @Test
    fun `writeBackground persists both keys and readBackground returns the pair`() {
        val day = 0xFFEAF2FB.toInt()
        val night = 0xFF16283F.toInt()

        val ok = WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, day, night)

        assertThat(ok).isTrue()
        assertThat(prefs.contains("ai_notify_bg_day")).isTrue()
        assertThat(prefs.contains("ai_notify_bg_night")).isTrue()
        assertThat(prefs.getInt("ai_notify_bg_day", -1)).isEqualTo(day)
        assertThat(prefs.getInt("ai_notify_bg_night", -1)).isEqualTo(night)
        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(day to night)
    }

    @Test
    fun `writeText persists both keys and readText returns the pair`() {
        val day = 0xFF17324D.toInt()
        val night = 0xFFD6E6F5.toInt()

        val ok = WidgetColorStore.writeText(context, WidgetColorStore.KEY_AI_REMINDER, day, night)

        assertThat(ok).isTrue()
        assertThat(prefs.contains("ai_reminder_text_day")).isTrue()
        assertThat(prefs.contains("ai_reminder_text_night")).isTrue()
        assertThat(WidgetColorStore.readText(context, WidgetColorStore.KEY_AI_REMINDER))
            .isEqualTo(day to night)
    }

    @Test
    fun `writeBackground rejects half pair persisting nothing`() {
        assertThat(WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, 0xFF112233.toInt(), null))
            .isFalse()
        assertThat(WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, null, 0xFF445566.toInt()))
            .isFalse()

        assertThat(prefs.contains("ai_notify_bg_day")).isFalse()
        assertThat(prefs.contains("ai_notify_bg_night")).isFalse()
        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(null to null)
    }

    @Test
    fun `writeText rejects half pair persisting nothing`() {
        assertThat(WidgetColorStore.writeText(context, WidgetColorStore.KEY_AI_NOTIFY, null, 0xFF445566.toInt()))
            .isFalse()

        assertThat(prefs.contains("ai_notify_text_day")).isFalse()
        assertThat(prefs.contains("ai_notify_text_night")).isFalse()
    }

    @Test
    fun `rejected half pair write leaves previously persisted pair untouched`() {
        WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, 0xFF112233.toInt(), 0xFF445566.toInt())

        val ok = WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, 0xFF778899.toInt(), null)

        assertThat(ok).isFalse()
        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(0xFF112233.toInt() to 0xFF445566.toInt())
    }

    @Test
    fun `readBackground treats externally half-persisted pair as unset`() {
        // 契约口径：both-null unless pair present——只有一键在场视为未设（防御外部手改）
        prefs.edit().putInt("ai_notify_bg_day", 0x11223344).apply()

        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(null to null)
    }

    @Test
    fun `fully transparent zero argb is a legal color and never sentinel-swallowed`() {
        // 0x00000000 是合法颜色值：contains 守卫必须让它存得进、读得出，绝不被 0/-1 哨兵吞掉
        val ok = WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, 0, 0)

        assertThat(ok).isTrue()
        assertThat(prefs.contains("ai_notify_bg_day")).isTrue()
        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(0 to 0)
    }

    // ========================================================================
    // 复位（remove = 默认，never 哨兵写回）
    // ========================================================================

    @Test
    fun `writeBackground with both null removes both keys back to default`() {
        WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_REMINDER, 0xFFAABBCC.toInt(), 0xFFDDEEFF.toInt())

        val ok = WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_REMINDER, null, null)

        assertThat(ok).isTrue()
        assertThat(prefs.contains("ai_reminder_bg_day")).isFalse()
        assertThat(prefs.contains("ai_reminder_bg_night")).isFalse()
        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_REMINDER))
            .isEqualTo(null to null)
    }

    @Test
    fun `clearBackground and clearText remove keys restoring defaults`() {
        WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, 0xFFAABBCC.toInt(), 0xFFDDEEFF.toInt())
        WidgetColorStore.writeText(context, WidgetColorStore.KEY_AI_NOTIFY, 0xFF112233.toInt(), 0xFF445566.toInt())

        WidgetColorStore.clearBackground(context, WidgetColorStore.KEY_AI_NOTIFY)
        WidgetColorStore.clearText(context, WidgetColorStore.KEY_AI_NOTIFY)

        assertThat(prefs.contains("ai_notify_bg_day")).isFalse()
        assertThat(prefs.contains("ai_notify_bg_night")).isFalse()
        assertThat(prefs.contains("ai_notify_text_day")).isFalse()
        assertThat(prefs.contains("ai_notify_text_night")).isFalse()
        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(null to null)
        assertThat(WidgetColorStore.readText(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(null to null)
    }

    @Test
    fun `clear on unset keys is a harmless no-op`() {
        WidgetColorStore.clearBackground(context, WidgetColorStore.KEY_AI_REMINDER)
        WidgetColorStore.clearText(context, WidgetColorStore.KEY_AI_REMINDER)

        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_REMINDER))
            .isEqualTo(null to null)
        assertThat(WidgetColorStore.readText(context, WidgetColorStore.KEY_AI_REMINDER))
            .isEqualTo(null to null)
    }

    // ========================================================================
    // 双卡隔离
    // ========================================================================

    @Test
    fun `color slots are isolated per card key`() {
        WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, 0xFFAABBCC.toInt(), 0xFFDDEEFF.toInt())

        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_REMINDER))
            .isEqualTo(null to null)
    }

    // ========================================================================
    // normalizeHex 矩阵
    // ========================================================================

    @Test
    fun `normalizeHex accepts six digit uppercase producing opaque argb`() {
        assertThat(WidgetColorStore.normalizeHex("#1A2B3C")).isEqualTo(0xFF1A2B3C.toInt())
    }

    @Test
    fun `normalizeHex accepts six digit lowercase same as uppercase`() {
        assertThat(WidgetColorStore.normalizeHex("#1a2b3c")).isEqualTo(WidgetColorStore.normalizeHex("#1A2B3C"))
        assertThat(WidgetColorStore.normalizeHex("#ffffff")).isEqualTo(0xFFFFFFFF.toInt())
    }

    @Test
    fun `normalizeHex rejects non hex letters`() {
        assertThat(WidgetColorStore.normalizeHex("#GGGGGG")).isNull()
    }

    @Test
    fun `normalizeHex rejects missing hash prefix`() {
        assertThat(WidgetColorStore.normalizeHex("1A2B3C")).isNull()
    }

    @Test
    fun `normalizeHex rejects eight digit form carrying alpha`() {
        assertThat(WidgetColorStore.normalizeHex("#1A2B3C4D")).isNull()
    }

    @Test
    fun `normalizeHex rejects four and five digit forms`() {
        assertThat(WidgetColorStore.normalizeHex("#1234")).isNull()
        assertThat(WidgetColorStore.normalizeHex("#12345")).isNull()
    }

    @Test
    fun `normalizeHex rejects empty and whitespace input`() {
        assertThat(WidgetColorStore.normalizeHex("")).isNull()
        assertThat(WidgetColorStore.normalizeHex("  ")).isNull()
    }

    // ========================================================================
    // PRESETS 元数据
    // ========================================================================

    @Test
    fun `presets hold eight entries with unique names`() {
        assertThat(WidgetColorStore.PRESETS).hasSize(8)
        assertThat(WidgetColorStore.PRESETS.map { it.name }.distinct()).hasSize(8)
    }

    @Test
    fun `preset entries carry fully opaque colors in all four slots`() {
        val opaqueMask = 0xFF000000.toInt()
        for (preset in WidgetColorStore.PRESETS) {
            for (argb in listOf(preset.bgDay, preset.bgNight, preset.textDay, preset.textNight)) {
                assertThat(argb and opaqueMask).isEqualTo(opaqueMask)
            }
        }
    }

    @Test
    fun `default preset mirrors the built-in card palette`() {
        val default = WidgetColorStore.PRESETS.first()

        assertThat(default.name).isEqualTo("默认纸感")
        assertThat(default.bgDay).isEqualTo(0xFFFFFFFF.toInt())
        assertThat(default.bgNight).isEqualTo(0xFF2B2930.toInt())
        assertThat(default.textDay).isEqualTo(0xFF1D1B20.toInt())
        assertThat(default.textNight).isEqualTo(0xFFE6E1E5.toInt())
    }

    @Test
    fun `preset colors survive write-read round trip`() {
        // 预设为成对完整色：任意预设为 T6 一键写入后必须原样读回
        val preset = WidgetColorStore.PRESETS[1]

        assertThat(WidgetColorStore.writeBackground(context, WidgetColorStore.KEY_AI_NOTIFY, preset.bgDay, preset.bgNight)).isTrue()
        assertThat(WidgetColorStore.writeText(context, WidgetColorStore.KEY_AI_NOTIFY, preset.textDay, preset.textNight)).isTrue()
        assertThat(WidgetColorStore.readBackground(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(preset.bgDay to preset.bgNight)
        assertThat(WidgetColorStore.readText(context, WidgetColorStore.KEY_AI_NOTIFY))
            .isEqualTo(preset.textDay to preset.textNight)
    }
}
