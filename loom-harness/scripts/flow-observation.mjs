#!/usr/bin/env node
/**
 * L9 flow observation dashboard (standalone, zero dependencies).
 *
 * Commands:
 *   start    --root <stateRoot> [--days 7]      write window.json
 *   report   --root <stateRoot> [--json]        JSON + Markdown dashboard
 *   dashboard                                   alias of report
 *   record-ci --root <stateRoot> --status pass|fail [--detail text]
 *
 * Reads {root}/flow-observation/{events.jsonl,window.json,ci.jsonl}. Never requires
 * flow to be enabled: a missing window/events file reports "not_started" cleanly.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const OBS_DIR = "flow-observation";
const EVENTS_FILE = "events.jsonl";
const WINDOW_FILE = "window.json";
const CI_FILE = "ci.jsonl";
const WINDOW_SCHEMA = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A scheduled wake that is this late without delivered/cleared/stale is lost. */
export const LOST_GRACE_MS = 5 * 60 * 1000;
/** flow.ended must be followed by session.idle inside this window. */
export const IDLE_MATCH_WINDOW_MS = 60 * 1000;

function usage() {
  return [
    "usage:",
    "  flow-observation start --root <stateRoot> [--days 7]",
    "  flow-observation report --root <stateRoot> [--json]",
    "  flow-observation dashboard --root <stateRoot> [--json]",
    "  flow-observation record-ci --root <stateRoot> --status pass|fail [--detail text]",
  ].join("\n");
}

function fail(message) {
  console.error(`flow-observation: ${message}`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const command = argv[0];
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      flags.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!["root", "days", "status", "detail"].includes(name)) {
      throw new Error(`unknown flag: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${token}`);
    }
    flags[name] = value;
    index += 1;
  }
  return { command, flags };
}

function observationDir(root) {
  return join(root, OBS_DIR);
}

function readJsonLines(file) {
  if (!existsSync(file)) return { rows: [], malformed: 0 };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { rows: [], malformed: 0 };
  }
  const rows = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) rows.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
}

