/**
 * 健康数据类型
 *
 * 对应 /api/health/query 和 /api/mobile/dashboard 的数据结构
 * 包含 Dashboard 仪表盘块配置类型
 */

// ==================== 原始健康样本 ====================

/**
 * 单条健康数据样本
 * 时间戳 t 为 Unix 秒数 (从 index.original.html: new Date((s.t || 0) * 1000))
 */
export interface HealthSample {
  /** Unix 时间戳 (秒) */
  t?: number;
  /** 心率 (bpm) */
  hr?: number;
  /** 步数 */
  steps?: number;
  /** 血氧饱和度 (%) */
  spo2?: number;
  /** 压力值 (0-100) */
  stress?: number;
  /** 手机电池电量 (%) */
  battery?: number;
  /** 附加字段 */
  [key: string]: unknown;
}

// ==================== 日汇总数据 ====================

/** 每日健康汇总 */
export interface DailySummary {
  /** 平均心率 */
  hr_avg?: number;
  /** 总步数 */
  steps?: number;
  /** 其他汇总字段 */
  [key: string]: unknown;
}

// ==================== 睡眠数据 ====================

/** 睡眠阶段类型 */
export type SleepStageType = 'deep' | 'light' | 'rem' | 'awake';

/**
 * 睡眠阶段条目
 * t 为 "HH:MM" 格式的时间字符串 (如 "23:22")
 */
export interface SleepStage {
  /** 阶段开始时间 (HH:MM) */
  t: string;
  /** 阶段类型 */
  type: SleepStageType;
}

/** 睡眠阶段颜色映射 */
export const SLEEP_STAGE_COLORS: Record<SleepStageType, string> = {
  deep: '#6c5ce7',
  light: '#a29bfe',
  rem: '#74b9ff',
  awake: '#fd79a8',
} as const;

/** 睡眠阶段标签映射 */
export const SLEEP_STAGE_LABELS: Record<SleepStageType, string> = {
  deep: '深睡',
  light: '浅睡',
  rem: 'REM',
  awake: '清醒',
} as const;

/** 睡眠阶段顺序 */
export const SLEEP_STAGE_ORDER: readonly SleepStageType[] = [
  'deep',
  'light',
  'rem',
  'awake',
] as const;

/** 睡眠数据 */
export interface SleepData {
  /** 睡眠阶段序列 (用于绘制睡眠时间线) */
  stages?: SleepStage[];
  /** 深睡分钟数 (无 stages 时的聚合值) */
  deep_min?: number;
  /** 浅睡分钟数 */
  light_min?: number;
  /** REM 分钟数 */
  rem_min?: number;
  /** 清醒分钟数 */
  awake_min?: number;
}

// ==================== /api/health/query 响应 ====================

/** /api/health/query 接口响应 */
export interface HealthQueryResponse {
  status: string;
  samples?: HealthSample[];
  daily_summary?: DailySummary;
  sleep_data?: SleepData;
}

// ==================== Dashboard 数据类型 ====================

/** Dashboard 中的健康摘要 (health 字段) */
export interface HealthSummary {
  heart_rate?: {
    avg: number;
    min?: number;
    max?: number;
  };
  steps?: number;
  spo2?: {
    avg: number;
    min?: number;
    max?: number;
  };
  stress?: {
    avg: number;
    min?: number;
    max?: number;
  };
  sleep?: {
    duration_min: number;
    deep_min?: number;
    light_min?: number;
    rem_min?: number;
    awake_min?: number;
  };
}

/** Dashboard 中的感知摘要 (perception 字段) */
export interface PerceptionSummary {
  /** 语音会话数 */
  voice_sessions?: number;
  /** GPS 记录数 */
  gps_records?: number;
  /** 电池时间线数据 */
  battery_timeline?: BatteryTimelineEntry[];
}

/** 电池时间线条目 */
export interface BatteryTimelineEntry {
  /** 时间戳 (Unix 秒) */
  t: number;
  /** 电量百分比 */
  level: number;
  /** 是否在充电 */
  charging?: boolean;
}

/** /api/mobile/dashboard 接口响应 */
export interface DashboardResponse {
  health?: HealthSummary;
  perception?: PerceptionSummary;
}

// ==================== BlockDetail 仪表盘块配置 ====================

/** 仪表盘块大小 */
export type BlockSize = '1' | '2' | '2x2';

/** 仪表盘块中的单条统计 */
export interface BlockStat {
  /** 统计项标签 */
  label: string;
  /** 统计值 (已格式化) */
  val: string;
  /** 显示颜色 */
  color?: string;
}

/** 仪表盘块配置 */
export interface BlockConfig {
  /** 块标题 */
  title: string;
  /** 统计数据列表 */
  stats: BlockStat[];
  /** Chart.js 图表 ID (用于展开图) */
  chartId?: string;
  /** AI 洞察文本 */
  insight: string;
}

/** 全部仪表盘块配置映射 */
export type BlockDetailsMap = Record<string, BlockConfig>;
