/**
 * 报告类型
 *
 * 对应 /api/mobile/reports 接口及报告卡片渲染
 */

/** 报告标签类型 */
export type ReportTag =
  | '日常报告'
  | '异常报告'
  | '周报'
  | '日志'
  | string;

/** 后端推导的报告类别 (T2B) */
export type ReportKind = 'daily' | 'weekly' | 'monthly' | 'audit' | 'other';

/** 用户面报告类别（后端允许清单） */
export type ReportFamily = 'health' | 'daily' | 'weekly' | 'review';

/** 报告类别筛选值 */
export type ReportFamilyFilter = 'all' | ReportFamily;

/** 报告类别展示顺序 */
export const REPORT_FAMILY_ORDER: readonly ReportFamily[] = [
  'health',
  'daily',
  'weekly',
  'review',
];

/** 报告类别中文标签 */
export const FAMILY_LABELS: Record<ReportFamily, string> = {
  health: '健康清单',
  daily: '日报',
  weekly: '周报',
  review: '复盘',
};

/** 四类报告的数量统计 */
export type ReportFamilyCounts = Record<ReportFamily, number>;

/** /api/mobile/reports 的 families 条目 */
export interface ReportFamilyCount {
  id: ReportFamily;
  label: string;
  count: number;
}

/** 单条报告条目 */
export interface ReportItem {
  /** 报告标题 */
  title: string;
  /** 报告日期 (YYYY-MM-DD) */
  date: string;
  /** 报告类型 */
  type: string;
  /** 报告标签列表 */
  tags?: ReportTag[];
  /** 文件路径 (用于加载报告详情) */
  path?: string;
  /** Markdown 内容 (内联报告全文) */
  md?: string;
  /** 后端推导的报告类别 */
  kind?: ReportKind;
  /** 用户面报告类别 */
  family?: ReportFamily;
  /** 报告文件大小 (字节) */
  size_bytes?: number;
}

/** /api/mobile/reports 响应 */
export interface ReportListResponse {
  reports: ReportItem[];
  /** 返回集总数 */
  total?: number;
  /** 返回集按类别计数 */
  counts?: Partial<ReportFamilyCounts>;
  /** 报告类别清单（顺序即展示顺序） */
  families?: ReportFamilyCount[];
}

/** 报告筛选参数 */
export interface ReportFilter {
  /** 按标签筛选 */
  tag?: ReportTag;
  /** 按报告类别筛选 */
  family?: ReportFamily;
}

/**
 * 解析一条报告所属的展示类别。
 *
 * 后端新契约始终返回 family；旧数据/测试夹具可能只有 kind，
 * 此时按 kind 回退到最接近的类别，无法判定返回 null。
 */
export function resolveReportFamily(report: ReportItem): ReportFamily | null {
  if (report.family) return report.family;
  switch (report.kind) {
    case 'daily':
      return 'daily';
    case 'weekly':
      return 'weekly';
    case 'audit':
      return 'review';
    default:
      return null;
  }
}
