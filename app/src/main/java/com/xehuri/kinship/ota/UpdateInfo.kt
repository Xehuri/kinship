package com.xehuri.kinship.ota

import org.json.JSONObject

/**
 * 更新元数据 — 描述一个可用更新的基本信息
 *
 * @property versionCode 版本号（递增，用于比较）
 * @property versionName 版本名称（显示用，如 "1.1.0"）
 * @property downloadUrl APK 下载地址
 * @property changelog 更新日志
 * @property fileSize APK 文件大小（字节，可选）
 * @property md5 MD5 校验值（可选，Phase 2 用于完整性校验）
 */
data class UpdateInfo(
    val versionCode: Long,
    val versionName: String,
    val downloadUrl: String,
    val changelog: String,
    val fileSize: Long? = null,
    val md5: String? = null
) {
    companion object {
        /**
         * 从 JSONObject 解析 [UpdateInfo]
         */
        fun fromJson(json: JSONObject): UpdateInfo {
            return UpdateInfo(
                versionCode = json.getLong("versionCode"),
                versionName = json.getString("versionName"),
                downloadUrl = json.getString("downloadUrl"),
                changelog = json.optString("changelog", ""),
                fileSize = if (json.has("fileSize")) json.getLong("fileSize") else null,
                md5 = if (json.has("md5")) json.getString("md5") else null
            )
        }
    }
}
