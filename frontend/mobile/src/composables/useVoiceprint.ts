/**
 * 声纹数据 Composable — 从 perception.jsonl 解析 voice 记录
 *
 * 数据源: ai/data/daily/{date}/perception.jsonl
 * 只提取 type="voice" 的记录
 */

import { ref, type Ref } from 'vue'
import { fetchFileContent, getFileRawUrl } from '@/api/files'
import { USE_MOCK_DATA } from '@/composables/useMockData'
import type { VpRecord, VpTimeline, VpStats, VpAudioState } from '@/types'
import { calcVpStats, hasVpData } from '@/utils/voiceprint'

const MOCK_RECORDS: VpRecord[] = [
  {
    t: '10:51:48', dur: 60, tag: 'self', text: '要。',
    audio: 'daily/2026-07-23/audio/105137_default.wav',
    segs: [{
      start: 2.6, end: 3.2, text: '要。',
      vp: { spk: 'Axeuh', sim: 0.40 },
      tokens: [{ c: '要', v: 0.40 }, { c: '。', v: 0.40 }],
    }],
  },
  {
    t: '10:55:39', dur: 60, tag: 'mixed', text: '我们中午吃不用吃饭了？',
    audio: 'daily/2026-07-23/audio/105531_default.wav',
    segs: [{
      start: 0.9, end: 2.7, text: '我们中午吃不用吃饭了？',
      vp: { spk: 'speaker-a', sim: 0.23 },
      tokens: [
        { c: '我', v: 0.13 }, { c: '们', v: 0.13 }, { c: '中', v: 0.13 }, { c: '午', v: 0.13 },
        { c: '吃', v: 0.13 }, { c: '不', v: 0.13 }, { c: '用', v: 0.28 }, { c: '吃', v: 0.28 },
        { c: '饭', v: 0.28 }, { c: '了', v: 0.28 }, { c: '？', v: 0.28 },
      ],
    }],
  },
  {
    t: '10:57:00', dur: 60, tag: 'other', text: '',
    audio: 'daily/2026-07-23/audio/105700_default.wav',
    segs: [],
  },
]

/**
 * 判断 perception.jsonl 单行对象是否为声纹 (voice) 记录
 *
 * 仅校验判别字段 type, 其余字段结构由数据源保证, 不做逐字段校验 (避免误丢有效记录)。
 */
function isVpRecord(obj: Record<string, unknown>): obj is Record<string, unknown> & VpRecord {
  return obj.type === 'voice'
}

export interface UseVoiceprintReturn {
  timeline: Ref<VpTimeline | null>
  stats: Ref<VpStats | null>
  loading: Ref<boolean>
  hasData: Ref<boolean>
  error: Ref<string | null>
  audioState: Ref<VpAudioState>
  audioCurrent: Ref<number>
  audioDuration: Ref<number>
  loadVoiceprintData: (date: string) => Promise<void>
  buildAudioUrl: (audioFullPath: string) => Promise<string>
  playAudio: (url: string, label: string) => void
  stopAudio: () => void
  seekAudio: (t: number) => void
}

export function useVoiceprint(): UseVoiceprintReturn {
  const timeline = ref<VpTimeline | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const stats = ref<VpStats | null>(null)
  const hasData = ref(false)
  const audioState = ref<VpAudioState>({ src: null, label: '', isPlaying: false })
  const audioCurrent = ref(0)
  const audioDuration = ref(0)
  const _audioEl = ref<HTMLAudioElement | null>(null)

  async function loadVoiceprintData(date: string): Promise<void> {
    loading.value = true; error.value = null
    try {
      if (USE_MOCK_DATA) {
        await new Promise(r => setTimeout(r, 200))
        timeline.value = { records: MOCK_RECORDS }
      } else {
        const path = `daily/${date}/perception.jsonl`
        const raw = await fetchFileContent(path, 'data')
        if (!raw) {
          timeline.value = null
          error.value = '数据文件不存在'
          return
        }
        // 后端对 .jsonl 返回 {objects: [...], total_lines, parse_errors}
        // 先提取已解析好的对象数组
        let objects: Record<string, unknown>[]
        if (typeof raw === 'object' && raw !== null && 'objects' in raw) {
          objects = (raw as { objects: Record<string, unknown>[] }).objects
        } else if (typeof raw === 'string') {
          // 回退：手动按行解析
          objects = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        } else {
          objects = []
        }
        const records: VpRecord[] = []
        for (const obj of objects) {
          if (isVpRecord(obj)) records.push(obj)
        }
        timeline.value = { records }
      }
      if (hasVpData(timeline.value!)) {
        stats.value = calcVpStats(timeline.value!)
        hasData.value = true
      } else {
        stats.value = null
        hasData.value = false
      }
    } catch (e) {
      console.error('[useVoiceprint] 加载失败:', e)
      error.value = e instanceof Error ? e.message : '未知错误'
      timeline.value = null; stats.value = null; hasData.value = false
    } finally { loading.value = false }
  }

  /**
   * 音频 URL (音频文件在 ai/data/ 下需 scope=data)
   * 一次性 ticket 异步换取, 由 api 层统一处理认证
   */
  async function buildAudioUrl(audioFullPath: string): Promise<string> {
    return getFileRawUrl(audioFullPath, 'data')
  }

  function _getAudio(): HTMLAudioElement {
    if (!_audioEl.value) {
      _audioEl.value = new Audio()
      _audioEl.value.addEventListener('ended', () => {
        audioState.value = { ...audioState.value, isPlaying: false }
      })
      _audioEl.value.addEventListener('timeupdate', () => {
        audioCurrent.value = _audioEl.value?.currentTime || 0
      })
      _audioEl.value.addEventListener('loadedmetadata', () => {
        audioDuration.value = _audioEl.value?.duration || 0
      })
    }
    return _audioEl.value
  }

  function playAudio(url: string, label: string): void {
    const a = _getAudio()
    a.src = url
    a.load()
    audioCurrent.value = 0; audioDuration.value = 0
    a.play().then(() => {
      audioState.value = { src: url, label, isPlaying: true }
    }).catch(e => {
      console.warn('[useVoiceprint] 播放失败:', e)
    })
  }

  function stopAudio(): void {
    if (_audioEl.value) {
      _audioEl.value.pause()
      _audioEl.value.src = ''
    }
    audioState.value = { src: null, label: '', isPlaying: false }
    audioCurrent.value = 0; audioDuration.value = 0
  }

  function seekAudio(t: number): void {
    if (_audioEl.value) _audioEl.value.currentTime = t
  }

  return {
    timeline: timeline as Ref<VpTimeline | null>,
    stats,
    loading,
    hasData,
    error,
    audioState,
    audioCurrent,
    audioDuration,
    loadVoiceprintData,
    buildAudioUrl,
    playAudio,
    stopAudio,
    seekAudio,
  }
}

let _singleton: UseVoiceprintReturn | null = null
export function useVoiceprintSingleton(): UseVoiceprintReturn {
  if (!_singleton) _singleton = useVoiceprint()
  return _singleton
}
