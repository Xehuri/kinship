package com.xehuri.kinship.wakeword

import android.content.Context
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.getFeatureConfig
import timber.log.Timber

/**
 * 端侧唤醒词识别（sherpa-onnx KWS）。
 *
 * 模型与词表来自 `assets/kws/`（与服务端 `ai/data/wake_word/` 同源，chunk-8 即 160ms 延迟）。
 * 检测参数 [KEYWORDS_SCORE] / [KEYWORDS_THRESHOLD] 与服务端 `config.yaml` 的
 * `audio.wake_word` 对齐（1.8 / 0.25，2026-09-14 标定；2.5 经全天实测否决）。
 *
 * 线程约定：**非线程安全**，必须在单一线程串行调用（本项目中即 AudioCollector 的录音线程）。
 *
 * 失败策略：模型缺失或加载异常时 [initialize] 返回 false 并保持不可用，
 * 绝不抛出异常影响采集链路（`keywords.txt` 缺失会导致原生层直接退出进程，
 * 因此该文件必须随 assets 一并打包）。
 */
class LocalKwsEngine(context: Context, private val config: Config = Config()) {

    companion object {
        /** 采样率，须与 AudioRecord 采集参数一致 */
        const val SAMPLE_RATE = 16000

        /** fbank 维度，KWS 模型固定 80 */
        private const val FEATURE_DIM = 80

        /** 模型与词表在 assets 下的目录（相对 assets 根，不可用绝对路径） */
        private const val ASSET_DIR = "kws"
        private const val ENCODER = "encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx"
        private const val DECODER = "decoder-epoch-13-avg-2-chunk-8-left-64.onnx"
        private const val JOINER = "joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx"
        private const val TOKENS = "tokens.txt"
        private const val KEYWORDS = "keywords.txt"

        /** 唤醒词加权分默认值，与服务端 `audio.wake_word.keywords_score` 一致 */
        const val KEYWORDS_SCORE = 1.8f

        /** 唤醒词判定阈值默认值，与服务端 `audio.wake_word.keywords_threshold` 一致 */
        const val KEYWORDS_THRESHOLD = 0.25f

        /** 默认推理间隔（毫秒），与录音帧长一致 */
        const val DEFAULT_INTERVAL_MS = 100

        /** 推理间隔允许范围 */
        private const val MIN_INTERVAL_MS = 100
        private const val MAX_INTERVAL_MS = 1000
    }

    /**
     * 引擎参数。
     *
     * @param keywordsScore 唤醒词加权分（越大越难触发）
     * @param keywordsThreshold 判定阈值
     * @param customKeywords 自定义词表（已编码 token，多行）；空串表示沿用 assets 内置 keywords.txt
     * @param intervalMs 推理间隔（毫秒）：累积满该时长才跑一次模型。100 = 每帧推理（默认）；
     *   200/300 可显著降低 CPU 占用（唤醒延迟同量级增加，感知不明显）。注意必须是**累积**而非跳帧，
     *   否则送入模型的音频不连续会导致识别失败。
     */
    class Config(
        val keywordsScore: Float = KEYWORDS_SCORE,
        val keywordsThreshold: Float = KEYWORDS_THRESHOLD,
        val customKeywords: String = "",
        val intervalMs: Int = DEFAULT_INTERVAL_MS,
    )

    private val appContext = context.applicationContext

    private var spotter: KeywordSpotter? = null
    private var stream: OnlineStream? = null

    /** 一个推理块所需样本数（intervalMs × 采样率 / 1000） */
    private val chunkSamples: Int =
        SAMPLE_RATE * config.intervalMs.coerceIn(MIN_INTERVAL_MS, MAX_INTERVAL_MS) / 1000

    /** 累积缓冲：凑满 chunkSamples 才送入模型，保证送进去的音频始终连续 */
    private val pending = FloatArray(chunkSamples)

    /** 已累积样本数 */
    private var pendingCount = 0

