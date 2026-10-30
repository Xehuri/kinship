package com.xehuri.kinship.network

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.xehuri.kinship.util.DeviceId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.X509TrustManager

/**
 * 下载进度
 *
 * 用于 [AppHttpClient.download] 方法报告下载状态。
 */
sealed class DownloadProgress {
    /** 下载中 */
    data class InProgress(val progressPercent: Int) : DownloadProgress()
    /** 下载完成 */
    data class Completed(val file: File) : DownloadProgress()
    /** 下载失败 */
    data class Failed(val error: String) : DownloadProgress()
}

/**
 * 统一 HTTP 客户端 -- 封装 OkHttp，提供 SSL/TLS 支持、Token 注入和常用方法
 *
 * 替换 App 中所有零散的 [java.net.HttpURLConnection] 调用，统一使用 OkHttp。
 *
 * ## SSL 安全说明
 *
 * SSL 证书验证由用户设置控制（SharedPreferences `axeuh_prefs["ssl_verify"]`）：
 * - 缺省（键不存在）：开启校验，使用 OkHttp/系统默认验证
 * - 显式关闭：信任所有证书、跳过主机名校验，仅用于自签名证书 / IP 直连（设置页二次确认）
 * - 开启：使用 OkHttp/系统默认验证，仅信任受信任 CA 签发的证书
 *
 * 切换设置后调用 [rebuildAll] 可重建所有活跃客户端，使其立即生效。
 *
 * @param appContext Application Context，用于读取 SharedPreferences 中的 auth_token
 * @param deviceIdProvider 稳定设备标识提供器（默认 [DeviceId.get]），随请求注入 `X-Device-Id`
 */
