package com.xehuri.kinship.service

import android.app.Notification
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import java.util.LinkedHashMap
import java.util.LinkedList

/**
 * NotificationListenerService - 通知监听服务
 *
 * 监听系统所有通知（微信消息、系统通知等），将通知内容缓存到内存。
 * 通过 getRecentNotifications() 供其他组件查询最近通知。
 *
 * 缓存上限 50 条，线程安全（synchronized）。
 *
 * ## Xiaomi / MIUI 兼容性
 * 在 MIUI / HyperOS 上，仅声明 BIND_NOTIFICATION_LISTENER_SERVICE 权限不够，
 * 用户必须手动开启「通知读取权限」：
 *   Settings → 应用设置 → 应用管理 → Kinship → 通知读取权限
 * 或通过 Intent 引导：
 *   Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
 *
 * ## Android 15+ 兼容性
 * notification.extras 可能缺少 EXTRA_TITLE 或 EXTRA_TEXT，代码已做 null 安全处理。
 * extras 本身也可能为 null（罕见但可能），已做 try-catch 保护。
 */
class NotificationListenerService : NotificationListenerService() {

    /**
     * 通知条目数据类
     *
     * [key]/[id]/[subText] 为通知上行新增字段，均带默认值以保持既有构造兼容。
     */
    data class NotificationEntry(
        val packageName: String,
        val title: String,
        val text: String,
        val postTime: Long,
        /** sbn.key：通知去重主键（同一通知刷新时保持不变） */
        val key: String = "",
        /** sbn.id：系统通知 ID */
        val id: Int = 0,
        /** 可选副标题 */
        val subText: String? = null
    )

    companion object {
        /** 当前正在运行的 NotificationListenerService 实例 */
        @JvmStatic
        var currentInstance: NotificationListenerService? = null
            private set

        /**
         * 通知上行转发监听器：由 NotificationCollector 在启动时注册、停止时注销。
         * 仅在「通知新建或内容变化」时回调（去重已在 [onNotificationPosted] 内完成）。
         */
        @Volatile
        var entryListener: ((NotificationEntry) -> Unit)? = null

        /** 去重表容量上限（LRU） */
        private const val DEDUP_LIMIT = 64

        /**
         * 检查通知监听服务是否已启用
         * 优先判断 currentInstance（服务正在运行），
         * 回退检查系统设置（解决 MIUI 等 ROM 重启后 currentInstance 丢失的问题）
         */
        @JvmStatic
        fun isListenerEnabled(context: Context? = null): Boolean {
            if (currentInstance != null) return true
            val ctx = context ?: currentInstance ?: return false
            val enabled = try {
                Settings.Secure.getString(
                    ctx.contentResolver,
                    "enabled_notification_listeners"
                )
            } catch (_: Exception) { null }
            return enabled?.contains("com.xehuri.kinship/.service.NotificationListenerService") == true
        }

        /**
         * 获取 currentInstance（供 DataCollectorService 直接操作）
         */
        @JvmStatic
        fun getInstance(): NotificationListenerService? = currentInstance
    }

    /** 内存缓存，最多 50 条 */
    @JvmField
    val notificationCache: java.util.LinkedList<NotificationEntry> = LinkedList()

    /**
     * 上行去重器：以 key → 内容指纹 的判定是否需要转发（有界 LRU）。
     */
    private val dedup = NotificationDedup(DEDUP_LIMIT)

    override fun onListenerConnected() {
        super.onListenerConnected()
        currentInstance = this
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        currentInstance = null
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            val extras = sbn.notification.extras ?: return
            val title = extras.getString(Notification.EXTRA_TITLE) ?: ""
            val text = extras.getString(Notification.EXTRA_TEXT) ?: ""
            val subText = try {
                extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()
            } catch (_: Exception) {
                null
            }
            val key = sbn.key ?: "${sbn.packageName}:${sbn.id}"
            val entry = NotificationEntry(
                packageName = sbn.packageName,
                title = title,
                text = text,
                postTime = sbn.postTime,
                key = key,
                id = sbn.id,
                subText = subText
            )
            synchronized(notificationCache) {
                notificationCache.addLast(entry)
                if (notificationCache.size > 50) {
                    notificationCache.removeFirst()
                }
            }

            // 去重：同一 key 仅在新建或内容变化时转发（有界 LRU，防止刷屏）
            val fingerprint = "$title\u0000$text\u0000${subText ?: ""}"
            if (dedup.shouldEmit(key, fingerprint)) {
                try {
                    entryListener?.invoke(entry)
                } catch (_: Exception) {
                    // 转发回调异常不影响后续通知处理
                }
            }
        } catch (_: Exception) {
            // 通知解析失败时静默跳过，不崩溃
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        // 通知移除时不做处理，保留在缓存中供历史查询
    }

    /**
     * 获取最近的通知列表（线程安全）
     */
    fun getRecentNotifications(): List<NotificationEntry> {
        synchronized(notificationCache) {
            return notificationCache.toList()
        }
    }
}

/**
 * 通知上行去重器 —— 以 `key → 内容指纹` 判定是否需要转发。
 *
 * 同一 key 仅在「首次出现」或「内容指纹变化」时返回 true；使用 accessOrder=true
 * 的 LinkedHashMap 作为有界 LRU（超过 [limit] 淘汰最久未访问项）。线程安全。
 */
internal class NotificationDedup(private val limit: Int = 64) {

    private val cache = object : LinkedHashMap<String, String>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>): Boolean =
            size > limit
    }
    private val lock = Any()

    /** 内容新建或变化返回 true；否则返回 false。 */
    fun shouldEmit(key: String, fingerprint: String): Boolean = synchronized(lock) {
        val prev = cache[key]
        cache[key] = fingerprint
        prev != fingerprint
    }
}
