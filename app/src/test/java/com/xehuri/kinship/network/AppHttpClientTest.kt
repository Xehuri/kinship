package com.xehuri.kinship.network

import android.content.Context
import android.content.SharedPreferences
import com.google.common.truth.Truth.assertThat
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * AppHttpClient 单元测试
 *
 * 使用 MockWebServer 模拟 HTTP 服务端，验证 GET/POST/Multipart/Download 等请求行为。
 * 使用 mockk 模拟 Context/SharedPreferences，无需 Robolectric。
 */
class AppHttpClientTest {

    private lateinit var mockWebServer: MockWebServer
    private lateinit var client: AppHttpClient
    private lateinit var mockPrefs: SharedPreferences
    private lateinit var mockPrefsEditor: SharedPreferences.Editor

    @Before
    fun setup() {
        mockWebServer = MockWebServer()
        mockWebServer.start()

        // Mock SharedPreferences.Editor
        mockPrefsEditor = mockk {
            every { putString(any(), any()) } returns this
            every { remove(any()) } returns this
            every { apply() } returns Unit
            every { commit() } returns true
        }

        // Mock SharedPreferences (auth_token defaults to empty)
        mockPrefs = mockk {
            every { getString("auth_token", "") } returns ""
            every { getString(any(), any()) } returns ""
            // AppHttpClient 校验 SSL 开关时会读 ssl_verify；漏桩会导致严格 mock 抛
            // MockKException（no answer found），进而让本类全部请求类用例连锁失败
            every { getBoolean("ssl_verify", true) } returns false
            every { edit() } returns mockPrefsEditor
        }

        // Mock Context
        val context = mockk<Context>(relaxUnitFun = true) {
            every { getSharedPreferences(any<String>(), any()) } returns mockPrefs
        }

        client = AppHttpClient(context)
    }

    @After
    fun teardown() {
        AppHttpClient.resetTransportFailureCallback()
        mockWebServer.shutdown()
    }

    // ========================================================================
    // GET 请求
    // ========================================================================

    @Test
    fun `GET request returns response body`() = runBlocking {
        mockWebServer.enqueue(
            MockResponse().setResponseCode(200).setBody("Hello World")
        )

        val result = client.get(mockWebServer.url("/test").toString())

        assertThat(result).isEqualTo("Hello World")
    }

