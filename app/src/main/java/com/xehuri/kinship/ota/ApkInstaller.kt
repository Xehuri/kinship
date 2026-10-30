package com.xehuri.kinship.ota

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File

/**
 * APK 安装结果
 */
sealed class InstallResult {
    /** 安装成功 */
    data object Success : InstallResult()

    /** 安装失败 */
    data class Failure(
        val error: String,
        val exception: Throwable? = null
    ) : InstallResult()
}

/**
 * APK 安装器 — 通过系统安装工具（ACTION_VIEW）打开 APK
 *
 * 使用 FileProvider 生成 content:// URI 传给系统 PackageInstaller，
 * 用户在系统界面点击确认安装。对 Android 8+ 兼容。
 *
 * @param context Android 上下文
 */
class ApkInstaller(
    private val context: Context
) {

    companion object {
        private const val TAG = "ApkInstaller"
    }

    /**
     * 安装 APK 文件 — 先校验完整性/签名，通过后再打开系统安装界面
     *
     * 安装前校验（AN-C2）：
     * 1. 若提供 [expectedHash]，比对文件哈希（SHA-256/MD5）
     * 2. 校验 APK 签名与当前应用一致
     * 任一校验失败即拒绝安装并返回 [InstallResult.Failure]。
     *
     * @param apkFile 待安装的 APK 文件（必须位于 FileProvider 声明的路径下）
     * @param expectedHash 后端提供的期望哈希（可选；为空则跳过哈希校验，但仍校验签名）
     * @return [InstallResult] 安装结果（启动系统安装器即返回 Success）
     */
    fun install(apkFile: File, expectedHash: String? = null): InstallResult {
        // 0. 基础文件校验
        if (!apkFile.exists() || apkFile.length() == 0L) {
            Log.e(TAG, "APK 文件不存在或为空: ${apkFile.absolutePath}")
            return InstallResult.Failure("APK 文件不存在或为空")
        }

        // 1. 哈希校验（后端提供哈希时才执行）
        if (!ApkVerifier.verifyHash(apkFile, expectedHash)) {
            Log.e(TAG, "APK 哈希校验失败，拒绝安装")
            return InstallResult.Failure("APK 完整性校验失败（哈希不匹配），已拒绝安装")
        }

        // 2. 签名校验（必须与当前应用签名一致）
        if (!ApkVerifier.verifySignature(context, apkFile)) {
            Log.e(TAG, "APK 签名校验失败，拒绝安装")
            return InstallResult.Failure("APK 签名校验失败（与当前应用签名不一致），已拒绝安装")
        }

        // 3. 校验通过 → 打开系统安装器
        return try {
            val authority = context.packageName + ".fileprovider"
            val apkUri = FileProvider.getUriForFile(context, authority, apkFile)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(intent)
            Log.i(TAG, "已打开系统安装器: $apkUri")
            InstallResult.Success
        } catch (e: Exception) {
            Log.e(TAG, "启动系统安装器失败: ${e.message}")
            InstallResult.Failure("启动系统安装器失败: ${e.message}", e)
        }
    }
}
