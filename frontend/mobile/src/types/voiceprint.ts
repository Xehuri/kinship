/**
 * 声纹数据类型 — perception.jsonl 中 type=voice 记录
 *
 * 每字符一个 token {c: 字, v: sim}, 存在 segs[].tokens 中
 * 示例: {"type":"voice","t":"10:51:48","tag":"self","text":"要。",
 *   "audio":"daily/...","segs":[{"start":2.6,"end":3.2,"text":"要。",
 *   "vp":{"spk":"Axeuh","sim":0.4022},
 *   "tokens":[{"c":"要","v":0.4022},{"c":"。","v":0.4022}]}]}
 */

/** 单字符 token (声纹相似度) */
export interface VpCharToken {
  /** 字符 */
  c: string
  /** 相似度分数 (-1~1) */
  v: number
}

/** 声纹识别结果 */
export interface VpResult {
  /** 说话人名字 */
  spk: string
  /** 平均相似度 */
  sim: number
  /** 最大相似度 (某些记录) */
  max?: number
  /** 你的占比 (某些记录) */
  pct?: number
  /** 滑窗分数 (某些记录) */
  ws?: number[]
}

/** 语音子片段 (segs[]) */
export interface VpSegment {
  /** 起始偏移秒 */
  start: number
  /** 结束偏移秒 */
  end: number
  /** ASR 文本 */
  text: string
  /** 声纹结果 */
  vp?: VpResult
  /** 逐字 token (有则存在) */
  tokens?: VpCharToken[]
}

/** 标签 */
export type VpTag = 'self' | 'mixed' | 'other'

/** perception.jsonl 的一条 voice 记录 */
export interface VpRecord {
  t: string
  dur: number
  tag: VpTag
  text: string
  audio: string
  segs?: VpSegment[]
  scene?: string
  ac?: { db: number; spk: number }
  env?: string[]
}

export interface VpTimeline { records: VpRecord[] }

export interface VpStats {
  totalRecords: number
  selfCount: number
  mixedCount: number
  otherCount: number
  selfPercent: number
  youSecs: number
}

export interface VpAudioState {
  src: string | null
  label: string
  isPlaying: boolean
}
