package com.xehuri.kinship.service.uploader

import android.content.Context
import org.json.JSONObject
import timber.log.Timber
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 分段录音的崩溃安全 checkpoint 落盘器。
 *
 * ## 背景
 * 分段采集模式此前把整段 PCM 只留在内存里，直到满时长才生成 WAV 上传。App 被删后台、
 * 进程被杀或系统回收服务时，这一段已录制的音频会全部丢失。本类把「仅存内存」的窗口
 * 收敛到一个 flush 周期（默认 10 秒）。
 *
 * ## 落盘布局
 * ```
 * filesDir/audio_checkpoint/pending/<sessionId>/<segStartMs>.json   # sidecar 元数据（先写）
 * filesDir/audio_checkpoint/pending/<sessionId>/<segStartMs>.part   # 原始 s16le PCM（后追加，无 WAV 头）
 * ```
 * 崩溃后由 [CheckpointRecovery] 把残留的 `.part` 转成 [upload_cache] 条目并触发补传。
 *
 * ## 完成
 * [finalizeSegment] 按 `uploadFormat` 编码（WAV 补 44 字节头；FLAC 经 [FlacEncoder]，
 * 编码失败自动降级 WAV 绝不丢数据），写进 `cacheDir/upload_cache/{segStartMs}-{segSeq}.wav|.flac`
 * 与同名 `.json`（含 `format` 字段；字段与 [AudioCollector] 的离线碎片缓存完全一致，
 * `uploadCachedData()` 可直接重放），然后删除 `.part` 与 sidecar。
 *
 * ## 线程模型
 * 所有文件 IO 都在内部单线程 [ioExecutor] 上执行；生命周期变更由 [lifecycleLock] 串行化，
 * 因此 [append] / [flush] / [finalizeSegment] / [abort] 可被多线程安全调用。
 *
 * @param context 用于定位 filesDir（checkpoint）与 cacheDir（upload_cache）
 * @param sessionId 会话标识；会做文件名安全化处理
 * @param segSeq 分段序号，与 [segStartMs] 共同组成 upload_cache 条目名
 * @param deviceId 设备标识（写入 sidecar 与最终 JSON）
 * @param sampleRate 采样率（默认 16000）
 * @param segStartMs 分段起始墙钟毫秒；默认取当前时间
 * @param flushIntervalMs 周期 flush 间隔（毫秒）；<=0 表示关闭周期 flush，仅手动 flush
 * @param uploadFormat 上传格式（"wav" 默认 | "flac"），决定 finalize 产出后缀与 JSON format
 * @param flacEncoder FLAC 编码器注入缝；生产默认 [FlacFinalizer]（MediaCodec + Java 兜底）
 */
