package com.xehuri.kinship.service.uploader

import android.content.Context
import org.json.JSONObject
import timber.log.Timber
import java.io.File
import java.io.FileOutputStream

/**
 * 崩溃后的 checkpoint 恢复器。
 *
 * 扫描 `filesDir/audio_checkpoint/pending/<sessionId>/` 下残留的 `.part`（进程被杀时
 * [PcmCheckpointWriter] 未走到 [PcmCheckpointWriter.finalizeSegment]），补 WAV 头后写入
 * 现有 `cacheDir/upload_cache/` 条目，再由调用方触发 `uploadCachedData()` 补传。
 *
 * 容错原则：任何异常都不得向上抛。空文件、损坏的 sidecar 一律删除并记日志后跳过，
 * 只保留可恢复的分片。
 */
object CheckpointRecovery {

    /** 由文件名推断不出起始时间时的兜底：直接丢弃，避免产出错误时间戳的音频 */
    private const val UNKNOWN_START = -1L

    /**
     * 恢复 pending 下所有可用分片。
     *
     * @param context 用于定位 filesDir（pending）与 cacheDir（upload_cache）
     * @param fallbackSampleRate sidecar 缺失或 `sample_rate` 非法时的兜底采样率
     * @param deviceIdFallback sidecar 缺失时的兜底设备标识
     * @param flacEncoder FLAC 编码器注入缝（sidecar format=flac 时消费；生产默认 [FlacFinalizer]）
     * @return 成功转换出的 upload_cache 条目数（0 表示无需补传）
     */
    fun recover(
        context: Context,
        fallbackSampleRate: Int = PcmCheckpointFormat.DEFAULT_SAMPLE_RATE,
        deviceIdFallback: String = "",
        flacEncoder: FlacEncoder = FlacFinalizer
    ): Int {
        val pendingRoot = File(
            File(context.filesDir, PcmCheckpointWriter.CHECKPOINT_DIR_NAME),
            PcmCheckpointWriter.PENDING_DIR_NAME
        )
        if (!pendingRoot.isDirectory) return 0

        val cacheDir = File(context.cacheDir, PcmCheckpointWriter.CACHE_DIR_NAME)
        cacheDir.mkdirs()

        var converted = 0
        val sessionDirs = pendingRoot.listFiles { file -> file.isDirectory } ?: return 0
        for (sessionDir in sessionDirs) {
            val parts = sessionDir.listFiles { file ->
                file.isFile && file.name.endsWith(PcmCheckpointWriter.PART_SUFFIX)
            } ?: continue
            for (part in parts) {
                try {
                    if (convertOne(part, sessionDir.name, cacheDir, fallbackSampleRate, deviceIdFallback, flacEncoder)) {
                        converted++
                    }
                } catch (e: Exception) {
                    // 单条失败不影响其余分片，且保留 .part 供下次再试
                    Timber.w(e, "checkpoint 恢复失败: ${part.name}")
                }
            }
            // 会话目录已空则清理
            val remaining = sessionDir.listFiles()
            if (remaining == null || remaining.isEmpty()) {
                sessionDir.delete()
            }
        }

        if (converted > 0) {
            Timber.i("checkpoint 恢复完成: $converted 个分段待补传")
        }
        return converted
    }

