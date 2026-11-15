/**
 * Generic default master schedule used by the panel's `seed` route.
 *
 * The seed is deliberately impersonal: fixed daily review/build slots, one
 * weekly review, and seven 4h coverage checkpoints. Every entry carries a
 * short, Loom-agnostic `instruction` so a wake on a fresh install is still
 * actionable; the coverage anchors rely on the renderer's generated
 * window/target-day instruction instead.
 *
 * @module kinship-plan-scheduler/defaults
 */

import { MASTER_SCHEMA, validateMasterPlanDocument } from './plan/master-plan.js'
import type { MasterEntry, MasterPlanDocument } from './plan/master-plan.js'

/** Inputs for one seeded master document. */
export interface CreateDefaultMasterOptions {
  /** IANA timezone written into the document. */
  readonly timezone: string
  /** Epoch milliseconds used for `created_at`/`updated_at` and every entry. */
  readonly now: number
}

/** Coverage checkpoint hours (local); each covers the preceding four hours. */
const COVERAGE_HOURS = ['00', '06', '08', '12', '16', '20', '22'] as const

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function fixedEntry(
  id: string,
  title: string,
  at: string,
  action: string,
  now: number,
  instruction: string,
): MasterEntry {
  return {
    id,
    kind: 'fixed',
    title,
    enabled: true,
    action,
    instruction,
    schedule: { kind: 'daily', at },
    created_at: now,
    updated_at: now,
  }
}

function weeklyEntry(
  id: string,
  title: string,
  days: readonly string[],
  at: string,
  action: string,
  now: number,
  instruction: string,
): MasterEntry {
  return {
    id,
    kind: 'fixed',
    title,
    enabled: true,
    action,
    instruction,
    schedule: { kind: 'weekly', days, at },
    created_at: now,
    updated_at: now,
  }
}

/** One anchor entry; `window` is the four-hour span ending at `at`. */
function coverageEntry(hour: string, now: number): MasterEntry {
  const end = Number(hour)
  const start = (end + 20) % 24
  return {
    id: `cov-${hour}`,
    kind: 'anchor',
    title: `覆盖检查点 cov-${hour}`,
    enabled: true,
    action: 'coverage.run',
    schedule: { kind: 'daily', at: `${hour}:00` },
    target_date: 'today',
    window: `${pad2(start)}:00~${pad2(end)}:00`,
    created_at: now,
    updated_at: now,
  }
}

/**
 * Build the generic seeded master document.
 *
 * @param options - timezone and fixed clock.
 * @returns a schema-1 master document that already passed validation.
 * @throws {MasterPlanValidationError} when the timezone is not a valid IANA zone.
 */
export function createDefaultMaster(options: CreateDefaultMasterOptions): MasterPlanDocument {
  const now = options.now
  if (!Number.isInteger(now) || now < 0) {
    throw new Error(`createDefaultMaster: now must be a non-negative integer: ${String(now)}`)
  }
  const document: MasterPlanDocument = {
    schema: MASTER_SCHEMA,
    kind: 'master-plan',
    timezone: options.timezone,
    version: 1,
    created_at: now,
    updated_at: now,
    entries: [
      fixedEntry(
        'daily-review',
        '今日复盘',
        '00:40',
        'review.daily',
        now,
        '按日复盘流程执行昨日复盘；复盘目标日期是昨天。',
      ),
      fixedEntry(
        'compactor',
        '会话压缩',
        '04:00',
        'session.compact',
        now,
        '压缩当前会话上下文，保留结论与未决项。',
      ),
      fixedEntry(
        'plan-build',
        '日计划',
        '05:00',
        'plan.build',
        now,
        '按 Plan mode 执行：先收口昨日计划（plan read/close），再读今日数据，最后写今日计划（plan commit）；只落计划文件，不在聊天里播报计划表。',
      ),
      fixedEntry(
        'plan-review',
        '计划复核',
        '07:30',
        'plan.review',
        now,
        '复核今日计划与数据覆盖；只读为主，必要时用 plan revise 调整；不播报计划表。',
      ),
      fixedEntry(
        'weather',
        '每日天气',
        '07:00',
        'weather.morning',
        now,
        '查询今日天气；确有变化时用一句话告知用户。',
      ),
      weeklyEntry(
        'weekly-review',
        '周报总结',
        ['mon'],
        '03:00',
        'review.weekly',
        now,
        '按周报流程执行本周复盘。',
      ),
      ...COVERAGE_HOURS.map(hour => coverageEntry(hour, now)),
    ],
  }
  return validateMasterPlanDocument(document)
}
