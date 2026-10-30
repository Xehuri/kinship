/**
 * FlowSubject 行构造（内部模块）：把已校验的提交输入投影成不可变台账行。
 * 本模块不做容量/CAS/closed 裁决——那些属于 store 协议，由 MemoryFlowStore 先行判定。
 */

import { FLOW_SUBJECT_SCHEMA } from "./types.js";
import type { FlowLimits } from "./limits.js";
import type {
  FlowCommitInput,
  FlowCommitStamp,
  FlowFocus,
  FlowState,
  FlowSubject,
  FlowSubjectKind,
} from "./types.js";
import {
  appendNotes,
  requireText,
  requireWorkspaceRef,
  resolveCloseReason,
  resolveParentId,
  resolveSchedule,
  resolveTimeField,
  resolveTimezone,
} from "./validation.js";

export interface SubjectPlanDraft {
  readonly sessionId: string;
  readonly subjectName: string;
  readonly input: FlowCommitInput;
  readonly state: FlowState;
  readonly focus: FlowFocus | undefined;
  readonly kind: FlowSubjectKind | undefined;
  readonly now: number;
  /** null = ensureDefault 直接创建（无 last_commit）。 */
  readonly turnIdx: number | null;
  /** 容量/notes 限额；缺省 = FLOW_LIMITS（appendNotes 兜底）。 */
  readonly limits?: FlowLimits;
}

export interface SubjectPlan extends SubjectPlanDraft {
  readonly subjectId: string;
}

export interface SubjectUpdateContext {
  readonly state: FlowState;
  readonly focus: FlowFocus | undefined;
  readonly kind: FlowSubjectKind | undefined;
  readonly now: number;
  readonly turnIdx: number;
  /** notes 限额；缺省 = FLOW_LIMITS（appendNotes 兜底）。 */
  readonly limits?: FlowLimits;
}

function freezeSubject(subject: FlowSubject): FlowSubject {
  return Object.freeze({
    ...subject,
    notes: Object.freeze([...subject.notes]),
    last_commit:
      subject.last_commit === null
        ? null
        : Object.freeze({
            turn_idx: subject.last_commit.turn_idx,
            at: subject.last_commit.at,
          }),
  });
}

function stamp(turnIdx: number, now: number): FlowCommitStamp {
  return Object.freeze({ turn_idx: turnIdx, at: now });
}

export function buildSubject(plan: SubjectPlan): FlowSubject {
  const { input, now, state } = plan;
  const closing = state === "closed";
  return freezeSubject({
    schema: FLOW_SUBJECT_SCHEMA,
    subject_id: plan.subjectId,
    subject_name: plan.subjectName,
    session_id: plan.sessionId,
    kind: plan.kind ?? "thread",
    title: input.title === undefined ? plan.subjectName : requireText(input.title, "title"),
    description:
      input.description === undefined ? "" : requireText(input.description, "description"),
    notes: input.notes_append === undefined ? [] : appendNotes([], input.notes_append, plan.limits),
    notes_ref:
      input.notes_ref === undefined || input.notes_ref === null
        ? null
        : requireWorkspaceRef(input.notes_ref),
    state,
    focus: plan.focus ?? "foreground",
    version: 1,
    created_at: now,
    updated_at: now,
    next_decision_at: closing
      ? null
      : resolveTimeField("next_decision_at", input.next_decision_at, now),
    soft_deadline: resolveTimeField("soft_deadline", input.soft_deadline, now),
    due_at: resolveTimeField("due_at", input.due_at, now),
    timezone: input.timezone === undefined ? null : resolveTimezone(input.timezone),
    schedule: input.schedule === undefined ? null : resolveSchedule(input.schedule),
    parent_id: input.parent_id === undefined ? null : resolveParentId(input.parent_id, null),
    closed_at: closing ? now : null,
    close_reason: resolveCloseReason(input, closing),
    last_commit: plan.turnIdx === null ? null : stamp(plan.turnIdx, now),
  });
}

export function buildUpdatedSubject(
  subject: FlowSubject,
  input: FlowCommitInput,
  context: SubjectUpdateContext,
): FlowSubject {
  const closing = context.state === "closed";
  const notes =
    input.notes_append === undefined
      ? subject.notes
      : appendNotes(subject.notes, input.notes_append, context.limits);
  return freezeSubject({
    ...subject,
    kind: context.kind ?? subject.kind,
    title: input.title === undefined ? subject.title : requireText(input.title, "title"),
    description:
      input.description === undefined
        ? subject.description
        : requireText(input.description, "description"),
    notes,
    notes_ref:
      input.notes_ref === undefined
        ? subject.notes_ref
        : input.notes_ref === null
          ? null
          : requireWorkspaceRef(input.notes_ref),
    state: context.state,
    focus: context.focus ?? subject.focus,
    version: subject.version + 1,
    updated_at: context.now,
    next_decision_at: closing
      ? null
      : input.next_decision_at === undefined
        ? subject.next_decision_at
        : resolveTimeField("next_decision_at", input.next_decision_at, context.now),
    soft_deadline:
      input.soft_deadline === undefined
        ? subject.soft_deadline
        : resolveTimeField("soft_deadline", input.soft_deadline, context.now),
    due_at:
      input.due_at === undefined
        ? subject.due_at
        : resolveTimeField("due_at", input.due_at, context.now),
    timezone:
      input.timezone === undefined ? subject.timezone : resolveTimezone(input.timezone),
    schedule:
      input.schedule === undefined ? subject.schedule : resolveSchedule(input.schedule),
    parent_id:
      input.parent_id === undefined
        ? subject.parent_id
        : resolveParentId(input.parent_id, subject.subject_id),
    closed_at: closing ? context.now : subject.closed_at,
    close_reason: resolveCloseReason(input, closing),
    last_commit: stamp(context.turnIdx, context.now),
  });
}
