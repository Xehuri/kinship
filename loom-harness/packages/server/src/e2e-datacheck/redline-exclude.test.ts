/**
 * 红线扫描排除：健康监控根已包含 loom-harness 本体，harness 自身构建/测试缓存
 * （如 node_modules/.vite）不得被当成现网漂移。同时证明未排除时该文件可见。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { findFileNames, snapshotDrift, snapshotMtrees } from "./redline.js";

const TMP = mkdtempSync(join(tmpdir(), "redline-exclude-"));
const AI = join(TMP, "ai");
const HARNESS = join(TMP, "loom-harness");

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("redline 扫描排除子树", () => {
  it("snapshotMtrees 排除目录内的新增不计入漂移，findFileNames 同样跳过", () => {
    mkdirSync(AI, { recursive: true });
    mkdirSync(HARNESS, { recursive: true });
    writeFileSync(join(AI, "keep.txt"), "keep");
    writeFileSync(join(HARNESS, "skip.txt"), "skip");

    const before = snapshotMtrees(TMP, 5000, ["loom-harness"]);
    writeFileSync(join(AI, "new.txt"), "new");
    writeFileSync(join(HARNESS, "new2.txt"), "new2");
    const after = snapshotMtrees(TMP, 5000, ["loom-harness"]);

    expect(snapshotDrift(before, after, TMP)).toEqual(["ai/new.txt"]);
    expect(findFileNames(TMP, ["new2.txt"], 5000, ["loom-harness"])).toEqual([]);
    expect(findFileNames(TMP, ["new2.txt"], 5000).length).toBe(1);
  });
});