    /** 模型是否已就绪（加载成功且流可用） */
    val isReady: Boolean
        get() = spotter != null && stream != null

    /**
     * 加载模型并创建检测流。
     *
     * @return true 表示可用；false 表示不可用（模型缺失/加载失败），调用方应跳过后续推理
     */
    fun initialize(): Boolean {
        if (isReady) return true
        return try {
            val spotterConfig = KeywordSpotterConfig(
                featConfig = getFeatureConfig(sampleRate = SAMPLE_RATE, featureDim = FEATURE_DIM),
                modelConfig = OnlineModelConfig(
                    transducer = OnlineTransducerModelConfig(
                        encoder = "$ASSET_DIR/$ENCODER",
                        decoder = "$ASSET_DIR/$DECODER",
                        joiner = "$ASSET_DIR/$JOINER",
                    ),
                    tokens = "$ASSET_DIR/$TOKENS",
                    numThreads = 1,
                    modelType = "zipformer2",
                ),
                keywordsFile = "$ASSET_DIR/$KEYWORDS",
                keywordsScore = config.keywordsScore,
                keywordsThreshold = config.keywordsThreshold,
            )
            val s = KeywordSpotter(assetManager = appContext.assets, config = spotterConfig)
            spotter = s
            // 自定义词表（若有）在运行时覆盖 assets 内置 keywords.txt
            stream = s.createStream(config.customKeywords)
            Timber.i(
                "[LocalKws] KWS 模型加载完成 score=%.2f threshold=%.2f words=%s",
                config.keywordsScore,
                config.keywordsThreshold,
                if (config.customKeywords.isBlank()) "内置词表" else "自定义词表",
            )
            true
        } catch (e: Throwable) {
            Timber.e(e, "[LocalKws] KWS 模型加载失败，端侧唤醒不可用")
            release()
            false
        }
    }

    /**
     * 送入一帧 PCM 并返回命中的唤醒词。
     *
     * 输入帧长可以与 [Config.intervalMs] 不同：本方法内部**累积**样本，
     * 每凑满一个 interval 才真正跑一次模型（累积而非跳帧，保证音频连续）。
     *
     * @param samples 单声道 Float PCM，取值范围 -1f ~ 1f
     * @return 命中时返回唤醒词文本；未命中返回 null
     */
    fun accept(samples: FloatArray): String? {
        if (samples.isEmpty()) return null
        var offset = 0
        while (offset < samples.size) {
            val take = minOf(chunkSamples - pendingCount, samples.size - offset)
            System.arraycopy(samples, offset, pending, pendingCount, take)
            pendingCount += take
            offset += take
            if (pendingCount == chunkSamples) {
                pendingCount = 0
                val hit = infer(pending)
                if (hit != null) return hit
            }
        }
        return null
    }

    /** 对完整一块样本执行一次前向推理；任何异常仅记日志并返回 null */
    private fun infer(samples: FloatArray): String? {
        val s = spotter ?: return null
        val st = stream ?: return null
        return try {
            st.acceptWaveform(samples, sampleRate = SAMPLE_RATE)
            var hit: String? = null
            // 一个 chunk 可能产出多个结果，逐个取直到不再就绪
            while (s.isReady(st)) {
                s.decode(st)
                val text = s.getResult(st).keyword
                if (text.isNotBlank()) {
                    // 命中后必须 reset，否则同一段音频会被反复判定为命中
                    s.reset(st)
                    hit = text
                }
            }
            hit
        } catch (e: Throwable) {
            Timber.w(e, "[LocalKws] 推理异常")
            null
        }
    }

    /** 释放原生资源（幂等，可重复调用） */
    fun release() {
        pendingCount = 0
        try {
            stream?.release()
        } catch (_: Throwable) {
        }
        try {
            spotter?.release()
        } catch (_: Throwable) {
        }
        stream = null
        spotter = null
    }
}