    /**
     * 把单个 `.part` 转成 upload_cache 条目。
     *
     * 按 sidecar `format` 字段决定产出 `.flac` 还是 `.wav`（缺失默认 wav）；
     * format=flac 时经注入编码器转换，编码失败降级 WAV 绝不丢数据。
     *
     * @return true 表示已成功产出 upload_cache 条目
     */
    private fun convertOne(
        part: File,
        sessionDirName: String,
        cacheDir: File,
        fallbackSampleRate: Int,
        deviceIdFallback: String,
        flacEncoder: FlacEncoder
    ): Boolean {
        val partLength = part.length()
        val sidecar = File(part.parentFile, part.nameWithoutExtension + ".json")

        // 空文件：直接丢弃
        if (partLength <= 0L) {
            Timber.w("checkpoint 丢弃空分片: ${part.name}")
            deleteQuietly(part)
            deleteQuietly(sidecar)
            return false
        }
        if (partLength > Int.MAX_VALUE - PcmCheckpointFormat.WAV_HEADER_BYTES) {
            Timber.w("checkpoint 丢弃超大分片: ${part.name} (${partLength}B)")
            return false // 保留 .part，交由人工/后续策略处理
        }

        // sidecar 存在但损坏：删除（不猜测元数据）
        var meta: JSONObject? = null
        if (sidecar.exists()) {
            meta = try {
                JSONObject(sidecar.readText())
            } catch (e: Exception) {
                Timber.w(e, "checkpoint 丢弃损坏 sidecar: ${sidecar.name}")
                deleteQuietly(part)
                deleteQuietly(sidecar)
                return false
            }
        }

        // 起始时间：sidecar 优先，缺失时回退文件名（写 sidecar 前崩溃的场景）
        val startWallMs = meta?.optLong("start_wall_ms", UNKNOWN_START)
            ?.takeIf { it > 0L }
            ?: part.nameWithoutExtension.toLongOrNull()
            ?: run {
                Timber.w("checkpoint 丢弃无法确定起始时间的分片: ${part.name}")
                deleteQuietly(part)
                deleteQuietly(sidecar)
                return false
            }

        val seq = meta?.optInt("seg_seq", 0) ?: 0
        val sessionId = meta?.optString("session_id", "")
            ?.takeIf { it.isNotEmpty() }
            ?: sessionDirName
        val deviceId = meta?.optString("device_id", "") ?: deviceIdFallback
        val sampleRate = meta?.optInt("sample_rate", 0)
            ?.takeIf { it > 0 }
            ?: fallbackSampleRate
        val sampleCount = (partLength / 2).toInt()
        // T2: sidecar format 决定产出后缀（缺失/非法回退 wav）
        val wantFormat = meta?.optString("format", PcmCheckpointWriter.FORMAT_WAV)
            ?.takeIf { it == PcmCheckpointWriter.FORMAT_FLAC }
            ?: PcmCheckpointWriter.FORMAT_WAV

        val base = "$startWallMs-$seq"
        val jsonFile = File(cacheDir, "$base.json")

        // 1) 音频落盘：flac 优先，编码失败降级 wav（数据绝不丢）
        var audioFile: File? = null
        var actualFormat = PcmCheckpointWriter.FORMAT_WAV
        if (wantFormat == PcmCheckpointWriter.FORMAT_FLAC) {
            audioFile = try {
                val pcm = part.readBytes()
                val encoded = flacEncoder.encode(pcm, sampleRate)
                if (encoded != null && encoded.size > 42) {
                    val tmp = File(cacheDir, "$base.flac.tmp")
                    val target = File(cacheDir, "$base.flac")
                    tmp.writeBytes(encoded)
                    if (!tmp.renameTo(target)) {
                        if (target.exists()) target.delete()
                        tmp.copyTo(target, overwrite = true)
                        tmp.delete()
                    }
                    target
                } else null
            } catch (e: Exception) {
                Timber.w(e, "checkpoint 恢复 FLAC 编码失败，降级 WAV")
                null
            }
            if (audioFile != null) actualFormat = PcmCheckpointWriter.FORMAT_FLAC
        }
        if (audioFile == null) {
            val wavFile = File(cacheDir, "$base.wav")
            try {
                FileOutputStream(wavFile).use { fos ->
                    fos.write(PcmCheckpointFormat.wavHeader(partLength.toInt(), sampleRate))
                    part.inputStream().use { input -> input.copyTo(fos) }
                    fos.flush()
                    fos.fd.sync()
                }
            } catch (e: Exception) {
                Timber.w(e, "checkpoint 写出 WAV 失败: ${part.name}")
                deleteQuietly(wavFile)
                return false // 保留 .part 供下次重试
            }
            audioFile = wavFile
            actualFormat = PcmCheckpointWriter.FORMAT_WAV
        }

        // 2) 落 JSON：uploadCachedData 以 .json 为入口，保证配对完整
        try {
            jsonFile.writeText(
                PcmCheckpointFormat.cacheJson(
                    startWallMs = startWallMs,
                    seq = seq,
                    sessionId = sessionId,
                    deviceId = deviceId,
                    sampleRate = sampleRate,
                    sampleCount = sampleCount,
                    format = actualFormat
                )
            )
        } catch (e: Exception) {
            Timber.w(e, "checkpoint 写出 JSON 失败: ${part.name}")
            deleteQuietly(audioFile)
            return false
        }

        deleteQuietly(part)
        deleteQuietly(sidecar)
        Timber.i("checkpoint 已恢复: $base.${actualFormat} (${sampleCount / sampleRate}s)")
        return true
    }

    /** 删除文件并吞掉异常 */
    private fun deleteQuietly(file: File) {
        try {
            if (file.exists()) file.delete()
        } catch (_: Exception) {
            // 忽略删除失败
        }
    }
}

/**
 * checkpoint 清理条目。
 *
 * @param file 代表性文件（upload_cache 中为 `.json`；cleanup 会连带删除同名 `.wav`/`.flac`）
 * @param sizeBytes 参与配额计算的字节数
 * @param lastTouchedMs 最近一次写入/确认时间（LRU 依据）
 * @param uploaded 是否已上传成功（ACK）。true = 可被淘汰；false = 受保护，绝不淘汰
 */
data class CheckpointEntry(
    val file: File,
    val sizeBytes: Long,
    val lastTouchedMs: Long,
    val uploaded: Boolean
)

