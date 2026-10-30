/// <reference types="vitest/globals" />

/**
 * api/plan 测试
 *
 * 验证:
 *   1. GET /api/plan/{date} 与 GET /api/plan/long-tasks 的 URL 与响应;
 *   2. plan:null 的空计划是合法成功响应;
 *   3. HTTP 500 (apiGet -> null) / 网络异常 -> PlanApiError;
 *   4. 结构非法的响应不被当作成功。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiGet = vi.hoisted(() => vi.fn());
const mockApiGetVerbose = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
  apiGetVerbose: mockApiGetVerbose,
}));

import {
  fetchEffectivePlan,
  fetchPlanDay,
  fetchLongTasks,
  PlanApiError,
} from '@/api/plan';
import type {
  LongTask,
  PlanCoverage,
  PlanDayResponse,
  PlanDocument,
  PlanLongTasksResponse,
} from '@/types';
import type { EffectivePlanResponse } from '@/types/plan';

const COVERAGE: PlanCoverage = {
  profile: 'merged_7',
  checkpoints: ['cov-00', 'cov-06', 'cov-08', 'cov-12', 'cov-16', 'cov-20', 'cov-22'],
  debt: [],
};

const PLAN: PlanDocument = {
  schema: 1,
  date: '2026-10-28',
  status: 'committed',
  version: 2,
  created_at: 1761600000,
  updated_at: 1761603600,
  review_at: 1761638400,
  items: [
    {
      id: 'c1',
      kind: 'care',
      intent: '材料提交',
      status: 'planned',
      target_date: '2026-10-28',
      window: '09:30~11:00',
      checkpoint_id: 'cov-08',
      done_when: '材料提交成功',
      not_do: '不主动提理发',
      source: 'data_check',
      note: '缺一张照片',
    },
  ],
  coverage: COVERAGE,
  notes: ['周五拍照要理发，先别催'],
};

const LONG_TASK: LongTask = {
  schema: 1,
  id: 'lt_weekly_review',
  title: '每周复盘',
  intent: '把一周的事收口',
  cadence: 'weekly',
  next_check: '2026-10-28T20:00:00+08:00',
  last_done: null,
  status: 'active',
  review_policy: 'after_done',
  notes: ['周日晚上做'],
  created_at: 1761500000,
  updated_at: 1761590000,
  version: 3,
};

const DAY_RESPONSE: PlanDayResponse = {
  date: '2026-10-28',
  plan: PLAN,
  coverage: COVERAGE,
  long_tasks_due: [LONG_TASK],
  warnings: ['coverage debt 未收口'],
  generated_at: 1761640000,
};

const TASKS_RESPONSE: PlanLongTasksResponse = {
  tasks: [LONG_TASK],
  generated_at: 1761640000,
};

describe('fetchPlanDay', () => {
  beforeEach(() => {
    mockApiGet.mockReset();
  });

  it('请求 /api/plan/{date} 并返回计划响应', async () => {
    mockApiGet.mockResolvedValue(DAY_RESPONSE);

    await expect(fetchPlanDay('2026-10-28')).resolves.toEqual(DAY_RESPONSE);
    expect(mockApiGet).toHaveBeenCalledWith('/api/plan/2026-10-28');
  });

  it('空计划 (plan:null) 是成功响应而非错误', async () => {
    const empty: PlanDayResponse = {
      date: '2026-10-29',
      plan: null,
      coverage: null,
      long_tasks_due: [],
      warnings: [],
      generated_at: 1761640001,
    };
    mockApiGet.mockResolvedValue(empty);

    await expect(fetchPlanDay('2026-10-29')).resolves.toEqual(empty);
  });

  it('500 等失败 (apiGet -> null) 抛出 PlanApiError', async () => {
    mockApiGet.mockResolvedValue(null);

    const request = fetchPlanDay('2026-10-28');
    await expect(request).rejects.toBeInstanceOf(PlanApiError);
    await expect(request).rejects.toMatchObject({
      path: '/api/plan/2026-10-28',
    });
  });

  it('网络异常抛出 PlanApiError 并保留原因', async () => {
    mockApiGet.mockRejectedValue(new Error('network down'));

    await expect(fetchPlanDay('2026-10-28')).rejects.toThrow(
      /network down/,
    );
  });

  it('响应结构非法时抛出 PlanApiError', async () => {
    mockApiGet.mockResolvedValue({ plan: PLAN });

    await expect(fetchPlanDay('2026-10-28')).rejects.toBeInstanceOf(
      PlanApiError,
    );
  });

  it('可选字段缺失时归一化为空数组/0', async () => {
    mockApiGet.mockResolvedValue({
      date: '2026-10-28',
      plan: null,
      coverage: null,
    });

    await expect(fetchPlanDay('2026-10-28')).resolves.toEqual({
      date: '2026-10-28',
      plan: null,
      coverage: null,
      long_tasks_due: [],
      warnings: [],
      generated_at: 0,
    });
  });
});

describe('fetchLongTasks', () => {
  beforeEach(() => {
    mockApiGet.mockReset();
  });

  it('请求 /api/plan/long-tasks 并返回任务列表', async () => {
    mockApiGet.mockResolvedValue(TASKS_RESPONSE);

    await expect(fetchLongTasks()).resolves.toEqual(TASKS_RESPONSE);
    expect(mockApiGet).toHaveBeenCalledWith('/api/plan/long-tasks');
  });

  it('失败 (apiGet -> null) 抛出 PlanApiError', async () => {
    mockApiGet.mockResolvedValue(null);

    await expect(fetchLongTasks()).rejects.toBeInstanceOf(PlanApiError);
  });

  it('tasks 缺失时抛出 PlanApiError', async () => {
    mockApiGet.mockResolvedValue({ generated_at: 1761640000 });

    await expect(fetchLongTasks()).rejects.toBeInstanceOf(PlanApiError);
  });
});

describe('fetchEffectivePlan', () => {
  const EFFECTIVE: EffectivePlanResponse = {
    date: '2026-10-28',
    master_version: 3,
    master: {
      timezone: 'Asia/Shanghai',
      entries: [
        {
          id: 'm_fixed',
          kind: 'fixed',
          title: '晨间',
          enabled: true,
          schedule: { kind: 'daily', at: '08:00' },
          created_at: 1761500000,
          updated_at: 1761600000,
        },
      ],
    },
    overlay: {
      schema: 1,
      kind: 'plan-overlay',
      date: '2026-10-28',
      base_version: 3,
      version: 2,
      status: 'committed',
      created_at: 1761600000,
      updated_at: 1761603600,
      ops: [],
      notes: ['今天别催'],
      coverage: COVERAGE,
    },
    effective: {
      items: [
        {
          id: 'm_fixed',
          kind: 'fixed',
          title: '晨间',
          intent: '开始一天',
          at: '08:00',
          at_override: false,
          status: 'planned',
          source: 'master',
          suppressed: false,
          master_version: 3,
          overlay_version: 2,
        },
      ],
      coverage: COVERAGE,
    },
    long_tasks_due: [LONG_TASK],
    warnings: [],
    generated_at: 1761640000,
  };

  beforeEach(() => {
    mockApiGetVerbose.mockReset();
  });

  it('请求 /api/plan/{date}/effective 并返回有效视图', async () => {
    mockApiGetVerbose.mockResolvedValue({
      status: 200,
      ok: true,
      data: EFFECTIVE,
    });

    await expect(fetchEffectivePlan('2026-10-28')).resolves.toEqual(EFFECTIVE);
    expect(mockApiGetVerbose).toHaveBeenCalledWith(
      '/api/plan/2026-10-28/effective',
    );
  });

  it('旧后端 400/404/405 视为端点缺失返回 null (由调用方回退 v1)', async () => {
    for (const status of [400, 404, 405]) {
      mockApiGetVerbose.mockResolvedValue({ status, ok: false, data: null });

      await expect(fetchEffectivePlan('2026-10-28')).resolves.toBeNull();
    }
  });

  it('500 等真实失败抛出带状态码的 PlanApiError (不静默降级)', async () => {
    mockApiGetVerbose.mockResolvedValue({
      status: 500,
      ok: false,
      data: { detail: '母版文件损坏' },
    });

    await expect(fetchEffectivePlan('2026-10-28')).rejects.toMatchObject({
      name: 'PlanApiError',
      path: '/api/plan/2026-10-28/effective',
      status: 500,
    });
  });

  it('响应缺少 effective.items 时抛出 PlanApiError', async () => {
    mockApiGetVerbose.mockResolvedValue({
      status: 200,
      ok: true,
      data: { date: '2026-10-28', effective: {} },
    });

    await expect(fetchEffectivePlan('2026-10-28')).rejects.toBeInstanceOf(
      PlanApiError,
    );
  });
});
