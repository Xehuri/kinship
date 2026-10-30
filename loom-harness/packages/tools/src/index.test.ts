/**
 * @axeuh/loom-tools 冒烟测试（替换 T01 占位）。
 * 深度行为测试见 __tests__/tools.test.ts 与 __tests__/pi-compat.test.ts；
 * 本文件验收计划点名的两条：七件套 factory 正常构造、bash 工具在
 * fixture-workspace cwd 跑 echo。
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestContext } from "@axeuh/loom-core/testing";
import { createAllTools, createBashTool, toolNames } from "./index.js";

const fixtureWorkspace = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../fixture-workspace",
);

describe("loom-tools smoke", () => {
  it("exports the seven first-party tool names", () => {
    expect([...toolNames]).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
    const all = createAllTools(fixtureWorkspace);
    for (const name of toolNames) {
      expect(all[name].name).toBe(name);
    }
  });

  it("bash tool runs echo in the fixture-workspace cwd", async () => {
    const tool = createBashTool(fixtureWorkspace);
    const signal = new AbortController().signal;
    const result = await tool.execute(
      { command: "echo loom-tools-ok && pwd" },
      createTestContext({ signal }).ctx,
      signal,
    );
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("expected text result");
    expect(first.text).toContain("loom-tools-ok");
    // defaultExec 的 $PWD 应落在 fixture-workspace（symlink 场景用 realpath 对比）。
    const printedCwd = first.text.split("\n").filter((line) => line.length > 0).at(-1);
    if (printedCwd === undefined) throw new Error("pwd output missing");
    await expect(realpath(printedCwd)).resolves.toBe(
      await realpath(fixtureWorkspace),
    );
  });
});
