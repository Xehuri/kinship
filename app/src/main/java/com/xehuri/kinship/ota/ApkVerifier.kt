package com.xehuri.kinship.ota

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import java.io.File
import java.security.MessageDigest

/**
 * APK 完整性校验工具 —— 在安装前验证下载文件的哈希与签名。
 *
 * 安全目标（AN-C2）：OTA 更新若被中间人篡改或服务端下发错误文件，
 * 必须在安装前拦截，避免安装恶意 APK。
 *
 * - [verifyHash]：若后端 OTA 元数据提供哈希（SHA-256 或 MD5），则比对文件实际哈希
 * - [verifySignature]：校验下载 APK 的签名证书与当前已安装应用是否一致，
 *   不一致一律拒绝（防止第三方重签名 APK）
 */
object ApkVerifier {

    private const val TAG = "ApkVerifier"

    /** 计算文件的 SHA-256 摘要（小写十六进制） */
    fun sha256(file: File): String = digest(file, "SHA-256")

    /** 计算文件的 MD5 摘要（小写十六进制） */
    fun md5(file: File): String = digest(file, "MD5")

    private fun digest(file: File, algorithm: String): String {
        val md = MessageDigest.getInstance(algorithm)
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            var n: Int
            while (input.read(buffer).also { n = it } != -1) {
                md.update(buffer, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * 校验文件哈希，按长度自动识别算法：
     * - 64 位十六进制 → SHA-256
     * - 32 位十六进制 → MD5
     *
     * @param expectedHex 期望的哈希值；为空表示后端未提供哈希，跳过校验
     * @return 校验通过（或无需校验）返回 true
     */
    fun verifyHash(file: File, expectedHex: String?): Boolean {
        if (expectedHex.isNullOrBlank()) return true
        val expected = expectedHex.trim().lowercase()
        val actual = when (expected.length) {
            64 -> sha256(file)
            32 -> md5(file)
            else -> {
                Log.w(TAG, "未知哈希长度 ${expected.length}，跳过哈希校验")
                return true
            }
        }
        return actual.equals(expected, ignoreCase = true)
    }

    /**
     * 下载 APK 的包名必须与当前已安装应用一致；archivePackage 为空视为不一致。
     */
    internal fun isSamePackage(archivePackage: String?, installedPackage: String): Boolean =
        archivePackage == installedPackage

    /**
     * 校验下载 APK 的签名证书是否与当前已安装应用一致。
     *
     * 包名不一致（例如旧包收到新 applicationId 的 APK）一律拒绝，避免 OTA 跨包安装。
     *
     * @return 签名一致返回 true；无法读取或签名缺失/不一致返回 false
     */
    fun verifySignature(context: Context, apkFile: File): Boolean {
        return try {
            val pm = context.packageManager
            val archiveInfo = getArchivePackageInfo(pm, apkFile.absolutePath) ?: run {
                Log.w(TAG, "无法解析 APK 包信息")
                return false
            }
            if (!isSamePackage(archiveInfo.packageName, context.packageName)) {
                Log.w(TAG, "APK 包名不一致（archive=${archiveInfo.packageName}, installed=${context.packageName}），拒绝安装")
                return false
            }
            val selfInfo = getInstalledPackageInfo(pm, context.packageName) ?: run {
                Log.w(TAG, "无法读取当前应用包信息")
                return false
            }
            val archiveSigs = signaturesOf(archiveInfo)
            val selfSigs = signaturesOf(selfInfo)
            if (archiveSigs.isEmpty() || selfSigs.isEmpty()) {
                Log.w(TAG, "签名信息为空，拒绝安装")
                return false
            }
            archiveSigs.any { a -> selfSigs.any { s -> a.contentEquals(s) } }
        } catch (e: Exception) {
            Log.e(TAG, "APK 签名校验异常: ${e.message}")
            false
        }
    }

    private fun getArchivePackageInfo(pm: PackageManager, path: String): PackageInfo? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(SIGNATURE_FLAGS.toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageArchiveInfo(path, SIGNATURE_FLAGS)
        }
    }

    private fun getInstalledPackageInfo(pm: PackageManager, pkg: String): PackageInfo? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(SIGNATURE_FLAGS.toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, SIGNATURE_FLAGS)
        }
    }

    private fun signaturesOf(info: PackageInfo): List<ByteArray> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners?.map { it.toByteArray() } ?: emptyList()
        } else {
            @Suppress("DEPRECATION")
            info.signatures?.map { it.toByteArray() } ?: emptyList()
        }
    }

    /** 签名查询标志：API 28+ 用 GET_SIGNING_CERTIFICATES，旧版本用 GET_SIGNATURES */
    private val SIGNATURE_FLAGS: Int
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }
}
