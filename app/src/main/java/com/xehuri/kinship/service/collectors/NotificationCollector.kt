package com.xehuri.kinship.service.collectors

import android.content.Context
import android.service.notification.NotificationListenerService as AndroidNotificationListenerService
import timber.log.Timber
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.DataCollectorService
import com.xehuri.kinship.service.state.SensorStateHolder
import com.xehuri.kinship.service.uploader.PerceptionCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 通知采集器 —— 采集活跃通知计数，并将通知**内容**批量上行到后端。
 *
 * 职责分两块：
 * 1. **计数轮询**：周期性读取 [AndroidNotificationListenerService.activeNotifications]，
 *    更新 [SensorStateHolder] 的活跃通知数量（间隔 `notify_ms`）。
 * 2. **内容上行**：由 [com.xehuri.kinship.service.NotificationListenerService] 在
 *    按 `sbn.key` 去重后回调 [onNotificationEntry] 入队；本采集器的协程循环每轮
 *    按 `notify_upload_interval_ms` 限流，批量 POST 到
 *    `/api/screen/stt/perception-event`（`type="notify"`）。
 *
 * ## 开关与隐私
 * - 双重开关：`notification_enabled`（采集）与 `notify_upload_enabled`（上行）同时开启才上行；
 * - `notify_blocklist`（包名黑名单）内的通知只上报 `{package, ts, redacted:true}`，
 *   不携带标题/正文。
 *
 * ## 离线缓存
 * 上行失败的事件复用 [PerceptionCache] 落盘，下次上行前按序重放，避免丢数据。
 */
