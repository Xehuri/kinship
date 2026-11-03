/**
 * 线程（thread）归组与展示的唯一定义。
 *
 * 纪律：
 *   - 线程身份是二元组 `(source, thread_id)`；`threadKey` 用 `/` 连接，
 *     source 键正则不允许 `/`，因此不会产生跨来源碰撞。
 *   - 缺省值只在读取时解析，绝不回写账本记录：
 *       thread_id   = `${source}:${principal}`
 *       thread_name = principal
 *       thread_kind = contact
 *   - list/read/envelope 共用本文件，避免三处各自定义 fallback 漂移。
 */

import { UNREAD_LETTER_STATES, type LetterRecord } from "./types.js";

export const DEFAULT_THREAD_KIND = "contact";

/** 信封标签里的线程名上限（码点）；只影响展示，不改信件记录。 */
export const THREAD_LABEL_NAME_MAX_CHARS = 80;

/** 归组/展示只需要这几项；LetterRecord 与 LetterInput 都满足。 */
export interface ThreadIdentity {
  readonly source: string;
  readonly principal: string;
  readonly thread_id?: string;
  readonly thread_name?: string;
  readonly thread_kind?: string;
}

/** 解析后的线程 id（显式值优先，缺席时回退 source:principal）。 */
export function threadIdOf(letter: ThreadIdentity): string {
  return letter.thread_id ?? `${letter.source}:${letter.principal}`;
}

/** 解析后的线程展示名（显式值优先，缺席时回退 principal）。 */
export function threadDisplayName(letter: ThreadIdentity): string {
  return letter.thread_name ?? letter.principal;
}

/** 解析后的线程类别（显式值优先，缺席时回退 contact）。 */
export function threadKind(letter: ThreadIdentity): string {
  return letter.thread_kind ?? DEFAULT_THREAD_KIND;
}

/** 线程聚合键：source 不含 `/`，故 `source/thread_id` 可无歧义解析。 */
export function threadKey(letter: ThreadIdentity): string {
  return `${letter.source}/${threadIdOf(letter)}`;
}

/** 邮箱概览中的一行线程。 */
export interface ThreadView {
  readonly source: string;
  readonly thread_id: string;
  readonly thread_name: string;
  readonly thread_kind: string;
  readonly unread: number;
  readonly latest_at: number;
  readonly oldest_unread_at: number;
}

/** 旧→新：created_at 升序，同刻按 id 保证确定性。 */
export function compareLettersOldestFirst(left: LetterRecord, right: LetterRecord): number {
  if (left.created_at !== right.created_at) return left.created_at - right.created_at;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * 把信件按 `(source, thread_id)` 聚成未读线程并排序：
 * 只纳入未读状态；latest_at 倒序，再按 source、thread_id 升序。
 * 名称/类别取最新一封带该字段的信，整组都缺时回退 principal/contact。
 */
export function summarizeThreads(
  records: readonly LetterRecord[],
  kindFilter: string | undefined,
): ThreadView[] {
  const groups = new Map<
    string,
    { readonly source: string; readonly threadId: string; records: LetterRecord[] }
  >();
  for (const record of records) {
    if (!UNREAD_LETTER_STATES.has(record.state)) continue;
    const key = threadKey(record);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        source: record.source,
        threadId: threadIdOf(record),
        records: [record],
      });
    } else {
      group.records.push(record);
    }
  }

  const views: ThreadView[] = [];
  for (const group of groups.values()) {
    const newest = [...group.records].sort(compareLettersOldestFirst).reverse();
    const newestRecord = newest[0];
    if (newestRecord === undefined) continue;
    const named = newest.find((record) => record.thread_name !== undefined) ?? newestRecord;
    const kinded = newest.find((record) => record.thread_kind !== undefined) ?? newestRecord;
    const oldestRecord = newest[newest.length - 1] ?? newestRecord;
    const view: ThreadView = {
      source: group.source,
      thread_id: group.threadId,
      thread_name: threadDisplayName(named),
      thread_kind: threadKind(kinded),
      unread: group.records.length,
      latest_at: newestRecord.created_at,
      oldest_unread_at: oldestRecord.created_at,
    };
    if (kindFilter !== undefined && view.thread_kind !== kindFilter) continue;
    views.push(view);
  }
  return views.sort((left, right) => {
    if (left.latest_at !== right.latest_at) return right.latest_at - left.latest_at;
    if (left.source !== right.source) return left.source < right.source ? -1 : 1;
    if (left.thread_id === right.thread_id) return 0;
    return left.thread_id < right.thread_id ? -1 : 1;
  });
}
