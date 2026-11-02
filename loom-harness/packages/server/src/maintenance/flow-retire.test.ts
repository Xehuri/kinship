/**
 * Flow Phase A 退休工具测试。
 *
 * 覆盖：dry-run 零写入；apply 复制 + 写 manifest；原数据不变；wake sidecar 删 flow 条目而保留
 * plan/special；存活实例锁拒绝；verify 通过/失败；幂等重跑。
 *
 * 全部在临时目录构造 fixture，结束清理。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  apply,
  dryRun,
  liveInstancePresent,
  verify,
  type FlowApplyManifest,
} from "./flow-retire.js";

let root = "";
const created: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-retire-"));
  created.push(dir);
  return dir;
}

function makeSession(sid: string, opts: { nonClosed: number; closed: number; items: number }): void {
  const flowDir = join(root, "session", sid, "flow");
  mkdirSync(join(flowDir, "subjects"), { recursive: true });
  mkdirSync(join(flowDir, "items"), { recursive: true });
  let n = 0;
  for (let i = 0; i < opts.nonClosed; i += 1) {
    n += 1;
    writeFileSync(
      join(flowDir, "subjects", `flow_${String(n).padStart(12, "0")}.json`),
      `${JSON.stringify({ subject_id: `flow_${String(n).padStart(12, "0")}`, session_id: sid, state: "active" })}\n`,
      "utf8",
    );
  }
  for (let i = 0; i < opts.closed; i += 1) {
    n += 1;
    writeFileSync(
      join(flowDir, "subjects", `flow_${String(n).padStart(12, "0")}.json`),
      `${JSON.stringify({ subject_id: `flow_${String(n).padStart(12, "0")}`, session_id: sid, state: "closed" })}\n`,
      "utf8",
    );
  }
  for (let i = 0; i < opts.items; i += 1) {
    writeFileSync(
      join(flowDir, "items", `item-${String(i)}.json`),
      `${JSON.stringify({ id: `item-${String(i)}`, session_id: sid })}\n`,
      "utf8",
    );
  }
  writeFileSync(
    join(flowDir, "index.json"),
    `${JSON.stringify({ schema: 1, session_id: sid, subject_ids: [] })}\n`,
    "utf8",
  );
}

function makeWakeSidecar(sid: string): void {
  const dir = join(root, "session", "wake-queue");
  mkdirSync(dir, { recursive: true });
  const doc = {
    schema: 2,
    session_id: sid,
    entries: [
      { id: "plan-1", source: "plan", action: "plan.build", at: 1000, payload: {}, created_at: 900, attempts: 0 },
      { id: "flow-1", source: "flow", action: "flow.check", at: 2000, payload: {}, created_at: 1900, attempts: 0 },
      { id: "flow-2", source: "special", action: "flow.check", at: 3000, payload: {}, created_at: 2900, attempts: 0 },
      { id: "special-1", source: "special", action: "special.continue", at: 4000, payload: {}, created_at: 3900, attempts: 0 },
    ],
    delivered: [],
  };
  writeFileSync(join(dir, `${sid}.json`), `${JSON.stringify(doc)}\n`, "utf8");
}

function readSidecarEntries(sid: string): unknown[] {
  const p = join(root, "session", "wake-queue", `${sid}.json`);
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  return parsed["entries"] as unknown[];
}

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function listArchives(): string[] {
  return readdirSync(root).filter((n) => n.startsWith("flow.retired-"));
}

beforeEach(() => {
  root = tmpRoot();
});
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dryRun", () => {
  it("不写入任何文件", () => {
    makeSession("s1", { nonClosed: 2, closed: 1, items: 3 });
    makeWakeSidecar("s1");
    const before = JSON.stringify(listTree(root));
    const report = dryRun({ stateRoot: root });
    const after = JSON.stringify(listTree(root));
    expect(after).toBe(before);
    expect(report.totalFlowDirs).toBe(1);
    expect(report.sessions[0]!.subjectCount).toBe(3);
    expect(report.sessions[0]!.nonClosedCount).toBe(2);
    expect(report.sessions[0]!.itemCount).toBe(3);
    expect(report.flowWakeEntries.length).toBe(2);
  });
});

describe("apply", () => {
  it("复制 flow 目录 + 写 manifest，原数据不变", () => {
    makeSession("s1", { nonClosed: 1, closed: 1, items: 2 });
    makeWakeSidecar("s1");
    const manifest = apply({ stateRoot: root });
    expect(existsSync(join(manifest.archivePath, "session", "s1", "flow", "index.json"))).toBe(true);
    expect(existsSync(join(manifest.archivePath, "retired.json"))).toBe(true);
    expect(existsSync(join(root, "session", "s1", "flow", "index.json"))).toBe(true);
    const m2 = JSON.parse(readFileSync(join(manifest.archivePath, "retired.json"), "utf8")) as FlowApplyManifest;
    expect(m2.tool).toBe("flow-retire");
    expect(m2.phase).toBe("A");
    expect(m2.sessions[0]!.sessionId).toBe("s1");
    expect(m2.totalCopiedFiles).toBeGreaterThan(0);
  });

  it("取消 flow 唤醒条目但保留 plan/special", () => {
    makeSession("s1", { nonClosed: 1, closed: 0, items: 0 });
    makeWakeSidecar("s1");
    const manifest = apply({ stateRoot: root });
    expect(manifest.wakeEntriesCanceled).toBe(2);
    const entries = readSidecarEntries("s1");
    const ids = entries.map((e) => (e as { id: string }).id).filter((v): v is string => v !== undefined).sort();
    expect(ids).toEqual(["plan-1", "special-1"]);
    const parsed = JSON.parse(readFileSync(join(root, "session", "wake-queue", "s1.json"), "utf8"));
    expect(parsed["schema"]).toBe(2);
    expect(parsed["session_id"]).toBe("s1");
    expect(parsed["delivered"]).toEqual([]);
  });

  it("存活实例锁时拒绝且不写入", () => {
    makeSession("s1", { nonClosed: 1, closed: 0, items: 0 });
    const lockDir = join(root, "session", "wake-queue");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, ".instance.json"), `${JSON.stringify({ pid: process.pid, started_at: Date.now() })}\n`, "utf8");
    expect(liveInstancePresent(root).present).toBe(true);
    expect(() => apply({ stateRoot: root })).toThrow(/实例锁/);
    expect(listArchives().length).toBe(0);
  });

  it("实例锁为非存活 pid 时不拒绝（接管口径）", () => {
    makeSession("s1", { nonClosed: 1, closed: 0, items: 0 });
    makeWakeSidecar("s1");
    const lockDir = join(root, "session", "wake-queue");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, ".instance.json"), `${JSON.stringify({ pid: 999999, started_at: Date.now() })}\n`, "utf8");
    expect(liveInstancePresent(root).present).toBe(false);
    const manifest = apply({ stateRoot: root });
    expect(manifest.sessions.length).toBe(1);
  });
});

describe("verify", () => {
  it("apply 后（手动清残留）verify 通过", () => {
    makeSession("s1", { nonClosed: 1, closed: 0, items: 0 });
    makeWakeSidecar("s1");
    apply({ stateRoot: root });
    rmSync(join(root, "session", "s1", "flow"), { recursive: true, force: true });
    const result = verify({ stateRoot: root });
    expect(result.ok).toBe(true);
    expect(result.flowDirsRemaining).toEqual([]);
    expect(result.flowWakeEntriesRemaining).toEqual([]);
  });

  it("原 flow 未删时 verify 失败", () => {
    makeSession("s1", { nonClosed: 1, closed: 0, items: 0 });
    makeWakeSidecar("s1");
    const result = verify({ stateRoot: root });
    expect(result.ok).toBe(false);
    expect(result.flowDirsRemaining).toContain("s1");
  });
});

describe("idempotent rerun", () => {
  it("重复 apply 创建新归档且不删原", () => {
    makeSession("s1", { nonClosed: 1, closed: 0, items: 0 });
    makeWakeSidecar("s1");
    const first = apply({ stateRoot: root });
    const second = apply({ stateRoot: root });
    expect(first.archivePath).not.toBe(second.archivePath);
    expect(existsSync(join(first.archivePath, "retired.json"))).toBe(true);
    expect(existsSync(join(second.archivePath, "retired.json"))).toBe(true);
    expect(existsSync(join(root, "session", "s1", "flow", "index.json"))).toBe(true);
  });
});
