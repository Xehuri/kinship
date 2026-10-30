/**
 * flow_list / flow_get 参数边界（内部模块）：不可信 args → 类型化只读查询参数。
 *
 * TypeBox 只挡外层形状；这里再挡直接调用（单测 / 内部复用）时的类型漂移，
 * 任何不合法形状一律抛 FlowValidationError，由只读工具转成 isError 工具结果。
 */

import { FlowValidationError } from "./store.js";
import {
  isFlowFocus,
  isFlowState,
  isFlowSubjectKind,
  type FlowFocus,
  type FlowState,
  type FlowSubjectKind,
} from "./types.js";
import { requireSubjectId, requireSubjectName } from "./validation.js";

export const FLOW_LIST_DEFAULT_LIMIT = 20;
export const FLOW_LIST_MAX_LIMIT = 32;
export const FLOW_NOTES_DEFAULT_LIMIT = 5;
export const FLOW_NOTES_MAX_LIMIT = 10;

export interface FlowListArgs {
  readonly states: readonly FlowState[] | undefined;
  readonly focuses: readonly FlowFocus[] | undefined;
  readonly kind: FlowSubjectKind | undefined;
  readonly includeClosed: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface FlowGetArgs {
  readonly subjectId: string | undefined;
  readonly subjectName: string | undefined;
  readonly includeNotes: boolean;
  readonly notesLimit: number;
  readonly notesOffset: number;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new FlowValidationError(key, "必须是布尔值");
  }
  return value;
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

function boundedInteger(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = optionalInteger(args, key) ?? fallback;
  if (value < min) {
    throw new FlowValidationError(key, `必须 >= ${min}`);
  }
  return Math.min(value, max);
}

function nonNegativeInteger(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = optionalInteger(args, key) ?? fallback;
  if (value < 0) {
    throw new FlowValidationError(key, "必须 >= 0");
  }
  return value;
}

function enumArray<T extends string>(
  args: Record<string, unknown>,
  key: string,
  isValid: (value: unknown) => value is T,
  label: string,
): readonly T[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new FlowValidationError(key, `必须是${label}数组`);
  }
  const out: T[] = [];
  for (const item of value) {
    if (!isValid(item)) {
      throw new FlowValidationError(key, `包含非法${label}: ${String(item)}`);
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function optionalKind(args: Record<string, unknown>): FlowSubjectKind | undefined {
  const value = args["kind"];
  if (value === undefined) return undefined;
  if (!isFlowSubjectKind(value)) {
    throw new FlowValidationError("kind", `非法 kind: ${String(value)}`);
  }
  return value;
}

/** 不可信 args → 类型化列表查询；空枚举数组视为不过滤。 */
export function parseListArgs(args: Record<string, unknown>): FlowListArgs {
  return {
    states: enumArray(args, "state", isFlowState, "状态"),
    focuses: enumArray(args, "focus", isFlowFocus, "焦点"),
    kind: optionalKind(args),
    includeClosed: optionalBoolean(args, "include_closed", false),
    limit: boundedInteger(
      args,
      "limit",
      FLOW_LIST_DEFAULT_LIMIT,
      1,
      FLOW_LIST_MAX_LIMIT,
    ),
    offset: nonNegativeInteger(args, "offset", 0),
  };
}

function optionalSubjectId(
  args: Record<string, unknown>,
): string | undefined {
  const value = args["subject_id"];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new FlowValidationError("subject_id", "必须是字符串");
  }
  return requireSubjectId(value);
}

function optionalSubjectName(
  args: Record<string, unknown>,
): string | undefined {
  const value = args["subject_name"];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new FlowValidationError("subject_name", "必须是字符串");
  }
  return requireSubjectName(value);
}

/** 不可信 args → 类型化单主体查询；subject_id 与 subject_name 可同时给出（id 优先）。 */
export function parseGetArgs(args: Record<string, unknown>): FlowGetArgs {
  return {
    subjectId: optionalSubjectId(args),
    subjectName: optionalSubjectName(args),
    includeNotes: optionalBoolean(args, "include_notes", true),
    notesLimit: boundedInteger(
      args,
      "notes_limit",
      FLOW_NOTES_DEFAULT_LIMIT,
      1,
      FLOW_NOTES_MAX_LIMIT,
    ),
    notesOffset: nonNegativeInteger(args, "notes_offset", 0),
  };
}
