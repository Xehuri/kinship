import type { LongTask, PlanCoverage, PlanDocument } from '@/types'

export const PLAN_DATE = '2026-10-28'

export const COVERAGE: PlanCoverage = {
  profile: 'merged_7',
  checkpoints: [
    'cov-00',
    'cov-06',
    'cov-08',
    'cov-12',
    'cov-16',
    'cov-20',
    'cov-22',
  ],
  debt: ['cov-16 未收口'],
}

export const PLAN: PlanDocument = {
  schema: 1,
  date: PLAN_DATE,
  status: 'committed',
  version: 2,
  created_at: 1793095200,
  updated_at: 1793138400,
  review_at: 1793143800,
  items: [
    {
      id: 'c1',
      kind: 'care',
      intent: '材料提交',
      status: 'planned',
      target_date: PLAN_DATE,
      window: '09:30~11:00',
      checkpoint_id: 'cov-08',
      done_when: '材料提交成功',
      not_do: '不主动提理发',
      source: 'data_check',
      note: '缺一张照片',
    },
    {
      id: 'c2',
      kind: 'coverage',
      intent: '分析昨天 22:00 到 00:00 的数据',
      status: 'done',
      window: '22:00~00:00',
      checkpoint_id: 'cov-00',
      done_when: 'check_coverage exit 0',
    },
  ],
  coverage: COVERAGE,
  notes: ['周五拍照要理发，先别催'],
}

export const DUE_TASK: LongTask = {
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
  created_at: 1792900000,
  updated_at: 1793100000,
  version: 3,
}

export const FUTURE_TASK: LongTask = {
  ...DUE_TASK,
  id: 'lt_future',
  title: '下个月复诊',
  next_check: '2026-11-15T10:00:00+08:00',
}

export const PAUSED_TASK: LongTask = {
  ...DUE_TASK,
  id: 'lt_paused',
  title: '暂停中的任务',
  status: 'paused',
}
