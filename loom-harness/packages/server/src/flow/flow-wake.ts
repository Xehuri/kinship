/**
 * L6 flow 唤醒渲染：把 FlowStore 的待决策主体渲染成一条紧凑唤醒行。
 *
 * 同步 render 是 WakeScheduler 的消费契约：真源读取在 refresh 完成——boot reconcile 与
 * 每次主 run 收尾调用 refresh，把该 session 的主体快照缓存下来；到点投递时按 at 判 due，
 * 没有仍到期的主体返回 null（stale，调度器跳过投递并删除 sidecar）。
 * 多主体：列出全部 due 主体，并给出所有 pending 主体里的最早下次决策时刻。
 */

import {
  formatFlowTime,
  type FlowStore,
  type FlowSubject,
} from "@axeuh/loom-core";

export interface FlowWakeRendererOptions {
  readonly store: FlowStore;
}

export interface FlowWakeRenderer {
  /** 重读 session 的全部主体并更新缓存；store 读失败原样抛出（降级归调用方）。 */
  refresh(sessionID: string): Promise<readonly FlowSubject[]>;
  /** 同步渲染 at 时刻仍 due 的主体行；没有 due 主体 = null。 */
  render(sessionID: string, at: number): string | null;
  /** 丢弃该 session 的缓存（flow 关闭/无 pending 时由调用方清理）。 */
  clear(sessionID: string): void;
}

export interface PendingFlowSubject {
  readonly subject: FlowSubject;
  readonly at: number;
}

/** state=closed 或 next_decision_at=null 的主体不参与唤醒（与 FlowStore.earliestPending 同口径）。 */
export function pendingSubjects(subjects: readonly FlowSubject[]): PendingFlowSubject[] {
  const rows: PendingFlowSubject[] = [];
  for (const subject of subjects) {
    if (subject.state === "closed") continue;
    const at = subject.next_decision_at;
    if (at === null) continue;
    rows.push({ subject, at });
  }
  return rows;
}

/** 紧凑唤醒行：只有 at 时刻仍 due 的主体才出现；无 = null。 */
export function formatFlowWakeLine(
  subjects: readonly FlowSubject[],
  at: number,
): string | null {
  const pending = pendingSubjects(subjects);
  const due = pending.filter((row) => row.at <= at);
  if (due.length === 0) return null;
  let earliest = due[0]?.at ?? at;
  for (const row of pending) {
    if (row.at < earliest) earliest = row.at;
  }
  const list = due
    .map((row) => `「${row.subject.subject_name}」${row.subject.state}（${row.subject.subject_id}）`)
    .join("、");
  return `【心流唤醒】到点主体：${list}。最早下次决策：${formatFlowTime(earliest)}。请处理当前心流。`;
}

class CachedFlowWakeRenderer implements FlowWakeRenderer {
  readonly #store: FlowStore;
  readonly #cache = new Map<string, readonly FlowSubject[]>();

  constructor(store: FlowStore) {
    this.#store = store;
  }

  async refresh(sessionID: string): Promise<readonly FlowSubject[]> {
    const subjects = await this.#store.list(sessionID);
    this.#cache.set(sessionID, subjects);
    return subjects;
  }

  render(sessionID: string, at: number): string | null {
    const subjects = this.#cache.get(sessionID);
    if (subjects === undefined) return null;
    return formatFlowWakeLine(subjects, at);
  }

  clear(sessionID: string): void {
    this.#cache.delete(sessionID);
  }
}

export function createFlowWakeRenderer(
  opts: FlowWakeRendererOptions,
): FlowWakeRenderer {
  return new CachedFlowWakeRenderer(opts.store);
}
