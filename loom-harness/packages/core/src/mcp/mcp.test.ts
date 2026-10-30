/**
 * T23 验收：fake-MCP 子进程对两个工具 round-trip（tools/list → tools/call），
 * 语义兼容 fixture-workspace/.opencode/ai_mcp.py（send_notification / tts_speak）。
 * 另覆盖：id 乱序关联、超时、子进程死亡、协议违规、spawn 失败、stderr/cwd/env 透传、
 * close 幂等 + 无孤儿进程。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { McpClient } from "./client.js";
import {
  McpClosedError,
  McpProcessExitedError,
  McpProtocolError,
  McpRpcError,
  McpSpawnError,
  McpTimeoutError,
} from "./errors.js";
import type { McpStderrSink } from "./types.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "fake-mcp-server.mjs");
const LONG = 20_000;

function baseSpec(overrides?: {
  cwd?: string;
  env?: Record<string, string>;
  cmd?: string;
  args?: string[];
}) {
  return {
    cmd: overrides?.cmd ?? process.execPath,
    args: overrides?.args ?? [FIXTURE],
    ...(overrides?.cwd !== undefined ? { cwd: overrides.cwd } : {}),
    ...(overrides?.env !== undefined ? { env: overrides.env } : {}),
  };
}

function textOf(result: Awaited<ReturnType<McpClient["callTool"]>>): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected first content block to be text");
  }
  return first.text;
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-mcp-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function assertPidGone(pid: number | undefined): void {
  expect(pid).toBeTypeOf("number");
  let alive = true;
  try {
    process.kill(pid as number, 0);
  } catch {
    alive = false;
  }
  expect(alive, `child pid ${String(pid)} should be reaped`).toBe(false);
}

describe("McpClient / round-trip（ai_mcp 两工具）", () => {
  it(
    "start→tools/list→tools/call 两个工具语义回显",
    async () => {
      const cwd = makeTmpDir();
      const stderrLines: string[] = [];
      const onStderr: McpStderrSink = (l) => stderrLines.push(l);
      const client = await McpClient.start(baseSpec({ cwd }), { onStderr });
      try {
        // 握手元信息：env 透传 + serverInfo
        expect(client.serverInfo.name).toBe("fake-ai-mcp");

        const tools = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(["send_notification", "tts_speak"]);

        const notify = tools.find((t) => t.name === "send_notification");
        expect(notify?.description).toContain("手机发送一条系统通知");
        const notifySchema = notify?.inputSchema as {
          properties: Record<string, unknown>;
          required: string[];
        };
        expect(Object.keys(notifySchema.properties)).toEqual(["title", "content", "response_format"]);
        expect(notifySchema.required).toEqual(["title", "content"]);

        const tts = tools.find((t) => t.name === "tts_speak");
        expect(tts?.description).toContain("TTS语音合成");
        const ttsSchema = tts?.inputSchema as { required: string[] };
        expect(ttsSchema.required).toEqual(["text"]);

        const r1 = await client.callTool("send_notification", {
          title: "系统提醒",
          content: "任务完成",
        });
        expect(r1.isError).toBeUndefined();
        expect(textOf(r1)).toBe("通知已发送: 系统提醒 (count=1)");

        const r2 = await client.callTool("tts_speak", { text: "你好，世界", voice: "mimo_default" });
        expect(textOf(r2)).toBe('TTS语音已成功发送: "你好，世界" (count=1)');

        // 计数语义：第二次调用递增
        const r3 = await client.callTool("send_notification", { title: "第二次", content: "x" });
        expect(textOf(r3)).toBe("通知已发送: 第二次 (count=2)");

        // stderr 透传：首行含 ready + cwd，且工具调用行也到达回调
        expect(stderrLines[0]).toBe(`ready cwd=${cwd}`);
        expect(stderrLines).toContain("initialized");
        expect(stderrLines.some((l) => l.startsWith("tool send_notification #"))).toBe(true);
      } finally {
        await client.close();
        assertPidGone(client.pid);
      }
    },
    LONG,
  );

  it("env 段透传给子进程（serverInfo.version 回显）", async () => {
    const client = await McpClient.start(
      baseSpec({ env: { FAKE_MCP_ENV_TEST: "env-ok-123" } }),
    );
    try {
      expect(client.serverInfo.version).toBe("env-ok-123");
    } finally {
      await client.close();
    }
  }, LONG);

  it("长文本 preview 截断 50 字符（兼容 ai_mcp.py 语义）", async () => {
    const client = await McpClient.start(baseSpec());
    try {
      const long = "啊".repeat(60);
      const r = await client.callTool("tts_speak", { text: long });
      expect(textOf(r)).toBe(`TTS语音已成功发送: "${"啊".repeat(50)}..." (count=1)`);
    } finally {
      await client.close();
    }
  }, LONG);
});

describe("McpClient / 请求 id 关联与乱序", () => {
  it("并发请求乱序完成也按 id 正确回填", async () => {
    const client = await McpClient.start(baseSpec());
    try {
      const slow = client.callTool("send_notification", {
        title: "slow",
        content: "c",
        __delay_ms: 300,
      });
      const fast = client.callTool("send_notification", { title: "fast", content: "c" });
      const rFast = await fast;
      expect(textOf(rFast)).toBe("通知已发送: fast (count=1)");
      const rSlow = await slow;
      expect(textOf(rSlow)).toBe("通知已发送: slow (count=2)");
    } finally {
      await client.close();
    }
  }, LONG);

  it("未知工具 → McpRpcError（JSON-RPC error 帧）", async () => {
    const client = await McpClient.start(baseSpec());
    try {
      await expect(client.callTool("no_such_tool", {})).rejects.toBeInstanceOf(McpRpcError);
      // rpc 错误后可继续用
      const tools = await client.listTools();
      expect(tools).toHaveLength(2);
    } finally {
      await client.close();
    }
  }, LONG);
});

describe("McpClient / 超时与协议", () => {
  it("请求超时 → McpTimeoutError，且客户端随后可继续服务", async () => {
    const client = await McpClient.start(baseSpec(), { requestTimeoutMs: 150 });
    try {
      await expect(
        client.callTool("send_notification", { title: "t", content: "c", __delay_ms: 1_000 }),
      ).rejects.toBeInstanceOf(McpTimeoutError);
      // 迟到响应被忽略；新请求正常
      const ok = await client.callTool("tts_speak", { text: "after-timeout" });
      expect(textOf(ok)).toContain("TTS语音已成功发送");
    } finally {
      await client.close();
    }
  }, LONG);

  it("非法帧 → McpProtocolError，在途请求全部失败", async () => {
    const client = await McpClient.start(baseSpec());
    try {
      await expect(
        client.callTool("send_notification", { title: "__badframe__", content: "c" }),
      ).rejects.toBeInstanceOf(McpProtocolError);
    } finally {
      await client.close();
      assertPidGone(client.pid);
    }
  }, LONG);
});

describe("McpClient / 子进程死亡与关闭", () => {
  it("服务进程中途退出 → McpProcessExitedError，后续请求同样类型化失败", async () => {
    const client = await McpClient.start(baseSpec());
    const pid = client.pid;
    expect(pid).toBeTypeOf("number");
    await expect(client.callTool("tts_speak", { text: "__die__" })).rejects.toBeInstanceOf(
      McpProcessExitedError,
    );
    await expect(client.listTools()).rejects.toBeInstanceOf(McpProcessExitedError);
    // close 对已死进程不得挂起
    await client.close();
    assertPidGone(pid);
  }, LONG);

  it("close 幂等；关闭后请求 → McpClosedError", async () => {
    const client = await McpClient.start(baseSpec());
    await client.close();
    await client.close();
    await expect(client.listTools()).rejects.toBeInstanceOf(McpClosedError);
    assertPidGone(client.pid);
  }, LONG);

  it("spawn 失败（命令不存在）→ McpSpawnError，且 start 不留孤儿子进程", async () => {
    await expect(
      McpClient.start(baseSpec({ cmd: "/nonexistent/loom-t23-fake-cmd" })),
    ).rejects.toBeInstanceOf(McpSpawnError);
  }, LONG);
});
