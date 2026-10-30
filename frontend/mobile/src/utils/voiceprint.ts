/**
 * 声纹工具函数 — 颜色映射、统计
 *
 * 纯函数模块, 不依赖 api 层; 涉及网络请求的音频 URL 构造由
 * useVoiceprint composable (buildAudioUrl) 负责。
 *
 * 颜色规则 (per-character sim score v)，使用主题 CSS 变量：
 *   v > 0.5  → var(--legacy-accent) 绿色 (你是你)
 *   v < -0.2 → var(--danger) 红色 (非你)
 *   其他     → var(--text3) 灰色 (不确定)
 */

import type { VpRecord, VpTimeline, VpStats } from '@/types'

/**
 * 根据 sim 分数计算颜色（连续渐变，非三段跳）
 *
 * 映射规则（HSL 平滑插值）：
 *   sim ≤ -0.3 → 红   (hsl 0,   80%, 50%)
 *   sim = 0    → 灰   (hsl 60,  15%, 50%)
 *   sim ≥ 0.5  → 绿   (hsl 120, 80%, 50%)
 * 中间值线性插值，饱和度按距中点的距离渐变。
 * sim 为 null/undefined 时返回 undefined，由调用方使用默认颜色。
 */
export function charColor(sim: number | null | undefined): string | undefined {
  if (sim == null) return undefined
  // 映射范围（覆盖 token 和 seg 级 sim 的主要区间）
  const MIN = -0.3
  const MAX = 0.5
  const clamped = Math.max(MIN, Math.min(MAX, sim))
  // 归一化 [0, 1]: 0→红, 0.5→灰, 1→绿
  const t = (clamped - MIN) / (MAX - MIN)
  // 色相线性插值 0→120 (红→绿)
  const hue = t * 120
  // 饱和度 V 形：中点最低，两端最高
  const saturation = Math.round(Math.abs(t - 0.5) * 140 + 10)
  const lightness = 50
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

/** 标签文字颜色 */
export function tagColor(tag: string): string {
  if (tag === 'self') return 'var(--legacy-accent)'
  if (tag === 'mixed') return 'var(--legacy-accent3)'
  return 'var(--text3)'
}

/** 标签 CSS 类名（背景等通过 CSS 类控制，不写死颜色） */
export function tagClass(tag: string): string {
  if (tag === 'self') return 'vp-badge-self'
  if (tag === 'mixed') return 'vp-badge-mixed'
  return 'vp-badge-other'
}

/** 标签中文名 */
export function tagLabel(tag: string): string {
  const map: Record<string, string> = { self: '你', mixed: '混合', other: '他人' }
  return map[tag] || tag
}

/** 统计 */
export function calcVpStats(timeline: VpTimeline): VpStats {
  let selfCount = 0, mixedCount = 0, otherCount = 0, youSecs = 0
  for (const r of timeline.records) {
    if (r.tag === 'self') selfCount++
    else if (r.tag === 'mixed') mixedCount++
    else otherCount++
    if (r.tag === 'self' || r.tag === 'mixed') youSecs += r.dur
  }
  const total = timeline.records.length || 1
  return {
    totalRecords: total,
    selfCount, mixedCount, otherCount,
    selfPercent: selfCount / total * 100,
    youSecs,
  }
}

/** 判断是否有数据 */
export function hasVpData(timeline: VpTimeline | null): boolean {
  return timeline !== null && timeline.records.length > 0
}

/** 提取文件名 */
export function fmtFilename(audioPath: string): string {
  const f = audioPath.split('/').pop() || audioPath
  return f.replace(/_default\.wav$/, '_d')
}

/** 判断是否有 token 数据 */
export function hasTokens(rec: VpRecord): boolean {
  return !!(rec.segs && rec.segs.some(s => s.tokens && s.tokens.length > 0))
}

/** 判断是否有可显示的文本（text 字段或逐字 token） */
export function hasTextContent(rec: VpRecord): boolean {
  return !!(rec.text && rec.text.trim()) || hasTokens(rec)
}
