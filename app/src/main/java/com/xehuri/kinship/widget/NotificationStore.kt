package com.xehuri.kinship.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * NotificationStore - AI 通知全文历史持久化（写侧 + 读侧单实现）
 *
 * 取代旧 widget_snapshot.notify_ring（5 条 x 200 字环形缓冲）成为唯一真源：
 * 历史是 App 自身功能（桌面组件停用时仍照常记录），AiNotifyWidget 只是消费方之一
 * （取最近 5 条、展示侧截断），NotificationHistoryActivity 展示全文。
 *
 * 存储形态沿用 widget 数据桥既有惯例：独立 prefs 文件 + org.json 数组字符串（新条目在头），
 * 零新依赖；只存通知文案与时间戳，token/凭证绝不进本文件。
 *
 * 并发口径：写入方为采集服务主链（每条推送一次）与回填协程，均为读-改-写整数组回写；
 * SharedPreferences 自身保证原子落盘，同一秒内极端并发理论上可能丢一条更新（best-effort
 * 历史记录，接受该窗口，不加锁）。
 */
object NotificationStore {
    /** 独立 prefs 文件名（与 widget_snapshot 数据桥分离） */
    const val PREFS_NAME = "notification_store"

    private const val KEY_ITEMS = "items"

    /** 旧环形缓冲位置（迁移来源，一次性；迁移后即删该键） */
    private const val LEGACY_PREFS = WidgetSnapshot.PREFS_NAME
    private const val LEGACY_KEY_RING = "notify_ring"

    /** 条数封顶（新→旧，超出淘汰最旧） */
    private const val MAX_ITEMS = 50

    /** 正文防御性截断长度：全文保存但不允许超长文本撑爆 prefs */
    private const val BODY_MAX_CHARS = 4000

    /**
     * 写入一条通知（新条目插头部、封顶 50 条、正文防御截断 4000 字、按 (id, ts) 复合键去重）。
     * id 与 ts 全等才整条跳过——回填与实时推送共用后端自增 id，同一事件重复到达不双写；
     * 后端进程重启后自增 id 归零回收，与本地旧条目时间戳必不同，新推送不再被吞
     * （后端侧 id 的跨进程唯一性由 epoch-秒前缀保证，属兄弟提交的配套改动）。
     * 缺 ts 的历史行与 readAll 同语义按 0 解析：只会抑制 ts==0 的退化重复，绝不吞真实推送。
     * ts 默认当前时刻；回填历史条目传入 created_at 换算的毫秒值。
     */
    fun push(context: Context, id: Int, title: String, body: String, ts: Long = System.currentTimeMillis()) {
        runCatching {
            ensureLegacyMigration(context)
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val existing = JSONArray(prefs.getString(KEY_ITEMS, "[]") ?: "[]")
            for (i in 0 until existing.length()) {
                val o = existing.optJSONObject(i) ?: continue
                // 复合 (id, ts) 判重：两者全等才是同一事件的重复投递
                if (o.optInt("id", Int.MIN_VALUE) == id && o.optLong("ts", 0L) == ts) return
            }
            val items = JSONArray()
            items.put(
                JSONObject()
                    .put("id", id)
                    .put("title", title)
                    .put("body", body.take(BODY_MAX_CHARS))
                    .put("ts", ts)
            )
            for (i in 0 until existing.length()) {
                if (items.length() >= MAX_ITEMS) break
                existing.optJSONObject(i)?.let { items.put(it) }
            }
            prefs.edit().putString(KEY_ITEMS, items.toString()).apply()
        }
    }

    /** 读全部历史（新→旧）；任何解析失败/键缺失一律返回空列表 */
    fun readAll(context: Context): List<NotifyItem> =
        runCatching {
            ensureLegacyMigration(context)
            val raw = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_ITEMS, "[]") ?: "[]"
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { o ->
                    NotifyItem(
                        id = o.optInt("id"),
                        title = o.optString("title"),
                        body = o.optString("body"),
                        ts = o.optLong("ts"),
                    )
                }
            }
        }.getOrDefault(emptyList())

    /** 取最近 n 条（新→旧），通知卡消费口 */
    fun readRecent(context: Context, n: Int): List<NotifyItem> = readAll(context).take(n)

    /** 是否尚无任何历史（回填前置条件判定用） */
    fun isEmpty(context: Context): Boolean = readAll(context).isEmpty()

    /** 时间格式化（卡 "HH:mm" / 历史页 "MM-dd HH:mm" 共用，非正值显示占位） */
    fun formatTime(ts: Long, pattern: String = "HH:mm"): String {
        if (ts <= 0L) return "--:--"
        return SimpleDateFormat(pattern, Locale.getDefault()).format(Date(ts))
    }

    /**
     * 一次性迁移旧 widget_snapshot.notify_ring（5x200 环形缓冲）：
     * notification_store.items 键不存在 且 旧 ring 存在 → 全部条目移入（旧→新逐条插头部，
     * 最终新→旧次序不变），随后删除旧键，保证只迁一次。
     * 迁移自身独立 runCatching：失败（如 ring JSON 损坏）不影响本次读写，旧键保留、下次再试。
     */
    private fun ensureLegacyMigration(context: Context) {
        runCatching {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            if (prefs.getString(KEY_ITEMS, null) != null) return
            val legacy = context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)
            val ringRaw = legacy.getString(LEGACY_KEY_RING, null) ?: return
            val ring = JSONArray(ringRaw)
            val items = JSONArray()
            // ring 存序为新→旧；从尾（最旧）往头（最新）逐条插入 items 头部 → 次序原样保留
            for (i in ring.length() - 1 downTo 0) {
                ring.optJSONObject(i)?.let { item ->
                    if (items.length() < MAX_ITEMS) items.put(0, item)
                }
            }
            prefs.edit().putString(KEY_ITEMS, items.toString()).apply()
            legacy.edit().remove(LEGACY_KEY_RING).apply()
        }
    }
}

/** AI 通知历史条目：ts 为毫秒墙钟，展示侧文本由消费方经 formatTime 格式化 */
data class NotifyItem(
    val id: Int,
    val title: String,
    val body: String,
    val ts: Long,
)
