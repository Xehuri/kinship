/**
 * 健康摘要 Composable — 单日健康数据 (报告页顶部条)
 *
 * 只读取 GET /api/mobile/dashboard?date=YYYY-MM-DD，把聚合响应映射为
 * 报告页健康条所需的 7 个指标。不注入任何模拟数据：请求失败或响应为空时
 * 由视图展示“健康数据暂不可用”并提供重试。
 *
 * 使用方式:
 *   const { date, metrics, loading, error, load } = useHealthSummary()
 *   await load()
 */

import { computed, ref, readonly, type ComputedRef, type Ref } from 'vue';
import { fetchDashboard } from '@/api/health';
import type { DashboardResponse } from '@/types';

/** 健康条指标键 */
export type HealthMetricKey =
  | 'heartRate'
  | 'steps'
  | 'sleep'
  | 'spo2'
  | 'stress'
  | 'battery'
  | 'gps';

/** 健康条单个指标 (值已格式化; 无数据为 "—") */
export interface HealthSummaryMetric {
  key: HealthMetricKey;
  label: string;
  value: string;
  unit: string;
  icon: string;
}

/** useHealthSummary 返回值 */
export interface UseHealthSummaryReturn {
  /** 当前日期 (YYYY-MM-DD, 本地时区) */
  date: Ref<string>;
  /** 7 个健康指标 */
  metrics: ComputedRef<HealthSummaryMetric[]>;
  /** 加载中 */
  loading: Readonly<Ref<boolean>>;
  /** 请求失败 / 响应无可用数据 */
  error: Readonly<Ref<boolean>>;
  /** 加载指定日期; 不带参数时使用当前 date */
  load: (targetDate?: string) => Promise<void>;
}

const EMPTY_VALUE = '—';

/** 本地日历日期 YYYY-MM-DD (不用 toISOString, 避免 UTC 跨日) */
function localDateString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 仅接受有限数值，其余视为缺失 */
function asNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 分钟 -> XhYM (0 分钟保留 0m; 缺失返回空串) */
function formatMinutes(minutes: number | null): string {
  if (minutes == null) return '';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h${String(mins).padStart(2, '0')}m`;
}

/** 数值 -> 千分位字符串; 缺失为 "—" */
function formatNumber(value: number | null, fractionDigits = 0): string {
  if (value == null) return EMPTY_VALUE;
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** 取电量时间线最后一条的电量 */
function lastBatteryLevel(data: DashboardResponse | null): number | null {
  const timeline = data?.perception?.battery_timeline;
  if (!timeline || timeline.length === 0) return null;
  return asNumber(timeline[timeline.length - 1]?.level);
}

/**
 * 健康摘要 Composable
 */
export function useHealthSummary(): UseHealthSummaryReturn {
  const date = ref<string>(localDateString());
  const dashboard = ref<DashboardResponse | null>(null);
  const loading = ref(false);
  const error = ref(false);

  const metrics = computed<HealthSummaryMetric[]>(() => {
    const data = dashboard.value;
    const heartRate = asNumber(data?.health?.heart_rate?.avg);
    const steps = asNumber(data?.health?.steps);
    const sleepMinutes = asNumber(data?.health?.sleep?.duration_min);
    const spo2 = asNumber(data?.health?.spo2?.avg);
    const stress = asNumber(data?.health?.stress?.avg);
    const battery = lastBatteryLevel(data);
    const gpsCount = asNumber(data?.perception?.gps_records);

    return [
      {
        key: 'heartRate',
        label: '心率',
        value: heartRate == null ? EMPTY_VALUE : formatNumber(Math.round(heartRate)),
        unit: 'bpm',
        icon: 'Heartbeat',
      },
      {
        key: 'steps',
        label: '步数',
        value: formatNumber(steps),
        unit: '步',
        icon: 'Footprints',
      },
      {
        key: 'sleep',
        label: '睡眠',
        value: sleepMinutes == null ? EMPTY_VALUE : formatMinutes(sleepMinutes),
        unit: '',
        icon: 'MoonStars',
      },
      {
        key: 'spo2',
        label: '血氧',
        value: formatNumber(spo2),
        unit: '%',
        icon: 'Drop',
      },
      {
        key: 'stress',
        label: '压力',
        value: formatNumber(stress),
        unit: '/100',
        icon: 'Pulse',
      },
      {
        key: 'battery',
        label: '电量',
        value: formatNumber(battery),
        unit: '%',
        icon: 'BatteryFull',
      },
      {
        key: 'gps',
        label: 'GPS',
        value: formatNumber(gpsCount),
        unit: '点',
        icon: 'MapPin',
      },
    ];
  });

  async function load(targetDate?: string): Promise<void> {
    if (targetDate) {
      date.value = targetDate;
    }

    loading.value = true;
    error.value = false;
    dashboard.value = null;

    try {
      const result = await fetchDashboard(date.value);
      if (!result || (!result.health && !result.perception)) {
        error.value = true;
        return;
      }
      dashboard.value = result;
    } catch (e) {
      console.warn('[useHealthSummary] 健康数据加载失败:', e);
      error.value = true;
    } finally {
      loading.value = false;
    }
  }

  return {
    date,
    metrics,
    loading: readonly(loading),
    error: readonly(error),
    load,
  };
}
