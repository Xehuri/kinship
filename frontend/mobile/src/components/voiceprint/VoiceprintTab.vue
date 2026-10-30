<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useVoiceprintSingleton } from '@/composables/useVoiceprint'
import { useDashboardSingleton } from '@/composables/useDashboard'
import {
  charColor, tagClass, tagLabel,
  hasTextContent, fmtFilename,
} from '@/utils/voiceprint'
import type { VpRecord } from '@/types'

type TagFilter = 'all' | 'self' | 'mixed' | 'other'

const vp = useVoiceprintSingleton()
const dash = useDashboardSingleton()

const expanded = ref<Set<string>>(new Set())
const activeFilter = ref<TagFilter>('self')

const filterOptions = [
  { key: 'self' as TagFilter, label: '你是' },
  { key: 'mixed' as TagFilter, label: '混合' },
  { key: 'other' as TagFilter, label: '他人' },
  { key: 'all' as TagFilter, label: '全部' },
]

const statsCards = computed(() => {
  const s = vp.stats.value
  if (!s) return []
  return [
    { label: '总计', value: s.totalRecords, color: 'var(--text)' },
    { label: '你是', value: s.selfCount, color: 'var(--legacy-accent)' },
    { label: '混合', value: s.mixedCount, color: 'var(--legacy-accent3)' },
    { label: '他人', value: s.otherCount, color: 'var(--text3)' },
  ]
})

/** 全部含文本的记录 */
const textRecords = computed(() => {
  const all = vp.timeline.value?.records
  if (!all) return []
  return all.filter(r => hasTextContent(r as VpRecord))
})

/** 按标签筛选后的记录 */
const filteredRecords = computed(() => {
  if (activeFilter.value === 'all') return textRecords.value
  return textRecords.value.filter(r => r.tag === activeFilter.value)
})

/** 每个筛选标签下的记录数（仅含文本的） */
const filterCounts = computed(() => {
  const base = textRecords.value
  return {
    self: base.filter(r => r.tag === 'self').length,
    mixed: base.filter(r => r.tag === 'mixed').length,
    other: base.filter(r => r.tag === 'other').length,
    all: base.length,
  }
})

function rowKey(rec: VpRecord, i: number): string { return rec.t + '_' + i }

function toggleRow(key: string) {
  const next = new Set(expanded.value)
  next.has(key) ? next.delete(key) : next.add(key)
  expanded.value = next
}

async function playSeg(rec: VpRecord) {
  const url = await vp.buildAudioUrl(rec.audio)
  vp.playAudio(url, fmtFilename(rec.audio))
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return m + ':' + String(sec).padStart(2, '0')
}

onMounted(() => {
  vp.loadVoiceprintData(dash.dashDate.value)
})

watch(() => dash.dashDate.value, (d) => {
  vp.loadVoiceprintData(d)
})
</script>

