package com.xehuri.kinship.widget

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.InputStream
import kotlin.math.max

/**
 * decodeDownsampled - 卡片背景图降采样解码（两遍 BitmapFactory 纯函数）
 *
 * 为什么必须降采样：widget 位图最终要进 RemoteViews 随 binder 投递 launcher 进程，
 * 而 setImageViewBitmap 不压缩、原始像素直写 parcel（机制考证见 [ReminderWidget] 头注的
 * RemoteViews 体量口径：parcel 上限约 0.8MB，binder 每进程缓冲 1MB−8KB）；
 * 相册原图动辄数千万像素，不经收缩直送必然 binder 超限、卡片闪退。
 * 字节账：收缩到长边 ≤448px、按 RGB_565（2B/px）解码，最坏单卡 448×448×2 = 401,408B <
 * 0.8MB 上限，两卡并发合计仍在预算内；背景图恒被 60% 可读性遮罩压底，565 量化条带不可见。
 * 磁盘 PNG 格式不变——存量 512px 副本下次解码按本函数进一步收缩+转 565，自然生效。
 * 越界兜底由调用方按 [MAX_BG_BYTE_COUNT] 判 byteCount（护栏在 [AiNotifyWidget]/[ReminderWidget]）。
 *
 * 两遍式（inJustDecodeBounds 定 sample → 真解码）是 BitmapFactory 的标准降采样路径；
 * **不用 ImageDecoder**：那是 API 28+，本项目 minSdk 26（AGENTS.md 口径）。
 * 任何失败（空流/坏流/读流异常/解码失败）一律返回 null，绝不抛——调用方按"图不可用"降级。
 */

/** 默认长边上限（px）：RGB_565 下最坏 448×448×2 ≈ 401KB，留在 binder parcel 预算内 */
private const val DEFAULT_MAX_LONG_EDGE_PX = 448

/**
 * 背景位图 byteCount 预算（字节）——两卡护栏与本模块单测的唯一真源，勿再散落魔法数。
 * 正常路径最坏单卡 401,408B（RGB_565×448²），预算 600,000 留出余量；
 * 超预算一律按"图不可用"回收降级纯色（binder parcel 自述上限 0.8MB，见文件头字节账）。
 */
const val MAX_BG_BYTE_COUNT = 600_000

/**
 * 计算 BitmapFactory.inSampleSize：取**最小的 2 的幂**，使长边收缩后 ≤ maxLongEdgePx。
 *
 * BitmapFactory 只保证按 2 的幂高效降采样（Android 官方口径），故结果恒为 2 的幂；
 * 已达标的图返回 1（绝不上采样）。非法尺寸/非正目标一律 1，交由第二遍解码自行成败。
 * 暴露为 internal 纯函数供单测直接断言取样性质（decodeDownsampled 的输入是流，不便逐项验证）。
 */
internal fun computeInSampleSize(width: Int, height: Int, maxLongEdgePx: Int): Int {
    if (width <= 0 || height <= 0 || maxLongEdgePx <= 0) return 1
    val longEdge = max(width, height)
    if (longEdge <= maxLongEdgePx) return 1
    var sample = 1
    while (longEdge / sample > maxLongEdgePx) {
        sample *= 2
    }
    return sample
}

/**
 * 从流解码位图并降采样到长边 ≤ maxLongEdgePx；任何失败返回 null。
 *
 * 流程：整读字节（图库图片数 MB 级，内存可承受，且流不可重读、两遍必须基于同一字节数组）
 * → 第一遍 inJustDecodeBounds 只读尺寸定 sample → 第二遍真解码。
 */
fun decodeDownsampled(input: InputStream, maxLongEdgePx: Int = DEFAULT_MAX_LONG_EDGE_PX): Bitmap? {
    val bytes = runCatching { input.readBytes() }.getOrNull() ?: return null
    if (bytes.isEmpty()) return null

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    val options = BitmapFactory.Options().apply {
        inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, maxLongEdgePx)
        // binder 载荷按原始字节计（不压缩）；背景图恒压在 60% 可读性遮罩之下，
        // RGB_565（2B/px）相对 ARGB_8888 直接减半，量化条带肉眼不可见
        inPreferredConfig = Bitmap.Config.RGB_565
    }
    return runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) }.getOrNull()
}