class PcmCheckpointWriter(
    private val context: Context,
    sessionId: String,
    private val segSeq: Int,
    private val deviceId: String,
    private val sampleRate: Int = PcmCheckpointFormat.DEFAULT_SAMPLE_RATE,
    private val segStartMs: Long = System.currentTimeMillis(),
    private val flushIntervalMs: Long = DEFAULT_FLUSH_INTERVAL_MS,
    /** 上传格式："wav"（默认）或 "flac"；决定 finalize 产出的扩展名与 JSON format 字段 */
    private val uploadFormat: String = FORMAT_WAV,
    /** FLAC 编码器注入缝（单测用假编码器；生产默认 [FlacFinalizer]） */
    private val flacEncoder: FlacEncoder = FlacFinalizer
) {

    companion object {
        /** 默认周期 flush 间隔（毫秒） */
        const val DEFAULT_FLUSH_INTERVAL_MS = 10_000L

        /** checkpoint 根目录名（位于 filesDir） */
        const val CHECKPOINT_DIR_NAME = "audio_checkpoint"

        /** 待恢复目录名 */
        const val PENDING_DIR_NAME = "pending"

        /** 复用现有离线缓存目录名（位于 cacheDir） */
        const val CACHE_DIR_NAME = "upload_cache"

        /** 原始 PCM 分片后缀 */
        const val PART_SUFFIX = ".part"

        /** 上传格式常量：WAV 原始（默认） */
        const val FORMAT_WAV = "wav"

        /** 上传格式常量：FLAC 无损压缩 */
        const val FORMAT_FLAC = "flac"
    }

    /** 文件名安全化的会话标识 */
    private val safeSessionId: String = sessionId
        .replace(Regex("[^A-Za-z0-9_.-]"), "_")
        .ifBlank { "unknown" }

    /** pending/<sessionId> 目录 */
    private val segmentDir: File = File(
        File(File(context.filesDir, CHECKPOINT_DIR_NAME), PENDING_DIR_NAME),
        safeSessionId
    )

    /** 原始 PCM 文件 */
    private val partFile: File = File(segmentDir, "$segStartMs$PART_SUFFIX")

    /** sidecar 元数据文件 */
    private val sidecarFile: File = File(segmentDir, "$segStartMs.json")

    /** 单线程 IO 执行器：保证所有文件 IO 都在 IO 线程、且严格串行 */
    private val ioExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "PcmCheckpointWriter").apply { isDaemon = true }
    }

    /** 周期 flush 调度器 */
    private val flushScheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "PcmCheckpointFlush").apply { isDaemon = true }
    }

    /** 生命周期锁：串行化 append/flush/finalize/abort */
    private val lifecycleLock = Any()

    /** 已关闭标志（finalize 或 abort 之后不再接受写入） */
    @Volatile
    private var closed = false

    /** 当前打开的追加流 */
    private var outputStream: FileOutputStream? = null

    /** 已写入的 PCM 字节数 */
    private var pendingBytes: Long = 0L

    /** sidecar 是否已写 */
    private var sidecarWritten = false

    /** 周期 flush 任务句柄 */
    @Volatile
    private var flushFuture: ScheduledFuture<*>? = null

    /**
     * 追加一段原始 s16le PCM。
     *
     * 首次调用会先落 sidecar 元数据，再追加音频；空数组直接忽略。
     * 关闭后调用为空操作。
     */
    fun append(pcm: ByteArray) {
        if (pcm.isEmpty()) return
        synchronized(lifecycleLock) {
            if (closed) return
            runIo { doAppend(pcm) }
        }
    }

    /**
     * 把已写入的 PCM 刷入磁盘（flush + fsync）。
     *
     * 周期 flush 也走这里；关闭后调用为空操作。
     */
    fun flush() {
        synchronized(lifecycleLock) {
            if (closed) return
            runIo { doFlush() }
        }
    }

    /**
     * 结束本分段：按 uploadFormat 编码（flac 失败自动降级 WAV）并原子落地到 upload_cache。
     *
     * @return 写入 upload_cache 的音频文件（.wav 或 .flac）；无数据或落盘失败返回 null
     */
    fun finalizeSegment(): File? {
        synchronized(lifecycleLock) {
            if (closed) return null
            closed = true
            stopPeriodicFlush()
            val result = try {
                runIo { doFinalize() }
            } catch (e: Exception) {
                Timber.w(e, "checkpoint finalize 异常")
                null
            }
            shutdownExecutors()
            return result
        }
    }

    /**
     * 放弃本分段：删除 `.part` 与 sidecar（不会产出 upload_cache 条目）。
     *
     * 异常一律吞掉，调用方无需 try/catch。
     */
    fun abort() {
        synchronized(lifecycleLock) {
            if (closed) return
            closed = true
            stopPeriodicFlush()
            try {
                runIo { doAbort() }
            } catch (e: Exception) {
                Timber.w(e, "checkpoint abort 异常")
            }
            shutdownExecutors()
        }
    }

    // ======================== IO 线程内部实现 ========================

    /** 首次追加时先写 sidecar，再追加音频 */
    private fun doAppend(pcm: ByteArray) {
        if (!sidecarWritten) {
            writeSidecar()
            sidecarWritten = true
        }
        val stream = outputStream ?: openStream()
        stream.write(pcm)
        pendingBytes += pcm.size.toLong()
        ensurePeriodicFlush()
    }

    /** 刷盘并 fsync，保证进程被杀也不会丢已 flush 的内容 */
    private fun doFlush() {
        val stream = outputStream ?: return
        try {
            stream.flush()
            stream.fd.sync()
        } catch (e: Exception) {
            Timber.w(e, "checkpoint flush 失败")
        }
    }

    /** 按 uploadFormat 落盘（flac 优先，编码失败降级 WAV），再落 JSON，最后清理 pending */
    private fun doFinalize(): File? {
        closeStreamQuietly()
        val partLength = if (partFile.exists()) partFile.length() else 0L
        if (partLength <= 0L || partLength > Int.MAX_VALUE - PcmCheckpointFormat.WAV_HEADER_BYTES) {
            Timber.w("checkpoint 无有效数据，跳过落盘（${partLength}B）")
            deletePendingFiles()
            return null
        }

        val cacheDir = File(context.cacheDir, CACHE_DIR_NAME)
        cacheDir.mkdirs()
        val base = "$segStartMs-$segSeq"
        val jsonFile = File(cacheDir, "$base.json")

        // 1) 先落音频：按 uploadFormat 编码，flac 失败降级 WAV（数据绝不丢）
        var audioFile: File? = null
        var actualFormat = FORMAT_WAV
        if (uploadFormat == FORMAT_FLAC) {
            audioFile = tryEncodeFlac(cacheDir, base, partLength)
            if (audioFile != null) actualFormat = FORMAT_FLAC
        }
        if (audioFile == null) {
            audioFile = tryWriteWav(cacheDir, base, partLength) ?: return null
            actualFormat = FORMAT_WAV
        }

        // 2) 再落 JSON：上传端以 .json 为遍历入口，确保它出现时音频必然完整
        try {
            val sampleCount = (partLength / 2).toInt()
            val json = PcmCheckpointFormat.cacheJson(
                startWallMs = segStartMs,
                seq = segSeq,
                sessionId = safeSessionId,
                deviceId = deviceId,
                sampleRate = sampleRate,
                sampleCount = sampleCount,
                format = actualFormat
            )
            val tmpJson = File(cacheDir, "$base.json.tmp")
            tmpJson.writeText(json)
            moveInto(tmpJson, jsonFile)
        } catch (e: Exception) {
            Timber.w(e, "checkpoint JSON 落盘失败")
            audioFile.delete()
            return null
        }

        deletePendingFiles()
        Timber.i("checkpoint 已落地: $base.${actualFormat} (${pendingBytes / 2 / sampleRate}s)")
        return audioFile
    }

    /** flac 路径：读 .part PCM 经注入编码器落 {base}.flac；任何失败返回 null（降级 WAV） */
    private fun tryEncodeFlac(cacheDir: File, base: String, partLength: Long): File? {
        return try {
            val pcm = partFile.readBytes()
            if (pcm.size.toLong() != partLength) {
                Timber.w("checkpoint PCM 读取不完整，降级 WAV")
                return null
            }
            val encoded = flacEncoder.encode(pcm, sampleRate)
            if (encoded == null || encoded.size <= 42) {
                Timber.w("FLAC 编码失败/产出过短，降级 WAV")
                return null
            }
            val tmp = File(cacheDir, "$base.flac.tmp")
            val target = File(cacheDir, "$base.flac")
            FileOutputStream(tmp).use { fos ->
                fos.write(encoded)
                fos.flush()
                fos.fd.sync()
            }
            moveInto(tmp, target)
            target
        } catch (e: Exception) {
            Timber.w(e, "checkpoint FLAC 落盘失败，降级 WAV")
            null
        }
    }

    /** WAV 路径：tmp 写入后改名，避免上传端看到半截文件；失败保留 .part 供重试 */
    private fun tryWriteWav(cacheDir: File, base: String, partLength: Long): File? {
        val wavFile = File(cacheDir, "$base.wav")
        val tmpWav = File(cacheDir, "$base.wav.tmp")
        try {
            FileOutputStream(tmpWav).use { fos ->
                fos.write(PcmCheckpointFormat.wavHeader(partLength.toInt(), sampleRate))
                partFile.inputStream().use { input -> input.copyTo(fos) }
                fos.flush()
                fos.fd.sync()
            }
            moveInto(tmpWav, wavFile)
            return wavFile
        } catch (e: Exception) {
            Timber.w(e, "checkpoint WAV 落盘失败")
            tmpWav.delete()
            return null // 保留 .part，供后续重试
        }
    }

    /** 放弃分段：关闭流并删除 pending 文件 */
    private fun doAbort() {
        closeStreamQuietly()
        deletePendingFiles()
    }

    /** 首次追加前写 sidecar：先于音频落盘，保证崩溃后能识别分片 */
    private fun writeSidecar() {
        try {
            segmentDir.mkdirs()
            val json = JSONObject().apply {
                put("session_id", safeSessionId)
                put("start_wall_ms", segStartMs)
                put("sample_rate", sampleRate)
                put("device_id", deviceId)
                put("seg_seq", segSeq)
                // T2: 上传格式随 sidecar 持久化，崩溃恢复时按此产出对应后缀
                put("format", uploadFormat)
            }
            sidecarFile.writeText(json.toString())
        } catch (e: Exception) {
            Timber.w(e, "checkpoint sidecar 写入失败")
        }
    }

    /** 以追加模式打开 `.part` */
    private fun openStream(): FileOutputStream {
        segmentDir.mkdirs()
        val stream = FileOutputStream(partFile, true)
        outputStream = stream
        return stream
    }

    /** 关闭流（忽略异常），供 finalize/abort 复用 */
    private fun closeStreamQuietly() {
        try {
            outputStream?.flush()
        } catch (_: Exception) {
            // 关闭阶段的 flush 失败无需上报
        }
        try {
            outputStream?.close()
        } catch (_: Exception) {
            // 关闭失败无需上报
        }
        outputStream = null
    }

    /** 删除 `.part` 与 sidecar，并在目录为空时删除会话目录 */
    private fun deletePendingFiles() {
        try {
            if (partFile.exists()) partFile.delete()
        } catch (_: Exception) {
            // 忽略删除失败
        }
        try {
            if (sidecarFile.exists()) sidecarFile.delete()
        } catch (_: Exception) {
            // 忽略删除失败
        }
        val children = segmentDir.listFiles()
        if (children != null && children.isEmpty()) segmentDir.delete()
    }

    /** 原子改名；失败时退化为复制（Windows 上目标已存在时 renameTo 可能失败） */
    private fun moveInto(source: File, target: File) {
        if (source.renameTo(target)) return
        if (target.exists()) target.delete()
        source.copyTo(target, overwrite = true)
        source.delete()
    }

    /** 首次追加后启动周期 flush（仅一次） */
    private fun ensurePeriodicFlush() {
        if (flushIntervalMs <= 0L) return
        if (flushFuture != null) return
        flushFuture = flushScheduler.scheduleWithFixedDelay(
            {
                try {
                    flush()
                } catch (e: Exception) {
                    Timber.w(e, "checkpoint 周期 flush 异常")
                }
            },
            flushIntervalMs,
            flushIntervalMs,
            TimeUnit.MILLISECONDS
        )
    }

    /** 取消周期 flush */
    private fun stopPeriodicFlush() {
        try {
            flushFuture?.cancel(false)
        } catch (_: Exception) {
            // 忽略取消失败
        }
        flushFuture = null
    }

    /** 关闭内部执行器 */
    private fun shutdownExecutors() {
        try {
            ioExecutor.shutdown()
        } catch (_: Exception) {
            // 忽略
        }
        try {
            flushScheduler.shutdown()
        } catch (_: Exception) {
            // 忽略
        }
    }

    /** 把 block 投递到 IO 线程并等待结果 */
    private fun <T> runIo(block: () -> T): T {
        val future = ioExecutor.submit(Callable { block() })
        return try {
            future.get()
        } catch (e: ExecutionException) {
            throw (e.cause ?: e)
        }
    }
}