class AppHttpClient(
    private val appContext: Context,
    private val deviceIdProvider: (Context) -> String = { DeviceId.get(it) }
) {

    /** 401 已处理标志，避免重复触发 */
    companion object {
        @Volatile
        var authFailureHandled = false

        /**
         * 全局 401 回调 — 可选挂接点，在 401 且自动重登录失败时触发。
         *
         * 注意：当前 MainActivity 不再注册 Activity 跳转（避免运行时误触发、打断用户操作）。
         * 认证失效改为静默清 token，由下次启动时统一路由到设置页。若需挂接，只允许做
         * 轻量提示（如清 UI 登录态），不得在此做 startActivity 跳转。
         */
        @Volatile
        var onGlobalUnauthorized: (() -> Unit)? = null

        /**
         * 传输层失败（仅 [java.io.IOException]）回调，参数为请求 origin
         * (`scheme://host:port`)。HTTP 状态码错误绝不触发。
         */
        @Volatile
        var onTransportFailure: ((origin: String) -> Unit)? = null

        fun resetTransportFailureCallback() {
            onTransportFailure = null
        }

        /** 所有活跃实例的弱引用集合，用于 SSL 设置变更时全局重建 */
        private val liveInstances: MutableSet<AppHttpClient> =
            Collections.newSetFromMap(WeakHashMap<AppHttpClient, Boolean>())

        /**
         * 重置认证失败标志，在成功登录后调用
         */
        fun resetAuthFailureFlag() {
            authFailureHandled = false
        }

        /**
         * 强制登出 — 清除 token + 触发全局 401 回调（当前该回调不做 Activity 跳转）。
         * 供 VoiceprintPanel 等非 AppHttpClient 的 HTTP 调用使用。
         */
        fun forceLogout(context: android.content.Context) {
            if (!authFailureHandled) {
                authFailureHandled = true
                context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
                    .edit().remove("auth_token").apply()
                onGlobalUnauthorized?.invoke()
            }
        }

        /**
         * 重建所有活跃客户端实例 — SSL 证书验证开关变更后调用，使其立即生效。
         */
        @JvmStatic
        fun rebuildAll() {
            synchronized(liveInstances) {
                liveInstances.toList().forEach { it.rebuild() }
            }
        }
    }

    init {
        synchronized(liveInstances) {
            liveInstances.add(this)
        }
    }

    /** 主 OkHttpClient（@Volatile + 双检锁，支持 SSL 热切换重建） */
    @Volatile
    private var httpClient: OkHttpClient? = null

    /** 专用于重登录的独立 OkHttpClient（不含 401 拦截器，避免递归） */
    @Volatile
    private var reAuthClient: OkHttpClient? = null

    /** 获取（或惰性构建）主客户端 */
    private fun client(): OkHttpClient {
        httpClient?.let { return it }
        synchronized(this) {
            httpClient?.let { return it }
            return buildClient().also { httpClient = it }
        }
    }

    /** 获取（或惰性构建）重登录客户端 */
    private fun reAuth(): OkHttpClient {
        reAuthClient?.let { return it }
        synchronized(this) {
            reAuthClient?.let { return it }
            return buildReAuthClient().also { reAuthClient = it }
        }
    }

    /** 重建两个客户端 — SSL 设置变更后调用，使新策略立即生效 */
    fun rebuild() {
        synchronized(this) {
            httpClient = buildClient()
            reAuthClient = buildReAuthClient()
        }
    }

    /**
     * 发送 GET 请求
     *
     * @param url 目标 URL
     * @return 响应体字符串
     * @throws Exception HTTP 状态码非 2xx 时抛出
     */
    suspend fun get(url: String): String = withContext(Dispatchers.IO) {
        val request = requestBuilder(url).get().build()
        executeRequest(request)
    }

    /**
     * 发送 POST 请求（JSON body）
     *
     * @param url 目标 URL
     * @param body JSON 字符串
     * @return 响应体字符串
     * @throws Exception HTTP 状态码非 2xx 时抛出
     */
    suspend fun post(url: String, body: String): String = withContext(Dispatchers.IO) {
        val request = requestBuilder(url)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        executeRequest(request)
    }

    /**
     * 发送 Multipart POST 请求（文件上传）
     *
     * @param url 目标 URL
     * @param file 要上传的文件
     * @param params 额外的表单参数
     * @return 响应体字符串
     * @throws Exception HTTP 状态码非 2xx 时抛出
     */
    suspend fun postMultipart(
        url: String,
        file: File,
        params: Map<String, String>
    ): String = withContext(Dispatchers.IO) {
        val builder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
        params.forEach { (key, value) ->
            builder.addFormDataPart(key, value)
        }
        // T2: 按扩展名给 MIME（audio.wav|audio.flac），其余回退 octet-stream；
        // 后端另有 magic sniff，不信任本值作为唯一依据
        val mime = when {
            file.name.endsWith(".wav", ignoreCase = true) -> "audio/wav"
            file.name.endsWith(".flac", ignoreCase = true) -> "audio/flac"
            else -> "application/octet-stream"
        }
        builder.addFormDataPart(
            "file", file.name,
            file.asRequestBody(mime.toMediaType())
        )
        val multipartBody = builder.build()
        val request = requestBuilder(url)
            .post(multipartBody)
            .build()
        executeRequest(request)
    }

    /**
     * 下载文件（如 APK），通过 Flow 报告下载进度
     *
     * @param url 下载 URL
     * @param targetFile 目标文件路径
     * @return Flow<[DownloadProgress]> 下载进度流，正常结束会 emit [DownloadProgress.Completed]
     */
    fun download(url: String, targetFile: File): Flow<DownloadProgress> = flow {
        val request = requestBuilder(url).get().build()
        val response = executeCall(client(), request)
        if (!response.isSuccessful) {
            val errorBody = response.body?.string() ?: response.message
            emit(DownloadProgress.Failed("HTTP ${response.code}: $errorBody"))
            return@flow
        }
        val body = response.body ?: run {
            emit(DownloadProgress.Failed("响应体为空"))
            return@flow
        }
        val contentLength = body.contentLength()
        body.byteStream().use { input ->
            FileOutputStream(targetFile).use { output ->
                val buffer = ByteArray(8192)
                var bytesRead: Int
                var totalRead = 0L
                while (input.read(buffer).also { bytesRead = it } != -1) {
                    output.write(buffer, 0, bytesRead)
                    totalRead += bytesRead
                    if (contentLength > 0) {
                        val progress = ((totalRead.toFloat() / contentLength) * 100).toInt()
                        emit(DownloadProgress.InProgress(progress))
                    }
                }
            }
        }
        emit(DownloadProgress.Completed(targetFile))
    }.flowOn(Dispatchers.IO)

    /**
     * 直接获取 OkHttpClient 实例
     *
     * 用于需要直接访问 OkHttp 的场景（如自定义请求、WebSocket 等）。
     */
    fun getClient(): OkHttpClient = client()

    /**
     * 读取 SSL 证书验证开关（`axeuh_prefs["ssl_verify"]`）。
     *
     * 缺省 true = 使用系统默认验证（安全默认）；显式 false 仍保留信任所有证书的逃生口。
     */
    internal fun sslVerifyFromPrefs(): Boolean =
        appContext.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
            .getBoolean("ssl_verify", true)

    /**
     * 读取稳定设备标识；失败时返回空串（不阻断请求，也不新增请求头）。
     */
    internal fun deviceIdForRequest(): String = try {
        deviceIdProvider(appContext).trim()
    } catch (_: Exception) {
        ""
    }

    private fun encryptedPrefs(): android.content.SharedPreferences {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            appContext,
            "axeuh_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    /**
     * 构建主 OkHttpClient -- SSL 策略 + 超时配置 + 401 拦截器
     *
     * 连接超时: 15s
     * 读取超时: 30s
     */
    private fun buildClient(): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            // 401 拦截器 — 自动重登录 + 重试原请求
            .addInterceptor { chain ->
                val response = chain.proceed(chain.request())
                if (response.code == 401 && !authFailureHandled) {
                    authFailureHandled = true
                    if (tryReAuth()) {
                        // 重登录成功 → 重置标志，用新 token 重试原请求
                        authFailureHandled = false
                        val newRequest = requestBuilder(chain.request().url.toString())
                            .method(chain.request().method, chain.request().body)
                            .build()
                        return@addInterceptor chain.proceed(newRequest)
                    }
                    // 重登录失败 → 静默清除本地 token，不做任何 UI 跳转。
                    // 避免用户正在使用时（如聊天/浏览）被强制踢回设置页；
                    // 下次打开 App 时 MainActivity 检测到无 token 会路由到设置页登录。
                    clearAuthToken()
                    onGlobalUnauthorized?.invoke()
                }
                response
            }

        applySslPolicy(builder)
        return builder.build()
    }

    /**
     * 构建重登录专用 OkHttpClient -- 与主客户端共用同一 SSL 策略
     *
     * 连接超时: 10s
     * 读取超时: 10s
     */
    private fun buildReAuthClient(): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
        applySslPolicy(builder)
        return builder.build()
    }

    /**
     * 应用 SSL 策略到 Builder
     *
     * - [sslVerifyFromPrefs] 为 true（缺省）：使用 OkHttp/系统默认验证
     * - 显式 false：信任所有证书、跳过主机名校验，兼容自签名证书 / IP 直连
     */
    private fun applySslPolicy(builder: OkHttpClient.Builder) {
        if (sslVerifyFromPrefs()) return

        val trustAllCerts = arrayOf<X509TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(
                chain: Array<java.security.cert.X509Certificate>,
                authType: String
            ) {}
            override fun checkServerTrusted(
                chain: Array<java.security.cert.X509Certificate>,
                authType: String
            ) {}
            override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
        })
        val sslContext = javax.net.ssl.SSLContext.getInstance("TLS")
        sslContext.init(null, trustAllCerts, java.security.SecureRandom())
        builder.sslSocketFactory(sslContext.socketFactory, trustAllCerts[0])
        builder.hostnameVerifier { _, _ -> true }
    }

    /**
     * 从 SharedPreferences 读取 auth_token
     *
     * 每次请求时读取，不缓存，以支持 token 动态更新。
     */
    private fun authToken(): String {
        val prefs = appContext.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
        return prefs.getString("auth_token", "") ?: ""
    }

    /**
     * 静默清除本地 auth_token（认证失效时使用）。
     *
     * 只清 token、不触发任何 UI 跳转：运行时认证失效不应打断用户操作，
     * 下次打开 App 时 MainActivity 检测到无 token 会统一路由到设置页登录。
     */
    private fun clearAuthToken() {
        appContext.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
            .edit().remove("auth_token").apply()
    }

    /**
     * 构建 Request.Builder，自动注入 Authorization 与 X-Device-Id header
     *
     * 如果 SharedPreferences 中存在 auth_token，添加 Bearer 认证头。
     * 稳定设备标识用于后端识别来源设备（P2P 票据等接口要求该头）。
     */
    private fun requestBuilder(url: String): Request.Builder {
        val builder = Request.Builder().url(url)
        val token = authToken()
        if (token.isNotEmpty()) {
            builder.addHeader("Authorization", "Bearer $token")
        }
        val deviceId = deviceIdForRequest()
        if (deviceId.isNotEmpty()) {
            builder.addHeader("X-Device-Id", deviceId)
        }
        return builder
    }

    /**
     * 执行请求并解析响应
     *
     * @throws Exception HTTP 状态码非 2xx 时抛出，异常消息包含状态码和响应体
     */
    private fun executeRequest(request: Request): String {
        val response = executeCall(client(), request)
        val body = response.body?.string() ?: ""
        if (!response.isSuccessful) {
            throw Exception("HTTP ${response.code}: $body")
        }
        return body
    }

    private fun executeCall(okHttpClient: OkHttpClient, request: Request): Response = try {
        okHttpClient.newCall(request).execute()
    } catch (error: IOException) {
        notifyTransportFailure(request)
        throw error
    }

    private fun notifyTransportFailure(request: Request) {
        val url = request.url
        val origin = "${url.scheme}://${url.host}:${url.port}"
        val callback = onTransportFailure ?: return
        try {
            callback(origin)
        } catch (_: Exception) {
        }
    }

    /**
     * 尝试使用保存的账号密码重新登录
     *
     * 被 401 拦截器调用，使用独立的 [reAuthClient] 避免递归。
     *
     * @return true=重登录成功（token 已更新），false=重登录失败
     */
    private fun tryReAuth(): Boolean {
        try {
            val prefs = appContext.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
            val username = prefs.getString("auth_username", "") ?: ""
            val password = encryptedPrefs().getString("auth_password", "") ?: ""
            if (username.isBlank() || password.isBlank()) return false

            val baseUrl = com.xehuri.kinship.config.ServerConfig.BASE_URL

            val loginBody = JSONObject().apply {
                put("username", username)
                put("password", password)
            }.toString().toRequestBody("application/json".toMediaType())

            val loginRequest = Request.Builder()
                .url("$baseUrl/login")
                .post(loginBody)
                .build()

            val response = executeCall(reAuth(), loginRequest)
            if (!response.isSuccessful) return false

            val body = response.body?.string() ?: return false
            val json = JSONObject(body)
            val newToken = json.optString("token", "")
            if (newToken.isEmpty()) return false

            // 保存新 token
            prefs.edit().putString("auth_token", newToken).apply()
            return true
        } catch (_: Exception) {
            return false
        }
    }
}
