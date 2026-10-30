package com.xehuri.kinship.widget

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * NotificationHistoryBackfill.shouldPull 纯时间闸单元测试。
 *
 * 判据契约（WS 每次 connected 回执与冷启动共用，防重连风暴打爆后端）：
 * 1) lastPullAtMs==0（进程内从未拉过，首轮）恒放行，不受窗口约束；
 * 2) 距上次拉取不足 60_000ms 一律拒绝（含边界内 1ms）；
 * 3) 达到/超过 60_000ms 放行（边界值恰好放行）。
 *
 * 说明：本仓库未启用 useJUnitPlatform（见 ReminderBoardFingerprintTest 注释），
 * org.junit.jupiter 注解不会被执行，故沿用可运行的 JUnit4 + Truth。
 */
class NotificationHistoryBackfillTest {

    @Test
    fun `first ever pull is allowed when lastPullAtMs is zero`() {
        // 首轮语义：即使"当前时刻"很早（now-last 差值小于窗口），last=0 必须放行
        assertThat(NotificationHistoryBackfill.shouldPull(nowMs = 30_000L, lastPullAtMs = 0L)).isTrue()
        assertThat(NotificationHistoryBackfill.shouldPull(nowMs = 1L, lastPullAtMs = 0L)).isTrue()
    }

    @Test
    fun `pull inside 60s window is rejected`() {
        assertThat(NotificationHistoryBackfill.shouldPull(nowMs = 100_000L, lastPullAtMs = 60_000L)).isFalse()
        // 窗口内最后 1ms 仍拒绝
        assertThat(NotificationHistoryBackfill.shouldPull(nowMs = 119_999L, lastPullAtMs = 60_000L)).isFalse()
    }

    @Test
    fun `pull at exactly the window boundary is allowed`() {
        assertThat(NotificationHistoryBackfill.shouldPull(nowMs = 120_000L, lastPullAtMs = 60_000L)).isTrue()
    }

    @Test
    fun `pull after the window is allowed`() {
        assertThat(NotificationHistoryBackfill.shouldPull(nowMs = 200_000L, lastPullAtMs = 60_000L)).isTrue()
        // 时钟回拨（now 早于 last）落在窗口内 → 拒绝，天然防御
        assertThat(NotificationHistoryBackfill.shouldPull(nowMs = 50_000L, lastPullAtMs = 60_000L)).isFalse()
    }
}
