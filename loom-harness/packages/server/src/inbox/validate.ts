/**
 * 信件边界校验（parse, don't validate）。
 *
 * 调用方提交的是 unknown；本模块把它解析成 LetterInput 或抛出
 * LetterValidationError。正常路径不抛异常，非法输入只抛这一种类型化错误。
 *
 * 安全约束：
 *   - 服务端字段（id/created_at/state/attempts/...）一律拒绝，调用方不得自带；
 *   - 数值 score/weight/priority 一律拒绝——class 才是契约；
 *   - principal/kind/title 不允许控制字符；body 非空且有字节上限；
 *   - ref 必须可 JSON 序列化且 ≤2KB。
 */

import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_CAUSATION_DEPTH,
  DEFAULT_MAX_KEY_CHARS,
  DEFAULT_MAX_KIND_CHARS,
  DEFAULT_MAX_PRINCIPAL_CHARS,
  DEFAULT_MAX_REF_BYTES,
  DEFAULT_MAX_TITLE_CHARS,
} from "./defaults.js";
import { LETTER_CLASSES, LETTER_TRUSTS, type LetterClass, type LetterInput, type LetterTrust } from "./types.js";

export interface LetterFieldError {
  readonly field: string;
  readonly message: string;
}

export class LetterValidationError extends Error {
  readonly errors: readonly LetterFieldError[];

  constructor(errors: readonly LetterFieldError[]) {
    super(
      `letter 校验失败：\n- ${errors
        .map((e) => `${e.field}: ${e.message}`)
        .join("\n- ")}`,
    );
    this.name = "LetterValidationError";
    this.errors = errors;
  }
}

export interface LetterValidationOptions {
  readonly maxBodyBytes?: number;
  readonly maxTitleChars?: number;
  readonly maxRefBytes?: number;
  readonly maxKeyChars?: number;
  readonly maxPrincipalChars?: number;
  readonly maxKindChars?: number;
  readonly maxCausationDepth?: number;
}

const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set([
  "source",
  "kind",
  "class",
  "trust",
  "principal",
  "not_before",
  "expires_at",
  "title",
  "body",
  "ref",
  "correlation_id",
  "dedupe_key",
  "coalesce_key",
  "reply_to",
  "causation_depth",
]);

/** 服务端分配/管理字段：出现即拒绝（防止调用方伪造状态或时间）。 */
const SERVER_OWNED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "created_at",
  "state",
  "attempts",
  "delivered_at",
  "read_at",
  "acked_at",
  "ack_outcome",
  "evidence_ref",
  "deferred_until",
]);

/** 数值评分字段：class 契约之外不接受任何 score/weight/priority。 */
const SCORE_KEYS: ReadonlySet<string> = new Set(["score", "weight", "priority", "severity"]);

/** 控制字符（含 NUL / 换行 / 制表符 / DEL）。 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export const SOURCE_KEY_RE = /^[a-z0-9_.-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isControlFree(v: string): boolean {
  return !CONTROL_CHARS_RE.test(v);
}

function codePointLength(v: string): number {
  return Array.from(v).length;
}

function optionalNonNegInt(
  raw: Record<string, unknown>,
  key: string,
  field: string,
  errors: LetterFieldError[],
): number | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
    return v;
  }
  errors.push({ field, message: `需要 ≥0 的整数毫秒时间戳，实际为 ${JSON.stringify(v)}` });
  return undefined;
}

function optionalKeyString(
  raw: Record<string, unknown>,
  key: string,
  field: string,
  maxKeyChars: number,
  errors: LetterFieldError[],
): string | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    errors.push({ field, message: "需要非空字符串" });
    return undefined;
  }
  if (v.length > maxKeyChars) {
    errors.push({ field, message: `长度不得超过 ${maxKeyChars}，实际为 ${v.length}` });
    return undefined;
  }
  if (!isControlFree(v)) {
    errors.push({ field, message: "不允许控制字符" });
    return undefined;
  }
  return v;
}

/**
 * 校验并解析一封新信。失败抛出 LetterValidationError（errors 汇总全部问题）。
 * 选项缺省值集中在 defaults.ts；调用方（T3）可按配置 limits 覆盖。
 */
