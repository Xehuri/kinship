package com.xehuri.kinship.ota

import com.xehuri.kinship.network.AppHttpClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream

/**
 * APK 下载进度
 */
sealed class DownloadProgress {
    /** 下载开始，totalBytes 为文件总大小（-1 表示未知） */
    data class Started(val totalBytes: Long) : DownloadProgress()

    /** 下载中 */
    data class InProgress(
        val downloadedBytes: Long,
        val totalBytes: Long,
        val progressPercent: Int
    ) : DownloadProgress()

    /** 下载完成，持有目标文件引用；serverMd5 为服务端 Content-MD5 响应头（若有） */
    data class Completed(val file: File, val serverMd5: String? = null) : DownloadProgress()
}

/**
 * APK 下载器 — 通过 AppHttpClient (OkHttp) 下载 APK，通过 Flow 报告下载进度
 */
class ApkDownloader(
    private val httpClient: AppHttpClient,
    private val authToken: String = ""
) {

    /**
     * 下载 APK 到目标文件
     *
     * @param downloadUrl APK 下载地址（http/https）
     * @param targetFile 目标文件路径
     * @return Flow<[DownloadProgress]> 下载进度流，最后一个 emission 为 [DownloadProgress.Completed]
     */
    fun download(downloadUrl: String, targetFile: File): Flow<DownloadProgress> = flow {
        val requestBuilder = Request.Builder().url(downloadUrl)
        if (authToken.isNotEmpty()) {
            requestBuilder.header("Authorization", "Bearer $authToken")
        }
        val response = httpClient.getClient().newCall(requestBuilder.build()).execute()
        if (!response.isSuccessful) {
            response.close()
            throw Exception("下载失败 HTTP ${response.code}")
        }
        // 服务端可能通过 Content-MD5 响应头提供校验值（用于安装前完整性校验）
        val serverMd5 = response.header("Content-MD5")
        val body = response.body ?: run {
            response.close()
            throw Exception("响应体为空")
        }
        val totalBytes = body.contentLength()
        var downloadedBytes = 0L

        emit(DownloadProgress.Started(totalBytes))

        body.byteStream().use { input ->
            FileOutputStream(targetFile).use { output ->
                val buffer = ByteArray(BUFFER_SIZE)
                var bytesRead: Int
                while (input.read(buffer).also { bytesRead = it } != -1) {
                    output.write(buffer, 0, bytesRead)
                    downloadedBytes += bytesRead
                    if (totalBytes > 0) {
                        val progress = (downloadedBytes.toFloat() / totalBytes * 100).toInt()
                        emit(DownloadProgress.InProgress(downloadedBytes, totalBytes, progress))
                    }
                }
            }
        }

        emit(DownloadProgress.Completed(targetFile, serverMd5))
    }.flowOn(Dispatchers.IO)

    companion object {
        private const val BUFFER_SIZE = 8192
    }
}
