package com.xehuri.kinship.widget

import android.content.Context
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.network.AppHttpClient
import org.json.JSONObject
import timber.log.Timber
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * ReminderStore - AI 提醒公告板本地缓存（fetch + persist + widget 读侧单实现）
 *
 * 公告板模型（v2 契约）：整块覆盖制——服务端只维护**一整块文本**，AI 先读后编辑再
 * 整块覆写（POST 仅 AI 侧使用），App 只读、无任何写入通道；无条目生命周期，
 * updated_at 语义 = 最近一次整板写入时刻。数据真源在服务端（落盘文件，重启不丢）；
 * 本 store 只是渲染缓存：sync 成功即 REPLACE-ALL 整体覆盖两键——**含"成功且空板"**
 * （text 为 "" 是合法板面，照样覆盖，旧 v1 条目缓存由此自然清除）。写入方两条通道：
 * 采集服务主循环（约 30s 一轮）与 [WidgetSyncWorker] 15 分钟周期兜底。
 *
 * 契约实况（backend GET /api/reminders，逐字段照抄）：
 * {"text":str,"updated_at":int(unix秒, 0=从未写入)}
 * text 为整板全文（≤2000 字，可含换行，可为 ""）。判据只认**键存在性**：信封缺
 * "text" 键 / 类型不符 / 解析异常才算失败（保留本地旧板）——空字符串是合法板面，
 * 绝不能用 optString 的默认值语义把空板误判成失败。
 *
 * 红线同 widget 数据桥：只存提醒文案与时间戳，token/凭证绝不进本文件。
 */
object ReminderStore {
    /** 独立 prefs 文件（与 widget_snapshot / notification_store 分离，互不干扰） */
    const val PREFS_NAME = "reminder_store"

    /** 整板文本键（可为 ""=空板；键不存在=从未同步成功） */
    private const val KEY_TEXT = "text"

    /** 最近一次整板写入时刻键（unix 秒，0=从未写入） */
    private const val KEY_UPDATED_AT = "updated_at"

    /**
     * 从服务端同步整板并 REPLACE-ALL 覆盖本地缓存；成功返回 true（含"成功且空板"）。
     * 任何失败（网络/非 200/信封缺 text 键/解析异常）静默返回 false、本地旧板原样，
     * 只记 Timber.w——提醒同步失败绝不冒泡打断调用方主循环。
     * updated_at 按服务端原样存 unix 秒，读侧换算毫秒展示。
     */
    suspend fun syncFromServer(context: Context): Boolean {
        return runCatching {
            // 冷拉起语义与通知回填一致：BASE_URL 先幂等 init 从 prefs 现读
            ServerConfig.init(context)
            val url = "${ServerConfig.BASE_URL}/api/reminders"
            val body = AppHttpClient(context).get(url)
            val envelope = JSONObject(body)
            // 只认键存在性：has 对 null 值返回 false，空串 "" 才是合法空板
            if (!envelope.has(KEY_TEXT)) return false
            // getString 类型不符抛 JSONException，由 runCatching 兜为失败保留旧板
            val text = envelope.getString(KEY_TEXT)
            val updatedAt = envelope.optLong(KEY_UPDATED_AT, 0L)
            // clear 后整写两键 = 严格 REPLACE-ALL：首同步成功即冲掉 v1 时代遗留的条目缓存，
            // 之后本 prefs 恒只含 text / updated_at 两键
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .putString(KEY_TEXT, text)
                .putLong(KEY_UPDATED_AT, updatedAt)
                .apply()
            true
        }.getOrElse {
            Timber.w("提醒同步失败（保留本地旧板）: ${it.message}")
            false
        }
    }

    /** 纯本地读公告板缓存 (text, updated_at 秒)；键缺失/读取异常一律 ("", 0)，绝不阻塞渲染 */
    fun readBoard(context: Context): Pair<String, Long> =
        runCatching {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            (prefs.getString(KEY_TEXT, "") ?: "") to prefs.getLong(KEY_UPDATED_AT, 0L)
        }.getOrDefault("" to 0L)

    /** 时间格式化（"MM-dd HH:mm"，非正值显示占位；入参 unix 秒，本地实现，模式沿 NotificationStore.formatTime） */
    fun formatTime(tsSeconds: Long): String {
        if (tsSeconds <= 0L) return "--:--"
        return SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(tsSeconds * 1000L))
    }
}
