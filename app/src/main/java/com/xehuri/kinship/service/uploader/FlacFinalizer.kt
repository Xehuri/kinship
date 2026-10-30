package com.xehuri.kinship.service.uploader

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaFormat
import timber.log.Timber
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * FLAC 编码器抽象（可注入缝：单测注入假编码器，生产默认 [FlacFinalizer]）。
 *
 * 实现必须是线程安全的纯函数式调用（无跨调用状态）。
 */
fun interface FlacEncoder {
    /**
     * s16le 单声道 PCM → 完整 FLAC 字节（fLaC 魔数 + STREAMINFO 已回写 total samples）。
     *
     * @param pcm 原始 s16le 小端 PCM（长度必须为偶数）
     * @param sampleRate 采样率（Hz）
     * @return FLAC 字节；任何失败返回 null（调用方降级 WAV，绝不抛出）
     */
    fun encode(pcm: ByteArray, sampleRate: Int): ByteArray?
}

/**
 * 生产 FLAC 编码器：MediaCodec `audio/flac` 首选，java-flac-encoder 兜底。
 *
 * ## 路径
 * 1. **MediaCodec**（`MediaCodec.createEncoderByType("audio/flac")`）：系统编码器，
 *    零额外体积；无 FLAC 编码器的 ROM（CDD Android 12+ 麦克风设备才强制）
 *    create/configure 抛异常 → 回退。
 * 2. **java-flac-encoder**（`com.github.axet:java-flac-encoder:0.3.8`，Maven Central，
 *    LGPL-2.1，源码 https://github.com/amplexus/java-flac-encoder）：纯 Java，
 *    走 [net.sourceforge.javaflacencoder.FLACFileOutputStream]（canSeek=true，
 *    close 时库自动 seek 回文件头回写 total samples + MD5）。
 * 3. 两路都失败 → 返回 null → 调用方（checkpoint finalize / 碎片落盘）降级写 WAV，
 *    **数据绝不丢失**。
 *
 * ## 体积/性能
 * MediaCodec 路径体积 +0；Java 兜底 jar 约 89KB。60s @16k mono 段编码 <1s。
 *
 * ## 许可
 * 兜底库 LGPL-2.1：分发 APK 需随附许可声明；库源码 URL 见上方（未修改库本体）。
 */
object FlacFinalizer : FlacEncoder {

    /** MediaCodec 单次 input buffer 上限（字节） */
    private const val MAX_INPUT_CHUNK = 32 * 1024

    /** MediaCodec 超时（微秒） */
    private const val TIMEOUT_US = 10_000L

    /** 整体编码硬超时（毫秒），防 drain 死循环 */
    private const val ENCODE_DEADLINE_MS = 60_000L

    /** FLAC 魔数 */
    private val MAGIC = byteArrayOf('f'.code.toByte(), 'L'.code.toByte(), 'a'.code.toByte(), 'C'.code.toByte())

    override fun encode(pcm: ByteArray, sampleRate: Int): ByteArray? {
        if (pcm.isEmpty() || pcm.size % 2 != 0 || sampleRate <= 0) return null
        return encodeViaMediaCodec(pcm, sampleRate)
            ?: encodeViaJavaLib(pcm, sampleRate)
    }

    /**
     * 把 total samples（36-bit）写入 STREAMINFO（file offset 21 起 5 字节，
     * 低 4 位落在 offset21 的低 nibble，其余 32 位在 offset22-25）。
     *
     * 前置校验：fLaC 魔数 + 首 metadata 块必须是 STREAMINFO（type 0、len 34）；
     * 不满足时**原样返回**（未 patch 的 FLAC 仍合法，只是 total samples 未知）。
     * 幂等：可对同一字节反复调用。
     */
    fun patchTotalSamples(flac: ByteArray, totalSamples: Long): ByteArray {
        if (flac.size < 42) return flac
        for (i in MAGIC.indices) {
            if (flac[i] != MAGIC[i]) return flac
        }
        // 首块 type = 低 7 位（file offset 4），必须 0=STREAMINFO
        val blockType = flac[4].toInt() and 0x7F
        if (blockType != 0) return flac
        // 块长 3 字节大端（file offset 5-7），STREAMINFO 恒 34
        val blockLen = ((flac[5].toInt() and 0xFF) shl 16) or
            ((flac[6].toInt() and 0xFF) shl 8) or
            (flac[7].toInt() and 0xFF)
        if (blockLen != 34) return flac

        val v = totalSamples and 0xFFFFFFFFFL // 36-bit 截断
        val out = flac.copyOf()
        out[21] = ((out[21].toInt() and 0xF0) or ((v shr 32).toInt() and 0x0F)).toByte()
        out[22] = ((v shr 24) and 0xFF).toByte()
        out[23] = ((v shr 16) and 0xFF).toByte()
        out[24] = ((v shr 8) and 0xFF).toByte()
        out[25] = (v and 0xFF).toByte()
        return out
    }

    // ======================== 路径 1: MediaCodec ========================

    private fun encodeViaMediaCodec(pcm: ByteArray, sampleRate: Int): ByteArray? {
        var codec: MediaCodec? = null
        return try {
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_FLAC)
            val format = MediaFormat.createAudioFormat(
                MediaFormat.MIMETYPE_AUDIO_FLAC, sampleRate, 1
            )
            format.setInteger(
                MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT
            )
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, MAX_INPUT_CHUNK)
            // 复杂度提示：部分实现读此键；忽略未知键的实现安全
            @Suppress("DEPRECATION")
            format.setInteger("complexity", 5)
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()

