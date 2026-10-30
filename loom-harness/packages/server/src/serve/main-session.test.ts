/**
 * T2 主会话解析单测：优先级、标记持久化、跨 boot 稳定、非法输入跳过与写盘 fail-soft。
 * 全程临时 stateRoot，不触碰生产 state；id 均为测试造号。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  mainSessionMarkerPath,
  resolveMainSession,
  type MainSessionMarker,
  type MainSessionSource,
} from "./main-session.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loom-main-session-"));
  roots.push(root);
  return root;
}

function marker(root: string): MainSessionMarker | null {
  const file = mainSessionMarkerPath(root);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as MainSessionMarker;
}

function seedMarker(root: string, sessionID: string, source: MainSessionSource = "marker"): void {
  const file = mainSessionMarkerPath(root);
  mkdirSync(join(root, "session"), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ sessionID, source, updatedAt: 1 })}\n`,
    "utf8",
  );
}

function warns(lines: readonly { level: string; msg: string }[]): string[] {
  return lines.filter((line) => line.level === "warn").map((line) => line.msg);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveMainSession 优先级", () => {
  it("config 最高优先：压过标记/调度/存储，并把标记改写成 config 来源", () => {
    const root = tempRoot();
    seedMarker(root, "ses_marked");
    const resolution = resolveMainSession({
      stateRoot: root,
      configMainSessionID: "ses_cfgmain",
      schedulingSessionID: "ses_sched",
      sessionIDs: () => ["ses_stored"],
      now: () => 1234,
    });

    expect(resolution).toEqual({ sessionID: "ses_cfgmain", source: "config" });
    expect(marker(root)).toEqual({
      sessionID: "ses_cfgmain",
      source: "config",
      updatedAt: 1234,
    });
  });

  it("无 config 时标记压过调度与存储（跨两次 boot 恒定）", () => {
    const root = tempRoot();
    const first = resolveMainSession({
      stateRoot: root,
      schedulingSessionID: "ses_sched",
      sessionIDs: () => ["ses_stored"],
    });
    expect(first).toEqual({ sessionID: "ses_sched", source: "scheduling" });

    const second = resolveMainSession({
      stateRoot: root,
      schedulingSessionID: "ses_other",
      sessionIDs: () => ["ses_other_store"],
    });
    expect(second).toEqual({ sessionID: "ses_sched", source: "marker" });
    expect(marker(root)?.sessionID).toBe("ses_sched");
    expect(marker(root)?.source).toBe("marker");
    expect(typeof marker(root)?.updatedAt).toBe("number");
  });

  it("无 config/标记时用 scheduling.sessionId（trim 后）", () => {
    const root = tempRoot();
    const resolution = resolveMainSession({
      stateRoot: root,
      schedulingSessionID: "  ses_sched  ",
      sessionIDs: () => ["ses_stored"],
      now: () => 7,
    });
    expect(resolution).toEqual({ sessionID: "ses_sched", source: "scheduling" });
    expect(marker(root)?.sessionID).toBe("ses_sched");
    expect(marker(root)?.source).toBe("scheduling");
  });

  it("无 config/标记/调度时用主 store 首个 sid", () => {
    const root = tempRoot();
    const resolution = resolveMainSession({
      stateRoot: root,
      sessionIDs: () => ["ses_stored", "ses_second"],
    });
    expect(resolution).toEqual({ sessionID: "ses_stored", source: "store" });
    expect(marker(root)?.source).toBe("store");
  });

  it("空 state 新造 id，二次 boot 走标记且 id 不变", () => {
    const root = tempRoot();
    let seq = 0;
    const newSessionID = (): string => `ses_gen${String(++seq)}`;
    const first = resolveMainSession({
      stateRoot: root,
      sessionIDs: () => [],
      newSessionID,
      now: () => 100,
    });
    expect(first).toEqual({ sessionID: "ses_gen1", source: "generated" });
    expect(marker(root)).toEqual({
      sessionID: "ses_gen1",
      source: "generated",
      updatedAt: 100,
    });

    const second = resolveMainSession({
      stateRoot: root,
      sessionIDs: () => [],
      newSessionID,
      now: () => 200,
    });
    expect(second).toEqual({ sessionID: "ses_gen1", source: "marker" });
    expect(marker(root)).toEqual({
      sessionID: "ses_gen1",
      source: "marker",
      updatedAt: 200,
    });
  });
});

describe("resolveMainSession 非法输入跳过", () => {
  it("非法 config id 只 WARN，继续下一来源", () => {
    const root = tempRoot();
    seedMarker(root, "ses_marked");
    const lines: Array<{ level: string; msg: string }> = [];
    const resolution = resolveMainSession({
      stateRoot: root,
      configMainSessionID: "bad-id",
      sessionIDs: () => ["ses_stored"],
      log: (level, msg) => lines.push({ level, msg }),
    });
    expect(resolution).toEqual({ sessionID: "ses_marked", source: "marker" });
    expect(warns(lines)).toContain("loom main session invalid server.mainSessionId (skipped)");
  });

  it("非法 scheduling id 只 WARN，落到 store", () => {
    const root = tempRoot();
    const lines: Array<{ level: string; msg: string }> = [];
    const resolution = resolveMainSession({
      stateRoot: root,
      schedulingSessionID: "bad id",
      sessionIDs: () => ["ses_stored"],
      log: (level, msg) => lines.push({ level, msg }),
    });
    expect(resolution).toEqual({ sessionID: "ses_stored", source: "store" });
    expect(warns(lines)).toContain("loom main session invalid scheduling.sessionId (skipped)");
  });

  it("坏标记（JSON/形状/sessionID）只 WARN，继续下一来源", () => {
    const root = tempRoot();
    mkdirSync(join(root, "session"), { recursive: true });
    const file = mainSessionMarkerPath(root);
    const cases = ["{broken", JSON.stringify({ sessionID: 42 }), JSON.stringify({ sessionID: "bad-id" })];
    for (const raw of cases) {
      writeFileSync(file, raw, "utf8");
      const lines: Array<{ level: string; msg: string }> = [];
      const resolution = resolveMainSession({
        stateRoot: root,
        sessionIDs: () => ["ses_stored"],
        log: (level, msg) => lines.push({ level, msg }),
      });
      expect(resolution).toEqual({ sessionID: "ses_stored", source: "store" });
      expect(warns(lines).length).toBe(1);
    }
  });

  it("非法 store 首 sid 只 WARN，最终新造", () => {
    const root = tempRoot();
    const lines: Array<{ level: string; msg: string }> = [];
    const resolution = resolveMainSession({
      stateRoot: root,
      sessionIDs: () => ["bad-id", "ses_second"],
      newSessionID: () => "ses_gen",
      log: (level, msg) => lines.push({ level, msg }),
    });
    expect(resolution).toEqual({ sessionID: "ses_gen", source: "generated" });
    expect(warns(lines)).toContain("loom main session invalid first store session id (skipped)");
  });
});

describe("resolveMainSession 持久化", () => {
  it("标记文件原子写：目录自动创建、成功后无 tmp 残留", () => {
    const root = tempRoot();
    resolveMainSession({ stateRoot: root, newSessionID: () => "ses_gen" });
    expect(existsSync(mainSessionMarkerPath(root))).toBe(true);
    const leftovers = readdirSync(join(root, "session")).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("写盘失败 fail-soft：WARN 后仍返回解析结果", () => {
    const root = tempRoot();
    const blocker = join(root, "blocked");
    writeFileSync(blocker, "not a directory", "utf8");
    const lines: Array<{ level: string; msg: string }> = [];
    const resolution = resolveMainSession({
      stateRoot: blocker,
      newSessionID: () => "ses_gen",
      log: (level, msg) => lines.push({ level, msg }),
    });
    expect(resolution).toEqual({ sessionID: "ses_gen", source: "generated" });
    expect(warns(lines)).toContain(
      "loom main session marker write failed (continuing in memory)",
    );
  });
});
