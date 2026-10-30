/**
 * flow_list / flow_get 的查询逻辑（内部模块）：过滤、排序、引用解析、笔记切片。
 * 纯计算 + store 只读调用，不负责渲染、信封裁剪或工具生命周期。
 */

import type { FlowGetArgs, FlowListArgs } from "./read-args.js";
import type { RenderedNote } from "./read-render.js";
import {
  FlowNotFoundError,
  FlowValidationError,
  type FlowStore,
} from "./store.js";
import {
  DEFAULT_FLOW_SUBJECT_NAME,
  type FlowFocus,
  type FlowState,
  type FlowSubject,
} from "./types.js";

const FOCUS_RANK: Readonly<Record<FlowFocus, number>> = {
  foreground: 0,
  background: 1,
  parked: 2,
};

export function countStates(rows: readonly FlowSubject[]): {
  active: number;
  waiting: number;
} {
  let active = 0;
  let waiting = 0;
  for (const row of rows) {
    switch (row.state) {
      case "active":
        active += 1;
        break;
      case "waiting_user":
      case "waiting_event":
        waiting += 1;
        break;
      case "closed":
        break;
      default: {
        const unreachable: never = row.state;
        throw new Error(`unhandled FlowState: ${String(unreachable)}`);
      }
    }
  }
  return { active, waiting };
}

export function filterSubjects(
  subjects: readonly FlowSubject[],
  args: FlowListArgs,
): readonly FlowSubject[] {
  const states =
    args.states === undefined || args.states.length === 0
      ? null
      : new Set<FlowState>(args.states);
  const focuses =
    args.focuses === undefined || args.focuses.length === 0
      ? null
      : new Set<FlowFocus>(args.focuses);
  return subjects.filter((subject) => {
    if (args.kind !== undefined && subject.kind !== args.kind) return false;
    if (focuses !== null && !focuses.has(subject.focus)) return false;
    if (states !== null) return states.has(subject.state);
    return args.includeClosed || subject.state !== "closed";
  });
}

export function compareSubjects(a: FlowSubject, b: FlowSubject): number {
  const byFocus = FOCUS_RANK[a.focus] - FOCUS_RANK[b.focus];
  if (byFocus !== 0) return byFocus;
  if (a.next_decision_at !== b.next_decision_at) {
    if (a.next_decision_at === null) return 1;
    if (b.next_decision_at === null) return -1;
    return a.next_decision_at - b.next_decision_at;
  }
  if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
  if (a.subject_id === b.subject_id) return 0;
  return a.subject_id < b.subject_id ? -1 : 1;
}

export function listSubjectDetails(
  subject: FlowSubject,
  latestNote: string | null,
): Record<string, unknown> {
  return {
    subject_id: subject.subject_id,
    subject_name: subject.subject_name,
    kind: subject.kind,
    title: subject.title,
    state: subject.state,
    focus: subject.focus,
    version: subject.version,
    next_decision_at: subject.next_decision_at,
    updated_at: subject.updated_at,
    last_commit_turn:
      subject.last_commit === null ? null : subject.last_commit.turn_idx,
    notes_count: subject.notes.length,
    latest_note: latestNote,
  };
}

export async function resolveSubject(
  store: FlowStore,
  sessionId: string,
  args: FlowGetArgs,
): Promise<FlowSubject> {
  if (args.subjectId !== undefined) {
    const subject = await store.get(args.subjectId);
    if (subject === null || subject.session_id !== sessionId) {
      // 跨会话与不存在同构：不泄漏对方主体是否存在。
      throw new FlowNotFoundError(args.subjectId);
    }
    if (
      args.subjectName !== undefined &&
      subject.subject_name !== args.subjectName
    ) {
      throw new FlowValidationError(
        "subject_name",
        "与 subject_id 指向的主体不一致",
      );
    }
    return subject;
  }
  const name = args.subjectName ?? DEFAULT_FLOW_SUBJECT_NAME;
  const subject = await store.findByName(sessionId, name);
  if (subject === null) throw new FlowNotFoundError(name);
  return subject;
}

export interface NoteSelection {
  readonly notes: readonly RenderedNote[];
  readonly truncated: boolean;
}

export function selectNotes(
  notes: readonly string[],
  args: FlowGetArgs,
): NoteSelection {
  if (!args.includeNotes || notes.length === 0) {
    return { notes: [], truncated: false };
  }
  const total = notes.length;
  const end = Math.max(0, total - args.notesOffset);
  const start = Math.max(0, end - args.notesLimit);
  const selected: RenderedNote[] = [];
  for (let index = start; index < end; index += 1) {
    const text = notes[index];
    if (text === undefined) continue;
    selected.push({ index: index + 1, text });
  }
  // 只标「更早的笔记被 limit 截掉」：offset 主动跳过更新的笔记属分页语义，
  // 不叫 truncated；输出信封裁剪由调用方另行置位。
  return { notes: selected, truncated: start > 0 };
}
