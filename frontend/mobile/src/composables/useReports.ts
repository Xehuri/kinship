/**
 * 报告 Composable — 报告类别筛选、计数与分页
 *
 * 一次性加载 /api/mobile/reports（不带标签查询），
 * 类别筛选、计数与分页全部在前端内存中完成，避免切换标签时计数归零。
 */

import { ref, computed, readonly, watch, type Ref, type ComputedRef } from 'vue';
import type {
  ReportFamilyCounts,
  ReportFamilyFilter,
  ReportItem,
  ReportListResponse,
} from '@/types';
import { REPORT_FAMILY_ORDER, resolveReportFamily } from '@/types';
import { apiGet } from '@/api/client';
import { USE_MOCK_DATA } from '@/composables/useMockData';

/** 每页报告数 */
const PAGE_SIZE = 50;

/** 模拟报告数据 */
const MOCK_REPORTS: ReportItem[] = [
  {
    title: '7月16日行为报告',
    date: '2026-07-16',
    tags: ['行为', '日常'],
    type: 'daily',
    family: 'daily',
    md: '# 7月16日行为报告\n\n今日行为数据总结：在教室上课、在家学习、短暂外出活动。\n\n## 主要活动\n- 上午 8:00-12:00 教室上课\n- 下午 14:00-17:30 图书馆学习\n- 晚间 19:00-21:00 在家休息',
  },
  {
    title: '第28周健康复盘',
    date: '2026-07-14',
    tags: ['健康', '运动'],
    type: 'weekly',
    family: 'review',
    md: '# 第28周健康复盘\n\n本周心率平均71bpm，步数日均7,240步，睡眠质量良好。\n\n## 健康指标\n- 平均心率: 71 bpm\n- 日均步数: 7,240 步\n- 平均睡眠: 7小时22分钟',
  },
  {
    title: '7月上旬行为模式分析',
    date: '2026-07-10',
    tags: ['行为', '分析'],
    type: 'biweekly',
    family: 'daily',
    md: '# 7月上旬行为模式分析\n\n本月前10天行为模式：学习时间集中在下午和晚上。\n\n## 行为规律\n- 学习高峰: 14:00-18:00\n- 运动时间: 早晨为主\n- 社交活动: 周末增多',
  },
  {
    title: '本周学习总结',
    date: '2026-07-15',
    tags: ['学习', '进步'],
    type: 'study',
    family: 'weekly',
    md: '# 本周学习总结\n\n本周学习时长25小时，完成英语语法专项练习12套。\n\n## 学习成果\n- 总学习时长: 25 小时\n- 英语练习: 12 套\n- 数学复习: 8 章节',
  },
  {
    title: '社交活动记录',
    date: '2026-07-13',
    tags: ['社交'],
    type: 'social',
    family: 'daily',
    md: '# 社交活动记录\n\n本周与朋友互动频繁，QQ消息量增加30%。\n\n## 社交统计\n- QQ消息量: +30%\n- 线下聚会: 2 次\n- 电话通话: 5 次',
  },
  {
    title: '睡眠质量周报',
    date: '2026-07-12',
    tags: ['健康', '睡眠'],
    type: 'health',
    family: 'health',
    md: '# 睡眠质量周报\n\n本周平均睡眠7小时22分钟，深睡占比28%。\n\n## 睡眠数据\n- 平均睡眠: 7小时22分钟\n- 深睡占比: 28%\n- 入睡时间: 23:15 平均',
  },
];

/** useReports 返回值 */
export interface UseReportsReturn {
  /** 所有报告（一次性加载的完整列表） */
  reports: Ref<ReportItem[]>;
  /** 当前报告类别筛选 */
  familyFilter: Ref<ReportFamilyFilter>;
  /** 筛选后的报告列表 (computed, 按日期降序) */
  filteredReports: ComputedRef<ReportItem[]>;
  /** 报告总数 (筛选后) */
  reportCount: ComputedRef<number>;
  /** 四类报告计数 (基于完整列表, 不受当前筛选影响) */
  counts: ComputedRef<ReportFamilyCounts>;
  /** 当前页可见报告 (类别视图每页 50 条; 全部视图返回完整筛选结果) */
  visibleReports: ComputedRef<ReportItem[]>;
  /** 类别视图是否还有下一页 */
  hasMore: ComputedRef<boolean>;
  /** 加载下一页 */
  loadMore: () => void;
  /** 加载中 */
  loading: Readonly<Ref<boolean>>;
  /** 加载失败标记 (API 异常时为 true, 不注入伪造数据) */
  error: Readonly<Ref<boolean>>;
  /** 加载报告列表 (不带标签查询) */
  loadReportList: () => Promise<void>;
}

