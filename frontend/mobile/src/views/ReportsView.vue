<template>
  <AppShell title="报告" :meta="headerMeta">
    <div class="ax-page">
      <HealthSummaryStrip
        :date="healthDate"
        :metrics="healthMetrics"
        :loading="healthLoading"
        :error="healthError"
        @retry="loadHealth()"
        @gps="handleGpsOpen"
        @voiceprint="voiceprintVisible = true"
      />

      <div class="ax-page-toolbar">
        <div class="report-tabs" role="group" aria-label="按报告类别筛选">
          <button
            v-for="tab in TABS"
            :key="tab.id"
            class="report-tab"
            :class="{ 'report-tab--active': familyFilter === tab.id }"
            type="button"
            :aria-pressed="familyFilter === tab.id"
            :data-testid="`report-tab-${tab.id}`"
            @click="selectFamily(tab.id)"
          >
            <span class="report-tab__label">{{ tab.label }}</span>
            <span
              class="report-tab__count"
              :data-testid="`report-tab-count-${tab.id}`"
            >{{ tabCount(tab.id) }}</span>
          </button>
        </div>
        <span v-if="!error && !initialLoading" class="ax-page-count">
          共 {{ reportCount }} 份
        </span>
      </div>

      <div
        v-if="error"
        class="ax-state"
        role="alert"
      >
        <h2 class="ax-state__title">加载失败</h2>
        <p class="ax-state__body">无法获取报告列表，请检查连接后重试。</p>
        <button class="ax-state__action" type="button" @click="handleRetry">
          重试
        </button>
      </div>

      <div
        v-else-if="initialLoading"
        class="ax-list"
        aria-busy="true"
        aria-label="正在加载报告"
      >
        <div
          v-for="index in 6"
          :key="index"
          class="ax-skeleton"
        >
          <span class="skeleton ax-skeleton__line" />
          <span class="skeleton ax-skeleton__line ax-skeleton__line--short" />
        </div>
      </div>

      <div
        v-else-if="showTotalEmpty"
        class="ax-state"
        data-testid="reports-empty"
      >
        <h2 class="ax-state__title">暂无报告</h2>
        <p class="ax-state__body">仅显示健康清单、日报、周报与复盘；未生成时会出现在这里。</p>
      </div>

      <div
        v-else-if="familyFilter !== 'all' && filteredReports.length === 0"
        class="ax-state"
        data-testid="reports-family-empty"
      >
        <h2 class="ax-state__title">暂无{{ currentFamilyLabel }}</h2>
        <p class="ax-state__body">这一类还没有报告。</p>
        <button class="ax-state__action" type="button" @click="selectFamily('all')">
          查看全部报告
        </button>
      </div>

      <div v-else-if="familyFilter === 'all'" class="report-sections">
        <section
          v-for="section in allSections"
          :key="section.family"
          class="report-section"
          :data-testid="`report-section-${section.family}`"
        >
          <div class="report-section__head">
            <h2 class="report-section__title">{{ section.label }}</h2>
            <span
              class="report-section__count"
              :data-testid="`report-section-count-${section.family}`"
            >{{ section.total }}</span>
          </div>
          <div class="ax-list">
            <div class="ax-list__head ax-report-row" aria-hidden="true">
              <span>报告</span>
              <span>类型</span>
              <span>日期</span>
              <span>大小</span>
            </div>
            <ul class="ax-list__body">
              <li
                v-for="report in section.reports"
                :key="rowKey(report)"
                class="ax-list__item"
              >
                <ReportRow :report="report" @open="handleReportClick" />
              </li>
            </ul>
          </div>
          <button
            class="report-section__more"
            type="button"
            :data-testid="`report-section-more-${section.family}`"
            @click="selectFamily(section.family)"
          >
            查看全部 {{ section.total }} 份
          </button>
        </section>
      </div>

      <div v-else class="report-sections">
        <section
          class="report-section"
          :data-testid="`report-section-${familyFilter}`"
        >
          <div class="report-section__head">
            <h2 class="report-section__title">{{ currentFamilyLabel }}</h2>
            <span
              class="report-section__count"
              :data-testid="`report-section-count-${familyFilter}`"
            >{{ filteredReports.length }}</span>
          </div>
          <div class="ax-list">
            <div class="ax-list__head ax-report-row" aria-hidden="true">
              <span>报告</span>
              <span>类型</span>
              <span>日期</span>
              <span>大小</span>
            </div>
            <ul class="ax-list__body">
              <li
                v-for="report in visibleReports"
                :key="rowKey(report)"
                class="ax-list__item"
              >
                <ReportRow :report="report" @open="handleReportClick" />
              </li>
            </ul>
          </div>
          <button
            v-if="hasMore"
            class="report-section__more"
            type="button"
            data-testid="reports-load-more"
            @click="loadMore"
          >
            加载更多
          </button>
        </section>
      </div>

      <DetailOverlay
        :visible="reportDetailVisible"
        :title="selectedReport?.title || ''"
        @close="reportDetailVisible = false"
      >
        <div v-if="selectedReport?.md" class="report-detail-body" data-testid="report-detail">
          <MarkdownContent :content="selectedReport.md" />
        </div>
        <p v-else-if="detailLoading" class="detail-loading">正在加载报告正文…</p>
        <p v-else-if="detailError" class="detail-error">{{ detailError }}</p>
      </DetailOverlay>

      <GpsMapOverlay
        :visible="gpsMapVisible"
        :gps-points="gpsPointsForMap"
        @close="gpsMapVisible = false"
      />

      <VoiceprintSheet
        :visible="voiceprintVisible"
        @close="voiceprintVisible = false"
      >
        <VoiceprintTab />
      </VoiceprintSheet>
    </div>
  </AppShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import AppShell from '@/components/shell/AppShell.vue'
