package com.xehuri.kinship.service

import android.content.Context
import org.json.JSONObject
import timber.log.Timber
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * 待上传感知事件队列（进程内单例）。
 *
 * **统一上传约定（2026-09-16）**：除「健康数据」（`HealthBatchUploader` → `/api/health/sync`）
 * 与「环境音频」（`AudioUploader` / WS 推流）外，所有感知事件都不再由采集器自己发 HTTP ——
 * 采集器只调用 `DataCollectorService.enqueueEvent(type, payload)` 入队，由 `DataCollectorService`
 * 的主循环按 `loop_ms`（默认 30s）统一触发上传（`flushPendingUploads()`）。
 *
 * 收益：网络活动集中在主循环时刻，采集侧不再各自唤醒网络（系统状态默认 1s 一轮，
 * 原先每次变化都直接 POST）。上传失败的事件仍由 `PerceptionCache` 落盘重试，不会丢。
 *
 * 取舍：进程被杀会丢失队列中尚未发出的事件 —— 这与「统一上传」是同一个设计选择；
 * 若要求绝对不丢，需要把事件先落盘（IO 开销大），当前不做。
 */
object PendingUploadQueue {

    /**
     * 一条待发事件。
     *
     * [ts] 在**入队时**生成，保证上报的是事件发生时刻，而不是主循环统一发送的时刻。
     */
    class Item(val type: String, val payload: JSONObject, val ts: String)

    private val queue = ConcurrentLinkedQueue<Item>()

    /** 队列上限：长时间离线时防止内存无限增长（超出丢弃最旧的一条） */
    private const val MAX_SIZE = 2000

    /** 入队（线程安全）。payload 入队后不得再被调用方修改。 */
    fun put(type: String, payload: JSONObject) {
        val ts = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        while (queue.size >= MAX_SIZE) queue.poll()
        queue.add(Item(type, payload, ts))
    }

    /** 取出并清空全部待发事件（仅主循环调用） */
    fun drain(): List<Item> {
        val out = ArrayList<Item>()
        while (true) {
            val item = queue.poll() ?: break
            out.add(item)
        }
        return out
    }

    /** 当前积压条数 */
    fun size(): Int = queue.size

    // ── 落盘快照（可选，受「离线缓存」开关控制）──────────────────────
    //
    // 主循环发送前先把本轮快照落盘：发送过程中进程被杀也不会丢，下次服务启动由
    // restoreFromDisk() 恢复。缓存开关关闭时不落盘 —— 与「离线缓存」的整体语义一致。
    // 代价：若在发送后、clearPersisted() 前被杀，重启会重复发送该批（后端通知按
    // sbn.key 去重，其他事件可能重复一次）。

    private const val PERSIST_FILE = "pending_uploads.jsonl"

    private fun persistFile(ctx: Context): File = File(ctx.cacheDir, PERSIST_FILE)

    /** 把一批待发事件落盘（「离线缓存」关闭时直接跳过） */
    fun persistSnapshot(ctx: Context, items: List<Item>) {
        if (items.isEmpty()) return
        if (!DataCollectorService.isCacheEnabled(ctx)) return
        try {
            val sb = StringBuilder()
            for (item in items) {
                sb.append(
                    JSONObject().apply {
                        put("type", item.type)
                        put("payload", item.payload)
                        put("ts", item.ts)
                    }.toString()
                ).append('\n')
            }
            persistFile(ctx).writeText(sb.toString())
        } catch (e: Exception) {
            Timber.w("PendingUploadQueue 落盘失败: ${e.message}")
        }
    }

    /** 清空落盘快照（本轮发送流程结束后调用） */
    fun clearPersisted(ctx: Context) {
        try {
            persistFile(ctx).delete()
        } catch (_: Exception) {
        }
    }

    /** 服务启动时恢复上次未发出的条目（读入内存队列后删除快照文件） */
    fun restoreFromDisk(ctx: Context) {
        try {
            val f = persistFile(ctx)
            if (!f.exists()) return
            var n = 0
            for (line in f.readLines()) {
                if (line.isBlank()) continue
                try {
                    val o = JSONObject(line)
                    val payload = o.optJSONObject("payload") ?: continue
                    queue.add(Item(o.optString("type"), payload, o.optString("ts")))
                    n++
                } catch (_: Exception) {
                }
            }
            f.delete()
            if (n > 0) Timber.i("PendingUploadQueue 已恢复 $n 条未发送事件")
        } catch (e: Exception) {
            Timber.w("PendingUploadQueue 恢复失败: ${e.message}")
        }
    }
}
