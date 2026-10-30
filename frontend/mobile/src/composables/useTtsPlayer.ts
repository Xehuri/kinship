/**
 * TTS 播放器 Composable — 通过 WebSocket 接收并播放 TTS 音频
 *
 * 对应 ws 消息类型:
 *   - tts_start:        TTS 开始
 *   - tts_audio:        完整音频 (base64 WAV) — 不拆分，一次播放
 *   - tts_audio_chunk:  音频分片 (base64 WAV/PCM) — 按序播放，不叠加
 *   - tts_end:          TTS 结束
 *
 * 使用 Web Audio API 解码并播放音频
 */
import { useRealTimeSingleton } from '@/composables/useRealTime'

// ==================== 音频分片数据结构 ====================

/** TTS WebSocket 消息 (仅声明本模块用到的字段) */
interface TtsWsMessage {
  type?: string
  /** 音频数据 (base64 WAV/PCM) */
  audio?: string
  /** 分片序号 (tts_audio_chunk) */
  chunk_index?: number
  /** 分片总数 (tts_audio_chunk) */
  chunk_total?: number
}

// ==================== Web Audio API ====================

let _audioCtx: AudioContext | null = null
let _wired = false
/** 当前正在播放的音源节点，用于停止 */
let _currentSource: AudioBufferSourceNode | null = null
/** TTS 音量增益节点（模块级单例，挂在 AudioContext 与 destination 之间） */
let _gainNode: GainNode | null = null
/** 当前音量百分比（0-100） */
let _volumePercent = 100
/** 音量是否已初始化（从 URL 注入或 localStorage 读取） */
let _volumeInitialized = false

/** 音量持久化键与默认值（与原生 App 的 data_collector/tts_volume 语义一致） */
const TTS_VOLUME_STORAGE_KEY = 'tts_volume'
const TTS_VOLUME_DEFAULT = 100

/** 收敛音量到 0-100 的整数 */
function clampVolumePercent(value: number): number {
  if (!Number.isFinite(value)) return TTS_VOLUME_DEFAULT
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * 读取初始音量：优先 URL 注入的 `?tts_volume=`（原生 App 加载时携带），
 * 其次 localStorage 缓存，最后回退默认值。
 */
function readInitialVolumePercent(): number {
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const fromUrl = params.get('tts_volume')
      if (fromUrl !== null) {
        const parsed = clampVolumePercent(Number(fromUrl))
        localStorage.setItem(TTS_VOLUME_STORAGE_KEY, String(parsed))
        return parsed
      }
      const cached = localStorage.getItem(TTS_VOLUME_STORAGE_KEY)
      if (cached !== null) return clampVolumePercent(Number(cached))
    }
  } catch {
    // 读取失败时降级为默认值
  }
  return TTS_VOLUME_DEFAULT
}

function ensureVolumeInitialized(): void {
  if (_volumeInitialized) return
  _volumeInitialized = true
  _volumePercent = readInitialVolumePercent()
}

/** 获取（惰性创建）增益节点，并同步当前音量 */
function getGainNode(ctx: AudioContext): GainNode {
  if (!_gainNode) {
    _gainNode = ctx.createGain()
    _gainNode.connect(ctx.destination)
  }
  _gainNode.gain.value = _volumePercent / 100
  return _gainNode
}

/**
 * 设置 TTS 播放音量（0-100），立即生效并持久化。
 *
 * 原生 App 会通过 `window.__axeuhSetTtsVolume` 调用本函数（见 wireTtsPlayer）。
 */
export function setTtsVolume(percent: number): void {
  ensureVolumeInitialized()
  const value = clampVolumePercent(percent)
  _volumePercent = value
  try {
    localStorage.setItem(TTS_VOLUME_STORAGE_KEY, String(value))
  } catch {
    // 存储不可用时仅内存生效
  }
  if (_gainNode) {
    _gainNode.gain.value = value / 100
  }
}

/** 当前 TTS 音量（0-100） */
export function getTtsVolume(): number {
  ensureVolumeInitialized()
  return _volumePercent
}

function getAudioCtx(): AudioContext {
  if (!_audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) {
      throw new Error('当前环境不支持 Web Audio API')
    }
    _audioCtx = new Ctor()
  }
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume()
  }
  return _audioCtx
}

/** 停止当前正在播放的音频 */
function stopCurrentAudio(): void {
  if (_currentSource) {
    try {
      _currentSource.onended = null  // 防止触发 resolve
      _currentSource.stop()
    } catch {
      // 可能已经停止了
    }
    _currentSource = null
  }
}

/** 播放 Base64 编码音频，返回 Promise 在播放完成后 resolve */
function playTtsAudio(base64Audio: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const binaryStr = atob(base64Audio)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }
      const ctx = getAudioCtx()
      const gain = getGainNode(ctx)
      ctx.decodeAudioData(bytes.buffer, (buf) => {
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(gain)
        src.onended = () => {
          _currentSource = null
          resolve()
        }
        _currentSource = src
        src.start()
      }, () => {
        _currentSource = null
        resolve()
      })
    } catch {
      _currentSource = null
      resolve()
    }
  })
}

// ==================== WS 消息处理 ====================

/** 播放队列：链式 Promise，确保音频按序播放不叠加 */
let _playingQueue: Promise<void> = Promise.resolve()

function handleWsMessage(data: unknown): void {
  const msg = data as TtsWsMessage
  const type = msg.type
  if (!type) return

  if (type === 'tts_start') {
    // 前台停止正在播放的音频 + 重置队列，丢弃未播的
    stopCurrentAudio()
    _playingQueue = Promise.resolve()
    return
  }

  if (type === 'tts_audio') {
    // 完整音频排队播（不覆盖队列，防止与 chunk 叠加）
    const audio = msg.audio
    if (audio) {
      _playingQueue = _playingQueue.then(() => playTtsAudio(audio))
    }
    return
  }

  if (type === 'tts_audio_chunk') {
    // 音频分片按序播放：新分片排队等前一个播完
    const audio = msg.audio
    if (audio) {
      _playingQueue = _playingQueue.then(() => playTtsAudio(audio))
    }
    return
  }

  if (type === 'tts_end') {
    // TTS 结束，不做操作
  }
}

/**
 * 挂载 TTS 播放器到 WebSocket 消息流
 */
export function wireTtsPlayer(): void {
  if (_wired) return
  _wired = true
  ensureVolumeInitialized()
  // 暴露全局钩子供原生 Android 注入音量（入参 0-100，与设置页一致）
  try {
    ;(window as unknown as Record<string, unknown>).__axeuhSetTtsVolume = (value: number) =>
      setTtsVolume(value)
  } catch {
    // 非浏览器环境（测试等）忽略
  }
  const rt = useRealTimeSingleton()
  rt.onWSMessage(handleWsMessage)
}

/**
 * 停止 TTS 播放并清空播放队列 (登出时调用, FE-H6)
 */
export function stopTtsPlayback(): void {
  stopCurrentAudio()
  _playingQueue = Promise.resolve()
}