import DetailOverlay from '@/components/common/DetailOverlay.vue'
import MarkdownContent from '@/components/chat/MarkdownContent.vue'
import ReportRow from '@/components/reports/ReportRow.vue'
import HealthSummaryStrip from '@/components/reports/HealthSummaryStrip.vue'
import VoiceprintSheet from '@/components/reports/VoiceprintSheet.vue'
import GpsMapOverlay from '@/components/dashboard/GpsMapOverlay.vue'
import VoiceprintTab from '@/components/voiceprint/VoiceprintTab.vue'
import { useReportsSingleton } from '@/composables/useReports'
import { useHealthSummary } from '@/composables/useHealthSummary'
import { useGps } from '@/composables/useGps'
import { fetchReportContent } from '@/api/reports'
import { FAMILY_LABELS, REPORT_FAMILY_ORDER, resolveReportFamily } from '@/types'
import type { ReportFamily, ReportFamilyFilter, ReportItem } from '@/types'

interface ReportTab {
  id: ReportFamilyFilter
  label: string
}

interface ReportSection {
  family: ReportFamily
  label: string
  total: number
  reports: ReportItem[]
}

/** 全部视图每个类别最多展示的条数 */
const PREVIEW_SIZE = 8

const TABS: ReportTab[] = [
  { id: 'all', label: '全部' },
  ...REPORT_FAMILY_ORDER.map((family) => ({
    id: family,
    label: FAMILY_LABELS[family],
  })),
]

const reportsApi = useReportsSingleton()
const {
  reports,
  familyFilter,
  filteredReports,
  reportCount,
  counts,
  visibleReports,
  hasMore,
  loadMore,
  loading,
  error,
  loadReportList,
} = reportsApi

// ==================== 健康摘要 (报告页顶部条) ====================

const {
  date: healthDate,
  metrics: healthMetrics,
  loading: healthLoading,
  error: healthError,
  load: loadHealth,
} = useHealthSummary()

// ==================== GPS 轨迹 / 声纹记录入口 ====================

const gps = useGps()
const gpsPointsForMap = computed(() => gps.gpsPointData.value)
const gpsMapVisible = ref(false)
const voiceprintVisible = ref(false)