class NotificationCollector(
    context: Context,
    stateHolder: SensorStateHolder,
    httpClient: AppHttpClient,
    /** 通知服务提供者（可注入 mock 以方便测试） */
    private val notificationServiceProvider: () -> AndroidNotificationListenerService?
) : BaseCollector(context, stateHolder, httpClient) {

    companion object {
        /** 待上行队列上限（超出丢弃最旧，防止内存无界增长） */
        private const val MAX_PENDING = 200

        /** 使用 NotificationListenerService.getInstance 创建生产实例 */
        fun create(
            context: Context,
            stateHolder: SensorStateHolder,
            httpClient: AppHttpClient
        ): NotificationCollector {
            val ourServiceClass =
                "com.xehuri.kinship.service.NotificationListenerService"
            return NotificationCollector(context, stateHolder, httpClient) {
                try {
                    val clazz = Class.forName(ourServiceClass)
                    val method = clazz.getMethod("getInstance")
                    method.invoke(null) as? AndroidNotificationListenerService
                } catch (_: Exception) {
                    null
                }
            }
        }
    }

    private var scope: CoroutineScope? = null

    /** 待上行通知 payload 队列（NLS 回调入队、采集循环批量发出） */
    private val pending = ArrayDeque<JSONObject>()
    private val batchLock = Any()

    /** 上次批量上行的时间戳（ms），用于按 `notify_upload_interval_ms` 限流 */
    @Volatile
    private var lastUploadTs = 0L

    override val isEnabled: Boolean
        get() = DataCollectorService.isNotificationEnabled(context)

    override val isRunning: Boolean
        get() = scope != null

    override fun start() {
        if (scope != null) return
        // 注册 NLS 转发回调（按 sbn.key 去重已在 NLS 内完成），停止时注销
        com.xehuri.kinship.service.NotificationListenerService.entryListener = { entry ->
            onNotificationEntry(entry)
        }
        lastUploadTs = System.currentTimeMillis()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope!!.launch {
            Timber.i("通知采集已启动")
            while (isActive) {
                try {
                    // 逐轮复查开关，关闭后由 CollectorManager.applyToggle 停止
                    if (isEnabled) {
                        collectNotificationSummary()
                        flushPendingNotifications()
                    }
                } catch (e: Exception) {
                    Timber.w("通知采集异常: ${e.message}")
                }
                // 每轮重读间隔键，使设置页改动即时生效
                delay(getNotifyInterval())
            }
        }
    }

    override fun stop() {
        com.xehuri.kinship.service.NotificationListenerService.entryListener = null
        scope?.cancel()
        scope = null
        Timber.i("通知采集已停止")
    }

    /** 从 SharedPreferences 读取通知计数轮询间隔（默认 5000ms） */
    private fun getNotifyInterval(): Long =
        DataCollectorService.getNotifyInterval(context)

    // ======================== 上行入队 ========================

    /**
     * NLS 去重后的回调入口：按上行开关决定是否入队（不同步阻塞 NLS 线程）。
     */
    internal fun onNotificationEntry(
        entry: com.xehuri.kinship.service.NotificationListenerService.NotificationEntry
    ) {
        if (!DataCollectorService.isNotifyUploadEnabled(context)) return
        val payload = buildPayload(entry)
        synchronized(batchLock) {
            if (pending.size >= MAX_PENDING) pending.removeFirst()
            pending.addLast(payload)
        }
    }

    /**
     * 构造通知上行 payload。
     * 黑名单包只上报 `{package, ts, redacted:true}`，不携带标题/正文以保护隐私。
     */
    internal fun buildPayload(
        entry: com.xehuri.kinship.service.NotificationListenerService.NotificationEntry
    ): JSONObject {
        val ts = entry.postTime.takeIf { it > 0L } ?: System.currentTimeMillis()
        return if (entry.packageName in blocklistSet()) {
            JSONObject().apply {
                put("package", entry.packageName)
                put("ts", ts)
                put("redacted", true)
            }
        } else {
            JSONObject().apply {
                put("key", entry.key)
                put("id", entry.id)
                put("package", entry.packageName)
                put("title", entry.title)
                put("text", entry.text)
                if (!entry.subText.isNullOrEmpty()) put("subText", entry.subText)
                put("ts", ts)
                put("redacted", false)
            }
        }
    }

    /** 解析 `notify_sensitive_apps`（逗号/换行/分号分隔）为包名集合。 */
    private fun blocklistSet(): Set<String> =
        DataCollectorService.getNotifySensitiveApps(context)
            .split(',', '\n', ';')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .toSet()

    /**
     * 批量上行待发送通知。
     *
     * 复用感知事件端点与 [PerceptionCache] 离线队列模式：发送前先重放离线缓存，
     * 单条失败则落盘等待下次重试。受 `notify_upload_enabled` 与
     * `notification_enabled` 双重开关约束，并按 `notify_upload_interval_ms` 限流。
     */
    internal fun flushPendingNotifications() {
        if (!DataCollectorService.isNotifyUploadEnabled(context)) return
        if (!isEnabled) return

        val batch = synchronized(batchLock) {
            if (pending.isEmpty()) return
            val copy = pending.toList()
            pending.clear()
            copy
        }

        // 统一上传（2026-09-16）：只入队，由服务主循环按 loop_ms 统一发出。
        // 因此不再需要 notify_upload_interval_ms 限流 —— 采集到即刻入队，发送时机由主循环决定。
        for (payload in batch) {
            DataCollectorService.enqueueEvent("notify", payload)
        }
    }

    // ======================== 计数轮询 ========================

    /**
     * 单次采集入口（供内部循环和测试使用）。
     * 读取 activeNotifications 统计活跃通知总数并更新 [SensorStateHolder]。
     */
    internal suspend fun collectNotificationSummary() {
        val nls = notificationServiceProvider() ?: run {
            Timber.d("NotificationListenerService 未运行，跳过采集")
            return
        }
        val sbns = nls.activeNotifications ?: run {
            Timber.d("activeNotifications 为 null，跳过采集")
            return
        }
        stateHolder.updateNotificationCount(sbns.size)
        // 通知摘要仅用于驱动状态更新，刻意不写日志，避免每轮轮询刷屏服务日志
    }
}