function emptyCounts(): ReportFamilyCounts {
  return { health: 0, daily: 0, weekly: 0, review: 0 };
}

function normalizeCounts(source: Partial<ReportFamilyCounts>): ReportFamilyCounts {
  const normalized = emptyCounts();
  for (const family of REPORT_FAMILY_ORDER) {
    const value = source[family];
    if (typeof value === 'number' && Number.isFinite(value)) {
      normalized[family] = value;
    }
  }
  return normalized;
}

/**
 * 报告 Composable — 一次性加载、内存筛选、分组计数与分页
 */
export function useReports(): UseReportsReturn {
  const reports = ref<ReportItem[]>([]);
  const familyFilter = ref<ReportFamilyFilter>('all');
  const loading = ref(false);
  const error = ref(false);
  /** API 返回的计数, 仅在无法从行数据推导时兜底 */
  const apiCounts = ref<Partial<ReportFamilyCounts> | null>(null);
  const pageSize = ref(PAGE_SIZE);

  watch(
    familyFilter,
    () => {
      pageSize.value = PAGE_SIZE;
    },
    { flush: 'sync' },
  );

  /** 筛选后的报告列表, 按日期降序 */
  const filteredReports = computed<ReportItem[]>(() => {
    const list =
      familyFilter.value === 'all'
        ? reports.value
        : reports.value.filter(
            (report) => resolveReportFamily(report) === familyFilter.value,
          );
    return [...list].sort((a, b) => b.date.localeCompare(a.date));
  });

  /** 报告总数 (筛选后) */
  const reportCount = computed<number>(() => filteredReports.value.length);

  /** 四类计数: 优先由完整列表推导, 行数据无法分类时退回 API counts */
  const counts = computed<ReportFamilyCounts>(() => {
    const derived = emptyCounts();
    let classified = 0;
    for (const report of reports.value) {
      const family = resolveReportFamily(report);
      if (!family) continue;
      derived[family] += 1;
      classified += 1;
    }
    if (classified === 0 && apiCounts.value) {
      return normalizeCounts(apiCounts.value);
    }
    return derived;
  });

  /** 当前页可见报告 */
  const visibleReports = computed<ReportItem[]>(() => {
    if (familyFilter.value === 'all') return filteredReports.value;
    return filteredReports.value.slice(0, pageSize.value);
  });

  /** 类别视图是否还有更多 */
  const hasMore = computed<boolean>(
    () =>
      familyFilter.value !== 'all' &&
      filteredReports.value.length > visibleReports.value.length,
  );

  /** 加载下一页 (每次 +50) */
  function loadMore(): void {
    if (hasMore.value) {
      pageSize.value += PAGE_SIZE;
    }
  }

  /**
   * 加载报告列表
   *
   * 只请求一次完整的 /api/mobile/reports（无 tag 查询），
   * 类别切换全部在内存中完成。API 失败时不注入伪造数据。
   */
  async function loadReportList(): Promise<void> {
    loading.value = true;
    error.value = false;
    pageSize.value = PAGE_SIZE;

    if (USE_MOCK_DATA) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      reports.value = [...MOCK_REPORTS];
      apiCounts.value = null;
      loading.value = false;
      return;
    }

    try {
      const result = await apiGet<ReportListResponse>('/api/mobile/reports');
      reports.value = result?.reports ?? [];
      apiCounts.value = result?.counts ?? null;
    } catch (e) {
      console.error('[useReports] 加载失败:', e);
      error.value = true;
    } finally {
      loading.value = false;
    }
  }

  return {
    reports,
    familyFilter,
    filteredReports,
    reportCount,
    counts,
    visibleReports,
    hasMore,
    loadMore,
    loading: readonly(loading),
    error: readonly(error),
    loadReportList,
  };
}

// ==================== 单例 ====================

let _singleton: UseReportsReturn | null = null;

/**
 * 全局单例 useReports (跨组件共享同一个报告状态)
 */
export function useReportsSingleton(): UseReportsReturn {
  if (!_singleton) {
    _singleton = useReports();
  }
  return _singleton;
}