<template>
  <div class="vp-tab">
    <div v-if="vp.loading.value" class="vp-center-state">加载中...</div>

    <template v-else>
      <div v-if="vp.error.value" class="vp-center-state vp-error">{{ vp.error.value }}</div>

      <div v-else-if="!vp.hasData.value" class="vp-center-state">今日暂无声纹数据</div>

      <template v-else>
        <!-- 统计卡片 -->
        <div class="vp-stats">
          <div v-for="card in statsCards" :key="card.label" class="vp-stat-card">
            <div class="vp-stat-label">{{ card.label }}</div>
            <div class="vp-stat-value" :style="{ color: card.color }">{{ card.value }}</div>
          </div>
        </div>

        <!-- 标签筛选 -->
        <div class="vp-filter-bar">
          <button
            v-for="opt in filterOptions" :key="opt.key"
            class="vp-filter-btn"
            :class="{ 'vp-filter-active': activeFilter === opt.key }"
            :style="activeFilter === opt.key ? { color: (opt.key === 'all' ? 'var(--text)' : opt.key === 'self' ? 'var(--legacy-accent)' : opt.key === 'mixed' ? 'var(--legacy-accent3)' : 'var(--text3)') } : {}"
            @click="activeFilter = opt.key"
          >
            {{ opt.label }} {{ filterCounts[opt.key] }}
          </button>
        </div>

        <!-- 记录列表 -->
        <div class="vp-table-wrap">
          <!-- 表头 -->
          <div class="vp-grid-header">
            <span>时间</span>
            <span>内容</span>
            <span></span>
          </div>
          <!-- 内容行 -->
          <div class="vp-grid-body">
            <template v-for="(rec, i) in filteredRecords" :key="rowKey(rec as VpRecord, i)">
              <div class="vp-grid-row" @click="toggleRow(rowKey(rec as VpRecord, i))">
                <span
                  class="vp-td-time"
                  @click.stop="playSeg(rec as VpRecord)"
                  :title="'播放 ' + fmtFilename((rec as VpRecord).audio)"
                >{{ (rec as VpRecord).t }}</span>
                <div class="vp-td-content">
                  <span :class="['vp-badge', tagClass((rec as VpRecord).tag)]">
                    {{ tagLabel((rec as VpRecord).tag) }}
                  </span>
                  <!-- 逐 segment 渲染：有 token 则逐字着色，否则用段级 sim -->
                  <template v-if="(rec as VpRecord).segs?.length">
                    <span class="vp-token-text">
                      <template v-for="seg in (rec as VpRecord).segs" :key="seg.start">
                        <!-- 有 token → 逐字着色 -->
                        <template v-if="seg.tokens?.length">
                          <span
                            v-for="tk in seg.tokens" :key="seg.start + '_' + tk.c"
                            class="vp-char"
                            :style="{ color: charColor(tk.v) }"
                            :title="tk.c + ' v=' + tk.v.toFixed(3)"
                          >{{ tk.c }}</span>
                        </template>
                        <!-- 无 token 但有 vp.sim → 拆成逐字用段级 sim 着色 -->
                        <template v-else-if="seg.vp?.sim != null && seg.text">
                          <span
                            v-for="(ch, ci) in seg.text.split('')" :key="seg.start + '_' + ci"
                            class="vp-char"
                            :style="{ color: charColor(seg.vp.sim) }"
                            :title="ch + ' sim=' + seg.vp.sim.toFixed(2)"
                          >{{ ch }}</span>
                        </template>
                        <!-- 无 token 无 sim → 纯文本 -->
                        <span v-else-if="seg.text" class="vp-text-plain-seg">{{ seg.text }}</span>
                      </template>
                    </span>
                  </template>
                  <!-- 无 segs 但有 text → 纯文本降级 -->
                  <span v-else-if="(rec as VpRecord).text" class="vp-text-plain">{{ (rec as VpRecord).text }}</span>
                </div>
                <span class="vp-td-expand">{{ expanded.has(rowKey(rec as VpRecord, i)) ? '▴' : '▾' }}</span>
              </div>
              <div v-if="expanded.has(rowKey(rec as VpRecord, i))" class="vp-detail">
                <div v-for="seg in (rec as VpRecord).segs" :key="seg.start" class="vp-seg-detail">
                  <span class="vp-seg-time">{{ seg.start }}s-{{ seg.end }}s</span>
                  <span class="vp-seg-spk">{{ seg.vp?.spk || '?' }}</span>
                  <span class="vp-seg-sim">sim={{ seg.vp?.sim?.toFixed(2) }}</span>
                  <span class="vp-seg-text">{{ seg.text }}</span>
                </div>
                <div v-if="!(rec as VpRecord).segs || (rec as VpRecord).segs!.length === 0" class="vp-seg-detail">
                  <span class="vp-text-plain">无片段数据</span>
                </div>
              </div>
            </template>
          </div>
          <div v-if="filteredRecords.length === 0" class="vp-empty">
            当前筛选无匹配记录
          </div>
        </div>
      </template>
    </template>

    <!-- 底部播放栏 -->
    <div v-if="vp.audioState.value.src" class="vp-player">
      <button class="vp-player-btn" @click="vp.stopAudio()">&#10074;&#10074;</button>
      <span class="vp-player-label">{{ vp.audioState.value.label }}</span>
      <span class="vp-player-time">{{ fmtTime(vp.audioCurrent.value) }}</span>
      <input
        type="range" class="vp-player-bar"
        :min="0" :max="vp.audioDuration.value || 1"
        :value="vp.audioCurrent.value"
        @input="vp.seekAudio(Number(($event.target as HTMLInputElement).value))"
      />
      <span class="vp-player-time">{{ fmtTime(vp.audioDuration.value) }}</span>
    </div>
  </div>
</template>

<style scoped>
.vp-tab {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg);
  color: var(--text);
}

/* 空状态 */
.vp-center-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  font-size: 13px;
  color: var(--text3);
}
.vp-error { color: var(--danger); }

/* 统计卡片 */
.vp-stats {
  display: flex;
  gap: 8px;
  padding: 8px 16px;
}
.vp-stat-card {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
}
.vp-stat-label {
  font-size: 10px;
  color: var(--text3);
  margin-bottom: 2px;
}
.vp-stat-value {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.2;
}

/* 筛选栏 */
.vp-filter-bar {
  display: flex;
  gap: 6px;
  padding: 0 16px 8px;
}
.vp-filter-btn {
  flex: 1;
  padding: 4px 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text3);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.vp-filter-active {
  border-color: var(--text3);
  font-weight: 600;
}
.vp-filter-active[style] {
  /* style from computed overrides */
}

