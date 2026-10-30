package com.xehuri.kinship.service.uploader

import android.content.Context
import timber.log.Timber
import com.xehuri.kinship.network.AppHttpClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 健康数据批量上传器
 *
 * 从 DataCollectorService 中提取的健康数据上传逻辑，
 * 使用 [AppHttpClient] 替代原始的 [java.net.HttpURLConnection]。
 *
 * ## 功能
 * - 批量上传样本数据到 `/api/health/sync`
 * - 上传睡眠数据
 * - 全量同步（样本 + 睡眠 + 电量等）
 * - 重试机制（最多 3 次）
 * - 401 自动处理（回调通知）
 * - 失败缓存 + 重放
 *
 * @param httpClient 统一 OkHttp 客户端（已处理 SSL 和 token 注入）
 * @param context    用于读取服务器地址和缓存目录
 */
class HealthBatchUploader(
    private val httpClient: AppHttpClient,
    private val context: Context
) {

    companion object {
        private const val TAG = "HealthBatchUploader"
        private const val MAX_RETRIES = 3
        private const val CACHE_DIR_NAME = "health_upload_cache"
    }

    /** 收到 401 时的回调（一般用于清除 token + 通知用户） */
    @Volatile
    var onUnauthorized: (() -> Unit)? = null

    private fun getBaseUrl(): String = com.xehuri.kinship.config.ServerConfig.BASE_URL

    private fun getHealthUrl(): String = "${getBaseUrl()}/api/health/sync"

    // ======================== 公开上传方法 ========================

    /**
     * 批量上传样本数据
     *
     * @param samples JSONArray，每个元素: { t, hr?, steps?, stress?, spo2? }
     * @return [UploadResult]
     */
    suspend fun uploadSamples(samples: JSONArray): UploadResult {
        return doUploadString("{\"samples\":$samples}")
    }

    /**
     * 上传睡眠数据
     *
     * @param sleepData JSONObject: { duration_min, deep_min, light_min, rem_min, awake_min, ... }
     * @return [UploadResult]
     */
    suspend fun uploadSleepData(sleepData: JSONObject): UploadResult {
        return doUploadString("{\"sleep_data\":$sleepData}")
    }

    /**
     * 全量同步（样本 + 睡眠 + 电量等）
     *
     * @param body 完整请求体: { samples?, sleep_data?, battery_levels?, daily_summary?, client_time? }
     * @return [UploadResult]
     */
    suspend fun uploadSync(body: JSONObject): UploadResult = doUploadString(body.toString())

    // ======================== 核心上传逻辑 ========================

    /**
     * 执行带重试的 POST 请求（基于字符串请求体）
     *
     * 最多重试 [MAX_RETRIES] 次，每次失败后指数退避（1s, 2s）。
     * 401 立即停止重试并触发 [onUnauthorized] 回调。
     * 所有重试失败后，若 [cacheOnFailure] 为 true 则缓存数据。
     *
     * @param cacheOnFailure 失败时是否写入新的缓存文件。重放缓存（[uploadCachedData]）时传
     *   false：原缓存文件仍在磁盘上等待下次重试，再次缓存只会生成一份重复副本。
     */
    private suspend fun doUploadString(
        bodyStr: String,
        cacheOnFailure: Boolean = true
    ): UploadResult = withContext(Dispatchers.IO) {
        var lastError: String? = null

        for (attempt in 1..MAX_RETRIES) {
            try {
                val url = getHealthUrl()
                val response = httpClient.post(url, bodyStr)
                Timber.i("上传成功 (attempt $attempt)")
                return@withContext UploadResult.Success(response)
            } catch (e: Exception) {
                val msg = e.message ?: ""
                lastError = msg

                if (msg.contains("HTTP 401")) {
                    Timber.w("收到 401，触发 onUnauthorized 回调")
                    onUnauthorized?.invoke()
                    return@withContext UploadResult.Unauthorized
                }

                Timber.w("上传失败 (attempt $attempt/$MAX_RETRIES): $msg")
                if (attempt < MAX_RETRIES) {
                    // 指数退避：1s, 2s
                    Thread.sleep(1000L * attempt)
                }
            }
        }

        // 所有重试失败：正常上传路径缓存到本地；重放路径保留原文件，避免重复副本
        if (cacheOnFailure) {
            Timber.w("所有重试均失败，缓存数据")
            cacheForRetryString(bodyStr)
        } else {
            Timber.w("所有重试均失败，保留原缓存文件待下次重放")
        }
        UploadResult.Failed(lastError ?: "未知错误")
    }

    // ======================== 离线缓存 ========================

    private fun getCacheDir(): File {
        val dir = File(context.cacheDir, CACHE_DIR_NAME)
        dir.mkdirs()
        return dir
    }

    /**
     * 将上传数据缓存到本地文件（按时间戳前缀，便于重放时排序）
     */
    suspend fun cacheForRetry(data: JSONObject) {
        cacheForRetryString(data.toString())
    }

    private suspend fun cacheForRetryString(dataStr: String) {
        if (!com.xehuri.kinship.service.DataCollectorService.isCacheEnabled(context)) {
            Timber.i("缓存已禁用，跳过健康数据缓存")
            return
        }
        withContext(Dispatchers.IO) {
            try {
                val cacheDir = getCacheDir()
                val file = File(cacheDir, "${System.currentTimeMillis()}.json")
                file.writeText(dataStr)
                Timber.i("数据已缓存: ${file.absolutePath} (${dataStr.length}B)")
            } catch (e: Exception) {
                Timber.w("缓存写入失败: ${e.message}")
            }
        }
    }

    /**
     * 重放所有缓存的离线数据
     *
     * 按文件时间戳顺序上传，遇到失败立即停止。
     * 成功后删除对应缓存文件。
     *
     * @return 成功上传的条数
     */
    suspend fun uploadCachedData(): Int = withContext(Dispatchers.IO) {
        val cacheDir = getCacheDir()
        if (!cacheDir.exists()) return@withContext 0

        val jsonFiles = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
            ?.sortedBy { it.name } ?: return@withContext 0

        if (jsonFiles.isEmpty()) return@withContext 0

        Timber.i("找到 ${jsonFiles.size} 个缓存文件，开始重放...")
        var successCount = 0

        for (jsonFile in jsonFiles) {
            try {
                val jsonData = jsonFile.readText()
                val body = JSONObject(jsonData)
                when (doUploadString(body.toString(), cacheOnFailure = false)) {
                    is UploadResult.Success -> {
                        jsonFile.delete()
                        successCount++
                        Timber.i("缓存上传成功: ${jsonFile.name}")
                    }
                    is UploadResult.Unauthorized -> {
                        Timber.w("缓存上传 401，停止后续尝试")
                        break
                    }
                    is UploadResult.Failed -> {
                        Timber.w("缓存上传失败，停止后续尝试: ${jsonFile.name}")
                        break
                    }
                }
            } catch (e: Exception) {
                Timber.w("缓存上传异常: ${e.message}")
                break
            }
        }

        Timber.i("缓存重放完成: $successCount/${jsonFiles.size} 成功")
        successCount
    }

    /**
     * 清空所有缓存
     */
    suspend fun clearCache() = withContext(Dispatchers.IO) {
        val cacheDir = getCacheDir()
        if (cacheDir.exists()) {
            cacheDir.listFiles()?.forEach { it.delete() }
            Timber.i("缓存已清除")
        }
    }
}

/**
 * 上传结果
 *
 * @see HealthBatchUploader
 */
sealed class UploadResult {
    /** 上传成功，包含服务器响应体 */
    data class Success(val response: String) : UploadResult()

    /** 收到 401，需要重新登录 */
    data object Unauthorized : UploadResult()

    /** 上传失败，包含错误描述 */
    data class Failed(val error: String) : UploadResult()
}
