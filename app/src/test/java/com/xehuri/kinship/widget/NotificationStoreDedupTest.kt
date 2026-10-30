package com.xehuri.kinship.widget

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * NotificationStore 去重键单元测试（Robolectric 真实 prefs）。
 *
 * 背景：后端 notifications.py _next_id 每进程重启从 1 重来，回收 id 撞上本地旧条目——
 * 旧纯 id 去重把新推送整条吞掉（v1.4.1 桌面卡冻结根因）。去重键改为复合 (id, ts)。
 *
 * 说明：仓库沿用 JUnit4 org.junit.Test + Robolectric 可运行组合
 * （见 WidgetBackgroundStoreTest 头注）；"items" 为 NotificationStore.KEY_ITEMS
 * （private）的测试侧字面量，经 prefs 直接布置现场。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationStoreDedupTest {

    private lateinit var context: Context

    private val prefs get() =
        context.getSharedPreferences(NotificationStore.PREFS_NAME, Context.MODE_PRIVATE)

    @Before
    fun setup() {
        context = ApplicationProvider.getApplicationContext()
    }

    // ========================================================================
    // 复合键 (id, ts)：回收 id 不再吞新推送
    // ========================================================================

    @Test
    fun `recycled id with new ts is kept as separate entry`() {
        NotificationStore.push(context, id = 5, title = "旧推送", body = "重启前", ts = 1000L)
        NotificationStore.push(context, id = 5, title = "新推送", body = "重启后回收 id", ts = 2000L)

        val items = NotificationStore.readAll(context)
        assertThat(items).hasSize(2)
        // 新→旧：头部是刚到达的回收 id 推送，证明未被纯 id 去重吞掉
        assertThat(items[0].title).isEqualTo("新推送")
        assertThat(items[0].ts).isEqualTo(2000L)
        assertThat(items[1].title).isEqualTo("旧推送")
        assertThat(items[1].ts).isEqualTo(1000L)
    }

    @Test
    fun `same id and same ts is deduped`() {
        NotificationStore.push(context, id = 5, title = "同一推送", body = "重放", ts = 1000L)
        NotificationStore.push(context, id = 5, title = "同一推送", body = "重放", ts = 1000L)

        assertThat(NotificationStore.readAll(context)).hasSize(1)
    }

    @Test
    fun `live and backfill paths converge to one row when ts is frame-second-derived`() {
        // B1 回归：帧 ts 与回补 created_at 同为 epoch 秒，双路都按 *1000 换算后入店——
        // 同一事件两条路携带完全相同的 (id, tsSec*1000)，(id,ts) 复合键判重生效，
        // 实时推送到达后的第一次尾部回补不再产生孪生重复行。
        val tsSec = 1791892859L
        NotificationStore.push(context, id = 77, title = "推送", body = "实时直通帧 ts", ts = tsSec * 1000L)
        NotificationStore.push(context, id = 77, title = "推送", body = "尾部回补重放", ts = tsSec * 1000L)

        val items = NotificationStore.readAll(context)
        assertThat(items).hasSize(1)
        assertThat(items.single().ts).isEqualTo(tsSec * 1000L)
    }

    // ========================================================================
    // 封顶与次序（改动前后行为不变的基线护栏）
    // ========================================================================

    @Test
    fun `cap 50 keeps newest entries in new to old order`() {
        for (i in 0 until 55) {
            NotificationStore.push(context, id = i, title = "通知$i", body = "正文$i", ts = (i + 1) * 1000L)
        }

        val items = NotificationStore.readAll(context)
        assertThat(items).hasSize(50)
        assertThat(items.first().id).isEqualTo(54)
        // 新→旧严格降序，最旧的 5 条（ts 1000..5000）被淘汰
        assertThat(items.map { it.ts })
            .containsExactlyElementsIn((6..55).map { it * 1000L }.reversed())
    }

    @Test
    fun `writer always serializes ts and readAll roundtrips it`() {
        NotificationStore.push(context, id = 7, title = "形状", body = "验证 ts 字段", ts = 1730000000000L)

        val raw = JSONArray(prefs.getString("items", "[]") ?: "[]")
        assertThat(raw.length()).isEqualTo(1)
        assertThat(raw.getJSONObject(0).has("ts")).isTrue()
        assertThat(NotificationStore.readAll(context).single().ts).isEqualTo(1730000000000L)
    }

    // ========================================================================
    // 无 ts 历史行：失效安全方向
    // ========================================================================

    @Test
    fun `legacy row without ts only suppresses ts-zero duplicate and never swallows real pushes`() {
        // 手工布置"缺 ts"的历史行：去重比对与 readAll 同语义按 ts==0 解析。
        // 失效安全方向：只有 ts==0 的退化推送被当作重复抑制（0==0 判重）；
        // 真实推送（ts>0）绝不因时间戳缺失的旧行被吞——错也只能少记退化条目，不多吞新条目。
        val legacy = JSONArray().put(
            JSONObject().put("id", 5).put("title", "旧").put("body", "无时间戳"),
        )
        prefs.edit().putString("items", legacy.toString()).apply()

        NotificationStore.push(context, id = 5, title = "零时刻", body = "退化重复", ts = 0L)
        assertThat(NotificationStore.readAll(context)).hasSize(1)

        NotificationStore.push(context, id = 5, title = "真实推送", body = "绝不被吞", ts = 1234L)
        val items = NotificationStore.readAll(context)
        assertThat(items).hasSize(2)
        assertThat(items.first().title).isEqualTo("真实推送")
    }
}