function handleGpsOpen(): void {
  gpsMapVisible.value = true
  if (gpsPointsForMap.value.length === 0) {
    void gps.loadGpsData(healthDate.value)
  }
}

const initialLoading = computed(() => loading.value && reports.value.length === 0)

const headerMeta = computed(() => {
  if (error.value) return '加载失败'
  if (initialLoading.value) return '正在加载'
  return 'AI 生成的行为与健康分析'
})

const currentFamilyLabel = computed(() =>
  familyFilter.value === 'all' ? '' : FAMILY_LABELS[familyFilter.value],
)

const allSections = computed<ReportSection[]>(() => {
  const buckets: Record<ReportFamily, ReportItem[]> = {
    health: [],
    daily: [],
    weekly: [],
    review: [],
  }
  for (const report of filteredReports.value) {
    const family = resolveReportFamily(report)
    if (family) buckets[family].push(report)
  }
  return REPORT_FAMILY_ORDER.map((family) => ({
    family,
    label: FAMILY_LABELS[family],
    total: buckets[family].length,
    reports: buckets[family].slice(0, PREVIEW_SIZE),
  })).filter((section) => section.total > 0)
})

const showTotalEmpty = computed(
  () =>
    reports.value.length === 0 ||
    (familyFilter.value === 'all' && allSections.value.length === 0),
)

function tabCount(id: ReportFamilyFilter): number {
  return id === 'all' ? reports.value.length : counts.value[id]
}

function selectFamily(id: ReportFamilyFilter): void {
  familyFilter.value = id
}

function rowKey(report: ReportItem): string {
  return report.path || `${report.date}-${report.title}`
}

const reportDetailVisible = ref(false)
const selectedReport = ref<ReportItem | null>(null)
const detailLoading = ref(false)
const detailError = ref('')

async function handleReportClick(report: ReportItem): Promise<void> {
  selectedReport.value = report
  reportDetailVisible.value = true
  detailError.value = ''

  if (report.md) return
  if (!report.path) {
    detailError.value = '这份报告没有可读取的正文路径。'
    return
  }

  detailLoading.value = true
  try {
    const text = await fetchReportContent(report.path)
    if (text === null) {
      detailError.value = '读取报告正文失败，请稍后重试。'
      return
    }
    selectedReport.value = { ...report, md: text }
  } catch (e) {
    console.warn('[ReportsView] 加载报告内容失败:', e)
    detailError.value = '读取报告正文失败，请稍后重试。'
  } finally {
    detailLoading.value = false
  }
}

function handleRetry(): void {
  void loadReportList()
}

onMounted(() => {
  void loadReportList()
  void loadHealth()
})
</script>

<style scoped>
.report-detail-body {
  color: var(--ink);
  font-size: 14px;
  line-height: 1.7;
}

.detail-loading,
.detail-error {
  padding-block: var(--space-4);
  color: var(--muted);
  font-size: 13px;
}

.detail-error {
  color: var(--danger);
}

.report-tabs {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--space-1);
  min-inline-size: 0;
  max-inline-size: 100%;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.report-tabs::-webkit-scrollbar {
  display: none;
}

.report-tab {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  justify-content: center;
  min-block-size: var(--tap);
  padding-inline: var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
}

.report-tab:hover {
  background: var(--inset);
  color: var(--ink);
}

.report-tab--active {
  border-color: var(--hairline);
  background: var(--surface-raised);
  color: var(--ink);
}

.report-tab__label {
  display: inline-block;
}

.report-tab__count {
  color: inherit;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
}

.report-sections {
  display: flex;
  flex-direction: column;
  gap: var(--density-section-gap);
  min-inline-size: 0;
}

.report-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-inline-size: 0;
}

.report-section__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-inline-size: 0;
}

.report-section__title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
}

.report-section__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 22px;
  padding-inline: var(--space-2);
  border-radius: 999px;
  background: var(--inset);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
}

.report-section__more {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  justify-content: center;
  min-block-size: var(--tap);
  padding-inline: var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
}

.report-section__more:hover {
  background: var(--inset);
}
</style>
