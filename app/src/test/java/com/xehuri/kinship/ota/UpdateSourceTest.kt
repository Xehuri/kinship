package com.xehuri.kinship.ota

import android.content.Context
import android.content.res.AssetManager
import com.google.common.truth.Truth.assertThat
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UpdateSourceTest {

    @Test
    fun `LocalUpdateSource returns UpdateInfo when remote version is higher`() = runBlocking {
        val json = """
            {
                "versionCode": 2,
                "versionName": "1.1.0",
                "downloadUrl": "https://example.com/app.apk",
                "changelog": "Bug fixes"
            }
        """.trimIndent()

        val source = createLocalSource(json)
        val result = source.checkForUpdate(currentVersionCode = 1)

        assertThat(result).isNotNull()
        assertThat(result!!.versionCode).isEqualTo(2)
        assertThat(result.versionName).isEqualTo("1.1.0")
        assertThat(result.downloadUrl).isEqualTo("https://example.com/app.apk")
        assertThat(result.changelog).isEqualTo("Bug fixes")
    }

    @Test
    fun `LocalUpdateSource returns null when same version`() = runBlocking {
        val json = """
            {
                "versionCode": 2,
                "versionName": "1.1.0",
                "downloadUrl": "https://example.com/app.apk",
                "changelog": ""
            }
        """.trimIndent()

        val source = createLocalSource(json)
        val result = source.checkForUpdate(currentVersionCode = 2)

        assertThat(result).isNull()
    }

    @Test
    fun `LocalUpdateSource returns null when current version is newer`() = runBlocking {
        val json = """
            {
                "versionCode": 2,
                "versionName": "1.1.0",
                "downloadUrl": "https://example.com/app.apk",
                "changelog": ""
            }
        """.trimIndent()

        val source = createLocalSource(json)
        val result = source.checkForUpdate(currentVersionCode = 10)

        assertThat(result).isNull()
    }

    @Test
    fun `LocalUpdateSource handles optional fields`() = runBlocking {
        val json = """
            {
                "versionCode": 3,
                "versionName": "2.0.0",
                "downloadUrl": "https://example.com/app-v2.apk",
                "changelog": "Major update",
                "fileSize": 15728640,
                "md5": "abc123def456"
            }
        """.trimIndent()

        val source = createLocalSource(json)
        val result = source.checkForUpdate(currentVersionCode = 1)

        assertThat(result).isNotNull()
        assertThat(result!!.versionCode).isEqualTo(3)
        assertThat(result.fileSize).isEqualTo(15728640)
        assertThat(result.md5).isEqualTo("abc123def456")
    }

    @Test
    fun `LocalUpdateSource does not crash with minimal JSON`() = runBlocking {
        val json = """
            {
                "versionCode": 5,
                "versionName": "3.0.0",
                "downloadUrl": "https://example.com/app.apk"
            }
        """.trimIndent()

        val source = createLocalSource(json)
        val result = source.checkForUpdate(currentVersionCode = 1)

        assertThat(result).isNotNull()
        assertThat(result!!.versionCode).isEqualTo(5)
        assertThat(result.changelog).isEmpty()
    }

    @Test
    fun `UpdateSource interface can be implemented`() {
        // 楠岃瘉鎺ュ彛鍙 mock
        val mockSource = mockk<UpdateSource>()
        assertThat(mockSource).isNotNull()
    }

    /**
     * 鍒涘缓浣跨敤 mock AssetManager 鐨?[LocalUpdateSource]
     */
    private fun createLocalSource(jsonContent: String): LocalUpdateSource {
        val assetManager = mockk<AssetManager>()
        every { assetManager.open(any()) } returns jsonContent.byteInputStream()
        val context = mockk<Context>()
        every { context.assets } returns assetManager
        return LocalUpdateSource(context)
    }
}
