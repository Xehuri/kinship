#!/usr/bin/env node
/**
 * Bucket B migration dry-run (30 converge fixture tests).
 *
 * This script is read-only by construction: it scans the 30 files listed in
 * docs/flow-bucket-b-migration.md and prints the planned mechanical replacements.
 * There is no --apply. Any write attempt is refused.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

export const BUCKET_B_FILES = [
  "packages/core/src/main-loop/main-session.test.ts",
  "packages/core/src/main-loop/system-prompt-refresh.test.ts",
  "packages/server/src/contract/contract-api.test.ts",
  "packages/server/src/contract/contract-frames.test.ts",
  "packages/server/src/serve/boot-assembly.test.ts",
  "packages/server/src/serve/boot-instance.test.ts",
  "packages/server/src/serve/boot-prompt-e2e.test.ts",
  "packages/server/src/serve/boot-pty-e2e.test.ts",
  "packages/server/src/serve/boot-rehydrate.test.ts",
  "packages/server/src/serve/boot-reminder.test.ts",
  "packages/server/src/serve/boot-resume-continuity.test.ts",
  "packages/server/src/serve/boot-system-prompt-refresh.test.ts",
  "packages/server/src/serve/boot-task-ledger.test.ts",
  "packages/server/src/serve/boot-tools.test.ts",
  "packages/server/src/serve/boot-transcript.test.ts",
  "packages/server/src/serve/boot-wake.test.ts",
  "packages/server/src/serve/boot-wire-cache.test.ts",
  "packages/server/src/serve/context-change-boot.test.ts",
  "packages/server/src/serve/model-routing.test.ts",
  "packages/server/src/serve/session-context-main.test.ts",
  "packages/server/src/serve/trace-wiring.test.ts",
  "packages/server/src/serve/w11-live-events.test.ts",
  "packages/server/src/serve/w9s3-tasks.test.ts",
  "packages/server/src/session-api/boot-session-meta.test.ts",
  "packages/server/src/session-api/compaction-history-route.test.ts",
  "packages/server/src/session-api/compaction-status.test.ts",
  "packages/server/src/session-api/context-api.test.ts",
  "packages/server/src/session-api/context-full.test.ts",
  "packages/server/src/session-api/context-full-v2.test.ts",
  "packages/server/src/session-api/session-api.test.ts",
];

const RULES = [
  {
    id: "tool-name",
    pattern: /\bconverge(?:-main|-side)?\b/g,
    replacement: "flow_commit",
    note: "main-session fixture tool call only; side-session cases stay converge",
  },
  {
    id: "terminal-result",
    pattern: /\bconverged\b/g,
    replacement: "flowEnded",
    note: "terminal result assertion",
  },
  {
    id: "status-done",
    pattern: /status:\s*(["'])已完成\1/g,
    replacement: 'state: "closed"',
    note: "status to flow state",
  },
  {
    id: "status-waiting-user",
    pattern: /status:\s*(["'])待用户回应\1/g,
    replacement: 'state: "waiting_user"',
    note: "status to flow state",
  },
  {
    id: "status-needs-confirm",
    pattern: /status:\s*(["'])需用户确认\1/g,
    replacement: 'state: "waiting_user"',
    note: "确认折叠为 waiting_user（决策原因进 notes）",
  },
  {
    id: "wake-field",
    pattern: /\bwake:\s*/g,
    replacement: "next_decision_at: ",
    note: "wake -> next_decision_at; none becomes null",
  },
];

function usage() {
  return [
    "usage:",
    "  flow-bucket-b-migration [--dry-run]",
    "",
    "This command never writes. There is no apply mode.",
    "Bucket B stays blocked until the L9 observation gate passes.",
  ].join("\n");
}

function lineColumnOf(text, index) {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function snippetAt(text, index, length) {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 140);
}

function scanFile(relPath) {
  const file = join(REPO_ROOT, relPath);
  if (!existsSync(file)) return { relPath, missing: true, hits: [] };
  const text = readFileSync(file, "utf8");
  const hits = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      const { line, column } = lineColumnOf(text, match.index);
      hits.push({
        rule: rule.id,
        line,
        column,
        from: match[0],
        to: rule.replacement,
        note: rule.note,
        snippet: snippetAt(text, match.index, match[0].length),
      });
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }
  hits.sort((a, b) => a.line - b.line || a.column - b.column);
  return { relPath, missing: false, hits };
}

function main(argv) {
  const args = argv.filter((arg) => arg !== "--dry-run");
  if (args.includes("--apply") || args.includes("--write")) {
    console.error("flow-bucket-b-migration: refused. Bucket B is blocked until the L9 gate passes.");
    console.error("This script is dry-run only by design.");
    process.exitCode = 2;
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  if (args.length > 0) {
    console.error(`flow-bucket-b-migration: unexpected argument: ${args[0]}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const seen = new Set();
  const duplicates = [];
  for (const file of BUCKET_B_FILES) {
    if (seen.has(file)) duplicates.push(file);
    seen.add(file);
  }

  let totalHits = 0;
  let missing = 0;
  console.log(`bucket-b dry-run: files=${String(BUCKET_B_FILES.length)} root=${REPO_ROOT}`);
  if (duplicates.length > 0) {
    console.log(`duplicate entries: ${duplicates.join(", ")}`);
  }
  console.log("");
  for (const relPath of BUCKET_B_FILES) {
    const result = scanFile(relPath);
    if (result.missing) {
      missing += 1;
      console.log(`MISSING ${relPath}`);
      continue;
    }
    totalHits += result.hits.length;
    console.log(`${relPath}: ${String(result.hits.length)} planned replacement(s)`);
    for (const hit of result.hits) {
      console.log(
        `  ${String(hit.line)}:${String(hit.column)} [${hit.rule}] ${JSON.stringify(
          hit.from,
        )} -> ${JSON.stringify(hit.to)}  (${hit.note})`,
      );
      console.log(`    ${hit.snippet}`);
    }
  }
  console.log("");
  console.log(
    `summary: files=${String(BUCKET_B_FILES.length)} missing=${String(missing)} planned=${String(
      totalHits,
    )} writes=0`,
  );
  console.log("no files were modified; bucket B requires an explicit L9 gate pass.");
  if (missing > 0) process.exitCode = 1;
}

main(process.argv.slice(2));
