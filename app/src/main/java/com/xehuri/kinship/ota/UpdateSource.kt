package com.xehuri.kinship.ota

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * 更新源接口 — 抽象获取更新信息的来源
 *
 * Phase 1 使用 [LocalUpdateSource] 从 assets/update.json 读取 mock 配置；
 * Phase 2 可实现 RemoteUpdateSource 从 HTTP API 获取。
 */
interface UpdateSource {

    /**
     * 检查是否有可用更新
     *
     * @param currentVersionCode 当前应用的 versionCode
     * @return 如果有更新（远端 versionCode > 当前）则返回 [UpdateInfo]，否则返回 null
     */
    suspend fun checkForUpdate(currentVersionCode: Long): UpdateInfo?
}

/**
 * 本地更新源 — 从 assets/update.json 读取更新配置
 *
 * Phase 1 实现：使用本地文件作为 mock 源，验证版本比较逻辑和更新流程。
 */
class LocalUpdateSource(
    private val context: Context
) : UpdateSource {

    override suspend fun checkForUpdate(currentVersionCode: Long): UpdateInfo? =
        withContext(Dispatchers.IO) {
            val json = context.assets.open(UPDATE_JSON_PATH)
                .bufferedReader()
                .use { it.readText() }
            val updateInfo = UpdateInfo.fromJson(JSONObject(json))
            // 只在远端版本号大于当前版本时才视为有更新
            if (updateInfo.versionCode > currentVersionCode) updateInfo else null
        }

    companion object {
        private const val UPDATE_JSON_PATH = "update.json"
    }
}
