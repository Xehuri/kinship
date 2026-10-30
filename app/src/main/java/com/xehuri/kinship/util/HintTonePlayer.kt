package com.xehuri.kinship.util

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import com.xehuri.kinship.R
import timber.log.Timber

/**
 * 提示音播放器 —— 播放「唤醒确认 / 录制结束」两种短提示音。
 *
 * 音效来自内置资源 `res/raw/start.mp3`（唤醒确认）与 `res/raw/end.mp3`（录制结束），
 * 不使用 TTS 中文语音，也不在运行时程序化合成波形。
 *
 * ## 为什么用 SoundPool
 * 提示音是短音效，[SoundPool] 会预解码常驻内存，播放延迟低（毫秒级），
 * 适合「唤醒瞬间立即出声」的场景；且 `play()` 支持按次传入左右声道音量，
 * 天然满足音量可调需求（无需重建播放器）。
 *
 * ## 音频属性选择（重要）
 * 选用媒体用途（`USAGE_MEDIA` + `CONTENT_TYPE_SONIFICATION`）。原因：
 * - 提示音发生在设备正用麦克风录音（VOICE_RECOGNITION 音源）期间。该音源路径
 *   自带回声消除（AEC），会把扬声器外放的提示音从采集信号里消掉——这正好符合
 *   预期：用户听得见提示音，但它不会污染录音 / ASR。
 * - 通知流会在静音 / 振动模式或免打扰下被系统静音，导致提示完全听不到；
 *   媒体流不受铃声模式影响，外放更可靠。
 *
 * ## 音量
 * [setVolume] 取值范围 0-100；0 表示静音（不发声）。音量在每次播放时读取，
 * 因此设置页改动可实时生效。
 *
 * ## 线程与生命周期
 * - [SoundPool] 首次使用时惰性创建并异步加载两个音效资源；构造时即触发预热，
 *   到真正唤醒时通常已加载完成。
 * - [release] 释放 SoundPool（由采集器 `stop()` 调用）；释放后再次播放会惰性重建，
 *   可安全复用。
 * - 所有公开方法线程安全，且绝不向调用方抛出异常（失败仅记日志）。
 */
class HintTonePlayer(context: Context) {

    companion object {
        /** 默认音量（0-100） */
        const val DEFAULT_VOLUME = 90

        /** 最大同时播放流数（提示音很短，2 足够） */
        private const val MAX_STREAMS = 2

        /** 播放优先级（数值越大越优先） */
        private const val PRIORITY = 1
    }

    /** 使用 Application Context，避免持有 Activity 引用 */
    private val appContext: Context = context.applicationContext

    private val lock = Any()

    /** 惰性创建 / 可重建的播放池 */
    private var soundPool: SoundPool? = null

    /** 两个音效的加载 ID，0 表示尚未加载 */
    private var startSoundId = 0
    private var endSoundId = 0

    /** 当前音量（0-100），volatile 供播放线程读取 */
    @Volatile
    private var volume: Int = DEFAULT_VOLUME

    init {
        // 构造即预热：异步加载音效，缩短首次播放的等待
        ensurePool()
    }

    /** 设置音量（0-100），超出范围自动收敛；0 为静音 */
    fun setVolume(value: Int) {
        volume = value.coerceIn(0, 100)
    }

    /** 唤醒确认：播放 start 音效 */
    fun playStart() {
        ensurePool()
        playSound(startSoundId)
    }

    /** 录制结束：播放 end 音效 */
    fun playEnd() {
        ensurePool()
        playSound(endSoundId)
    }

    /**
     * 确保播放池已创建并已提交资源加载（幂等，线程安全）。
     *
     * 构造或加载失败时降级为「静默无提示音」，不影响音频采集主流程。
     */
    private fun ensurePool() {
        synchronized(lock) {
            if (soundPool != null) return
            try {
                val attributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
                val pool = SoundPool.Builder()
                    .setMaxStreams(MAX_STREAMS)
                    .setAudioAttributes(attributes)
                    .build()
                startSoundId = pool.load(appContext, R.raw.start, 1)
                endSoundId = pool.load(appContext, R.raw.end, 1)
                soundPool = pool
            } catch (e: Exception) {
                Timber.w(e, "提示音播放池初始化失败")
                soundPool = null
            }
        }
    }

    /**
     * 播放指定音效。
     *
     * 线程安全；任何异常一律吞掉并记日志，绝不抛给调用方（WebSocket 回调线程）。
     */
    private fun playSound(soundId: Int) {
        val vol = volume
        if (vol <= 0 || soundId == 0) return
        try {
            val pool = soundPool ?: return
            val gain = vol / 100f
            pool.play(soundId, gain, gain, PRIORITY, 0, 1f)
        } catch (e: Exception) {
            Timber.w(e, "提示音播放异常")
        }
    }

    /**
     * 释放播放池（由采集器 `stop()` 调用）。
     *
     * 先置空引用再释放，保证释放期间到来的播放请求会走惰性重建，
     * 因此释放后仍可安全复用。
     */
    fun release() {
        synchronized(lock) {
            val pool = soundPool ?: return
            soundPool = null
            startSoundId = 0
            endSoundId = 0
            try {
                pool.release()
            } catch (e: Exception) {
                Timber.w(e, "提示音播放池释放异常")
            }
        }
    }
}
