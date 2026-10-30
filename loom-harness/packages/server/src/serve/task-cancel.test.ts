/**
 * W37 task_cancel 面测试 —— 挂面纪律 + 主/子同面实锤（直调装配，零真树依赖）。
 * Given: createServeToolWiring 直调（fake 模型 + tmp workspace），taskCancel 端口条件注入
 * When:  ①接口的面清单逐名对钉；②不接口的旧面逐字节不变；
 *        ③经 task 工具同步派发一次真子会话，从 fake 模型 getCalls 取证子会话收到的工具面
 * Then:  task_cancel 进 wrapAll 包痕数组 = 主/副门面在场，且与 childFace 同一数组
 *        （子会话模型调用 tools 名单 = wiring.tools 名单，task/task_fetch W9/W11 同款纪律）；
 *        不接 = 面上无该键（旧调用面零扰动先例）。
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeModel, createTestContext } from "@axeuh/loom-core/testing";
import type { SubTaskRecord } from "@axeuh/loom-core/kernel";
import type { TaskCancelSource } from "@axeuh/loom-core/subagent/task-cancel";

import { createServeToolWiring, type ServeToolWiring } from "./tool-wiring.js";

let root = "";
let ws = "";
let stateRoot = "";

/** 假账本口（仅寻址形状；面测试不驱动取消语义——语义在 core task-cancel.test.ts 已钉）。 */
const fakeSource: TaskCancelSource = {
  get: (_taskId: string): SubTaskRecord | undefined => undefined,
  cancel: (_taskId: string, _reason?: string): boolean => false,
};

function faceNames(w: ServeToolWiring): string[] {
  return w.tools.map((t) => t.name).sort();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loom-w37-face-"));
  ws = join(root, "ws");
  stateRoot = join(root, "state");
  mkdirSync(ws, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("W37 task_cancel 挂面纪律（taskFetchTools 同款条件口）", () => {
  it("接 taskCancel 口 → 主/副门面含 task_cancel（精确名单，非仅 contains）", async () => {
    const model = createFakeModel([]);
    try {
      const wiring = await createServeToolWiring({
        workspaceRoot: ws,
        stateRoot,
        model,
        llmOptions: {},
        taskCancel: fakeSource,
      });
      expect(faceNames(wiring)).toEqual(
        [
          "bash", "edit", "find", "grep", "ls", "read", "task", "task_cancel", "write",
          "pty_spawn", "pty_write", "pty_read", "pty_list", "pty_kill",
        ].sort(),
      );
    } finally {
      model.teardown();
    }
  }, 30_000);

  it("不接 taskCancel 口 → 旧面逐字节不变（缺省不挂纪律，含键缺席实锤）", async () => {
    const model = createFakeModel([]);
    try {
      const wiring = await createServeToolWiring({
        workspaceRoot: ws,
        stateRoot,
        model,
        llmOptions: {},
      });
      expect(faceNames(wiring)).not.toContain("task_cancel");
      expect(faceNames(wiring)).toEqual(
        [
          "bash", "edit", "find", "grep", "ls", "read", "task", "write",
          "pty_spawn", "pty_write", "pty_read", "pty_list", "pty_kill",
        ].sort(),
      );
    } finally {
      model.teardown();
    }
  }, 30_000);

  it(
    "子会话同面实锤：task 同步派发 → 子模型调用的 tools 名单 = wiring.tools 名单（childFace=同一 wrapAll 数组，task/task_fetch W9/W11 先例镜像）",
    async () => {
      // 脚本消费序：#0 = 子会话唯一一轮纯文本收尾（同步派发管线等子终态）。
      const model = createFakeModel([{ content: [{ type: "text", text: "w37-child-done" }] }]);
      try {
        const wiring = await createServeToolWiring({
          workspaceRoot: ws,
          stateRoot,
          model,
          llmOptions: {},
          taskCancel: fakeSource,
        });
        const task = wiring.tools.find((t) => t.name === "task");
        expect(task).toBeDefined();
        const { ctx } = createTestContext();
        const result = await task!.execute(
          { agent_type: "general", task: "说一句收口" },
          ctx,
          new AbortController().signal,
        );
        expect(JSON.stringify(result.content)).toContain("<task_metadata>");
        // 子会话是本轮唯一模型调用方（父侧为直调 execute，不发起父模型轮）。
        const calls = model.getCalls();
        expect(calls.length, "子会话应恰好发起一轮模型调用").toBe(1);
        const childTools = (calls[0]?.tools ?? []).map((t) => (t as { name: string }).name).sort();
        expect(childTools).toContain("task_cancel");
        // 同面强钉：子名单与主面名单逐项相等（同一 wrapped 数组的透传实锤，非二次装配）。
        expect(childTools).toEqual(faceNames(wiring));
      } finally {
        model.teardown();
      }
    },
    30_000,
  );
});
