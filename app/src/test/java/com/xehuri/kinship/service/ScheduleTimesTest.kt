package com.xehuri.kinship.service

import com.google.common.truth.Truth.assertThat
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Calendar

/**
 * 验证健康数据「定时时段」调度的两个纯函数：
 * [DataCollectorService.parseScheduleTimes] 与 [DataCollectorService.scheduleTimeCrossed]。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScheduleTimesTest {

    // ======================== parseScheduleTimes ========================

    @Test
    fun `parse valid times`() {
        assertThat(DataCollectorService.parseScheduleTimes("08:00,13:00,22:00"))
            .containsExactly(480, 780, 1320)
            .inOrder()
    }

    @Test
    fun `parse ignores invalid and dedups`() {
        assertThat(DataCollectorService.parseScheduleTimes("8:00, 25:00, 08:00, abc, 12:60"))
            .containsExactly(480)
            .inOrder()
    }

    @Test
    fun `parse supports newline and semicolon separators`() {
        assertThat(DataCollectorService.parseScheduleTimes("07:30\n09:15;11:45"))
            .containsExactly(450, 555, 705)
            .inOrder()
    }

    @Test
    fun `parse blank returns empty`() {
        assertThat(DataCollectorService.parseScheduleTimes("")).isEmpty()
        assertThat(DataCollectorService.parseScheduleTimes("   ")).isEmpty()
    }

    // ======================== scheduleTimeCrossed ========================

    @Test
    fun `crossed when target within window`() {
        val now = timeOf(2026, Calendar.SEPTEMBER, 14, 13, 30)
        val last = now - 3_600_000L // 12:30
        assertTrue(DataCollectorService.scheduleTimeCrossed(last, now, 13 * 60))
    }

    @Test
    fun `not crossed when target before window`() {
        val now = timeOf(2026, Calendar.SEPTEMBER, 14, 13, 30)
        val last = now - 600_000L // 13:20
        assertFalse(DataCollectorService.scheduleTimeCrossed(last, now, 13 * 60))
    }

    @Test
    fun `not crossed when target in the future today`() {
        val now = timeOf(2026, Calendar.SEPTEMBER, 14, 13, 30)
        val last = now - 3_600_000L
        assertFalse(DataCollectorService.scheduleTimeCrossed(last, now, 14 * 60))
    }

    @Test
    fun `first run always crossed`() {
        val now = timeOf(2026, Calendar.SEPTEMBER, 14, 13, 30)
        assertTrue(DataCollectorService.scheduleTimeCrossed(0L, now, 8 * 60))
    }

    @Test
    fun `target exactly equal to now counts as crossed`() {
        val now = timeOf(2026, Calendar.SEPTEMBER, 14, 13, 30)
        val last = now - 1_000L
        assertTrue(DataCollectorService.scheduleTimeCrossed(last, now, 13 * 60 + 30))
    }

    private fun timeOf(year: Int, month: Int, day: Int, hour: Int, minute: Int): Long =
        Calendar.getInstance().apply {
            set(year, month, day, hour, minute, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis
}
