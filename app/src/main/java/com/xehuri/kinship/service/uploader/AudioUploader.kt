package com.xehuri.kinship.service.uploader

import timber.log.Timber
import com.xehuri.kinship.network.AppHttpClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * 音频上传器
 *
 * 从 [com.xehuri.kinship.service.DataCollectorService] 中提取的音频 multipart 上传逻辑，
 * 使用 [AppHttpClient] 替代原始的 [java.net.HttpURLConnection]。
 *
 * ## 上传格式
 *
 * 与 DataCollectorService.sendToBackend() 保持一致：
 * - `file`: audio.wav (audio/wav)
 * - `client_time`: ISO 格式时间戳（录音开始时间）
 * - `mode`: "listen"
 *
 * ## 响应处理
 *
 * - 200 响应：解析 JSON 中的 `text` 字段
 * - 401 响应：触发 [onUnauthorized] 回调
 * - 其他错误：返回 [AudioUploadResult.Failed]
 *
 * @param httpClient 统一 OkHttp 客户端（已处理 SSL 和 token 注入）
 * @param baseUrl 服务器基础地址，如 "https://localhost:8767"
 */
class AudioUploader(
    private val httpClient: AppHttpClient,
    private val baseUrl: String
) {

    private val tag = "AudioUploader"

    /** 收到 401 时的回调（一般用于清除 token + 通知用户） */
    @Volatile
    var onUnauthorized: (() -> Unit)? = null

    /** 音频会话上传 URL */
    private val uploadUrl: String get() = "$baseUrl/api/screen/stt/voice-session-multipart"

    /**
     * 上传录音数据到后端
     *
     * 写入临时文件后调用 [AppHttpClient.postMultipart]，
     * 上传完成后自动清理临时文件。
     *
     * ## 请求参数
     *
     * | 字段 | 说明 |
     * |------|------|
     * | file | audio.wav (audio/wav) |
     * | client_time | ISO 格式录音开始时间 |
     * | start_wall_ms | 毫秒级起始时间（可选；后端优先采用，避免秒级截断多裁音频） |
     * | mode | 上传模式（"listen"） |
     * | device_id | 稳定设备 UUID（可选） |
     * | session_id | 采集会话 ID（可选） |
     * | seq | 分片序号（可选） |
     *
     * @param audioData WAV 音频字节数据
     * @param clientTime 录音开始时间（ISO 格式，如 "2026-06-23T10:00:00+08:00"）
     * @param mode 上传模式（默认 "listen"）
     * @param startWallMs 毫秒级起始墙钟时间（可选；提供时后端优先采用）
     * @param deviceId 稳定设备 UUID（可选；P2P/多设备归属）
     * @param sessionId 采集会话 ID（可选）
     * @param seq 分片序号（可选）
     * @return [AudioUploadResult]
     */
    suspend fun uploadAudio(
        audioData: ByteArray,
        clientTime: String,
        mode: String = "listen",
        startWallMs: Long? = null,
        deviceId: String? = null,
        sessionId: String? = null,
        seq: Int? = null
    ): AudioUploadResult = withContext(Dispatchers.IO) {
        var tempFile: File? = null
        try {
            // 写音频到临时文件（AppHttpClient.postMultipart 需要 File 参数）
            // 文件名/MIME 按格式档位（audio.wav|audio.flac），与 AudioCollector.sendCachedData 约定一致
            val tempDir = File(System.getProperty("java.io.tmpdir"), "axeuh_audio_${System.currentTimeMillis()}")
            tempDir.mkdirs()
            val isFlac = audioData.isFlacEncoded()
            tempFile = File(tempDir, if (isFlac) "audio.flac" else "audio.wav")
            tempFile!!.writeBytes(audioData)

            val params = mutableMapOf(
                "client_time" to clientTime,
                "mode" to mode
            )
            if (startWallMs != null && startWallMs >= 0L) {
                params["start_wall_ms"] = startWallMs.toString()
            }
            params["device_name"] = com.xehuri.kinship.config.ServerConfig.effectiveDeviceName
            deviceId?.takeIf { it.isNotBlank() }?.let { params["device_id"] = it }
            sessionId?.takeIf { it.isNotBlank() }?.let { params["session_id"] = it }
            seq?.let { params["seq"] = it.toString() }

            val response = httpClient.postMultipart(uploadUrl, tempFile!!, params)
            Timber.i("音频上传成功")

            // 解析响应中的 text 字段（与 DataCollectorService 原有逻辑一致）
            val json = JSONObject(response)
            val text = json.optString("text", "")
            AudioUploadResult.Success(text, response)
        } catch (e: Exception) {
            val msg = e.message ?: ""
            if (msg.contains("HTTP 401")) {
                Timber.w("上传收到 401，触发 onUnauthorized 回调")
                onUnauthorized?.invoke()
                AudioUploadResult.Unauthorized
            } else {
                Timber.w("音频上传失败: $msg")
                AudioUploadResult.Failed(msg)
            }
        } finally {
            // 清理临时文件
            if (tempFile?.exists() == true) {
                tempFile.delete()
            }
        }
    }

    /**
     * 从缓存数据上传（兼容 DataCollectorService 的离线缓存格式）
     *
     * @param clientTime ISO 格式时间戳
     * @param mode 上传模式
     * @param wavData WAV 音频数据，为 null 时返回 [AudioUploadResult.Failed]
     * @param deviceId 稳定设备 UUID（可选）
     * @param sessionId 采集会话 ID（可选）
     * @param seq 分片序号（可选）
     * @return [AudioUploadResult]
     */
    suspend fun uploadFromCache(
        clientTime: String,
        mode: String,
        wavData: ByteArray?,
        deviceId: String? = null,
        sessionId: String? = null,
        seq: Int? = null
    ): AudioUploadResult {
        if (wavData == null) {
            Timber.w("缓存上传无音频数据")
            return AudioUploadResult.Failed("无音频数据")
        }
        return uploadAudio(
            wavData, clientTime, mode,
            deviceId = deviceId, sessionId = sessionId, seq = seq
        )
    }
}

/**
 * 音频上传结果
 */
sealed class AudioUploadResult {
    /** 上传成功，包含响应中的 text 字段和完整响应 JSON */
    data class Success(val text: String, val rawJson: String) : AudioUploadResult()
    /** 收到 401，token 可能已过期 */
    data object Unauthorized : AudioUploadResult()
    /** 上传失败，包含错误描述 */
    data class Failed(val error: String) : AudioUploadResult()
}

/** 按 fLaC 魔数判定字节是否为 FLAC（否则按 WAV 处理）。 */
internal fun ByteArray.isFlacEncoded(): Boolean =
    size >= 4 &&
        this[0] == 'f'.code.toByte() && this[1] == 'L'.code.toByte() &&
        this[2] == 'a'.code.toByte() && this[3] == 'C'.code.toByte()
