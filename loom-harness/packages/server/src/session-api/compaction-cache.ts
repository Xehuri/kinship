import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SessionCompactionResponse } from "./types.js";

export type ActiveCompaction = Extract<SessionCompactionResponse, { status: "active" }>;

const CACHE_VERSION = 1;
const SESSION_ID_RE = /^[a-zA-Z0-9_]+$/;

function cacheFile(stateRoot: string, sessionID: string): string {
  return join(stateRoot, "session", "compaction", `${sessionID}.json`);
}

function isActiveCompaction(value: unknown, sessionID: string): value is ActiveCompaction {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row["status"] === "active" &&
    row["sessionID"] === sessionID &&
    typeof row["summaryText"] === "string" &&
    typeof row["coveredCount"] === "number" &&
    Number.isFinite(row["coveredCount"]) &&
    (row["anchorMessageId"] === null || typeof row["anchorMessageId"] === "string") &&
    (row["anchorTimestampMs"] === null ||
      (typeof row["anchorTimestampMs"] === "number" && Number.isFinite(row["anchorTimestampMs"]))) &&
    typeof row["tailCount"] === "number" &&
    Number.isFinite(row["tailCount"]) &&
    typeof row["totalMessages"] === "number" &&
    Number.isFinite(row["totalMessages"])
  );
}

export function readCompactionCache(stateRoot: string, sessionID: string): ActiveCompaction | null {
  if (!SESSION_ID_RE.test(sessionID)) return null;
  try {
    const raw = JSON.parse(readFileSync(cacheFile(stateRoot, sessionID), "utf8")) as {
      version?: unknown;
      body?: unknown;
    };
    if (raw.version !== CACHE_VERSION || !isActiveCompaction(raw.body, sessionID)) return null;
    return raw.body;
  } catch {
    return null;
  }
}

export function writeCompactionCache(
  stateRoot: string,
  sessionID: string,
  body: ActiveCompaction,
): void {
  if (!SESSION_ID_RE.test(sessionID)) return;
  const file = cacheFile(stateRoot, sessionID);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: CACHE_VERSION, body })}\n`, "utf8");
  renameSync(tmp, file);
}