/* 表格 → CSS Grid */
.vp-table-wrap {
  flex: 1;
  overflow-y: auto;
  padding: 0 16px 8px;
}
.vp-empty {
  text-align: center;
  padding: 24px 0;
  font-size: 12px;
  color: var(--text3);
}

/* 表头 */
.vp-grid-header {
  display: grid;
  grid-template-columns: 64px 1fr 28px;
  align-items: center;
  padding: 6px 8px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  font-size: 10px;
  font-weight: 600;
  color: var(--text3);
  position: sticky;
  /* 吸附位置与所在页面 (#page-dashboard) 的内容起始位置对齐:
     该页面 padding-top = 16px + --app-top-inset, 因此此处同样计入 16px */
  top: calc(16px + var(--app-top-inset, 0px));
  z-index: 2;
}

/* 数据行 */
.vp-grid-row {
  display: grid;
  grid-template-columns: 64px 1fr 28px;
  align-items: center;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.12s;
}
.vp-grid-row:hover { background: var(--surface); }

/* 展开详情（跨整行） */
.vp-detail {
  padding: 0;
  background: var(--bg);
}

/* 时间列 */
.vp-td-time {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  color: var(--primary);
  cursor: pointer;
  user-select: none;
}
.vp-td-time:hover {
  text-decoration: underline;
}

/* 内容列 */
.vp-td-content {
  line-height: 1.6;
}

/* 标签 badge — CSS 类驱动，不写死颜色 */
.vp-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.6;
  vertical-align: middle;
  margin-right: 6px;
}
.vp-badge-self {
  background: rgba(48, 209, 88, 0.15);
  color: var(--legacy-accent);
}
.vp-badge-mixed {
  background: rgba(255, 159, 10, 0.15);
  color: var(--legacy-accent3);
}
.vp-badge-other {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text3);
}

/* token 文本 */
.vp-token-text { vertical-align: middle; }
.vp-char {
  cursor: default;
  font-size: 13px;
  transition: opacity 0.1s;
}
.vp-char:hover { opacity: 0.6; }
/* 无 token 时按段着色（自然流式布局，不设宽度约束） */
.vp-seg-text-colored {
  vertical-align: middle;
}
/* 无 seg 时的纯文本降级 */
.vp-text-plain {
  color: var(--text3);
  vertical-align: middle;
}
.vp-text-plain-seg {
  color: var(--text2);
  vertical-align: middle;
  font-size: 13px;
}

/* 展开列 */
.vp-td-expand {
  text-align: center;
  color: var(--text3);
  font-size: 11px;
  user-select: none;
}

/* 展开详情 */
.vp-detail {
  padding: 0;
  background: var(--bg);
}
.vp-seg-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 8px;
  font-size: 11px;
  border-bottom: 1px solid var(--border);
}
.vp-seg-detail:last-child { border-bottom: none; }
.vp-seg-time {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  color: var(--text3);
  min-width: 80px;
}
.vp-seg-spk {
  color: var(--primary);
  font-weight: 600;
}
.vp-seg-sim {
  color: var(--text2);
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}
.vp-seg-text {
  color: var(--text);
  flex: 1;
  min-width: 120px;
}

/* 播放栏 */
.vp-player {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  position: sticky;
  bottom: 0;
  z-index: 100;
}
.vp-player-btn {
  background: none;
  border: none;
  color: var(--primary);
  font-size: 14px;
  cursor: pointer;
  padding: 2px;
  line-height: 1;
  flex-shrink: 0;
}
.vp-player-label {
  font-size: 11px;
  color: var(--text2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 80px;
  flex-shrink: 0;
}
.vp-player-time {
  font-size: 10px;
  color: var(--text3);
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  min-width: 30px;
  text-align: center;
  flex-shrink: 0;
}
.vp-player-bar {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--surface2);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.vp-player-bar::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--primary);
  cursor: pointer;
}

/* 移动端 */
@media (max-width: 767px) {
  .vp-stats {
    flex-wrap: wrap;
    padding: 8px 12px;
  }
  .vp-stat-card {
    flex: 1 1 calc(50% - 4px);
    min-width: 0;
  }
  .vp-stat-value { font-size: 16px; }
  .vp-filter-bar { padding: 0 12px 8px; }
  .vp-table-wrap { padding: 0 12px 8px; }
  .vp-grid-header, .vp-grid-row {
    grid-template-columns: 60px 1fr 24px;
    padding: 4px 6px;
    font-size: 11px;
  }
  .vp-char { font-size: 12px; }
  .vp-seg-detail {
    gap: 6px;
    padding: 5px 6px;
    font-size: 10px;
  }
}
</style>