            val frames = ByteArrayOutputStream(pcm.size / 2 + 1024)
            var csd: ByteArray? = null
            var inPos = 0
            var inputDone = false
            var outputDone = false
            val info = MediaCodec.BufferInfo()
            val deadline = System.currentTimeMillis() + ENCODE_DEADLINE_MS

            while (!outputDone) {
                if (System.currentTimeMillis() > deadline) {
                    Timber.w("MediaCodec FLAC 编码超时，转 Java 兜底")
                    return null
                }
                if (!inputDone) {
                    val inIndex = codec.dequeueInputBuffer(TIMEOUT_US)
                    if (inIndex >= 0) {
                        val inBuf = codec.getInputBuffer(inIndex)!!
                        inBuf.clear()
                        val cap = inBuf.capacity()
                        val chunk = minOf(cap, pcm.size - inPos)
                        if (chunk > 0) {
                            inBuf.put(pcm, inPos, chunk)
                            inPos += chunk
                        }
                        val eos = inPos >= pcm.size
                        val ptsUs = (inPos / 2) * 1_000_000L / sampleRate
                        codec.queueInputBuffer(
                            inIndex, 0, chunk, ptsUs,
                            if (eos) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0
                        )
                        if (eos) inputDone = true
                    }
                }
                when (val outIndex = codec.dequeueOutputBuffer(info, TIMEOUT_US)) {
                    MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        // 备选 CSD 来源：outputFormat 的 csd-0（与 CODEC_CONFIG buffer 二选一）
                        if (csd == null) {
                            val csd0 = codec.outputFormat.getByteBuffer("csd-0")
                            if (csd0 != null) {
                                val arr = ByteArray(csd0.remaining())
                                csd0.duplicate().get(arr)
                                if (arr.size >= 8 && arr.copyOfRange(0, 4)
                                        .contentEquals(MAGIC)
                                ) {
                                    csd = arr
                                }
                            }
                        }
                    }
                    MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
                    else -> {
                        if (outIndex >= 0) {
                            val outBuf = codec.getOutputBuffer(outIndex)!!
                            if (info.size > 0) {
                                val bytes = ByteArray(info.size)
                                outBuf.position(info.offset)
                                outBuf.get(bytes, 0, info.size)
                                if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                                    // delta: CSD#0 与 CODEC_CONFIG buffer 都接受为头来源
                                    csd = bytes
                                } else {
                                    frames.write(bytes)
                                }
                            }
                            val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                            codec.releaseOutputBuffer(outIndex, false)
                            if (eos) outputDone = true
                        }
                    }
                }
            }

            val header = csd ?: run {
                Timber.w("MediaCodec FLAC 未产出 CSD 头，转 Java 兜底")
                return null
            }
            val full = header + frames.toByteArray()
            if (full.size < 42 || !full.copyOfRange(0, 4).contentEquals(MAGIC)) {
                Timber.w("MediaCodec FLAC 组装结果无 fLaC 魔数，转 Java 兜底")
                return null
            }
            patchTotalSamples(full, pcm.size / 2L)
        } catch (e: Exception) {
            // 无 FLAC encoder / configure 失败 —— 正常降级路径，不刷 error 堆栈
            Timber.i("MediaCodec FLAC 不可用，转 Java 兜底: ${e.message}")
            null
        } finally {
            try {
                codec?.stop()
            } catch (_: Exception) {
            }
            try {
                codec?.release()
            } catch (_: Exception) {
            }
        }
    }

    // ======================== 路径 2: java-flac-encoder ========================

    private fun encodeViaJavaLib(pcm: ByteArray, sampleRate: Int): ByteArray? {
        return try {
            val n = pcm.size / 2
            val samples = IntArray(n)
            val bb = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until n) {
                samples[i] = bb.short.toInt() // 符号扩展到 int
            }

            val enc = net.sourceforge.javaflacencoder.FLACEncoder()
            val sc = net.sourceforge.javaflacencoder.StreamConfiguration(
                /* channelCount */ 1,
                /* minBlock */ 4096,
                /* maxBlock */ 4096,
                /* sampleRate */ sampleRate,
                /* bitsPerSample */ 16
            )
            if (!enc.setStreamConfiguration(sc)) {
                Timber.w("java-flac-encoder 拒绝 StreamConfiguration(sr=$sampleRate)")
                return null
            }
            // 必须用可 seek 的文件流：FLACStreamOutputStream(ByteArray) 不回写 total samples
            val tmp = File.createTempFile("axeuh_flac_", ".tmp")
            try {
                val fos = net.sourceforge.javaflacencoder.FLACFileOutputStream(tmp)
                try {
                    enc.setOutputStream(fos)
                    enc.openFLACStream()
                    enc.addSamples(samples, n)
                    // end=true：编码残余块 + seek 回文件头回写 STREAMINFO + close
                    enc.encodeSamples(enc.samplesAvailableToEncode(), true)
                } finally {
                    // 库在 end=true 成功时已 close；失败路径自行 close（幂等）
                    try {
                        fos.close()
                    } catch (_: Exception) {
                    }
                }
                val out = tmp.readBytes()
                if (out.size < 42 || !out.copyOfRange(0, 4).contentEquals(MAGIC)) {
                    Timber.w("java-flac-encoder 产出无效 FLAC")
                    null
                } else {
                    // 库已 patch；再 patch 一次保证幂等一致
                    patchTotalSamples(out, n.toLong())
                }
            } finally {
                tmp.delete()
            }
        } catch (e: Exception) {
            Timber.w("java-flac-encoder 失败: ${e.message}")
            null
        }
    }
}
