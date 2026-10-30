package com.xehuri.kinship.service.uploader

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.network.AppHttpClient
import com.google.common.truth.Truth.assertThat
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkAll
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * HealthBatchUploader 单元测试
 *
 * 使用 MockWebServer 模拟 HTTP 服务端，验证上传逻辑、重试机制、401 处理、离线缓存等行为。
 * 使用 mockk 模拟 Context/SharedPreferences，无需 Robolectric。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HealthBatchUploaderTest {

    private lateinit var mockWebServer: MockWebServer
    private lateinit var httpClient: AppHttpClient
    private lateinit var uploader: HealthBatchUploader
    private lateinit var mockPrefs: SharedPreferences
    private lateinit var mockPrefsEditor: SharedPreferences.Editor
    private lateinit var mockContext: Context
    private var unauthorizedCalled = false

    /** 临时缓存目录，测试结束后清理 */
    private val tempCacheDirs = mutableListOf<File>()

    @Before
    fun setup() {
        // Mock android.util.Log（避免 Robolectric 类加载器下 Log 抛出异常）
        mockkStatic(Log::class)
        every { Log.i(any<String>(), any<String>()) } returns 0
        every { Log.w(any<String>(), any<String>()) } returns 0
        every { Log.e(any<String>(), any<String>()) } returns 0
        every { Log.d(any<String>(), any<String>()) } returns 0

        mockWebServer = MockWebServer()
        mockWebServer.start()

        // Mock SharedPreferences.Editor
        mockPrefsEditor = mockk {
            every { putString(any(), any()) } returns this
            every { remove(any()) } returns this
            every { apply() } returns Unit
            every { commit() } returns true
        }

        // Mock SharedPreferences (server_url points to MockWebServer)
        val mockServerUrl = mockWebServer.url("").toString().trimEnd('/')
        // HealthBatchUploader 现已改从 ServerConfig.BASE_URL 读取地址（不再读 prefs.server_url），
        // 必须显式指向 MockWebServer，否则请求打不到 MockWebServer，takeRequest 会永久阻塞
        ServerConfig.update(mockServerUrl)
        mockPrefs = mockk {
            every { getString("auth_token", "") } returns ""
            every { getString("server_url", any()) } returns mockServerUrl
            every { getString(any(), any()) } returns ""  // fallback
            // AppHttpClient 校验 SSL 开关时会读 ssl_verify；漏桩会让严格 mock 抛
            // MockKException，请求类用例会连锁失败
            every { getBoolean("ssl_verify", true) } returns false
            // HealthBatchUploader 缓存前会读 cache_enabled（默认 true）；漏桩同样会让严格 mock 抛
            every { getBoolean("cache_enabled", true) } returns true
            every { edit() } returns mockPrefsEditor
        }

        val tempCacheDir = createTempDir()
        tempCacheDirs.add(tempCacheDir)

        // Mock Context
        mockContext = mockk<Context>(relaxUnitFun = true) {
            every { getSharedPreferences(any<String>(), any()) } returns mockPrefs
            every { cacheDir } returns tempCacheDir
        }

        httpClient = AppHttpClient(mockContext)
        unauthorizedCalled = false
        uploader = HealthBatchUploader(httpClient, mockContext)
        uploader.onUnauthorized = { unauthorizedCalled = true }
    }

    @After
    fun teardown() {
        unmockkAll()
        mockWebServer.shutdown()
        tempCacheDirs.forEach { dir ->
            if (dir.exists()) {
                dir.deleteRecursively()
            }
        }
    }

    /** 创建一个临时目录（模拟 cacheDir） */
    private fun createTempDir(): File {
        val dir = File(System.getProperty("java.io.tmpdir"),
            "health_uploader_test_${System.nanoTime()}")
        dir.mkdirs()
        return dir
    }

    // ========================================================================
    // uploadSamples
    // ========================================================================

    @Test
    fun `uploadSamples success returns Success with response body`() = runBlocking {
        mockWebServer.enqueue(
            MockResponse().setResponseCode(200).setBody("{\"status\":\"ok\"}")
        )

        val samples = JSONArray("[{\"t\":1700000000,\"hr\":75,\"steps\":5000}]")
        val result = uploader.uploadSamples(samples)

        assertThat(result).isInstanceOf(UploadResult.Success::class.java)
        val success = result as UploadResult.Success
        assertThat(success.response).contains("ok")
    }

    @Test
    fun `uploadSamples sends POST with correct JSON format`() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))

        val samples = JSONArray("[{\"t\":100,\"hr\":80},{\"t\":200,\"steps\":1000}]")
        uploader.uploadSamples(samples)

        val request = mockWebServer.takeRequest()
        assertThat(request.method).isEqualTo("POST")
        assertThat(request.getHeader("Content-Type")).contains("application/json")

        val bodyStr = request.body.readUtf8()
        assertThat(bodyStr).contains("\"samples\"")
        assertThat(bodyStr).contains("\"hr\":80")
    }

    @Test
    fun `uploadSamples empty array works`() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))

        val result = uploader.uploadSamples(JSONArray())

        assertThat(result).isInstanceOf(UploadResult.Success::class.java)

        val request = mockWebServer.takeRequest()
        val bodyStr = request.body.readUtf8()
        assertThat(bodyStr).contains("\"samples\":[]")
    }

    // ========================================================================
    // uploadSleepData
    // ========================================================================

    @Test
    fun `uploadSleepData success`() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))

        val sleepData = JSONObject("{\"duration_min\":480,\"deep_min\":120,\"light_min\":240,\"rem_min\":90,\"awake_min\":30}")
        val result = uploader.uploadSleepData(sleepData)

        assertThat(result).isInstanceOf(UploadResult.Success::class.java)

        val request = mockWebServer.takeRequest()
        val bodyStr = request.body.readUtf8()
        assertThat(bodyStr).contains("\"sleep_data\"")
        assertThat(bodyStr).contains("\"duration_min\":480")
    }

    // ========================================================================
    // uploadSync
    // ========================================================================

    @Test
    fun `uploadSync posts full body`() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))

        val fullBody = JSONObject("""{"samples":[],"sleep_data":{"duration_min":400},"battery_levels":[],"daily_summary":{"steps":8000},"client_time":"2026-06-23T10:00:00+08:00"}""")
        val result = uploader.uploadSync(fullBody)

        assertThat(result).isInstanceOf(UploadResult.Success::class.java)

        val request = mockWebServer.takeRequest()
        val bodyStr = request.body.readUtf8()
        assertThat(bodyStr).contains("\"samples\"")
        assertThat(bodyStr).contains("\"sleep_data\"")
        assertThat(bodyStr).contains("\"battery_levels\"")
        assertThat(bodyStr).contains("\"daily_summary\"")
        assertThat(bodyStr).contains("\"client_time\"")
    }

    // ========================================================================
    // 401 处理
    // ========================================================================

    @Test
    fun `401 triggers unauthorized callback and returns Unauthorized`() = runBlocking {
        mockWebServer.enqueue(
            MockResponse().setResponseCode(401).setBody("Unauthorized")
        )

        val result = uploader.uploadSamples(JSONArray())

        assertThat(result).isInstanceOf(UploadResult.Unauthorized::class.java)
        assertThat(unauthorizedCalled).isTrue()
    }

    @Test
    fun `401 stops retry immediately`() = runBlocking {
        // Only enqueue 1 response - retry should NOT happen after 401
        mockWebServer.enqueue(
            MockResponse().setResponseCode(401).setBody("Unauthorized")
        )

        uploader.uploadSamples(JSONArray())

        // Only 1 request (no retry after 401)
        assertThat(mockWebServer.requestCount).isEqualTo(1)
    }

    // ========================================================================
    // 重试机制
    // ========================================================================

    @Test
    fun `retries 3 times on server error`() = runBlocking {
        // All 3 attempts return 500
        mockWebServer.enqueue(MockResponse().setResponseCode(500))
        mockWebServer.enqueue(MockResponse().setResponseCode(500))
        mockWebServer.enqueue(MockResponse().setResponseCode(500))

        val result = uploader.uploadSamples(JSONArray())

        assertThat(result).isInstanceOf(UploadResult.Failed::class.java)
        val failed = result as UploadResult.Failed
        assertThat(failed.error).contains("500")

        // Verify exactly 3 attempts
        assertThat(mockWebServer.requestCount).isEqualTo(3)
    }

    @Test
    fun `succeeds on retry after initial failure`() = runBlocking {
        // First fails, second succeeds
        mockWebServer.enqueue(MockResponse().setResponseCode(500).setBody("Server Error"))
        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))

        val result = uploader.uploadSamples(JSONArray())

        assertThat(result).isInstanceOf(UploadResult.Success::class.java)
        assertThat(mockWebServer.requestCount).isEqualTo(2)
    }

    // ========================================================================
    // 离线缓存
    // ========================================================================

    @Test
    fun `caches data after all retries fail`() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(500))
        mockWebServer.enqueue(MockResponse().setResponseCode(500))
        mockWebServer.enqueue(MockResponse().setResponseCode(500))

        val samples = JSONArray("[{\"t\":123,\"hr\":70}]")
        uploader.uploadSamples(samples)

        // Check cache directory has a JSON file
        val cacheDir = File(mockContext.cacheDir, "health_upload_cache")
        assertThat(cacheDir.exists()).isTrue()
        val cacheFiles = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
        assertThat(cacheFiles).isNotEmpty()
    }

    @Test
    fun `cacheForRetry saves correctly`() = runBlocking {
        val data = JSONObject("{\"samples\":[{\"t\":100,\"hr\":72}]}")
        uploader.cacheForRetry(data)

        val cacheDir = File(mockContext.cacheDir, "health_upload_cache")
        val cacheFiles = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
        assertThat(cacheFiles).hasLength(1)

        assertThat(cacheFiles!![0].readText()).contains("samples")
    }

    @Test
    fun `uploadCachedData replays cached data and deletes on success`() = runBlocking {
        // Save a cache entry first
        mockWebServer.enqueue(MockResponse().setResponseCode(500))
        mockWebServer.enqueue(MockResponse().setResponseCode(500))
        mockWebServer.enqueue(MockResponse().setResponseCode(500))

        val samples = JSONArray("[{\"t\":123,\"hr\":70}]")
        uploader.uploadSamples(samples)

        // Should have cached files now
        val cacheDir = File(mockContext.cacheDir, "health_upload_cache")
        val beforeFiles = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
        assertThat(beforeFiles).isNotEmpty()

        // Now replay - server returns success
        val count = beforeFiles!!.size
        for (i in 0 until count) {
            mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))
        }

        val replayed = uploader.uploadCachedData()
        assertThat(replayed).isEqualTo(count)

        // Cached files should be deleted
        val afterFiles = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
        assertThat(afterFiles == null || afterFiles.size == 0).isTrue()
    }

    @Test
    fun `uploadCachedData stops on failure`() = runBlocking {
        // Create 2 cached files manually
        val cacheDir = File(mockContext.cacheDir, "health_upload_cache")
        cacheDir.mkdirs()

        File(cacheDir, "1000.json").writeText("""{"samples":[{"t":1,"hr":60}]}""")
        File(cacheDir, "2000.json").writeText("""{"samples":[{"t":2,"hr":70}]}""")

        // First succeeds, second fails (after 3 retries)
        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))
        mockWebServer.enqueue(MockResponse().setResponseCode(500))
        mockWebServer.enqueue(MockResponse().setResponseCode(500))
        mockWebServer.enqueue(MockResponse().setResponseCode(500))

        val replayed = uploader.uploadCachedData()
        assertThat(replayed).isEqualTo(1)

        // First file should be deleted, second should remain
        val remaining = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
        assertThat(remaining).hasLength(1)
        assertThat(remaining!![0].name).isEqualTo("2000.json")
    }

    // ========================================================================
    // clearCache
    // ========================================================================

    @Test
    fun `clearCache removes all cached files`() = runBlocking {
        val cacheDir = File(mockContext.cacheDir, "health_upload_cache")
        cacheDir.mkdirs()
        File(cacheDir, "test.json").writeText("{}")

        uploader.clearCache()

        val files = cacheDir.listFiles()
        assertThat(files.isNullOrEmpty()).isTrue()
    }

    @Test
    fun `clearCache is idempotent when no cache exists`() = runBlocking {
        val cacheDir = File(mockContext.cacheDir, "health_upload_cache")
        assertThat(cacheDir.exists()).isFalse()

        // Should not throw
        uploader.clearCache()
    }

    // ========================================================================
    // 空缓存
    // ========================================================================

    @Test
    fun `uploadCachedData returns 0 when no cache`() = runBlocking {
        val count = uploader.uploadCachedData()
        assertThat(count).isEqualTo(0)
    }

    @Test
    fun `uploadCachedData returns 0 when cache dir missing`() = runBlocking {
        val count = uploader.uploadCachedData()
        assertThat(count).isEqualTo(0)
    }

    // ========================================================================
    // 连接超时（网络不可达）
    // ========================================================================

    @Test
    fun `network timeout returns Failed`() = runBlocking {
        // 使用一个不可达的地址（不存在的端口）
        // 地址同样经 ServerConfig.BASE_URL 生效，需显式指向不可达端口
        ServerConfig.update("http://localhost:1")
        val offlineUploader = HealthBatchUploader(httpClient, mockk<Context>(relaxUnitFun = true) {
            every { getSharedPreferences(any<String>(), any()) } returns mockk {
                every { getString(any(), any()) } returns "http://localhost:1"
                // AppHttpClient 校验 SSL 开关时会读 ssl_verify；漏桩会让严格 mock 抛
                // MockKException，请求类用例会连锁失败
                every { getBoolean("ssl_verify", true) } returns false
                // HealthBatchUploader 缓存前会读 cache_enabled（默认 true）；漏桩同样会让严格 mock 抛
                every { getBoolean("cache_enabled", true) } returns true
                every { edit() } returns mockPrefsEditor
            }
            every { cacheDir } returns mockContext.cacheDir
        })
        offlineUploader.onUnauthorized = { unauthorizedCalled = true }

        val result = offlineUploader.uploadSamples(JSONArray())

        assertThat(result).isInstanceOf(UploadResult.Failed::class.java)
        assertThat(unauthorizedCalled).isFalse() // 不应触发 401
    }
}
