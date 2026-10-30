/**
 * Loom 主会话解析（boot 期一次，确定性优先级）。
 *
 * 优先级：server.mainSessionId > 持久标记 > scheduling.sessionId > 主 store 首个 sid >
 * 新造 sid。解析结果以 `{stateRoot}/session/main-session.json` 原子落盘
 * （`{sessionID, source, updatedAt}`），后续 boot 无显式配置时沿用标记，保证主会话跨重启恒定。
 * 写盘失败只 WARN，绝不阻断启动（解析结果仍在内存生效）。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { newSubagentSessionId } from "@axeuh/loom-core/subagent/ids";

/** 会话 id 白名单（与前端 `[a-zA-Z0-9_]` 硬契约一致，连字符永久禁用）。 */
export const MAIN_SESSION_ID_RE = /^[A-Za-z0-9_]+$/;

/** 主会话来源（持久标记里如实记录解析依据）。 */
export type MainSessionSource = "config" | "marker" | "scheduling" | "store" | "generated";

export interface MainSessionMarker {
  readonly sessionID: string;
  readonly source: MainSessionSource;
  readonly updatedAt: number;
}

export interface MainSessionResolution {
  readonly sessionID: string;
  readonly source: MainSessionSource;
}

export type MainSessionLog = (
  level: "warn",
  msg: string,
  fields: Record<string, unknown>,
) => void;

export interface ResolveMainSessionOptions {
  readonly stateRoot: string;
  readonly configMainSessionID?: string | undefined;
  readonly schedulingSessionID?: string | undefined;
  readonly sessionIDs?: () => readonly string[];
  readonly newSessionID?: () => string;
  readonly now?: () => number;
  readonly log?: MainSessionLog;
}

export function mainSessionMarkerPath(stateRoot: string): string {
  return join(stateRoot, "session", "main-session.json");
}

/** 同 pid 同刻多次写的 tmp 名去重（与 wake/queue sidecar 同口径）。 */
let tmpSeq = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function validID(value: unknown): value is string {
  return typeof value === "string" && MAIN_SESSION_ID_RE.test(value);
}

function readMarker(
  file: string,
  log: MainSessionLog,
): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (!isEnoent(err)) {
      log("warn", "loom main session marker read failed (skipped)", {
        file,
        error: errorMessage(err),
      });
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log("warn", "loom main session marker unreadable (skipped)", {
      file,
      error: errorMessage(err),
    });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    log("warn", "loom main session marker invalid shape (skipped)", { file });
    return null;
  }
  const sessionID = Reflect.get(parsed, "sessionID");
  if (!validID(sessionID)) {
    log("warn", "loom main session marker invalid session id (skipped)", {
      file,
      sessionID,
    });
    return null;
  }
  return sessionID;
}

function writeMarker(
  file: string,
  marker: MainSessionMarker,
  log: MainSessionLog,
): void {
  const tmp = `${file}.${String(process.pid)}.${String(++tmpSeq)}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(marker)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 清理失败不影响主流程。
    }
    log("warn", "loom main session marker write failed (continuing in memory)", {
      file,
      error: errorMessage(err),
    });
  }
}

/**
 * 解析主会话并持久化标记。永不抛：坏标记/非法 id 只 WARN 后继续下一条来源。
 */
export function resolveMainSession(opts: ResolveMainSessionOptions): MainSessionResolution {
  const log = opts.log ?? ((): void => {});
  const persist = (sessionID: string, source: MainSessionSource): MainSessionResolution => {
    const marker: MainSessionMarker = {
      sessionID,
      source,
      updatedAt: (opts.now ?? Date.now)(),
    };
    writeMarker(mainSessionMarkerPath(opts.stateRoot), marker, log);
    return { sessionID, source };
  };

  const configured = opts.configMainSessionID;
  if (configured !== undefined) {
    if (validID(configured)) return persist(configured, "config");
    log("warn", "loom main session invalid server.mainSessionId (skipped)", {
      sessionID: configured,
    });
  }

  const marked = readMarker(mainSessionMarkerPath(opts.stateRoot), log);
  if (marked !== null) return persist(marked, "marker");

  const scheduling = opts.schedulingSessionID?.trim();
  if (scheduling !== undefined && scheduling !== "") {
    if (validID(scheduling)) return persist(scheduling, "scheduling");
    log("warn", "loom main session invalid scheduling.sessionId (skipped)", {
      sessionID: scheduling,
    });
  }

  const first = (opts.sessionIDs?.() ?? [])[0];
  if (first !== undefined) {
    if (validID(first)) return persist(first, "store");
    log("warn", "loom main session invalid first store session id (skipped)", {
      sessionID: first,
    });
  }

  return persist((opts.newSessionID ?? newSubagentSessionId)(), "generated");
}
