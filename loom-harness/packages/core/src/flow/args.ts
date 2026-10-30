/**
 * flow_commit 参数边界（内部模块）：不可信 args → 类型化 FlowCommitInput。
 *
 * TypeBox 已挡外层形状；这里再挡直接调用（单测 / 内部复用）时的类型漂移：
 * 任何不合法形状一律抛 FlowValidationError，由工具转成 isError 工具结果。
 */

import { FlowValidationError } from "./store.js";
import {
  isFlowFocus,
  isFlowState,
  isFlowSubjectKind,
  type FlowCommitInput,
  type FlowFocus,
  type FlowSubjectKind,
  type FlowTimeInput,
} from "./types.js";

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new FlowValidationError(key, "必须是字符串");
  }
  return value;
}

function optionalNullableString(
  args: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw new FlowValidationError(key, "必须是字符串或 null");
}

function optionalTime(
  args: Record<string, unknown>,
  key: string,
): FlowTimeInput | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new FlowValidationError(key, "必须是字符串、有限数字或 null");
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new FlowValidationError(key, "必须是整数");
  }
  return value;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!isStringArray(value)) {
    throw new FlowValidationError(key, "必须是字符串数组");
  }
  return [...value];
}

function optionalKind(
  args: Record<string, unknown>,
): FlowSubjectKind | undefined {
  const value = args["kind"];
  if (value === undefined) return undefined;
  if (!isFlowSubjectKind(value)) {
    throw new FlowValidationError("kind", `非法 kind: ${String(value)}`);
  }
  return value;
}

function optionalFocus(
  args: Record<string, unknown>,
): FlowFocus | undefined {
  const value = args["focus"];
  if (value === undefined) return undefined;
  if (!isFlowFocus(value)) {
    throw new FlowValidationError("focus", `非法 focus: ${String(value)}`);
  }
  return value;
}

/** 不可信 args → 类型化提交输入；任何形状漂移都抛 FlowValidationError。 */
export function parseCommitArgs(
  args: Record<string, unknown>,
): FlowCommitInput {
  const stateRaw = args["state"];
  if (!isFlowState(stateRaw)) {
    throw new FlowValidationError("state", `非法状态: ${String(stateRaw)}`);
  }
  const subjectId = optionalString(args, "subject_id");
  const subjectName = optionalString(args, "subject_name");
  const kind = optionalKind(args);
  const title = optionalString(args, "title");
  const description = optionalString(args, "description");
  const notesAppend = optionalStringArray(args, "notes_append");
  const notesRef = optionalNullableString(args, "notes_ref");
  const focus = optionalFocus(args);
  const expectedVersion = optionalInteger(args, "expected_version");
  const nextDecisionAt = optionalTime(args, "next_decision_at");
  const softDeadline = optionalTime(args, "soft_deadline");
  const dueAt = optionalTime(args, "due_at");
  const timezone = optionalNullableString(args, "timezone");
  const schedule = optionalNullableString(args, "schedule");
  const parentId = optionalNullableString(args, "parent_id");
  const closeReason = optionalNullableString(args, "close_reason");

  return {
    state: stateRaw,
    ...(subjectId === undefined ? {} : { subject_id: subjectId }),
    ...(subjectName === undefined ? {} : { subject_name: subjectName }),
    ...(kind === undefined ? {} : { kind }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(notesAppend === undefined ? {} : { notes_append: notesAppend }),
    ...(notesRef === undefined ? {} : { notes_ref: notesRef }),
    ...(focus === undefined ? {} : { focus }),
    ...(expectedVersion === undefined
      ? {}
      : { expected_version: expectedVersion }),
    ...(nextDecisionAt === undefined
      ? {}
      : { next_decision_at: nextDecisionAt }),
    ...(softDeadline === undefined ? {} : { soft_deadline: softDeadline }),
    ...(dueAt === undefined ? {} : { due_at: dueAt }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(parentId === undefined ? {} : { parent_id: parentId }),
    ...(closeReason === undefined ? {} : { close_reason: closeReason }),
  };
}