function readWindow(root) {
  const file = join(observationDir(root), WINDOW_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.started_at !== "number" ||
      typeof parsed.ends_at !== "number" ||
      !Number.isFinite(parsed.started_at) ||
      !Number.isFinite(parsed.ends_at) ||
      parsed.ends_at <= parsed.started_at
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeWindow(root, days) {
  const dir = observationDir(root);
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  const window = {
    schema: WINDOW_SCHEMA,
    started_at: startedAt,
    ends_at: startedAt + Math.round(days * DAY_MS),
    days,
  };
  const file = join(dir, WINDOW_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(window)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 未落地
    }
    throw error;
  }
  return window;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function armKey(sessionID, subjectAt, scheduledAt) {
  return `${sessionID}\u0000${subjectAt}\u0000${scheduledAt}`;
}

function scheduledKey(sessionID, scheduledAt) {
  return `${sessionID}\u0000${scheduledAt}`;
}

function deliveryKey(delivery) {
  if (isFiniteNumber(delivery.subject_at) && isFiniteNumber(delivery.scheduled_at)) {
    return armKey(delivery.session_id, delivery.subject_at, delivery.scheduled_at);
  }
  if (isFiniteNumber(delivery.scheduled_at)) {
    return scheduledKey(delivery.session_id, delivery.scheduled_at);
  }
  return `${delivery.session_id}\u0000unknown`;
}

function durationLabel(ms) {
  if (!isFiniteNumber(ms) || ms < 0) return "n/a";
  const hours = ms / 3_600_000;
  if (hours >= 48) return `${(hours / 24).toFixed(1)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

function summarize(root, events, window, ciRows, malformed, now) {
  const byType = (type) => events.filter((event) => event.type === type);
  const armed = byType("wake.armed");
  const delivered = byType("wake.delivered");
  const stale = byType("wake.stale");
  const cleared = byType("wake.cleared");
  const flowEnded = byType("flow.ended");
  const idles = byType("session.idle");

  const deliveredKeys = new Set(delivered.map(deliveryKey));
  const staleKeys = new Set(
    stale
      .filter((event) => isFiniteNumber(event.scheduled_at))
      .map((event) => scheduledKey(event.session_id, event.scheduled_at)),
  );
  const clearTimes = new Map();
  for (const event of cleared) {
    if (!isFiniteNumber(event.ts)) continue;
    const list = clearTimes.get(event.session_id) ?? [];
    list.push(event.ts);
    clearTimes.set(event.session_id, list);
  }

  const lostWakes = [];
  for (const event of armed) {
    if (!isFiniteNumber(event.subject_at) || !isFiniteNumber(event.scheduled_at)) continue;
    const key = armKey(event.session_id, event.subject_at, event.scheduled_at);
    const fallback = scheduledKey(event.session_id, event.scheduled_at);
    const deliveredMatch = deliveredKeys.has(key) || deliveredKeys.has(fallback);
    if (deliveredMatch) continue;
    if (staleKeys.has(fallback)) continue;
    const clears = clearTimes.get(event.session_id) ?? [];
    if (isFiniteNumber(event.ts) && clears.some((ts) => ts >= event.ts)) continue;
    const graceEndsAt = event.scheduled_at + LOST_GRACE_MS;
    if (now < graceEndsAt) continue;
    lostWakes.push({
      session_id: event.session_id,
      subject_at: event.subject_at,
      scheduled_at: event.scheduled_at,
      armed_at: event.ts ?? null,
      grace_ends_at: graceEndsAt,
    });
  }

  const deliveryGroups = new Map();
  for (const event of delivered) {
    const key = isFiniteNumber(event.subject_at)
      ? `${event.session_id}\u0000${event.subject_at}`
      : deliveryKey(event);
    const group = deliveryGroups.get(key) ?? [];
    group.push(event);
    deliveryGroups.set(key, group);
  }
  const duplicateWakes = [];
  for (const group of deliveryGroups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    duplicateWakes.push({
      session_id: first.session_id,
      subject_at: isFiniteNumber(first.subject_at) ? first.subject_at : null,
      scheduled_at: isFiniteNumber(first.scheduled_at) ? first.scheduled_at : null,
      count: group.length,
    });
  }

  const flowEndedWithoutIdle = [];
  for (const ended of flowEnded) {
    if (!isFiniteNumber(ended.ts)) {
      flowEndedWithoutIdle.push({
        session_id: ended.session_id,
        subject_id: ended.subject_id ?? null,
        state: ended.state ?? null,
        ended_at: null,
        reason: "missing_event_ts",
      });
      continue;
    }
    const matched = idles.some(
      (idle) =>
        idle.session_id === ended.session_id &&
        isFiniteNumber(idle.ts) &&
        idle.ts >= ended.ts &&
        idle.ts - ended.ts <= IDLE_MATCH_WINDOW_MS,
    );
    if (!matched) {
      flowEndedWithoutIdle.push({
        session_id: ended.session_id,
        subject_id: ended.subject_id ?? null,
        state: ended.state ?? null,
        ended_at: ended.ts,
        reason: "no_session_idle_within_window",
      });
    }
  }

  const latestCi = ciRows.length === 0 ? null : ciRows[ciRows.length - 1];
  const ci =
    latestCi === null
      ? null
      : {
          status: latestCi.status ?? null,
          detail: latestCi.detail ?? "",
          at: isFiniteNumber(latestCi.ts) ? latestCi.ts : null,
        };

  let windowSummary;
  if (window === null) {
    windowSummary = {
      state: "not_started",
      started_at: null,
      ends_at: null,
      days: null,
      elapsed_ms: null,
      remaining_ms: null,
      progress: null,
    };
  } else {
    const complete = now >= window.ends_at;
    const elapsed = Math.max(0, Math.min(now, window.ends_at) - window.started_at);
    const remaining = Math.max(0, window.ends_at - now);
    windowSummary = {
      state: complete ? "complete" : "running",
      started_at: window.started_at,
      ends_at: window.ends_at,
      days: isFiniteNumber(window.days) ? window.days : null,
      elapsed_ms: elapsed,
      remaining_ms: remaining,
      progress:
        window.ends_at > window.started_at
          ? Math.min(1, Math.max(0, elapsed / (window.ends_at - window.started_at)))
          : null,
    };
  }

  const duplicateSuppressed = byType("wake.duplicate_suppressed").length;
  const counts = {
    events: events.length,
    malformed,
    wake_armed: armed.length,
    wake_delivered: delivered.length,
    wake_stale: stale.length,
    wake_cleared: cleared.length,
    duplicate_suppressed: duplicateSuppressed,
    duplicate_wakes: duplicateWakes.length,
    flow_ended: flowEnded.length,
    session_idle: idles.length,
    session_idle_with_flow: idles.filter((event) => event.has_flow === true).length,
    session_idle_without_flow: idles.filter((event) => event.has_flow !== true).length,
    flow_unset: byType("flow.unset").length,
    lost_wakes: lostWakes.length,
    flow_ended_without_idle: flowEndedWithoutIdle.length,
  };

  const gateReasons = [];
  if (windowSummary.state !== "complete") gateReasons.push("window not complete");
  if (armed.length === 0) gateReasons.push("no wake sample");
  if (lostWakes.length > 0) gateReasons.push(`${String(lostWakes.length)} lost wake(s)`);
  if (duplicateWakes.length > 0) {
    gateReasons.push(`${String(duplicateWakes.length)} duplicate wake(s)`);
  }
  if (flowEndedWithoutIdle.length > 0) {
    gateReasons.push(`${String(flowEndedWithoutIdle.length)} flowEnded without idle`);
  }
  if (ci === null) gateReasons.push("no CI record");
  else if (ci.status !== "pass") gateReasons.push("CI not green");

  return {
    schema: 1,
    root,
    generated_at: now,
    observation_dir: observationDir(root),
    window: windowSummary,
    counts,
    lost_wakes: lostWakes,
    duplicate_wakes: duplicateWakes,
    flow_ended_without_idle: flowEndedWithoutIdle,
    ci,
    gate: { pass: gateReasons.length === 0, reasons: gateReasons },
  };
}

function renderMarkdown(summary) {
  const lines = [];
  const window = summary.window;
  lines.push("# Flow observation dashboard");
  lines.push("");
  lines.push(`- root: ${summary.root}`);
  lines.push(`- generated: ${new Date(summary.generated_at).toISOString()}`);
  if (window.state === "not_started") {
    lines.push("- window: not started");
  } else {
    lines.push(
      `- window: ${window.state} (${new Date(window.started_at).toISOString()} -> ${new Date(
        window.ends_at,
      ).toISOString()})`,
    );
    lines.push(
      `- elapsed: ${durationLabel(window.elapsed_ms)} / remaining: ${durationLabel(
        window.remaining_ms,
      )} / progress: ${window.progress === null ? "n/a" : `${(window.progress * 100).toFixed(1)}%`}`,
    );
  }
  lines.push(`- gate: ${summary.gate.pass ? "PASS" : "FAIL"}`);
  if (summary.gate.reasons.length > 0) {
    lines.push(`- gate reasons: ${summary.gate.reasons.join("; ")}`);
  }
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | ---: |");
  for (const [key, value] of Object.entries(summary.counts)) {
    lines.push(`| ${key} | ${String(value)} |`);
  }
  lines.push("");
  lines.push("## CI");
  lines.push("");
  lines.push(
    summary.ci === null
      ? "no CI record"
      : `${summary.ci.status}${summary.ci.detail === "" ? "" : ` - ${summary.ci.detail}`}`,
  );
  lines.push("");
  lines.push("## Lost wakes");
  lines.push("");
  if (summary.lost_wakes.length === 0) lines.push("none");
  for (const row of summary.lost_wakes) {
    lines.push(
      `- session=${row.session_id} subject_at=${new Date(row.subject_at).toISOString()} scheduled_at=${new Date(
        row.scheduled_at,
      ).toISOString()}`,
    );
  }
  lines.push("");
  lines.push("## Duplicate wakes");
  lines.push("");
  if (summary.duplicate_wakes.length === 0) lines.push("none");
  for (const row of summary.duplicate_wakes) {
    lines.push(
      `- session=${row.session_id} subject_at=${
        row.subject_at === null ? "unknown" : new Date(row.subject_at).toISOString()
      } count=${String(row.count)}`,
    );
  }
  lines.push("");
  lines.push("## flowEnded without idle");
  lines.push("");
  if (summary.flow_ended_without_idle.length === 0) lines.push("none");
  for (const row of summary.flow_ended_without_idle) {
    lines.push(
      `- session=${row.session_id} subject=${row.subject_id ?? "unknown"} state=${
        row.state ?? "unknown"
      } reason=${row.reason}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function appendCi(root, status, detail) {
  const dir = observationDir(root);
  mkdirSync(dir, { recursive: true });
  const record = { ts: Date.now(), status, detail };
  appendFileSync(join(dir, CI_FILE), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return;
  }
  const { command, flags } = parsed;
  if (flags.help || command === undefined) {
    console.log(usage());
    return;
  }
  if (!["start", "report", "dashboard", "record-ci"].includes(command)) {
    fail(`unknown command: ${command}`);
    console.error(usage());
    return;
  }
  if (typeof flags.root !== "string" || flags.root === "") {
    fail("--root is required");
    return;
  }
  const root = resolve(flags.root);

  if (command === "start") {
    const days = flags.days === undefined ? 7 : Number(flags.days);
    if (!isFiniteNumber(days) || days <= 0) {
      fail("--days must be a positive number");
      return;
    }
    try {
      const window = writeWindow(root, days);
      console.log(JSON.stringify(window, null, 2));
    } catch (error) {
      fail(`cannot write window: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (command === "record-ci") {
    if (flags.status !== "pass" && flags.status !== "fail") {
      fail("--status must be pass or fail");
      return;
    }
    try {
      const record = appendCi(root, flags.status, flags.detail ?? "");
      console.log(JSON.stringify(record, null, 2));
    } catch (error) {
      fail(`cannot append CI record: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  const dir = observationDir(root);
  const { rows: events, malformed } = readJsonLines(join(dir, EVENTS_FILE));
  const { rows: ciRows } = readJsonLines(join(dir, CI_FILE));
  const window = readWindow(root);
  const summary = summarize(root, events, window, ciRows, malformed, Date.now());
  if (flags.json === true) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(renderMarkdown(summary));
}

main(process.argv.slice(2));
