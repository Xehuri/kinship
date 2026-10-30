package com.xehuri.kinship.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import timber.log.Timber
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/**
 * WidgetBackgroundStore - 桌面卡片背景图存储（选择落盘 + 读侧单实现）
 *
 * 定位：AI 通知卡 / AI 提醒卡的用户自选背景图。图片经设置页图库选择器
 * （PickVisualMedia，零权限）交进来后立即 openInputStream 解码、降采样
 * （[decodeDownsampled]，长边 ≤512px，RemoteViews parcel 上限约 0.8MB 见
 * [ReminderWidget] 头注）、重编码 PNG 复制进 App 私有目录——**URI 不做持久化授权**，
 * 复制完成即与图库解耦。
 *
 * prefs 口径：独立 prefs 文件（store-per-prefs 约定，与 widget_snapshot /
 * notification_store / reminder_store 平级互不干扰，见 [WidgetSnapshot] 头注）；
 * **只存用户可见的文件名**（设置页回显用），不存路径——路径恒由 key 推导
 * （filesDir/widget_backgrounds/<key>.png），改目录零迁移。
 *
 * 原子性：写盘走 tmp→rename（模式沿 PcmCheckpointWriter 的 tmp+fsync+moveInto），
 * 读侧绝不看到半截文件；任何失败不留半成品（目标文件保持原状、prefs 不动）。
 *
 * 自愈：bitmapFile 命中 0 字节 / 解不出位图的坏件时当场删文件、清条目并返回 null，
 * 渲染端（T4 的 provideGlance）拿到 null 即回默认底，绝不因坏图崩卡。
 */
object WidgetBackgroundStore {
    /** 独立 prefs 文件名（MODE_PRIVATE，同进程读写） */
    const val PREFS_NAME = "widget_background_store"

    /** AI 通知卡背景键（prefs 键 = 落盘文件主名 = 卡片标识，三合一） */
    const val KEY_AI_NOTIFY = "ai_notify"

    /** AI 提醒卡背景键 */
    const val KEY_AI_REMINDER = "ai_reminder"

    /** 落盘目录名（App 私有 filesDir 下） */
    private const val DIR_NAME = "widget_backgrounds"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun backgroundDir(context: Context): File = File(context.filesDir, DIR_NAME)

    private fun fileFor(context: Context, key: String): File =
        File(backgroundDir(context), "$key.png")

    /**
     * 读背景图文件：条目未设 / 文件不存在 → null（无副作用）。
     * 0 字节或无法解码的坏件 → 删文件、清 prefs 条目、返回 null（自愈）。
     */
    fun bitmapFile(context: Context, key: String): File? {
        if (prefs(context).getString(key, null) == null) return null
        val file = fileFor(context, key)
        if (!file.exists()) return null
        if (file.length() == 0L || !isDecodable(file)) {
            Timber.w("背景图坏件，自愈清理: ${file.absolutePath}")
            file.delete()
            prefs(context).edit().remove(key).apply()
            return null
        }
        return file
    }

    /** 读显示文件名（设置页回显口径）；条目未设 → null */
    fun displayName(context: Context, key: String): String? =
        prefs(context).getString(key, null)

    /**
     * 从图库 content URI 保存背景图：openInputStream → [saveFromStream]。
     * URI 即时读取、不持久化保留（图片当场复制进私有目录）；任何失败返回 false。
     */
    fun saveFromUri(context: Context, key: String, uri: Uri, displayName: String?): Boolean {
        return try {
            val input = context.contentResolver.openInputStream(uri) ?: return false
            input.use { saveFromStream(context, key, displayName, it) }
        } catch (e: Exception) {
            Timber.w(e, "背景图 URI 读取失败: $uri")
            false
        }
    }

    /**
     * 流侧落盘实现（saveFromUri 的内核；internal 暴露为测试缝，绕过 ContentResolver 直测）。
     *
     * 链路：解码降采样 → PNG 重编码进 tmp（flush+fsync）→ rename 原子替换目标 →
     * prefs 记显示名（null/空白回退落盘文件名）。任何一步失败返回 false 且不留半成品。
     */
    internal fun saveFromStream(
        context: Context,
        key: String,
        displayName: String?,
        input: InputStream,
    ): Boolean {
        val bitmap = decodeDownsampled(input) ?: return false
        val dir = backgroundDir(context)
        if (!dir.mkdirs() && !dir.isDirectory) return false
        val target = fileFor(context, key)
        val tmp = File(dir, "$key.png.tmp")
        return try {
            FileOutputStream(tmp).use { fos ->
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, fos)) {
                    throw java.io.IOException("PNG 编码失败")
                }
                fos.flush()
                fos.fd.sync()
            }
            moveInto(tmp, target)
            val shown = displayName?.takeIf { it.isNotBlank() } ?: target.name
            prefs(context).edit().putString(key, shown).apply()
            true
        } catch (e: Exception) {
            Timber.w(e, "背景图落盘失败: $key")
            tmp.delete()
            false
        } finally {
            bitmap.recycle()
        }
    }

    /** 删除背景图：文件与 prefs 条目同删；未设置时是无害空操作 */
    fun clear(context: Context, key: String) {
        fileFor(context, key).delete()
        prefs(context).edit().remove(key).apply()
    }

    /** bounds-only 判可解码（不真正分配像素） */
    private fun isDecodable(file: File): Boolean {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        runCatching { BitmapFactory.decodeFile(file.absolutePath, options) }
        return options.outWidth > 0 && options.outHeight > 0
    }

    /**
     * tmp → target 原子替换：renameTo 恒在同目录（同文件系统）应成功；
     * 兜底 copy+delete 沿用 PcmCheckpointWriter.moveInto 口径，防个别文件系统语义。
     */
    private fun moveInto(source: File, target: File) {
        if (source.renameTo(target)) return
        if (target.exists()) target.delete()
        source.copyTo(target, overwrite = true)
        source.delete()
    }
}
