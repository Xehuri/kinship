package com.xehuri.kinship.service.uploader

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import timber.log.Timber
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 感知事件离线缓存 — 当前台应用/通知/GPS/锁屏等感知事件上传失败时，
 * 保存到本地文件，下次成功发送前自动重放。
 *
 * ## 缓存格式
 * ```
 * perception_cache/{timestamp_ms}_{type}.json
 * {"type":"app","payload":{"app":"Chrome"}}
 * ```
 *
 * ## 工作流
 * 1. [save]：上传失败时调用，写入缓存文件
 * 2. [flushSync]：主循环统一上传前调用，按序重放后删除
 *
 * 不依赖 AppHttpClient（兼容 Thread 和协程两种上下文），
 * 调用方传入自己的 HTTP 客户端即可。
 */
object PerceptionCache {

    private const val TAG = "PerceptionCache"
    private const val CACHE_DIR = "perception_cache"

    /** 缓存文件数量上限（超出后删除最旧的） */
    private const val MAX_CACHE_FILES = 500

    /** 缓存目录总字节上限（20MB，超出后删除最旧的） */
    private const val MAX_CACHE_BYTES = 20L * 1024 * 1024

    /**
     * 保存感知事件到本地缓存。
     *
     * @param ctx Context（用于获取 cacheDir）
     * @param type 事件类型（"app", "media", "device_env", "sensor", "screen", "heartbeat"）
     * @param payload 事件载荷
     */
    fun save(ctx: Context, type: String, payload: JSONObject) {
        if (!com.xehuri.kinship.service.DataCollectorService.isCacheEnabled(ctx)) {
            Timber.tag(TAG).i("缓存已禁用，跳过感知事件缓存")
            return
        }
        try {
            val dir = File(ctx.cacheDir, CACHE_DIR)
            dir.mkdirs()
            val ts = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
            val data = JSONObject().apply {
                put("type", type)
                put("payload", payload)
                put("ts", ts)
            }
            val file = File(dir, "${System.currentTimeMillis()}_${type}.json")
            file.writeText(data.toString())
            Timber.tag(TAG).i("感知事件已缓存: ${file.name}")
            // 按数量/字节配额淘汰最旧文件，防止缓存无限增长（AN-H7）
            prune(dir)
        } catch (e: Exception) {
            Timber.tag(TAG).w("感知事件缓存失败: ${e.message}")
        }
    }

    /**
     * 按数量/字节配额淘汰最旧缓存文件。
     * 文件名以毫秒时间戳开头，字典序即时间序，从最旧开始删除直到满足配额。
     */
    private fun prune(dir: File) {
        try {
            val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
                ?.sortedBy { it.name } ?: return
            var count = files.size
            var totalBytes = files.sumOf { it.length() }
            if (count <= MAX_CACHE_FILES && totalBytes <= MAX_CACHE_BYTES) return
            for (f in files) {
                if (count <= MAX_CACHE_FILES && totalBytes <= MAX_CACHE_BYTES) break
                val len = f.length()
                if (f.delete()) {
                    count--
                    totalBytes -= len
                }
            }
            Timber.tag(TAG).i("缓存淘汰完成: 剩余 $count 个 (${totalBytes / 1024}KB)")
        } catch (e: Exception) {
            Timber.tag(TAG).w("缓存淘汰失败: ${e.message}")
        }
    }

    /**
     * 同步刷新全部缓存（用于 [Thread] 上下文）。
     *
     * @param ctx Context（用于获取 cacheDir）
     * @param client OkHttpClient 实例
     * @param baseUrl 服务器基础地址
     * @param token Bearer token
     */
    fun flushSync(
        ctx: Context,
        client: OkHttpClient,
        baseUrl: String,
        token: String
    ) {
        val dir = File(ctx.cacheDir, CACHE_DIR)
        if (!dir.exists()) return
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
            ?.sortedBy { it.name } ?: return
        if (files.isEmpty()) return

        val url = "$baseUrl/api/screen/stt/perception-event"
        Timber.tag(TAG).i("刷新 ${files.size} 个缓存感知事件...")

        for (f in files) {
            try {
                val body = f.readText()
                    .toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url(url)
                    .apply {
                        if (token.isNotEmpty()) {
                            addHeader("Authorization", "Bearer $token")
                        }
                    }
                    .post(body)
                    .build()
                val response = client.newCall(request).execute()
                if (response.isSuccessful) {
                    f.delete()
                    Timber.tag(TAG).i("缓存事件已发送: ${f.name}")
                } else {
                    Timber.tag(TAG).w("缓存事件发送失败 HTTP ${response.code}，停止")
                    break
                }
            } catch (e: Exception) {
                Timber.tag(TAG).w("缓存事件发送异常: ${e.message}，停止")
                break
            }
        }
    }
}
