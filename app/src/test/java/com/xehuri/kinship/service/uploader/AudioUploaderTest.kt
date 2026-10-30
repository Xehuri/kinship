package com.xehuri.kinship.service.uploader

import android.content.Context
import android.content.SharedPreferences
import com.xehuri.kinship.network.AppHttpClient
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * AudioUploader 单元测试
 *
 * 使用 MockWebServer 模拟 HTTP 服务端，验证音频 multipart 上传。
 * 使用 mockk 模拟 Context/SharedPreferences（AppHttpClient 需要）。
 * 使用 Robolectric 提供 Android 框架实现（Log, JSONObject）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AudioUploaderTest {

    private lateinit var mockWebServer: MockWebServer
    private lateinit var httpClient: AppHttpClient
    private lateinit var uploader: AudioUploader

    @Before
    fun setup() {
        mockWebServer = MockWebServer()
        mockWebServer.start()

        // Mock SharedPreferences.Editor
        val mockPrefsEditor = mockk<SharedPreferences.Editor> {
            every { putString(any(), any()) } returns this
            every { remove(any()) } returns this
            every { apply() } returns Unit
            every { commit() } returns true
        }

        // Mock SharedPreferences (auth_token defaults to empty)
        val mockPrefs = mockk<SharedPreferences> {
            every { getString("auth_token", "") } returns ""
            every { getString(any(), any()) } returns ""
            // AppHttpClient 校验 SSL 开关时会读 ssl_verify；漏桩会让严格 mock 抛
            // MockKException，请求类用例会连锁失败
            every { getBoolean("ssl_verify", true) } returns false
            every { edit() } returns mockPrefsEditor
        }

        // Mock Context
        val context = mockk<Context>(relaxUnitFun = true) {
            every { getSharedPreferences(any<String>(), any()) } returns mockPrefs
        }

        httpClient = AppHttpClient(context)
        uploader = AudioUploader(httpClient, mockWebServer.url("").toString())
    }

    @After
    fun teardown() {
        mockWebServer.shutdown()
    }

    // ========================================================================
    // uploadAudio - 基础上传
    // ========================================================================

    @Test
    fun `uploadAudio success returns Success with text`() {
        runBlocking {
            mockWebServer.enqueue(
                MockResponse().setResponseCode(200)
                    .setBody("""{"text": "你好世界", "code": 0}""")
            )

            val audioData = byteArrayOf(0x52, 0x49, 0x46, 0x46) // "RIFF"
            val result = uploader.uploadAudio(
                audioData,
                "2026-06-23T10:00:00+08:00",
                "listen"
            )

            assertTrue(result is AudioUploadResult.Success)
            assertEquals("你好世界", (result as AudioUploadResult.Success).text)
        }
    }

    @Test
    fun `uploadAudio success contains rawJson in result`() {
        runBlocking {
            val responseJson = """{"text": "hello", "code": 0}"""
            mockWebServer.enqueue(
                MockResponse().setResponseCode(200).setBody(responseJson)
            )

            val result = uploader.uploadAudio(
                byteArrayOf(0x52, 0x49, 0x46, 0x46),
                "2026-06-23T10:00:00+08:00"
            )

            assertTrue(result is AudioUploadResult.Success)
            val success = result as AudioUploadResult.Success
            assertEquals("hello", success.text)
            assertEquals(responseJson, success.rawJson)
        }
    }

    @Test
    fun `uploadAudio success with empty text field`() {
        runBlocking {
            mockWebServer.enqueue(
                MockResponse().setResponseCode(200)
                    .setBody("""{"code": 0}""")
            )

            val result = uploader.uploadAudio(
                byteArrayOf(1, 2, 3),
                "2026-06-23T10:00:00+08:00"
            )

            assertTrue(result is AudioUploadResult.Success)
            assertEquals("", (result as AudioUploadResult.Success).text)
        }
    }

    // ========================================================================
    // uploadAudio - 错误处理
    // ========================================================================

    @Test
    fun `uploadAudio returns Unauthorized on 401`() {
        runBlocking {
            mockWebServer.enqueue(MockResponse().setResponseCode(401))

            var callbackCalled = false
            uploader.onUnauthorized = { callbackCalled = true }

            val result = uploader.uploadAudio(
                byteArrayOf(1, 2, 3),
                "2026-06-23T10:00:00+08:00"
            )

            assertTrue(result is AudioUploadResult.Unauthorized)
            assertTrue("onUnauthorized should be called on 401", callbackCalled)
        }
    }

    @Test
    fun `uploadAudio returns Failed on server error`() {
        runBlocking {
            mockWebServer.enqueue(MockResponse().setResponseCode(500))

            val result = uploader.uploadAudio(
                byteArrayOf(1, 2, 3),
                "2026-06-23T10:00:00+08:00"
            )

            assertTrue(result is AudioUploadResult.Failed)
            assertTrue(
                "Error message should contain HTTP 500",
                (result as AudioUploadResult.Failed).error.contains("500")
            )
        }
    }

    @Test
    fun `uploadAudio returns Failed on network error`() {
        runBlocking {
            // Use bad port to simulate network error
            val badUploader = AudioUploader(httpClient, "http://localhost:1")

            val result = badUploader.uploadAudio(
                byteArrayOf(1, 2, 3),
                "2026-06-23T10:00:00+08:00"
            )

            assertTrue(result is AudioUploadResult.Failed)
        }
    }

    @Test
    fun `uploadAudio does not call onUnauthorized on non-401 error`() {
        runBlocking {
            mockWebServer.enqueue(MockResponse().setResponseCode(500))

            var callbackCalled = false
            uploader.onUnauthorized = { callbackCalled = true }

            val result = uploader.uploadAudio(
                byteArrayOf(1, 2, 3),
                "2026-06-23T10:00:00+08:00"
            )

            assertTrue(result is AudioUploadResult.Failed)
            assertFalse("onUnauthorized should not be called on 500", callbackCalled)
        }
    }

    // ========================================================================
    // uploadFromCache - 缓存上传
    // ========================================================================

    @Test
    fun `uploadFromCache with null wav returns Failed`() {
        runBlocking {
            val result = uploader.uploadFromCache(
                "2026-06-23T10:00:00+08:00",
                "listen",
                null
            )

            assertTrue(result is AudioUploadResult.Failed)
            assertEquals("无音频数据", (result as AudioUploadResult.Failed).error)
        }
    }

    @Test
    fun `uploadFromCache with valid data uploads successfully`() {
        runBlocking {
            mockWebServer.enqueue(
                MockResponse().setResponseCode(200)
                    .setBody("""{"text": "cache ok"}""")
            )

            val result = uploader.uploadFromCache(
                "2026-06-23T10:00:00+08:00",
                "listen",
                byteArrayOf(0x52, 0x49, 0x46, 0x46)
            )

            assertTrue(result is AudioUploadResult.Success)
            assertEquals("cache ok", (result as AudioUploadResult.Success).text)
        }
    }

    // ========================================================================
    // Multipart 格式验证
    // ========================================================================

    @Test
    fun `multipart request sends POST method`() {
        runBlocking {
            mockWebServer.enqueue(
                MockResponse().setResponseCode(200).setBody("""{"text": "ok"}""")
            )

            uploader.uploadAudio(
                byteArrayOf(0x41, 0x42, 0x43),
                "2026-06-23T10:00:00+08:00",
                "listen"
            )

            val request = mockWebServer.takeRequest()
            assertEquals("POST", request.method)
            assertTrue(
                "Path should contain voice-session-multipart",
                request.path!!.contains("voice-session-multipart")
            )
            // Verify Content-Type is multipart
            val contentType = request.getHeader("Content-Type") ?: ""
            assertTrue(
                "Content-Type should be multipart/form-data, got: $contentType",
                contentType.startsWith("multipart/form-data")
            )
        }
    }

    @Test
    fun `multipart request contains all required parts`() {
        runBlocking {
            mockWebServer.enqueue(
                MockResponse().setResponseCode(200).setBody("""{"text": "ok"}""")
            )

            uploader.uploadAudio(
                byteArrayOf(0x41, 0x42, 0x43),
                "2026-06-23T10:00:00+08:00",
                "listen"
            )

            val request = mockWebServer.takeRequest()
            val body = request.body.readByteString().utf8()
            val contentType = request.getHeader("Content-Type") ?: ""

            // Verify Content-Type is multipart
            assertTrue(
                "Content-Type should be multipart/form-data, got: $contentType",
                contentType.startsWith("multipart/form-data")
            )

            // Verify all required form parts exist in the body
            assertTrue("Should contain client_time in body", body.contains("name=\"client_time\""))
            assertTrue("Should contain mode in body", body.contains("name=\"mode\""))
            assertTrue("Should contain file in body", body.contains("name=\"file\""))
            assertTrue("File should be named audio.wav in body", body.contains("filename=\"audio.wav\""))
        }
    }

    @Test
    fun `uploadAudio includes device session and seq identity fields`() {
        runBlocking {
            mockWebServer.enqueue(
                MockResponse().setResponseCode(200).setBody("""{"text": "ok"}""")
            )

            uploader.uploadAudio(
                audioData = byteArrayOf(0x41, 0x42, 0x43),
                clientTime = "2026-06-23T10:00:00+08:00",
                deviceId = "device-uuid-1",
                sessionId = "session-1",
                seq = 7
            )

            val body = mockWebServer.takeRequest().body.readByteString().utf8()
            assertTrue(body.contains("name=\"device_id\""))
            assertTrue(body.contains("device-uuid-1"))
            assertTrue(body.contains("name=\"session_id\""))
            assertTrue(body.contains("session-1"))
            assertTrue(body.contains("name=\"seq\""))
            assertTrue(body.contains("7"))
        }
    }

    @Test
    fun `uploadFromCache passes identity fields through`() {
        runBlocking {
            mockWebServer.enqueue(
                MockResponse().setResponseCode(200).setBody("""{"text": "ok"}""")
            )

            uploader.uploadFromCache(
                clientTime = "2026-06-23T10:00:00+08:00",
                mode = "listen",
                wavData = byteArrayOf(0x52, 0x49, 0x46, 0x46),
                deviceId = "device-uuid-2",
                sessionId = "session-2",
                seq = 3
            )

            val body = mockWebServer.takeRequest().body.readByteString().utf8()
            assertTrue(body.contains("device-uuid-2"))
            assertTrue(body.contains("session-2"))
            assertTrue(body.contains("name=\"seq\""))
        }
    }

    @Test
    fun `multipart request includes auth token`() {
        runBlocking {
            // Setup mock prefs with a token
            val mockPrefsEditor = mockk<SharedPreferences.Editor> {
                every { putString(any(), any()) } returns this
                every { remove(any()) } returns this
                every { apply() } returns Unit
                every { commit() } returns true
            }

            val mockPrefs = mockk<SharedPreferences> {
                every { getString("auth_token", "") } returns "test-token-123"
                every { getString(any(), any()) } returns "test-token-123"
                // 漏桩会让 AppHttpClient 抛 MockKException，请求发不出去，
                // 导致后面的 mockWebServer.takeRequest() 永久阻塞
                every { getBoolean("ssl_verify", true) } returns false
                every { edit() } returns mockPrefsEditor
            }

            val context = mockk<Context>(relaxUnitFun = true) {
                every { getSharedPreferences(any<String>(), any()) } returns mockPrefs
            }

            val httpClient = AppHttpClient(context)
            val uploaderWithToken = AudioUploader(
                httpClient,
                mockWebServer.url("").toString()
            )

            mockWebServer.enqueue(
                MockResponse().setResponseCode(200).setBody("""{"text": "ok"}""")
            )

            uploaderWithToken.uploadAudio(
                byteArrayOf(0x41, 0x42, 0x43),
                "2026-06-23T10:00:00+08:00"
            )

            val request = mockWebServer.takeRequest()
            val authHeader = request.getHeader("Authorization")
            assertEquals("Bearer test-token-123", authHeader)
        }
    }
}
