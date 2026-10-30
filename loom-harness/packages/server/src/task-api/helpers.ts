/**
 * T28 任务/运行域 API —— 边界解析与错误映射。
 *
 * 铁律：
 *   - 不可信 body/query 只在此处解析一次，进 handler 内部即类型化值（parse-don't-validate）；
 *   - 判别联合消费先 `kind` 收窄再取字段（DispatchResult / ControlPlaneError 皆然，
 *     前车之鉴：control-plane.test 曾犯过未收窄先取值）；
 *   - 内核类型化错误 → 稳定 HTTP 码：不吞 cause_kind，side→side 透传 403（验收项）。
 */

import {
  RUN_ID_SHAPE_RE,
  RUN_TRIGGERS,
  RunEngineError,
  type RunTrigger,
} from "@axeuh/loom-core/run-engine";
import { ControlPlaneError, isControlActor, type ControlActor } from "@axeuh/loom-core/control";
import { HttpError } from "../http/index.js";

/** run id 合法字符集（连字符永久禁用，docs/04 §3.2）。 */
const RUN_ID_ALLOWED_RE = /^[a-zA-Z0-9_]+$/;

/**
 * 归一化路径 runID：连字符→下划线（前端硬口径，同 T27 sessionID 惯例）、
 * 非法字符 400、形状不合 RUN_ID_SHAPE_RE 400。
 */
export function normalizeRunID(raw: string): string {
  const normalized = raw.replace(/-/g, "_");
  if (!RUN_ID_ALLOWED_RE.test(normalized)) {
    throw new HttpError(400, "bad_run_id", `invalid runID: ${raw}`);
  }
  if (!RUN_ID_SHAPE_RE.test(normalized)) {
    throw new HttpError(
      400,
      "bad_run_id",
      `runID "${normalized}" violates id shape (^[a-z][a-z0-9_]{2,4}_[0-9a-f]{16}$, hyphens banned)`,
    );
  }
  return normalized;
}

/** 路径取 runID（路由保证 :runID 存在，仍做防御）。 */
export function paramRunID(params: Readonly<Record<string, string>>): string {
  const raw = params["runID"];
  if (raw === undefined || raw.length === 0) {
    throw new HttpError(400, "bad_run_id", "missing runID in path");
  }
  return normalizeRunID(raw);
}

/** body 必须是 JSON 对象（数组/null/标量 = 400）。 */
export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new HttpError(400, "bad_request", "request body must be a JSON object");
}

/** 必填非空字符串字段。 */
export function requireString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new HttpError(400, "bad_request", `field "${key}" must be a non-blank string`);
  }
  return v;
}

/** 可选字符串字段（缺省/显式 null = undefined；非字符串 = 400）。 */
export function optionalString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new HttpError(400, "bad_request", `field "${key}" must be a non-blank string when present`);
  }
  return v;
}

/**
 * actor 边界解析：缺省 "http"（HTTP 控制面身份）；非法值 400；
 * "side" **原样放行**给 ControlPlane——拒绝与审计是 T25 的职责，API 不越权预判（side→side 透传）。
 */
export function parseActor(rec: Record<string, unknown>): ControlActor {
  const v = rec["actor"];
  if (v === undefined || v === null) return "http";
  if (!isControlActor(v)) {
    throw new HttpError(400, "bad_actor", `unknown actor ${JSON.stringify(v)}; must be main/http/script/side`);
  }
  return v;
}

/** trigger 边界解析：缺省 "manual"（手动派发语义，D15 词表；RUN_TRIGGERS 为词表真源）。 */
export function parseTrigger(rec: Record<string, unknown>): RunTrigger {
  const v = rec["trigger"];
  if (v === undefined || v === null) return "manual";
  const found = RUN_TRIGGERS.find((t): boolean => t === v);
  if (found === undefined) {
    throw new HttpError(400, "bad_trigger", `unknown trigger ${JSON.stringify(v)}`);
  }
  return found;
}

/**
 * 内核错误 → HttpError 的映射（handler catch 统一走这里）。
 * 已是 HttpError 的原样重抛；未知错误交给 Router 兜底 500。
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ControlPlaneError) {
    switch (err.cause_kind) {
      case "input":
        return new HttpError(400, "bad_request", err.message);
      case "unknown-run":
        return new HttpError(404, "run_not_found", err.message);
      case "side-to-side-forbidden":
        // D22 拒绝透传：403 + 稳定机器码（审计行已由 ControlPlane 落账）。
        return new HttpError(403, "side_to_side_forbidden", err.message);
    }
    return new HttpError(500, "internal_error", err.message);
  }
  if (err instanceof RunEngineError) {
    switch (err.cause_kind) {
      case "dispatch-input":
        return new HttpError(400, "bad_request", err.message);
      case "ledger":
      case "side-session-port":
      case "sink":
        return new HttpError(500, "internal_error", err.message);
    }
    return new HttpError(500, "internal_error", err.message);
  }
  return new HttpError(500, "internal_error", err instanceof Error ? err.message : "internal error");
}
