package com.xehuri.kinship.widget

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * ReminderBoardFingerprint 纯函数单元测试。
 *
 * 判重契约三判据（服务 5s 提醒子节拍据此决定是否重绘）：
 * 同板同指纹（不重绘）；text 变化换指纹；updated_at 单独变化也换指纹（廉价重绘，
 * 语义上整板确被覆写）。另验证注入性边界：text 以数字+'|' 开头不得与另一时间戳混淆。
 *
 * 说明：本仓库未启用 useJUnitPlatform（见 AudioSegmentPolicyTest 注释），
 * org.junit.jupiter 注解的测试不会被执行，故沿用可运行的 JUnit4 + Truth。
 */
class ReminderBoardFingerprintTest {

    @Test
    fun `same board produces equal fingerprint`() {
        val a = ReminderBoardFingerprint.of("今晚 8 点吃药\n带水杯", 1_728_000_000L)
        val b = ReminderBoardFingerprint.of("今晚 8 点吃药\n带水杯", 1_728_000_000L)
        assertThat(a).isEqualTo(b)
    }

    @Test
    fun `text change produces different fingerprint`() {
        val before = ReminderBoardFingerprint.of("今晚 8 点吃药", 1_728_000_000L)
        val after = ReminderBoardFingerprint.of("今晚 9 点吃药", 1_728_000_000L)
        assertThat(before).isNotEqualTo(after)
    }

    @Test
    fun `updated_at-only change produces different fingerprint`() {
        val before = ReminderBoardFingerprint.of("今晚 8 点吃药", 1_728_000_000L)
        val after = ReminderBoardFingerprint.of("今晚 8 点吃药", 1_728_000_001L)
        assertThat(before).isNotEqualTo(after)
    }

    @Test
    fun `empty board is a distinct valid fingerprint and never equals same-ts non-empty`() {
        // 空板是合法板面（sync 成功且空恒覆盖）：与同时间戳非空板必须区分
        assertThat(ReminderBoardFingerprint.of("", 0L))
            .isNotEqualTo(ReminderBoardFingerprint.of("x", 0L))
        // 空板换时间戳仍视为变更
        assertThat(ReminderBoardFingerprint.of("", 0L))
            .isNotEqualTo(ReminderBoardFingerprint.of("", 1L))
    }

    @Test
    fun `text starting with digits and separator cannot collide with another timestamp`() {
        // "0|1|2"：首段恒解析为时间戳 0、正文 "1|2"；不得与 (ts=1, text="2") 的 "1|2" 混淆
        assertThat(ReminderBoardFingerprint.of("1|2", 0L))
            .isNotEqualTo(ReminderBoardFingerprint.of("2", 1L))
    }

    @Test
    fun `negative and large timestamps stay injective`() {
        assertThat(ReminderBoardFingerprint.of("a", -1L))
            .isNotEqualTo(ReminderBoardFingerprint.of("a", 1L))
        assertThat(ReminderBoardFingerprint.of("a", Long.MIN_VALUE))
            .isNotEqualTo(ReminderBoardFingerprint.of("a", Long.MAX_VALUE))
    }
}
