package com.xehuri.kinship.widget

import android.graphics.Bitmap
import com.google.common.truth.Truth.assertThat
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * decodeDownsampled / computeInSampleSize 单元测试。
 *
 * 覆盖：垃圾流/空流一律 null、合法 PNG 解码、长边降采样到 ≤448px 目标、
 * 解码位图 byteCount 留在 binder 预算内（RemoteViews 原始像素不压缩直进 parcel）、
 * inSampleSize 纯计算（2 的幂、最小满足值、绝不上采样、非法尺寸兜底）。
 *
 * 说明：本仓库沿用实际可运行的 JUnit4 + Robolectric 组合（见 PcmCheckpointWriterTest 头注）；
 * @GraphicsMode(NATIVE) 必打——LEGACY（本环境默认）下 BitmapFactory 对垃圾字节返回
 * 100x100 影子假图、解码恒"成功"，只有 NATIVE 才与真机同语义（坏数据 null、按真实
 * 像素降采样），实测见 RED 轮探针记录。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WidgetBackgroundImageTest {

    /** 生成一张纯色位图并编码为 PNG 字节（测试图源，不经文件） */
    private fun pngBytes(width: Int, height: Int): ByteArray {
        // RGB_565 图源 = 恒不透明（无 alpha 通道）：与真实链路一致——store 落盘的相册副本
        // 经 565 重编码后就是无 alpha 的 RGB PNG；透明源 PNG 会被 Skia 升格回 8888，
        // 不代表背景图场景
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
        val out = ByteArrayOutputStream()
        val ok = bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        assertThat(ok).isTrue()
        return out.toByteArray()
    }

    private fun decode(bytes: ByteArray, maxLongEdgePx: Int = 448): Bitmap? =
        decodeDownsampled(ByteArrayInputStream(bytes), maxLongEdgePx)

    // ========================================================================
    // 失败面：任何非法输入必须 null，绝不抛
    // ========================================================================

    @Test
    fun `should return null for garbage stream`() {
        val garbage = ByteArray(4096) { index -> ((index * 31 + 7) % 251).toByte() }
        assertThat(decode(garbage)).isNull()
    }

    @Test
    fun `should return null for empty stream`() {
        assertThat(decode(ByteArray(0))).isNull()
    }

    @Test
    fun `should return null when stream open throws`() {
        val exploding = object : InputStream() {
            override fun read(): Int = throw java.io.IOException("模拟读流失败")
        }
        assertThat(decodeDownsampled(exploding)).isNull()
    }

    @Test
    fun `should return null for headerless png bytes`() {
        // 只留 8 字节 PNG 签名、无 IHDR：bounds 阶段即失败，绝不进第二遍解码
        val signatureOnly = pngBytes(120, 90).copyOfRange(0, 8)
        assertThat(decode(signatureOnly)).isNull()
    }

    // ========================================================================
    // 成功面：合法 PNG 解码 + 长边 ≤448 目标 + byteCount binder 预算
    // ========================================================================

    @Test
    fun `should decode png stream at original size when already small`() {
        val bitmap = decode(pngBytes(64, 48))
        assertThat(bitmap).isNotNull()
        bitmap?.let {
            assertThat(it.width).isEqualTo(64)
            assertThat(it.height).isEqualTo(48)
            it.recycle()
        }
    }

    @Test
    fun `should downsample large image so long edge stays within 448`() {
        val bitmap = decode(pngBytes(1500, 1000))
        assertThat(bitmap).isNotNull()
        bitmap?.let {
            assertThat(it.width).isAtMost(448)
            assertThat(it.height).isAtMost(448)
            // sample=2 时 750x500 仍超 448 → 必取 4 → 375x250
            assertThat(it.width).isEqualTo(375)
            assertThat(it.height).isEqualTo(250)
            it.recycle()
        }
    }

    @Test
    fun `should honor custom maxLongEdgePx`() {
        // 1200x320，目标 256：最小 2 的幂 sample=8 → 150x40（整除，无取整歧义）
        val bitmap = decode(pngBytes(1200, 320), maxLongEdgePx = 256)
        assertThat(bitmap).isNotNull()
        bitmap?.let {
            assertThat(it.width).isEqualTo(150)
            assertThat(it.height).isEqualTo(40)
            it.recycle()
        }
    }

    @Test
    fun `byteCount of decoded bitmap stays within binder budget`() {
        // RemoteViews 位图原始像素不压缩直进 binder parcel，载荷判据是字节数而非长边。
        // 448x448（默认长边上限的原样尺寸）经生产默认参数解码后 byteCount 必须 ≤ MAX_BG_BYTE_COUNT。
        // 故意走 decodeDownsampled 无参调用：辅助函数显式传参会绕过被测默认配置（RED 轮实证 802,816B）
        val bitmap = decodeDownsampled(ByteArrayInputStream(pngBytes(448, 448)))
        assertThat(bitmap).isNotNull()
        bitmap?.let {
            assertThat(it.byteCount).isAtMost(MAX_BG_BYTE_COUNT)
            it.recycle()
        }
    }

    // ========================================================================
    // inSampleSize 纯计算（internal 暴露供直接断言）
    // ========================================================================

    @Test
    fun `computeInSampleSize should pick smallest power of two meeting target`() {
        assertThat(computeInSampleSize(1024, 768, 512)).isEqualTo(2)
        assertThat(computeInSampleSize(2048, 1536, 512)).isEqualTo(4)
        assertThat(computeInSampleSize(512, 512, 512)).isEqualTo(1)
        assertThat(computeInSampleSize(513, 10, 512)).isEqualTo(2)
    }

    @Test
    fun `computeInSampleSize should never upscale`() {
        assertThat(computeInSampleSize(100, 80, 512)).isEqualTo(1)
        assertThat(computeInSampleSize(511, 512, 512)).isEqualTo(1)
    }

    @Test
    fun `computeInSampleSize should always return power of two hitting target`() {
        for (edge in intArrayOf(1, 300, 512, 513, 999, 1024, 1025, 4096, 9000, 65535)) {
            val sample = computeInSampleSize(edge, edge / 2, 512)
            assertThat(sample).isAtLeast(1)
            assertThat(sample and (sample - 1)).isEqualTo(0) // 2 的幂
            assertThat(edge / sample).isAtMost(512) // 目标达成
            if (sample > 1) assertThat(edge / (sample / 2)).isGreaterThan(512) // 最小满足
        }
    }

    @Test
    fun `computeInSampleSize should fall back to one for invalid bounds`() {
        assertThat(computeInSampleSize(-1, -1, 512)).isEqualTo(1)
        assertThat(computeInSampleSize(0, 0, 512)).isEqualTo(1)
        assertThat(computeInSampleSize(1000, 1000, 0)).isEqualTo(1)
    }
}