    @Test
    fun `GET request sends correct method`() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))

        client.get(mockWebServer.url("/test").toString())

        val request = mockWebServer.takeRequest()
        assertThat(request.method).isEqualTo("GET")
        assertThat(request.path).isEqualTo("/test")
    }

    // ========================================================================
    // POST 请求
    // ========================================================================

    @Test
    fun `POST request sends JSON and returns response`() = runBlocking {
        mockWebServer.enqueue(
            MockResponse().setResponseCode(200).setBody("{\"status\":\"ok\"}")
        )

        val result = client.post(
            mockWebServer.url("/api/data").toString(),
            "{\"key\":\"value\"}"
        )

        assertThat(result).isEqualTo("{\"status\":\"ok\"}")

        val request = mockWebServer.takeRequest()
        assertThat(request.method).isEqualTo("POST")
        assertThat(request.getHeader("Content-Type")).contains("application/json")
        assertThat(request.body.readUtf8()).isEqualTo("{\"key\":\"value\"}")
    }

    // ========================================================================
    // 错误处理
    // ========================================================================

    @Test
    fun `401 response throws exception`() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(401).setBody("Unauthorized"))

        var caught: Exception? = null
        try {
            client.get(mockWebServer.url("/secure").toString())
        } catch (e: Exception) {
            caught = e
        }

        assertThat(caught).isNotNull()
        assertThat(caught!!.message).contains("401")
    }

    @Test
    fun `500 response throws exception`() = runBlocking {
        mockWebServer.enqueue(MockResponse().setResponseCode(500).setBody("Server Error"))

        var caught: Exception? = null
        try {
            client.get(mockWebServer.url("/error").toString())
        } catch (e: Exception) {
            caught = e
        }

        assertThat(caught).isNotNull()
        assertThat(caught!!.message).contains("500")
        assertThat(caught!!.message).contains("Server Error")
    }

    @Test
    fun `401 response never triggers transport failure callback`() = runBlocking {
        val origins = mutableListOf<String>()
        AppHttpClient.onTransportFailure = { origins += it }
        mockWebServer.enqueue(MockResponse().setResponseCode(401).setBody("Unauthorized"))

        var caught: Exception? = null
        try {
            client.get(mockWebServer.url("/secure").toString())
        } catch (e: Exception) {
            caught = e
        }

        assertThat(caught).isNotNull()
        assertThat(origins).isEmpty()
    }

    @Test
    fun `500 response never triggers transport failure callback`() = runBlocking {
        val origins = mutableListOf<String>()
        AppHttpClient.onTransportFailure = { origins += it }
        mockWebServer.enqueue(MockResponse().setResponseCode(500).setBody("Server Error"))

        var caught: Exception? = null
        try {
            client.get(mockWebServer.url("/error").toString())
        } catch (e: Exception) {
            caught = e
        }

        assertThat(caught).isNotNull()
        assertThat(origins).isEmpty()
    }

    @Test
    fun `io failure triggers transport failure callback with request origin`() = runBlocking {
        val origins = mutableListOf<String>()
        AppHttpClient.onTransportFailure = { origins += it }
        val url = mockWebServer.url("/dead")
        val expectedOrigin = "${url.scheme}://${url.host}:${url.port}"
        mockWebServer.shutdown()

        var caught: Exception? = null
        try {
            client.get(url.toString())
        } catch (e: Exception) {
            caught = e
        }

        assertThat(caught).isInstanceOf(java.io.IOException::class.java)
        assertThat(origins).containsExactly(expectedOrigin)
        Unit
    }

    // ========================================================================
    // Token 注入
    // ========================================================================

    @Test
    fun `request includes auth token from SharedPreferences`() = runBlocking {
        // 配置 mock 返回 auth token
        every { mockPrefs.getString("auth_token", "") } returns "test-token-value"

        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))

        client.get(mockWebServer.url("/secure").toString())

        val request = mockWebServer.takeRequest()
        assertThat(request.getHeader("Authorization")).isEqualTo("Bearer test-token-value")
    }

    @Test
    fun `request without auth token does not add Authorization header`() = runBlocking {
        // auth_token 默认为空 (已在 @BeforeEach 中设置)
        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))

        client.get(mockWebServer.url("/public").toString())

        val request = mockWebServer.takeRequest()
        assertThat(request.getHeader("Authorization")).isNull()
    }

    // ========================================================================
    // Multipart POST
    // ========================================================================

    @Test
    fun `postMultipart sends file and params`() {
        runBlocking {
            mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("Uploaded"))

            val tempDir = createTempDir()
            val file = File(tempDir, "test_upload.txt")
            file.writeText("file content for testing")

            val result = client.postMultipart(
                url = mockWebServer.url("/upload").toString(),
                file = file,
                params = mapOf("description" to "test file", "type" to "text")
            )

            assertThat(result).isEqualTo("Uploaded")

            val request = mockWebServer.takeRequest()
            assertThat(request.method).isEqualTo("POST")
            assertThat(request.getHeader("Content-Type")).contains("multipart/form-data")

            val body = request.body.readUtf8()
            assertThat(body).contains("test_upload.txt")
            assertThat(body).contains("description")
            assertThat(body).contains("test file")
            assertThat(body).contains("type")
            assertThat(body).contains("text")

            // 清理临时文件
            file.delete()
            tempDir.deleteRecursively()
        }
    }

    // ========================================================================
    // 下载 (Flow)
    // ========================================================================

    @Test
    fun `download reports progress and completes`() {
        runBlocking {
            // 使用 String 作为 body，MockResponse 会自动设置 Content-Length
            val contentStr = "A".repeat(2048)
            mockWebServer.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .setBody(contentStr)
            )

            val tempDir = createTempDir()
            val targetFile = File(tempDir, "test_download.bin")
            val events = client.download(
                mockWebServer.url("/download").toString(),
                targetFile
            ).toList()

            // 验证最终状态
            assertThat(events.last()).isInstanceOf(DownloadProgress.Completed::class.java)
            val completed = events.last() as DownloadProgress.Completed
            assertThat(completed.file).isEqualTo(targetFile)
            assertThat(targetFile.exists()).isTrue()
            assertThat(targetFile.length()).isEqualTo(2048L)

            // 验证进度事件
            val progressEvents = events.filterIsInstance<DownloadProgress.InProgress>()
            assertThat(progressEvents).isNotEmpty()

            // 清理临时文件
            targetFile.delete()
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun `download with error response reports failed`() {
        runBlocking {
            mockWebServer.enqueue(MockResponse().setResponseCode(404).setBody("Not Found"))

            val tempDir = createTempDir()
            val targetFile = File(tempDir, "test_failed.bin")
            val events = client.download(
                mockWebServer.url("/missing").toString(),
                targetFile
            ).toList()

            assertThat(events.last()).isInstanceOf(DownloadProgress.Failed::class.java)
            val failed = events.last() as DownloadProgress.Failed
            assertThat(failed.error).contains("404")
            assertThat(targetFile.exists()).isFalse()

            // 清理临时文件
            targetFile.delete()
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun `download with small file emits completed event`() {
        runBlocking {
            mockWebServer.enqueue(
                MockResponse().setResponseCode(200).setBody("small")
            )

            val tempDir = createTempDir()
            val targetFile = File(tempDir, "test_small.bin")
            val events = client.download(
                mockWebServer.url("/small").toString(),
                targetFile
            ).toList()

            assertThat(events.last()).isInstanceOf(DownloadProgress.Completed::class.java)
            assertThat(targetFile.readText()).isEqualTo("small")

            // 清理临时文件
            targetFile.delete()
            tempDir.deleteRecursively()
        }
    }

    // ========================================================================
    // getClient()
    // ========================================================================

    @Test
    fun `getClient returns non-null OkHttpClient with correct timeouts`() {
        val okClient = client.getClient()
        assertThat(okClient).isNotNull()
        assertThat(okClient.connectTimeoutMillis).isEqualTo(15_000)
        assertThat(okClient.readTimeoutMillis).isEqualTo(30_000)
    }

    @Test
    fun `ssl verification defaults to true when preference is absent`() {
        val prefs = mockk<SharedPreferences> {
            every { getBoolean("ssl_verify", true) } returns true
        }
        val context = mockk<Context> {
            every { getSharedPreferences(any<String>(), any()) } returns prefs
        }

        assertThat(AppHttpClient(context).sslVerifyFromPrefs()).isTrue()
    }

    @Test
    fun `ssl verification honors explicit false opt-out`() {
        val prefs = mockk<SharedPreferences> {
            every { getBoolean("ssl_verify", true) } returns false
        }
        val context = mockk<Context> {
            every { getSharedPreferences(any<String>(), any()) } returns prefs
        }

        assertThat(AppHttpClient(context).sslVerifyFromPrefs()).isFalse()
    }

    @Test
    fun `request injects stable X-Device-Id header`() = runBlocking {
        val testContext = mockk<Context> {
            every { getSharedPreferences(any<String>(), any()) } returns mockPrefs
        }
        val clientWithDeviceId = AppHttpClient(appContext = testContext) { "device-uuid-123" }
        mockWebServer.enqueue(MockResponse().setResponseCode(200).setBody("OK"))

        clientWithDeviceId.get(mockWebServer.url("/device").toString())

        val request = mockWebServer.takeRequest()
        assertThat(request.getHeader("X-Device-Id")).isEqualTo("device-uuid-123")
    }
}
