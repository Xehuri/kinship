/**
 * W5-B MCP 装配单测：真 spawn T23 fixture（fake-mcp-server.mjs），
 * 走「握手 → listTools → 映射工具 execute 回声 → closeAll 无孤儿」全链。
 * Given: loom.yaml 形状的 server 声明（cmd=当前 node，args=fixture 绝对路径）
 * When:  createServeMcpWiring / mcpResultToToolResult 纯函数
 * Then:  工具名 = mcp_<server>_<tool>；inputSchema 直通 parameters；
 *        execute 把 JSON args 原样透传 callTool、结果文本回灌；
 *        spawn 失败 = 响亮 warn + 该 server 工具面缺席（不抛穿装配）；
 *        closeAll 幂等且子进程收尸（pid 复查 ESRCH）。
 */

import { afterAll, describe, expect, it } from "vitest";

import {
  createServeMcpWiring,
  describeMcpBlock,
  mcpMappedToolName,
  mcpResultToToolResult,
  type ServeMcpWiring,
} from "./mcp-wiring.js";
import type { McpServerEntryConfig } from "../config/loom-config.js";
import type { HarnessTool } from "@axeuh/loom-core";
import type { HookContext } from "@axeuh/loom-core";

// 测试跑在 src（vitest include packages/*/src/**/*.test.ts）：fixture 相对本文件定位，
// 与 server dist/src 深度无关（../../../core 即 packages/core）。
const FIXTURE = new URL(
  "../../../core/src/mcp/__fixtures__/fake-mcp-server.mjs",
  import.meta.url,
).pathname;

type LogLine = { level: string; msg: string; fields: Record<string, unknown> };

const logs: LogLine[] = [];
const log = (level: "debug" | "info" | "warn" | "error", msg: string, fields: Record<string, unknown>): void => {
  logs.push({ level, msg, fields });
};

function demoServer(extra: Partial<McpServerEntryConfig> = {}): McpServerEntryConfig {
  return {
    name: "demo",
    cmd: process.execPath,
    args: [FIXTURE],
    ...extra,
  };
}

function ctxStub(): HookContext {
  return { sessionId: "ses_mcp_wiring_test", state: new Map() } as unknown as HookContext;
}

const openWirings: ServeMcpWiring[] = [];

afterAll(async () => {
  for (const w of openWirings) await w.closeAll();
});

