/**
 * 健康数据 API
 *
 * 对应:
 *   - /api/mobile/dashboard — Dashboard 聚合数据
 *   - /api/health/query — 原始健康数据查询
 *
 * 使用方式:
 *   import { fetchDashboard, fetchHealthQuery } from '@/api/health'
 *   const dash = await fetchDashboard('2026-06-22')
 */

import { apiGet } from '@/api/client';
import type { DashboardResponse, HealthQueryResponse } from '@/types';

/**
 * 获取 Dashboard 聚合数据
 * GET /api/mobile/dashboard?date={date}
 *
 * 与原版一致:
 *   - 优先使用此 API, 失败时降级到 fetchHealthQuery
 *   - 返回 { health, perception } 结构
 */
export async function fetchDashboard(
  date: string,
): Promise<DashboardResponse | null> {
  return apiGet<DashboardResponse>(
    '/api/mobile/dashboard?date=' + encodeURIComponent(date),
  );
}

/**
 * 获取健康数据查询结果
 * GET /api/health/query?date={date}
 *
 * 包含 samples, daily_summary, sleep_data
 */
export async function fetchHealthQuery(
  date: string,
): Promise<HealthQueryResponse | null> {
  return apiGet<HealthQueryResponse>(
    '/api/health/query?date=' + encodeURIComponent(date),
  );
}
