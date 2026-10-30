/**
 * 嵌套布局回归：loom-harness 置于 monorepo 根（生产名为 axeuh-health-monitor）之内后，
 * scene.ts 的根解析必须仍指向 monorepo 根，且仓库 fixture 位于 loom-harness 内。
 *
 * 注：迁移暂存 worktree 的 monorepo 目录名为 import-wt，故根目录名按「harness 根的父目录」
 * 断言；生产布局下该名即 axeuh-health-monitor。
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HEALTH_MONITOR_ROOT, REPO_FIXTURE_WS } from "./scene.js";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("scene 根路径（loom-harness 嵌套于 axeuh-health-monitor）", () => {
  it("HEALTH_MONITOR_ROOT 指向 harness 的父目录（生产名 axeuh-health-monitor）且含 ai/backend", () => {
    expect(HEALTH_MONITOR_ROOT).toBe(dirname(HARNESS_ROOT));
    expect(basename(HEALTH_MONITOR_ROOT)).toBe(basename(dirname(HARNESS_ROOT)));
    expect(existsSync(join(HEALTH_MONITOR_ROOT, "ai"))).toBe(true);
    expect(existsSync(join(HEALTH_MONITOR_ROOT, "backend"))).toBe(true);
  });

  it("REPO_FIXTURE_WS 位于 loom-harness 内", () => {
    expect(basename(REPO_FIXTURE_WS)).toBe("fixture-workspace");
    expect(basename(dirname(REPO_FIXTURE_WS))).toBe("loom-harness");
  });
});