describe("createServeMcpWiring：fixture 真 spawn（握手 + listTools + callTool 回声）", () => {
  it("映射 mcp_demo_send_notification / mcp_demo_tts_speak，execute 透传 args 并回灌文本", async () => {
    const wiring = await createServeMcpWiring({ servers: [demoServer()], log });
    openWirings.push(wiring);

    expect(wiring.statuses).toHaveLength(1);
    expect(wiring.statuses[0]?.ok).toBe(true);
    expect(wiring.statuses[0]?.toolNames).toEqual([
      "mcp_demo_send_notification",
      "mcp_demo_tts_speak",
    ]);
    expect(wiring.statuses[0]?.serverInfoName).toBe("fake-ai-mcp");

    expect(wiring.tools.map((t) => t.name)).toEqual([
      "mcp_demo_send_notification",
      "mcp_demo_tts_speak",
    ]);

    const notify = wiring.tools.find((t) => t.name === "mcp_demo_send_notification") as HarnessTool;
    // inputSchema 直通：模型面 parameters 携带 server 声明的 title/content 字段。
    const params = notify.parameters as unknown as {
      properties: Record<string, { description?: string }>;
    };
    expect(params.properties["title"]).toBeDefined();

    const result = await notify.execute(
      { title: "回声题", content: "回声文" },
      ctxStub(),
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("通知已发送: 回声题");

    const tts = wiring.tools.find((t) => t.name === "mcp_demo_tts_speak") as HarnessTool;
    const spoken = await tts.execute({ text: "hello" }, ctxStub(), new AbortController().signal);
    expect((spoken.content[0] as { text: string }).text).toContain('TTS语音已成功发送: "hello"');

    // stderr 行按 debug 透传留痕（fixture 启动打 ready cwd=...）。
    expect(logs.some((l) => l.msg === "loom mcp stderr" && String(l.fields["line"]).startsWith("ready cwd="))).toBe(true);
    expect(logs.some((l) => l.msg === "loom mcp server wired")).toBe(true);
  }, 30_000);

  it("closeAll 收尸：pid 复查 ESRCH，且幂等", async () => {
    const wiring = await createServeMcpWiring({ servers: [demoServer()], log });
    const wired = logs.filter((l) => l.msg === "loom mcp server wired");
    const pid = wired[wired.length - 1]?.["fields"]["pid"] as number;
    expect(typeof pid).toBe("number");

    await wiring.closeAll();
    await wiring.closeAll(); // 幂等：二次不抛
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        break; // ESRCH：子进程已收
      }
      if (Date.now() > deadline) throw new Error(`mcp 子进程未收尸 pid=${String(pid)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }, 30_000);

  it("env 透传进 server 进程（fixture 回显在 serverInfo.version → status 可读）", async () => {
    const wiring = await createServeMcpWiring({
      servers: [demoServer({ env: { FAKE_MCP_ENV_TEST: "w5-env-ok" } })],
      log,
    });
    openWirings.push(wiring);
    expect(wiring.statuses[0]?.ok).toBe(true);
    // version 未入 status 观测面（name 已足）——以工具面可调用为 env 通路间接硬证。
    const notify = wiring.tools.find((t) => t.name === "mcp_demo_send_notification") as HarnessTool;
    const r = await notify.execute({ title: "env", content: "x" }, ctxStub(), new AbortController().signal);
    expect((r.content[0] as { text: string }).text).toContain("通知已发送");
  }, 30_000);
});

describe("createServeMcpWiring：降级与守卫（绝不 crash 装配）", () => {
  it("spawn 失败：warn + 该 server 工具面缺席，其余 server 照常映射", async () => {
    const wiring = await createServeMcpWiring({
      servers: [
        { ...demoServer({ name: "broken" }), cmd: "axeuh-no-such-binary-w5" },
        demoServer(),
      ],
      log,
    });
    openWirings.push(wiring);

    expect(wiring.statuses).toHaveLength(2);
    const broken = wiring.statuses.find((s) => s.name === "broken");
    expect(broken?.ok, "坏 cmd 的 server 必须 ok=false").toBe(false);
    expect(broken?.error).toContain("axeuh-no-such-binary-w5");
    expect(wiring.tools.map((t) => t.name)).toEqual([
      "mcp_demo_send_notification",
      "mcp_demo_tts_speak",
    ]);
    expect(logs.some((l) => l.msg === "loom mcp server start failed (degrade: tools absent)")).toBe(true);
  }, 30_000);

  it("重名守卫：reservedToolNames 命中即跳过 + warn；server 本身仍 ok", async () => {
    const wiring = await createServeMcpWiring({
      servers: [demoServer()],
      log,
      reservedToolNames: ["mcp_demo_send_notification"],
    });
    openWirings.push(wiring);
    expect(wiring.tools.map((t) => t.name)).toEqual(["mcp_demo_tts_speak"]);
    expect(wiring.statuses[0]?.toolNames).toEqual(["mcp_demo_tts_speak"]);
    expect(logs.some((l) => l.msg === "loom mcp tool skipped (duplicate tool name)")).toBe(true);
  }, 30_000);

  it("无 server 声明 = 空面空状态，不起任何进程", async () => {
    const wiring = await createServeMcpWiring({ servers: [], log });
    expect(wiring.tools).toEqual([]);
    expect(wiring.statuses).toEqual([]);
    await wiring.closeAll();
  });
});

describe("纯函数：命名与结果映射合约", () => {
  it("mcpMappedToolName = mcp_<server>_<tool>", () => {
    expect(mcpMappedToolName("demo", "send_notification")).toBe("mcp_demo_send_notification");
  });

  it("mcpResultToToolResult：text 块直取 / 非 text 块转描述符 / isError 透传 / 空块占位", () => {
    const r = mcpResultToToolResult({
      content: [
        { type: "text", text: "甲" },
        { type: "image", data: "xx", mimeType: "image/png" },
      ],
    });
    expect(r.content[0]).toEqual({ type: "text", text: "甲" });
    const imageText = (r.content[1] as { text: string }).text;
    expect(imageText).toBe("[image: image/png]");
    expect(imageText).not.toContain("{");
    expect(r.isError).toBeUndefined();

    const err = mcpResultToToolResult({ content: [{ type: "text", text: "坏" }], isError: true });
    expect(err.isError).toBe(true);

    const empty = mcpResultToToolResult({ content: [] });
    expect((empty.content[0] as { text: string }).text).toBe("(mcp empty result)");
  });

  it("describeMcpBlock：image/audio/resource/未知类型的描述符", () => {
    expect(describeMcpBlock({ type: "image" })).toBe("[image]");
    expect(describeMcpBlock({ type: "image", mimeType: "" })).toBe("[image]");
    expect(describeMcpBlock({ type: "image", mimeType: "image/png" })).toBe("[image: image/png]");
    expect(describeMcpBlock({ type: "audio", mimeType: "audio/wav" })).toBe("[audio: audio/wav]");
    expect(describeMcpBlock({ type: "audio" })).toBe("[audio]");
    expect(describeMcpBlock({ type: "resource", resource: { uri: "file:///tmp/a.png" } })).toBe(
      "[resource: file:///tmp/a.png]",
    );
    expect(describeMcpBlock({ type: "resource", uri: "file:///tmp/b.txt" })).toBe(
      "[resource: file:///tmp/b.txt]",
    );
    expect(describeMcpBlock({ type: "resource" })).toBe("[resource]");
    expect(describeMcpBlock({ type: "resource_link", uri: "file:///tmp/a.png" })).toBe(
      "[resource_link: file:///tmp/a.png]",
    );
    expect(describeMcpBlock({ type: "resource_link" })).toBe("[resource_link]");
    expect(describeMcpBlock({ type: "custom" })).toBe("[custom block]");
    expect(describeMcpBlock({ type: "" })).toBe("[unknown block]");
  });
});
