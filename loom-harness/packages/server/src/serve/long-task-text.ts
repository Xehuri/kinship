/**
 * long_task 的模型可读投影：把结构化记录压成紧凑纯文本。
 *
 * details.__long_task / __long_tasks 仍保留完整对象（消费方按结构取数）；
 * 本文件只负责 content[].text，省掉每条记录重新读整段 JSON 的 token。
 */

import type { LongTask, LongTaskReadResult } from "../plan/long-task-store.js";
import { clipText, plainBlock, plainInline } from "./text-utils.js";

/** 写动作（read/list 不走这里）。 */
export type LongTaskRecordAction = "create" | "update" | "pause" | "resume" | "archive";

export interface LongTaskListInfo {
  readonly due: string;
  /** null = 未显式给日期，store 按自己的时钟取今天。 */
  readonly date: string | null;
}

const TITLE_LIMIT = 120;
const LIST_TITLE_LIMIT = 80;
const INTENT_LIMIT = 300;
const NOTE_LIMIT = 10;

/** create/update/pause/resume/archive：一行摘要 + 意图 + 备注列表。 */
export function renderLongTaskRecord(action: LongTaskRecordAction, task: LongTask): string {
  const head = [
    `long_task ${action} ok`,
    `id=${task.id}`,
    `title=${clipText(plainInline(task.title), TITLE_LIMIT)}`,
    `v${String(task.version)}`,
    `status=${task.status}`,
    `cadence=${task.cadence}`,
    `next_check=${task.next_check}`,
    `review=${task.review_policy}`,
    ...(task.last_done === null ? [] : [`last_done=${task.last_done}`]),
  ].join(" ");

  const lines = [head, `intent: ${clipText(plainInline(task.intent), INTENT_LIMIT)}`];
  if (task.notes.length > 0) {
    lines.push(`notes ${String(task.notes.length)}:`);
    for (const note of task.notes.slice(0, NOTE_LIMIT)) {
      lines.push(`- ${plainInline(note)}`);
    }
    const hidden = task.notes.length - NOTE_LIMIT;
    if (hidden > 0) lines.push(`- …(+${String(hidden)})`);
  }
  return lines.join("\n");
}

/** list：一行头 + 每任务一行；空结果在头部标注，不产生条目。 */
export function renderLongTaskList(
  tasks: readonly LongTask[],
  info: LongTaskListInfo,
): string {
  const suffix = tasks.length === 0 ? " (no tasks)" : "";
  const head =
    `long_task list due=${info.due} date=${info.date ?? "store-today"}` +
    ` count=${String(tasks.length)}${suffix}`;
  if (tasks.length === 0) return head;
  const bullets = tasks.map(
    (task) =>
      `- ${task.id} ${clipText(plainInline(task.title), LIST_TITLE_LIMIT)}` +
      ` v${String(task.version)} status=${task.status} cadence=${task.cadence}` +
      ` next_check=${task.next_check}`,
  );
  return [head, ...bullets].join("\n");
}

/** read：Markdown 本身就是人读记录，原样返回（只做首尾空白收口）。 */
export function renderLongTaskRead(read: LongTaskReadResult): string {
  return plainBlock(read.markdown);
}
