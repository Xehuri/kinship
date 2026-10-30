/**
 * Flow 输入边界的解析/校验原语（内部模块，不进公共 barrel）。
 * 所有不可信字段在这里一次性变成类型化值或抛 FlowValidationError。
 */

import { FLOW_LIMITS, type FlowLimits } from "./limits.js";
import { FlowLimitError, FlowValidationError } from "./store.js";
import {
  isValidTimeZone,
  resolveDeadlineTime,
  resolveNextDecisionAt,
} from "./time.js";
import {
  isFlowFocus,
  isFlowState,
  isFlowSubjectKind,
  type FlowCommitInput,
  type FlowFocus,
  type FlowSchedule,
  type FlowState,
  type FlowSubjectKind,
  type FlowTimeInput,
} from "./types.js";

const SUBJECT_ID_RE = /^flow_[0-9a-f]{12}$/;

export function requireSessionId(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FlowValidationError("session_id", "必须是非空字符串");
  }
  return value;
}

export function requireNow(value: number): number {
  if (!Number.isFinite(value)) {
    throw new FlowValidationError("now", "必须是有限毫秒");
  }
  return value;
}

export function requireTurnIdx(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new FlowValidationError("turn_idx", "必须是 >=0 的整数");
  }
  return value;
}

export function requireVersion(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new FlowValidationError(field, "必须是 >=1 的整数");
  }
  return value;
}

export function requireState(value: unknown): FlowState {
  if (!isFlowState(value)) {
    throw new FlowValidationError("state", `非法状态: ${String(value)}`);
  }
  return value;
}

export function requireFocus(value: unknown): FlowFocus {
  if (!isFlowFocus(value)) {
    throw new FlowValidationError("focus", `非法 focus: ${String(value)}`);
  }
  return value;
}

export function requireKind(value: unknown): FlowSubjectKind {
  if (!isFlowSubjectKind(value)) {
    throw new FlowValidationError("kind", `非法 kind: ${String(value)}`);
  }
  return value;
}

export function requireSubjectId(value: string): string {
  if (typeof value !== "string" || !SUBJECT_ID_RE.test(value)) {
    throw new FlowValidationError("subject_id", `非法 subject_id: ${String(value)}`);
  }
  return value;
}

export function requireSubjectName(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FlowValidationError("subject_name", "必须是非空字符串");
  }
  return value;
}

export function requireText(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new FlowValidationError(field, "必须是字符串");
  }
  return value;
}

/** 工作区相对路径：拒绝绝对路径（POSIX/Windows/UNC/~）与任何 ".." 段。 */
export function requireWorkspaceRef(value: string): string {
  if (typeof value !== "string") {
    throw new FlowValidationError("notes_ref", "必须是字符串");
  }
  const ref = value.trim();
  if (ref === "") {
    throw new FlowValidationError("notes_ref", "不能为空；清空请传 null");
  }
  if (
    ref.startsWith("/") ||
    ref.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(ref) ||
    /^~(?:\/|\\|$)/.test(ref)
  ) {
    throw new FlowValidationError("notes_ref", "必须是工作区相对路径，拒绝绝对路径");
  }
  if (ref.split(/[\\/]+/).includes("..")) {
    throw new FlowValidationError("notes_ref", "拒绝 .. 路径穿越");
  }
  return ref;
}

/** notes_append 追加 + 逐条/累计双重限额；返回新数组（不改入参）。 */
export function appendNotes(
  existing: readonly string[],
  raw: readonly string[],
  limits: FlowLimits = FLOW_LIMITS,
): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new FlowValidationError("notes_append", "必须是字符串数组");
  }
  const next = [...existing];
  let bytes = existing.reduce((sum, note) => sum + Buffer.byteLength(note, "utf8"), 0);
  for (const note of raw) {
    if (typeof note !== "string") {
      throw new FlowValidationError("notes_append", "必须是字符串数组");
    }
    if (note.trim() === "") {
      throw new FlowValidationError("notes_append", "不允许空白 note");
    }
    const chars = Array.from(note).length;
    if (chars > limits.maxNoteChars) {
      throw new FlowLimitError("maxNoteChars", limits.maxNoteChars, chars);
    }
    bytes += Buffer.byteLength(note, "utf8");
    if (bytes > limits.maxNotesBytes) {
      throw new FlowLimitError("maxNotesBytes", limits.maxNotesBytes, bytes);
    }
    next.push(note);
  }
  return next;
}

export function resolveTimeField(
  field: "next_decision_at" | "soft_deadline" | "due_at",
  value: FlowTimeInput | undefined,
  now: number,
): number | null {
  const resolved =
    field === "next_decision_at"
      ? resolveNextDecisionAt(value, now)
      : resolveDeadlineTime(value, now);
  if (!resolved.ok) throw new FlowValidationError(field, resolved.reason);
  return resolved.at;
}

export function resolveTimezone(value: string | null): string | null {
  if (value === null) return null;
  if (!isValidTimeZone(value)) {
    throw new FlowValidationError("timezone", `非法时区: ${String(value)}`);
  }
  return value;
}

export function resolveSchedule(value: FlowSchedule | null): FlowSchedule | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new FlowValidationError("schedule", "必须是非空字符串或 null");
  }
  return value;
}

export function resolveParentId(value: string | null, selfId: string | null): string | null {
  if (value === null) return null;
  const parentId = requireSubjectId(value);
  if (selfId !== null && parentId === selfId) {
    throw new FlowValidationError("parent_id", "不能指向自身");
  }
  return parentId;
}

export function resolveCloseReason(input: FlowCommitInput, closing: boolean): string | null {
  if (!closing) {
    if (input.close_reason !== undefined && input.close_reason !== null) {
      throw new FlowValidationError("close_reason", "只有 state=closed 的提交才能携带 close_reason");
    }
    return null;
  }
  if (input.close_reason === undefined || input.close_reason === null) return null;
  return requireText(input.close_reason, "close_reason");
}
