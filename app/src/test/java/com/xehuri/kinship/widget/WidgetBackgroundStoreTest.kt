package com.xehuri.kinship.widget

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream

/**
 * WidgetBackgroundStore 单元测试（Robolectric 真实文件系统 + 真实 prefs）。
 *
 * 覆盖：未设置判空、saveFromStream 落盘/回显、saveFromUri 薄封装（ShadowContentResolver
 * 注册流）、失败不留半成品、clear 双删、0 字节/坏件自愈。
 *
 * 说明：saveFromStream 为 internal 测试缝（saveFromUri 只薄封装 openInputStream）；
 * 仓库沿用 JUnit4 + Robolectric 可运行组合（见 PcmCheckpointWriterTest 头注）。
 * @GraphicsMode(NATIVE) 必打：坏字节判废依赖真机同语义解码，LEGACY 影子恒返回假图。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WidgetBackgroundStoreTest {

    private lateinit var context: Context
    private lateinit var backgroundDir: File

    private val prefs get() =
        context.getSharedPreferences(WidgetBackgroundStore.PREFS_NAME, Context.MODE_PRIVATE)

    @Before
    fun setup() {
        context = ApplicationProvider.getApplicationContext()
        backgroundDir = File(context.filesDir, "widget_backgrounds")
    }

    /** 生成合法 PNG 字节流（纯色位图经真编码） */
    private fun pngStream(width: Int = 80, height: Int = 60): InputStream {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return ByteArrayInputStream(out.toByteArray())
    }

    private fun targetFile(key: String): File = File(backgroundDir, "$key.png")

    // ========================================================================
    // 未设置态
    // ========================================================================

    @Test
    fun `bitmapFile and displayName return null when nothing stored`() {
        assertThat(WidgetBackgroundStore.bitmapFile(context, WidgetBackgroundStore.KEY_AI_NOTIFY)).isNull()
        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_NOTIFY)).isNull()
    }

    // ========================================================================
    // saveFromStream（内部测试缝）
    // ========================================================================

    @Test
    fun `saveFromStream persists png file and display name`() {
        val ok = WidgetBackgroundStore.saveFromStream(
            context, WidgetBackgroundStore.KEY_AI_NOTIFY, "海边.jpg", pngStream(),
        )

        assertThat(ok).isTrue()
        assertThat(targetFile(WidgetBackgroundStore.KEY_AI_NOTIFY).exists()).isTrue()
        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_NOTIFY))
            .isEqualTo("海边.jpg")
        assertThat(WidgetBackgroundStore.bitmapFile(context, WidgetBackgroundStore.KEY_AI_NOTIFY))
            .isNotNull()
    }

    @Test
    fun `saveFromStream falls back to file name when display name missing`() {
        val ok = WidgetBackgroundStore.saveFromStream(
            context, WidgetBackgroundStore.KEY_AI_REMINDER, null, pngStream(),
        )

        assertThat(ok).isTrue()
        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_REMINDER))
            .isEqualTo("ai_reminder.png")
    }

    @Test
    fun `saveFromStream rejects garbage stream without touching prefs or file`() {
        val ok = WidgetBackgroundStore.saveFromStream(
            context, WidgetBackgroundStore.KEY_AI_NOTIFY, "坏图.png",
            ByteArrayInputStream(ByteArray(2048) { (it % 97).toByte() }),
        )

        assertThat(ok).isFalse()
        assertThat(prefs.getString(WidgetBackgroundStore.KEY_AI_NOTIFY, null)).isNull()
        assertThat(targetFile(WidgetBackgroundStore.KEY_AI_NOTIFY).exists()).isFalse()
    }

    @Test
    fun `failed save keeps previous good background intact`() {
        WidgetBackgroundStore.saveFromStream(
            context, WidgetBackgroundStore.KEY_AI_NOTIFY, "旧图.png", pngStream(),
        )
        val oldLength = targetFile(WidgetBackgroundStore.KEY_AI_NOTIFY).length()

        val ok = WidgetBackgroundStore.saveFromStream(
            context, WidgetBackgroundStore.KEY_AI_NOTIFY, "坏图.png",
            ByteArrayInputStream(ByteArray(64)),
        )

        assertThat(ok).isFalse()
        assertThat(targetFile(WidgetBackgroundStore.KEY_AI_NOTIFY).length()).isEqualTo(oldLength)
        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_NOTIFY))
            .isEqualTo("旧图.png")
    }

    @Test
    fun `second save replaces background and display name`() {
        WidgetBackgroundStore.saveFromStream(
            context, WidgetBackgroundStore.KEY_AI_NOTIFY, "第一张.png", pngStream(80, 60),
        )
        val ok = WidgetBackgroundStore.saveFromStream(
            context, WidgetBackgroundStore.KEY_AI_NOTIFY, "第二张.png", pngStream(64, 64),
        )

        assertThat(ok).isTrue()
        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_NOTIFY))
            .isEqualTo("第二张.png")
        val file = WidgetBackgroundStore.bitmapFile(context, WidgetBackgroundStore.KEY_AI_NOTIFY)
        assertThat(file).isNotNull()
        file?.let { assertThat(it.length()).isGreaterThan(0L) }
    }

    // ========================================================================
    // saveFromUri（ContentResolver 薄封装）
    // ========================================================================

    @Test
    fun `saveFromUri reads content stream and stores background`() {
        val uri = Uri.parse("content://axeuh.test/background/1")
        shadowOf(context.contentResolver).registerInputStream(uri, pngStream(70, 50))

        val ok = WidgetBackgroundStore.saveFromUri(
            context, WidgetBackgroundStore.KEY_AI_REMINDER, uri, "相册图.png",
        )

        assertThat(ok).isTrue()
        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_REMINDER))
            .isEqualTo("相册图.png")
        assertThat(targetFile(WidgetBackgroundStore.KEY_AI_REMINDER).exists()).isTrue()
    }

    @Test
    fun `saveFromUri returns false for unresolvable uri`() {
        val ok = WidgetBackgroundStore.saveFromUri(
            context, WidgetBackgroundStore.KEY_AI_NOTIFY,
            Uri.parse("content://axeuh.test/missing/404"), "无.png",
        )

        assertThat(ok).isFalse()
        assertThat(prefs.getString(WidgetBackgroundStore.KEY_AI_NOTIFY, null)).isNull()
    }

    // ========================================================================
    // clear
    // ========================================================================

    @Test
    fun `clear removes both file and prefs entry`() {
        WidgetBackgroundStore.saveFromStream(
            context, WidgetBackgroundStore.KEY_AI_NOTIFY, "待删.png", pngStream(),
        )

        WidgetBackgroundStore.clear(context, WidgetBackgroundStore.KEY_AI_NOTIFY)

        assertThat(targetFile(WidgetBackgroundStore.KEY_AI_NOTIFY).exists()).isFalse()
        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_NOTIFY)).isNull()
    }

    @Test
    fun `clear on unset key is a harmless no-op`() {
        WidgetBackgroundStore.clear(context, WidgetBackgroundStore.KEY_AI_REMINDER)

        assertThat(WidgetBackgroundStore.displayName(context, WidgetBackgroundStore.KEY_AI_REMINDER)).isNull()
        assertThat(WidgetBackgroundStore.bitmapFile(context, WidgetBackgroundStore.KEY_AI_REMINDER)).isNull()
    }

    // ========================================================================
    // 自愈：坏件（0 字节 / 无法解码）
    // ========================================================================

    @Test
    fun `bitmapFile self-heals zero byte file by deleting file and prefs entry`() {
        seedCorruptEntry(sizeZero = true)

        assertThat(WidgetBackgroundStore.bitmapFile(context, WidgetBackgroundStore.KEY_AI_NOTIFY)).isNull()
        assertThat(targetFile(WidgetBackgroundStore.KEY_AI_NOTIFY).exists()).isFalse()
        assertThat(prefs.getString(WidgetBackgroundStore.KEY_AI_NOTIFY, null)).isNull()
    }

    @Test
    fun `bitmapFile self-heals undecodable file by deleting file and prefs entry`() {
        seedCorruptEntry(sizeZero = false)

        assertThat(WidgetBackgroundStore.bitmapFile(context, WidgetBackgroundStore.KEY_AI_NOTIFY)).isNull()
        assertThat(targetFile(WidgetBackgroundStore.KEY_AI_NOTIFY).exists()).isFalse()
        assertThat(prefs.getString(WidgetBackgroundStore.KEY_AI_NOTIFY, null)).isNull()
    }

    @Test
    fun `bitmapFile returns null when prefs entry set but file missing`() {
        prefs.edit().putString(WidgetBackgroundStore.KEY_AI_NOTIFY, "幽灵.png").apply()

        assertThat(WidgetBackgroundStore.bitmapFile(context, WidgetBackgroundStore.KEY_AI_NOTIFY)).isNull()
    }

    /** 手工布置"条目在、文件坏"的自愈现场 */
    private fun seedCorruptEntry(sizeZero: Boolean) {
        backgroundDir.mkdirs()
        val file = targetFile(WidgetBackgroundStore.KEY_AI_NOTIFY)
        if (sizeZero) {
            file.createNewFile()
        } else {
            file.writeBytes(ByteArray(512) { (it % 131).toByte() })
        }
        prefs.edit().putString(WidgetBackgroundStore.KEY_AI_NOTIFY, file.name).apply()
    }
}
