/// <reference types="vitest/globals" />

/**
 * usePlan 测试
 *
 * 覆盖:
 *   - 初始日期与首次加载;
 *   - 空计划;
 *   - 加载中状态;
 *   - 失败设置 error 且保留上次成功数据 (无部分写入);
 *   - setDate 校验与刷新;
 *   - requestReplan 只发送一次控制文本 (backend=loom)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchEffectivePlan: vi.fn(),
  fetchPlanDay: vi.fn(),
  fetchLongTasks: vi.fn(),
  sendMessage: vi.fn(),
  fetchCurrentSessionId: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock('@/api/plan', () => ({
  fetchEffectivePlan: mocks.fetchEffectivePlan,
  fetchPlanDay: mocks.fetchPlanDay,
  fetchLongTasks: mocks.fetchLongTasks,
}));

vi.mock('@/api/session', () => ({
  sendMessage: mocks.sendMessage,
  fetchCurrentSessionId: mocks.fetchCurrentSessionId,
  listSessions: mocks.listSessions,
  normalizeSession: (raw: unknown) => raw,
}));

import { usePlan, isValidPlanDate, localPlanDate } from '@/composables/usePlan';
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
  checkpoints: ['cov-00', 'cov-06'],
  debt: ['cov-00 未收口'],
};

const PLAN: PlanDocument = {
  schema: 1,
  date: '2026-10-28',
  status: 'committed',
  version: 1,
  created_at: 1761600000,
  updated_at: 1761600000,
  review_at: 1761638400,
  items: [
    {
      id: 'c1',
      kind: 'care',
      intent: '材料提交',
      status: 'planned',
      done_when: '材料提交成功',
    },
  ],
  coverage: COVERAGE,
  notes: ['别催简历'],
};

const LONG_TASK: LongTask = {
  schema: 1,
  id: 'lt_weekly_review',
  title: '每周复盘',
  intent: '收口一周',
  cadence: 'weekly',
  next_check: '2026-10-28T20:00:00+08:00',
  last_done: null,
  status: 'active',
  review_policy: 'after_done',
  notes: [],
  created_at: 1761500000,
  updated_at: 1761500000,
  version: 1,
};

const DAY: PlanDayResponse = {
  date: '2026-10-28',
  plan: PLAN,
  coverage: COVERAGE,
  long_tasks_due: [LONG_TASK],
  warnings: ['debt 未收口'],
  generated_at: 1761640000,
};

const TASKS: PlanLongTasksResponse = {
  tasks: [LONG_TASK],
  generated_at: 1761640000,
};

function mockSuccess(day: PlanDayResponse = DAY): void {
  mocks.fetchPlanDay.mockResolvedValue(day);
  mocks.fetchLongTasks.mockResolvedValue(TASKS);
}

describe('usePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchEffectivePlan.mockResolvedValue(null);
  });

  it('默认日期是本地今天 YYYY-MM-DD, 可传入初始日期', () => {
    expect(usePlan().date.value).toBe(localPlanDate());
    expect(usePlan('2026-10-28').date.value).toBe('2026-10-28');
    expect(usePlan('2026-02-30').date.value).toBe(localPlanDate());
  });

  it('首次 refresh 同时加载计划、coverage、长期任务与告警', async () => {
    mockSuccess();
    const state = usePlan('2026-10-28');

    await state.refresh();

    expect(mocks.fetchPlanDay).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPlanDay).toHaveBeenCalledWith('2026-10-28');
    expect(mocks.fetchLongTasks).toHaveBeenCalledTimes(1);
    expect(state.plan.value).toEqual(PLAN);
    expect(state.coverage.value).toEqual(COVERAGE);
    expect(state.longTasks.value).toEqual([LONG_TASK]);
    expect(state.warnings.value).toEqual(['debt 未收口']);
    expect(state.loading.value).toBe(false);
    expect(state.error.value).toBeNull();
  });

  it('空计划 (plan:null) 正常落为 null 状态', async () => {
    mocks.fetchPlanDay.mockResolvedValue({
      date: '2026-10-29',
      plan: null,
      coverage: null,
      long_tasks_due: [],
      warnings: [],
      generated_at: 1761640001,
    });
    mocks.fetchLongTasks.mockResolvedValue({ tasks: [], generated_at: 1761640001 });
    const state = usePlan('2026-10-29');

    await state.refresh();

    expect(state.plan.value).toBeNull();
    expect(state.coverage.value).toBeNull();
    expect(state.longTasks.value).toEqual([]);
    expect(state.warnings.value).toEqual([]);
    expect(state.error.value).toBeNull();
  });

  it('加载期间 loading 为 true, 完成后复位', async () => {
    let resolveDay: (value: PlanDayResponse) => void = () => {};
    mocks.fetchPlanDay.mockReturnValue(
      new Promise<PlanDayResponse>((resolve) => {
        resolveDay = resolve;
      }),
    );
    mocks.fetchLongTasks.mockResolvedValue(TASKS);
    const state = usePlan('2026-10-28');

    const pending = state.refresh();
    expect(state.loading.value).toBe(true);

    resolveDay(DAY);
    await pending;

    expect(state.loading.value).toBe(false);
  });

  it('请求失败设置 error, 且两个接口都不产生部分写入', async () => {
    mocks.fetchPlanDay.mockRejectedValue(new Error('500'));
    mocks.fetchLongTasks.mockResolvedValue(TASKS);
    const state = usePlan('2026-10-28');

    await state.refresh();

    expect(state.error.value).toContain('500');
    expect(state.plan.value).toBeNull();
    expect(state.coverage.value).toBeNull();
    expect(state.longTasks.value).toEqual([]);
    expect(state.loading.value).toBe(false);
  });

  it('失败刷新保留上次成功数据', async () => {
    mockSuccess();
    const state = usePlan('2026-10-28');
    await state.refresh();

    mocks.fetchPlanDay.mockRejectedValue(new Error('boom'));
    mocks.fetchLongTasks.mockRejectedValue(new Error('boom'));
    await state.refresh();

    expect(state.error.value).toContain('boom');
    expect(state.plan.value).toEqual(PLAN);
    expect(state.coverage.value).toEqual(COVERAGE);
    expect(state.longTasks.value).toEqual([LONG_TASK]);
    expect(state.warnings.value).toEqual(['debt 未收口']);
  });

  it('setDate 拒绝非法日期且不发起请求', async () => {
    mockSuccess();
    const state = usePlan('2026-10-28');

    await expect(state.setDate('2026/10/29')).resolves.toBe(false);
    await expect(state.setDate('2026-02-30')).resolves.toBe(false);

    expect(state.date.value).toBe('2026-10-28');
    expect(mocks.fetchPlanDay).not.toHaveBeenCalled();
  });

  it('setDate 接受合法日期并按新日期刷新', async () => {
    mockSuccess();
    const state = usePlan('2026-10-28');

    await expect(state.setDate('2026-11-01')).resolves.toBe(true);

    expect(state.date.value).toBe('2026-11-01');
    expect(mocks.fetchPlanDay).toHaveBeenCalledWith('2026-11-01');
  });

  it('requestReplan 只发送一次控制文本到当前会话 (backend=loom)', async () => {
    mocks.fetchCurrentSessionId.mockResolvedValue('ses-current');
    mocks.listSessions.mockResolvedValue([
      { id: 'ses-current', title: '当前会话' },
    ]);
    mocks.sendMessage.mockResolvedValue({ status: 'ok' });
    const state = usePlan('2026-10-28');

    await expect(state.requestReplan()).resolves.toBe(true);

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      session_id: 'ses-current',
      content: '【计划重排】请根据今天的计划重新安排。',
      backend: 'loom',
    });
    expect(state.error.value).toBeNull();
  });

  it('requestReplan 在 current_session 缺失时回退到列表首个会话', async () => {
    mocks.fetchCurrentSessionId.mockResolvedValue(null);
    mocks.listSessions.mockResolvedValue([
      { id: 'ses-first', title: '首个会话' },
      { id: 'ses-second', title: '第二个会话' },
    ]);
    mocks.sendMessage.mockResolvedValue({ status: 'ok' });
    const state = usePlan('2026-10-28');

    await state.requestReplan();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'ses-first', backend: 'loom' }),
    );
  });

  it('没有可用会话时不发送消息并设置 error', async () => {
    mocks.fetchCurrentSessionId.mockResolvedValue(null);
    mocks.listSessions.mockResolvedValue([]);
    const state = usePlan('2026-10-28');

    await expect(state.requestReplan()).resolves.toBe(false);

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(state.error.value).toContain('没有可用的会话');
  });

  it('发送失败时返回 false 且只调用一次', async () => {
    mocks.fetchCurrentSessionId.mockResolvedValue('ses-current');
    mocks.listSessions.mockResolvedValue([
      { id: 'ses-current', title: '当前会话' },
    ]);
    mocks.sendMessage.mockResolvedValue(null);
    const state = usePlan('2026-10-28');

    await expect(state.requestReplan()).resolves.toBe(false);

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(state.error.value).toContain('发送失败');
  });
});

describe('isValidPlanDate', () => {
  it('接受合法日期并拒绝非法形状/日历日', () => {
    expect(isValidPlanDate('2026-10-28')).toBe(true);
    expect(isValidPlanDate('2024-02-29')).toBe(true);
    expect(isValidPlanDate('2026-02-29')).toBe(false);
    expect(isValidPlanDate('2026-13-01')).toBe(false);
    expect(isValidPlanDate('2026-1-01')).toBe(false);
    expect(isValidPlanDate('2026/10/28')).toBe(false);
  });
});

const EFFECTIVE: EffectivePlanResponse = {
  date: '2026-10-28',
  master_version: 3,
  master: {
    timezone: 'Asia/Shanghai',
    entries: [],
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
        id: 'c1',
        kind: 'fixed',
        title: '晨间',
        intent: '材料提交',
        at: '08:00',
        at_override: true,
        status: 'planned',
        source: 'master',
        suppressed: false,
        master_version: 3,
        overlay_version: 2,
      },
      {
        id: 'gone',
        kind: 'note',
        intent: '取消的事项',
        status: 'skipped',
        at_override: false,
        source: 'master',
        suppressed: true,
        master_version: 3,
        overlay_version: 2,
      },
    ],
    coverage: COVERAGE,
  },
  long_tasks_due: [LONG_TASK],
  warnings: ['base 正常'],
  generated_at: 1761640000,
};

describe('usePlan effective 优先', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchLongTasks.mockResolvedValue(TASKS);
  });

  it('effective 可用时使用合并视图且不回退 v1', async () => {
    mocks.fetchEffectivePlan.mockResolvedValue(EFFECTIVE);
    const state = usePlan('2026-10-28');

    await state.refresh();

    expect(mocks.fetchEffectivePlan).toHaveBeenCalledWith('2026-10-28');
    expect(mocks.fetchPlanDay).not.toHaveBeenCalled();
    expect(state.effectivePlan.value).toEqual(EFFECTIVE);
    expect(state.plan.value?.status).toBe('committed');
    expect(state.plan.value?.version).toBe(2);
    expect(state.plan.value?.notes).toEqual(['今天别催']);
    expect(state.plan.value?.items.map((item) => item.id)).toEqual(['c1']);
    expect(state.plan.value?.items[0]?.kind).toBe('care');
    expect(state.plan.value?.items[0]?.intent).toBe('材料提交');
    expect(state.coverage.value).toEqual(COVERAGE);
    expect(state.warnings.value).toEqual(['base 正常']);
    expect(state.error.value).toBeNull();
  });

  it('端点缺失 (null) 回退 v1 且保持旧状态形状', async () => {
    mocks.fetchEffectivePlan.mockResolvedValue(null);
    mocks.fetchPlanDay.mockResolvedValue(DAY);
    const state = usePlan('2026-10-28');

    await state.refresh();

    expect(mocks.fetchPlanDay).toHaveBeenCalledWith('2026-10-28');
    expect(state.plan.value).toEqual(PLAN);
    expect(state.coverage.value).toEqual(COVERAGE);
    expect(state.effectivePlan.value).toBeNull();
  });

  it('effective 真实失败不静默回退, 设置 error', async () => {
    mocks.fetchEffectivePlan.mockRejectedValue(new Error('母版文件损坏'));
    mocks.fetchPlanDay.mockResolvedValue(DAY);
    const state = usePlan('2026-10-28');

    await state.refresh();

    expect(mocks.fetchPlanDay).not.toHaveBeenCalled();
    expect(state.error.value).toContain('母版文件损坏');
  });
});
