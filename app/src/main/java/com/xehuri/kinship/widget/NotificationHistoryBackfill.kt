package com.xehuri.kinship.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.DataCollectorService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import timber.log.Timber

/**
 * NotificationHistoryBackfill - 通知历史增量尾部回填（时间闸、可重入）
 *
 * 背景：后端 /api/notification/history 是易失内存态历史（每用户上限 100 条、重启即清）。
 * 增量语义：每次触发（服务冷启动 + 通知 WS 每次 connected 回执）尾部拉取 limit 条，
 * **不再要求本地库为空、也不再"一进程只拉一次"**——WS 半开/后端重启期间错过的通知，
 * 靠重连后的下一次 connected 触发回补。重连风暴由 60s 时间闸封顶：WS 退避上限 30s
 * （NotificationStreamClient scheduleReconnect），每次连接最多触发一次拉取，
 * 换算恒 ≤1 GET/分钟。幂等靠 NotificationStore.push 的 (id,ts) 去重（重复行是安全
 * 空操作），每次拉取天然只补新行。拉不到/为空都属正常，静默失败只记日志。
 *
 * 并发说明：闸的"认领"是 lastPullAtMs 先置后拉；极端并发下两个触发同时过闸最多多拉
 * 一次，去重语义保证内容不变，接受此窗口（不引入 AtomicLong/CAS 复杂度）。
 *
 * 响应契约（backend/routers/notifications.py get_notification_history 实况）：
 * {"notifications": [{"id": int, "title": str, "content": str, "created_at": unix秒}], "total": int}
 * —— notifications 已按新→旧返回；导入时反转为旧→新逐条 push（push 插头部），
 * 最终新→旧次序与后端一致；Bearer 由 AppHttpClient 自动注入，凭证绝不落本地库。
 */
object NotificationHistoryBackfill {

    /** 两次尾部拉取的最小间隔（ms）：WS 退避封顶 30s → 本闸换算 ≤1 GET/分钟 */
    private const val MIN_PULL_INTERVAL_MS = 60_000L

    /** 上次拉取的墙钟毫秒；0=进程内从未拉过（首轮恒放行） */
    @Volatile
    private var lastPullAtMs = 0L

    /** 纯时间闸（无副作用、可单测）：首轮恒放行；窗口内拒绝；到界放行；时钟回拨拒绝 */
    internal fun shouldPull(nowMs: Long, lastPullAtMs: Long): Boolean =
        lastPullAtMs == 0L || nowMs - lastPullAtMs >= MIN_PULL_INTERVAL_MS

    /** 尾部拉取条数上限（与后端 limit 参数及本地封顶一致） */
    private const val BACKFILL_LIMIT = 50

    suspend fun pullTail(context: Context) {
        val now = System.currentTimeMillis()
        if (!shouldPull(now, lastPullAtMs)) return
        lastPullAtMs = now
        runCatching {
            withContext(Dispatchers.IO) {
                // Worker/服务冷拉起语义一致：BASE_URL 先幂等 init 从 prefs 现读
                ServerConfig.init(context)
                val url = "${ServerConfig.BASE_URL}/api/notification/history?limit=$BACKFILL_LIMIT"
                val body = AppHttpClient(context).get(url)
                val arr = JSONObject(body).optJSONArray("notifications") ?: return@withContext
                // 拉取前本地 id 集合：判定真正新增的行（push 按 id 去重，集合本身也防数组内重复行）
                val known = NotificationStore.readAll(context).mapTo(HashSet()) { it.id }
                var pulled = 0
                var added = 0
                // 反序遍历（后端新→旧 → 本地按旧→新逐条插头部）
                for (i in arr.length() - 1 downTo 0) {
                    val o = arr.optJSONObject(i) ?: continue
                    val id = o.optInt("id")
                    val sec = o.optLong("created_at")
                    // created_at 缺失/非法（<=0）时落当前时刻，避免整条时间戳为 0 显示占位。
                    // 同源口径：WS 帧 ts == 历史 created_at（同为 epoch 秒），实时路直通
                    // tsSec*1000 入店与这里同值 ⇒ 同一事件双路 (id,ts) 判重命中，无孪生行。
                    val tsMs = if (sec > 0L) sec * 1000L else System.currentTimeMillis()
                    NotificationStore.push(context, id, o.optString("title"), o.optString("content"), tsMs)
                    pulled++
                    if (known.add(id)) added++
                }
                Timber.i("通知历史增量回填：拉取 $pulled 条，新增 $added 条")
                // 仅真正落入新行才刷通知卡（重复拉取全旧内容不打扰 Glance 异步会话；
                // 停用态渲染为占位卡，直更无意义，仍受总开关门控）
                if (added > 0 && DataCollectorService.isWidgetsEnabled(context)) {
                    runCatching { AiNotifyWidget().updateAll(context) }
                }
            }
        }.onFailure { Timber.w("通知历史回填失败（忽略，下次连接触发再试）: ${it.message}") }
    }
}
