/**
 * DeadLetterSink 落盘验收（任务 C：dead-letter/{date}.jsonl 生产者接线）。
 * Given: 临时 state 根（StateLayout 六子目录）
 * When:  引擎形状 payload → sink.emit
 * Then:  `{stateRoot}/dead-letter/{UTC日}.jsonl` 逐行落盘、payload 字段原样可 parse；
 *        同日两次 = 同分片两行；跨日 = 两分片；写失败只 warn 不抛（观测面不反噬盖棺）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stateDateKey } from "@axeuh/loom-adapters";
import type { DeadLetterPayload } from "@axeuh/loom-core/run-engine";

import { createDeadLetterSink } from "./dead-letter-sink.js";

let workDir = "";
let warns: Array<Record<string, unknown>> = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "loom-dead-letter-"));
  warns = [];
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function mkSink() {
  return createDeadLetterSink({
    stateRoot: workDir,
    log: (level, msg, fields) => warns.push({ level, msg, ...fields }),
  });
}

function payload(over: Partial<DeadLetterPayload> = {}): DeadLetterPayload {
  return {
    kind: "dead-letter",
    run_id: "run_" + "a".repeat(16),
    workflow: "w-dl",
    attempt: 1,
    trigger: "manual",
    parent_run: null,
    session_id: "ses_" + "b".repeat(16),
    digest: "failed：强制收束（nudge-limit），无合法回执",
    blockers: ["nudge-limit"],
    forceReason: "nudge-limit",
    at: Date.now(),
    ...over,
  };
}

function shard(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("createDeadLetterSink：死信分片落盘", () => {
  it("emit 一行 → dead-letter/{UTC日}.jsonl 存在且 payload 字段原样回读", () => {
    const p = payload();
    mkSink().emit(p);
    const path = join(workDir, "dead-letter", `${stateDateKey(p.at)}.jsonl`);
    expect(existsSync(path)).toBe(true);
    const rows = shard(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ ...p });
  });

  it("同日两次 = 同分片两行（journal 复用不重放丢行）；跨日 = 两分片", () => {
    const day1 = Date.UTC(2026, 9, 5, 12); // 固定 UTC 日（不落真实时钟，分片键确定性）
    const day2 = day1 + 36 * 3600 * 1000;
    const sink = mkSink();
    sink.emit(payload({ at: day1, run_id: "run_" + "1".repeat(16) }));
    sink.emit(payload({ at: day1 + 60_000, run_id: "run_" + "2".repeat(16) }));
    sink.emit(payload({ at: day2, run_id: "run_" + "3".repeat(16) }));

    const shard1 = join(workDir, "dead-letter", `${stateDateKey(day1)}.jsonl`);
    const shard2 = join(workDir, "dead-letter", `${stateDateKey(day2)}.jsonl`);
    expect(shard(shard1).map((r) => r["run_id"])).toEqual([
      "run_" + "1".repeat(16),
      "run_" + "2".repeat(16),
    ]);
    expect(shard(shard2)).toHaveLength(1);
  });

  it("落盘失败（dead-letter 路径被普通文件占据）：emit 不抛、warn 留痕", () => {
    mkdirSync(join(workDir, "dead-letter"), { recursive: true });
    writeFileSync(join(workDir, "dead-letter", "manifest"), "占位：不影响日分片目录存在");
    const blocked = join(tmpdir(), "loom-dead-letter-blocked-" + String(Date.now()));
    mkdirSync(blocked, { recursive: true });
    // 把 blocked/dead-letter 做成文件 → Journal 构造 mkdirSync 必炸（ENOTDIR/EEXIST）。
    writeFileSync(join(blocked, "dead-letter"), "not-a-dir");
    expect(() => createDeadLetterSink({ stateRoot: blocked }).emit(payload())).not.toThrow();
    expect(warns).toHaveLength(0); // 该 sink 未接 log：吞错即合规
  });
});