/**
 * checkpoint 清理策略：LRU + TTL + 字节上限。
 *
 * 硬性约束：**绝不淘汰未上传成功的条目**。可淘汰集合仅包含 `uploaded == true` 的条目，
 * 先按 TTL 清理过期项，再在超出字节上限时按最旧优先淘汰，直到回到上限以内或没有
 * 可淘汰项为止。未上传条目无论多大都不参与淘汰（磁盘占用因此可能超过上限，这是
 * 数据安全优先于容量控制的有意取舍）。
 *
 * @param ttlMs 保留时长，超过即淘汰已上传条目（默认 7 天）
 * @param maxBytes 字节上限（默认 500MB）；统计口径为全部条目字节和
 */
class CheckpointCleanup(
    private val ttlMs: Long = DEFAULT_TTL_MS,
    private val maxBytes: Long = DEFAULT_MAX_BYTES
) {

    companion object {
        /** 默认保留 7 天 */
        const val DEFAULT_TTL_MS = 7L * 24 * 60 * 60 * 1000

        /** 默认字节上限 500MB */
        const val DEFAULT_MAX_BYTES = 500L * 1024 * 1024

        /** 上传成功标记后缀：`<base>.ack` 存在即视为已 ACK */
        const val ACK_SUFFIX = ".ack"
    }

    /**
     * 计算应淘汰的条目（纯函数，不落盘）。
     *
     * @return 淘汰列表（最旧优先），未上传条目永不出现
     */
    fun planEvictions(
        entries: List<CheckpointEntry>,
        nowMs: Long = System.currentTimeMillis()
    ): List<CheckpointEntry> {
        val evicted = LinkedHashSet<CheckpointEntry>()
        val candidates = entries
            .filter { it.uploaded }
            .sortedBy { it.lastTouchedMs }

        // 1) TTL：已上传且超过保留期
        for (entry in candidates) {
            if (nowMs - entry.lastTouchedMs > ttlMs) {
                evicted.add(entry)
            }
        }

        // 2) 字节上限：剩余条目（含受保护的未上传条目）总量超限时，仅从已上传项中按最旧优先淘汰
        var totalBytes = entries.filter { it !in evicted }.sumOf { it.sizeBytes }
        for (entry in candidates) {
            if (totalBytes <= maxBytes) break
            if (evicted.add(entry)) {
                totalBytes -= entry.sizeBytes
            }
        }

        return evicted.toList()
    }

    /**
     * 执行淘汰，返回实际删除的条目数。
     */
    fun cleanup(
        entries: List<CheckpointEntry>,
        nowMs: Long = System.currentTimeMillis()
    ): Int {
        var removed = 0
        for (entry in planEvictions(entries, nowMs)) {
            if (deleteEntry(entry)) removed++
        }
        return removed
    }

    /**
     * 扫描 upload_cache 目录构造清理条目。
     *
     * 存在 `<base>.ack` 标记的条目视为已上传成功，可进入淘汰候选；
     * 其余（等待补传的条目）受保护。音频实体按 `.wav` / `.flac` 双后缀解析。
     */
    fun scanCacheEntries(cacheDir: File): List<CheckpointEntry> {
        if (!cacheDir.isDirectory) return emptyList()
        val jsonFiles = cacheDir.listFiles { file ->
            file.isFile && file.name.endsWith(".json")
        } ?: return emptyList()

        return jsonFiles.map { json ->
            val base = json.nameWithoutExtension
            val audio = File(cacheDir, "$base.wav").takeIf { it.exists() }
                ?: File(cacheDir, "$base.flac").takeIf { it.exists() }
            val ack = File(cacheDir, "$base$ACK_SUFFIX")
            val audioLength = if (audio != null && audio.exists()) audio.length() else 0L
            val audioTouched = if (audio != null && audio.exists()) audio.lastModified() else 0L
            CheckpointEntry(
                file = json,
                sizeBytes = json.length() + audioLength,
                lastTouchedMs = maxOf(json.lastModified(), audioTouched),
                uploaded = ack.exists()
            )
        }
    }

    /** 删除条目：`file` 本身，以及同名 `.wav`/`.flac`（若存在） */
    private fun deleteEntry(entry: CheckpointEntry): Boolean {
        val file = entry.file
        return try {
            var ok = true
            if (file.exists() && !file.delete()) ok = false
            if (file.name.endsWith(".json")) {
                val base = file.nameWithoutExtension
                for (ext in arrayOf(".wav", ".flac")) {
                    val audio = File(file.parentFile, base + ext)
                    if (audio.exists() && !audio.delete()) ok = false
                }
            }
            ok
        } catch (e: Exception) {
            Timber.w(e, "checkpoint 淘汰失败: ${file.name}")
            false
        }
    }
}