export function validateLetterInput(
  raw: unknown,
  options: LetterValidationOptions = {},
): LetterInput {
  const errors: LetterFieldError[] = [];
  if (!isRecord(raw)) {
    throw new LetterValidationError([
      { field: "letter", message: "需要对象（信件字段映射）" },
    ]);
  }

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxTitleChars = options.maxTitleChars ?? DEFAULT_MAX_TITLE_CHARS;
  const maxRefBytes = options.maxRefBytes ?? DEFAULT_MAX_REF_BYTES;
  const maxKeyChars = options.maxKeyChars ?? DEFAULT_MAX_KEY_CHARS;
  const maxPrincipalChars = options.maxPrincipalChars ?? DEFAULT_MAX_PRINCIPAL_CHARS;
  const maxKindChars = options.maxKindChars ?? DEFAULT_MAX_KIND_CHARS;
  const maxCausationDepth = options.maxCausationDepth ?? DEFAULT_MAX_CAUSATION_DEPTH;

  for (const key of Object.keys(raw)) {
    if (SCORE_KEYS.has(key)) {
      errors.push({
        field: key,
        message: "数值评分由 policy 内部计算，调用方只能提交 class（interrupt/notify/digest）",
      });
    } else if (SERVER_OWNED_KEYS.has(key)) {
      errors.push({ field: key, message: "服务端分配/管理字段，调用方不得提供" });
    } else if (!ALLOWED_INPUT_KEYS.has(key)) {
      errors.push({ field: key, message: "未知字段" });
    }
  }

  const sourceRaw = raw["source"];
  let source: string | undefined;
  if (typeof sourceRaw !== "string") {
    errors.push({ field: "source", message: "必填，需要字符串 source 注册键" });
  } else if (!SOURCE_KEY_RE.test(sourceRaw)) {
    errors.push({
      field: "source",
      message: `需要匹配 ${String(SOURCE_KEY_RE)}（小写字母/数字/下划线/点/连字符，1-64 字符），实际为 ${JSON.stringify(sourceRaw)}`,
    });
  } else {
    source = sourceRaw;
  }

  const kindRaw = raw["kind"];
  let kind: string | undefined;
  if (typeof kindRaw !== "string" || kindRaw.trim().length === 0) {
    errors.push({ field: "kind", message: "必填，需要非空字符串" });
  } else if (codePointLength(kindRaw) > maxKindChars) {
    errors.push({ field: "kind", message: `长度不得超过 ${maxKindChars}` });
  } else if (!isControlFree(kindRaw)) {
    errors.push({ field: "kind", message: "不允许控制字符" });
  } else {
    kind = kindRaw;
  }

  const classRaw = raw["class"];
  let letterClass: LetterClass | undefined;
  if (typeof classRaw === "string" && (LETTER_CLASSES as readonly string[]).includes(classRaw)) {
    letterClass = classRaw as LetterClass;
  } else {
    errors.push({
      field: "class",
      message: `需要 ${LETTER_CLASSES.map((c) => `"${c}"`).join(" / ")} 之一，实际为 ${JSON.stringify(classRaw)}`,
    });
  }

  const trustRaw = raw["trust"];
  let trust: LetterTrust | undefined;
  if (typeof trustRaw === "string" && (LETTER_TRUSTS as readonly string[]).includes(trustRaw)) {
    trust = trustRaw as LetterTrust;
  } else {
    errors.push({
      field: "trust",
      message: `需要 ${LETTER_TRUSTS.map((t) => `"${t}"`).join(" / ")} 之一，实际为 ${JSON.stringify(trustRaw)}`,
    });
  }

  const principalRaw = raw["principal"];
  let principal: string | undefined;
  if (typeof principalRaw !== "string" || principalRaw.trim().length === 0) {
    errors.push({ field: "principal", message: "必填，需要非空字符串" });
  } else if (codePointLength(principalRaw) > maxPrincipalChars) {
    errors.push({ field: "principal", message: `长度不得超过 ${maxPrincipalChars}` });
  } else if (!isControlFree(principalRaw)) {
    errors.push({ field: "principal", message: "不允许控制字符" });
  } else {
    principal = principalRaw;
  }

  const bodyRaw = raw["body"];
  let body: string | undefined;
  if (typeof bodyRaw !== "string") {
    errors.push({ field: "body", message: "必填，需要字符串" });
  } else if (bodyRaw.trim().length === 0) {
    errors.push({ field: "body", message: "不能为空（trim 后至少一个字符）" });
  } else if (Buffer.byteLength(bodyRaw, "utf8") > maxBodyBytes) {
    errors.push({
      field: "body",
      message: `UTF-8 字节数不得超过 ${maxBodyBytes}，实际为 ${Buffer.byteLength(bodyRaw, "utf8")}`,
    });
  } else {
    body = bodyRaw;
  }

  let title: string | undefined;
  const titleRaw = raw["title"];
  if (titleRaw !== undefined) {
    if (typeof titleRaw !== "string" || titleRaw.trim().length === 0) {
      errors.push({ field: "title", message: "存在时需为非空字符串" });
    } else if (codePointLength(titleRaw) > maxTitleChars) {
      errors.push({ field: "title", message: `长度不得超过 ${maxTitleChars} 码点` });
    } else if (!isControlFree(titleRaw)) {
      errors.push({ field: "title", message: "标题必须是单行文本，不允许控制字符/换行" });
    } else {
      title = titleRaw;
    }
  }

  let ref: unknown;
  const refRaw = raw["ref"];
  if (refRaw !== undefined) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(refRaw);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      errors.push({ field: "ref", message: "需要可 JSON 序列化的值" });
    } else if (Buffer.byteLength(serialized, "utf8") > maxRefBytes) {
      errors.push({
        field: "ref",
        message: `JSON 序列化后不得超过 ${maxRefBytes} 字节，实际为 ${Buffer.byteLength(serialized, "utf8")}`,
      });
    } else {
      ref = refRaw;
    }
  }

  const correlationId = optionalKeyString(
    raw,
    "correlation_id",
    "correlation_id",
    maxKeyChars,
    errors,
  );
  const dedupeKey = optionalKeyString(raw, "dedupe_key", "dedupe_key", maxKeyChars, errors);
  const coalesceKey = optionalKeyString(raw, "coalesce_key", "coalesce_key", maxKeyChars, errors);
  const replyTo = optionalKeyString(raw, "reply_to", "reply_to", maxKeyChars, errors);

  const notBefore = optionalNonNegInt(raw, "not_before", "not_before", errors);
  const expiresAt = optionalNonNegInt(raw, "expires_at", "expires_at", errors);

  let causationDepth: number | undefined;
  const depthRaw = raw["causation_depth"];
  if (depthRaw !== undefined) {
    if (
      typeof depthRaw !== "number" || !Number.isSafeInteger(depthRaw) || depthRaw < 0 ||
      depthRaw > maxCausationDepth
    ) {
      errors.push({
        field: "causation_depth",
        message: `需要 0-${maxCausationDepth} 的整数，实际为 ${JSON.stringify(depthRaw)}`,
      });
    } else {
      causationDepth = depthRaw;
    }
  }

  if (
    notBefore !== undefined && expiresAt !== undefined && expiresAt <= notBefore
  ) {
    errors.push({
      field: "expires_at",
      message: `必须大于 not_before（not_before=${notBefore}, expires_at=${expiresAt}）`,
    });
  }

  if (
    errors.length > 0 || source === undefined || kind === undefined || letterClass === undefined ||
    trust === undefined || principal === undefined || body === undefined
  ) {
    if (errors.length === 0) {
      errors.push({ field: "letter", message: "内部不一致：必填字段缺失但未上报错误" });
    }
    throw new LetterValidationError(errors);
  }

  return {
    source,
    kind,
    class: letterClass,
    trust,
    principal,
    ...(notBefore === undefined ? {} : { not_before: notBefore }),
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    ...(title === undefined ? {} : { title }),
    body,
    ...(ref === undefined ? {} : { ref }),
    ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
    ...(dedupeKey === undefined ? {} : { dedupe_key: dedupeKey }),
    ...(coalesceKey === undefined ? {} : { coalesce_key: coalesceKey }),
    ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    ...(causationDepth === undefined ? {} : { causation_depth: causationDepth }),
  };
}