/**
 * checkpoint 与 upload_cache 共用的格式工具。
 *
 * WAV 头参数固定为 s16le 单声道 16bit，与 [AudioCollector.pcmToWav] 保持一致；
 * upload_cache JSON 字段与离线碎片缓存对齐，确保 `uploadCachedData()` 无需改动即可重放。
 */
object PcmCheckpointFormat {

    /** 默认采样率 */
    const val DEFAULT_SAMPLE_RATE = 16000

    /** WAV 头字节数 */
    const val WAV_HEADER_BYTES = 44

    /** client_time 时间格式（与后端约定的 ISO8601 带时区偏移；毫秒精度避免跨段裁剪多裁） */
    private const val CLIENT_TIME_PATTERN = "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"

    /** 墙钟毫秒 -> client_time 字符串 */
    fun formatClientTime(wallMs: Long): String =
        SimpleDateFormat(CLIENT_TIME_PATTERN, Locale.getDefault()).format(Date(wallMs))

    /** 构造 44 字节 WAV 头（PCM / 单声道 / 16bit） */
    fun wavHeader(dataLen: Int, sampleRate: Int): ByteArray {
        val out = ByteArrayOutputStream(WAV_HEADER_BYTES)

        fun w16(value: Int) {
            out.write(value and 0xFF)
            out.write((value shr 8) and 0xFF)
        }

        fun w32(value: Int) {
            w16(value)
            w16(value shr 16)
        }

        out.write("RIFF".toByteArray(Charsets.US_ASCII)); w32(36 + dataLen)
        out.write("WAVE".toByteArray(Charsets.US_ASCII))
        out.write("fmt ".toByteArray(Charsets.US_ASCII)); w32(16)
        w16(1)                       // PCM
        w16(1)                       // 单声道
        w32(sampleRate)              // 采样率
        w32(sampleRate * 2)          // 字节率
        w16(2)                       // block align
        w16(16)                      // 位深
        out.write("data".toByteArray(Charsets.US_ASCII)); w32(dataLen)
        return out.toByteArray()
    }

    /**
     * 构造 upload_cache 的 JSON 内容。
     *
     * `client_time` 与 `mode` 是 `uploadCachedData()` / `sendCachedData()` 的必需字段；
     * `format`（"wav" | "flac"）驱动补传时的扩展名解析与 multipart filename/MIME；
     * 其余为可选的完整元数据。
     */
    fun cacheJson(
        startWallMs: Long,
        seq: Int,
        sessionId: String,
        deviceId: String,
        sampleRate: Int,
        sampleCount: Int,
        format: String = "wav"
    ): String = JSONObject().apply {
        put("client_time", formatClientTime(startWallMs))
        put("mode", "listen")
        put("session_id", sessionId)
        put("device_id", deviceId)
        put("seq", seq)
        put("start_wall_ms", startWallMs)
        put("sample_count", sampleCount)
        put("sample_rate", sampleRate)
        put("format", format)
    }.toString()
}
