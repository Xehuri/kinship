/**
 * W16-B 上下文全字节面验收（GET /sessions/:id/context/full）。
 *   单元面：buildContextFull 纯函数 —— 用 core 真 assembler（assemble/renderAssemblyPrefix）
 *   造 fixture，钉死偏移/字节数/恒等式/零截断（CJK 多字节混入，防"字符数=字节数"假绿）。
 *   端点面：fake 模型全链 e2e（复用 boot-assembly.test.ts W15-B describe 的收包口姿势）——
 *   响应 systemPrompt 与模型**实收**字节全等；transient 提醒模型收到但本视图排除；
 *   W13 /context 旧形状不变（additive）；404/400 错误口径。
 */

import { deepStrictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySessionStore, type Message } from "@axeuh/loom-core";
import { assemble, renderAssemblyPrefix, type AssemblyPlan } from "@axeuh/loom-core/assembly";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { createFakeModelFromConfig, FAKE_PROVIDER } from "../fake-model/index.js";
import { Router } from "../http/router.js";
import { SessionRegistry, registerSessionRoutes, type SessionApiDeps } from "./index.js";
import { buildContextFull, type ContextFullView } from "./context-full.js";

const GOOD_TOKEN = "tok-context-full-test";
const IDLE_TIMEOUT_MS = 20_000;

const FAKE_YAML = [
  "server:",
  "  port: 5103",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-context-full-workspace",
  "models:",
  "  - id: fake-full",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
].join("\n");

const PLAN: AssemblyPlan = {
  systemPrompt: "你是 loom 主会话。",
  memorySources: [{ source: "AGENTS.md", content: "# 工作区记忆\nW16-B 全字节面哨兵\n", degrade: null }],
  workflows: [{ name: "quick", prompt: "快速通道。\n" }],
};

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sha256Prefixed(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

/** provider 投影口径（e2e 实测钉死）：toolResult 的 `details` 是 harness 侧元数据、
 * 不进模型上线视图——比对双方先剥此键再判结构等值。 */
function stripHarnessMeta(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("details" in value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy["details"];
  return copy;
}

/** 序列化文本 vs 对象的结构等值（忽略键序与 harness 元数据 details）。 */
function jsonEquals(text: string, value: unknown): boolean {
  try {
    deepStrictEqual(stripHarnessMeta(JSON.parse(text)), stripHarnessMeta(value));
    return true;
  } catch {
    return false;
  }
}

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("W16-B buildContextFull 单元：真 assembler fixture 钉偏移/字节/恒等式", () => {
  const systemPrompt = renderAssemblyPrefix(PLAN);
  const assembly = assemble(PLAN, null, { historyCursor: 0, nudges: ["快收"], currentMessage: "你好" });
  const messages: readonly Message[] = [
    { role: "user", content: "第一轮你好（CJK 多字节）", timestamp: 111 },
    {
      role: "assistant",
      content: [{ type: "text", text: "收口。" }],
      api: "fake",
      provider: "fake",
      model: "fake-full",
      usage: USAGE,
      stopReason: "stop",
      timestamp: 222,
    },
  ];

  function build(): ContextFullView {
    return buildContextFull({
      sessionID: "ses_full_unit",
      capturedAt: 987654321,
      systemPrompt,
      assembly,
      messages,
      contextWindow: 200000,
    });
  }

  it("冻结契约字段集（Lane C 逐字对齐口径）", () => {
    const view = build();
    expect(Object.keys(view).sort()).toEqual([
      "basis",
      "capturedAt",
      "contextWindow",
      "messages",
      "messagesByteLength",
      "note",
      "prefixByteLength",
      "prefixHash",
      "segments",
      "sessionID",
      "systemPrompt",
      "systemPromptSha256",
      "totalPromptByteLength",
      "transientExcluded",
    ]);
    expect(view.basis).toBe("live");
    expect(view.transientExcluded).toBe(true);
    expect(view.sessionID).toBe("ses_full_unit");
    expect(view.capturedAt).toBe(987654321);
    expect(view.contextWindow).toBe(200000);
    expect(view.note).toContain("transient");
  });

  it("恒等式 systemPromptSha256 === prefixHash（装配声明值，W15-B 同源）", () => {
    const view = build();
    expect(view.systemPromptSha256).toBe(sha256Prefixed(systemPrompt));
    expect(view.prefixHash).toBe(assembly.prefixHash);
    expect(view.systemPromptSha256).toBe(view.prefixHash);
  });

  it("segments 只列 stable 段且字节可寻址：偏移累加含段间 1 字节分隔位", () => {
    const view = build();
    expect(view.segments.map((s) => s.label)).toEqual(["system", "memory", "workflow"]);
    expect(view.segments.map((s) => s.index)).toEqual([0, 1, 2]);

    const prefixBuf = Buffer.from(systemPrompt, "utf8");
    expect(view.prefixByteLength).toBe(prefixBuf.byteLength);
    let expectedOffset = 0;
    for (const seg of view.segments) {
      expect(seg.offset).toBe(expectedOffset);
      expect(seg.byteLength).toBe(byteLen(seg.text));
      // 段体在真实 systemPrompt 字节里的切片全等（CJK 起界不错位）。
      expect(prefixBuf.slice(seg.offset, seg.offset + seg.byteLength).toString("utf8")).toBe(seg.text);
      expectedOffset += seg.byteLength + 1; // 段间 SEGMENT_SEP
    }
    expect(expectedOffset - 1).toBe(view.prefixByteLength); // 末段无尾分隔 ⇒ 恰好铺满前缀
  });

  it("messages 完整序列化 + 偏移续接前缀：零截断、键序无关", () => {
    const view = build();
    expect(view.messages.length).toBe(messages.length);
    view.messages.forEach((entry, i) => {
      expect(entry.index).toBe(i);
      expect(jsonEquals(entry.text, messages[i])).toBe(true); // 全文等值，非片段
    });
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(view.messages[0]!.text).toContain("第一轮你好（CJK 多字节）"); // 内容完整在场

    // 偏移连续性：首条 = 前缀字节 + 1（分隔），其后逐条累加。
    expect(view.messages[0]!.offset).toBe(view.prefixByteLength + 1);
    for (let i = 1; i < view.messages.length; i++) {
      expect(view.messages[i]!.offset).toBe(
        view.messages[i - 1]!.offset + view.messages[i - 1]!.byteLength,
      );
    }
    const total = view.messages.reduce((n, m) => n + m.byteLength, 0);
    expect(view.messagesByteLength).toBe(total);
    expect(view.totalPromptByteLength).toBe(view.prefixByteLength + 1 + total);
    expect(view.totalPromptByteLength).toBe(
      byteLen(systemPrompt + "\n" + view.messages.map((m) => m.text).join("")),
    );
  });

  it("同一消息键序打乱 → 序列化文本全等（canonical 稳定性，防序抖动进偏移）", () => {
    const a = buildContextFull({
      sessionID: "s",
      capturedAt: 1,
      systemPrompt: "",
      assembly: null,
      messages: [{ role: "user", content: "hi", timestamp: 5 }],
      contextWindow: null,
    });
    const b = buildContextFull({
      sessionID: "s",
      capturedAt: 1,
      systemPrompt: "",
      assembly: null,
      // 同一消息、插入序不同（timestamp 在前）。
      messages: [{ timestamp: 5, role: "user", content: "hi" } as Message],
      contextWindow: null,
    });
    expect(a.messages[0]!.text).toBe(b.messages[0]!.text);
  });

  it("空转录：无分隔位、总量=前缀；无装配：prefixHash 如实回退为发送字节哈希", () => {
    const empty = buildContextFull({
      sessionID: "ses_full_unit",
      capturedAt: 2,
      systemPrompt,
      assembly,
      messages: [],
      contextWindow: null,
    });
    expect(empty.messages).toEqual([]);
    expect(empty.messagesByteLength).toBe(0);
    expect(empty.totalPromptByteLength).toBe(empty.prefixByteLength);
    expect(empty.contextWindow).toBeNull();

    const noAssembly = buildContextFull({
      sessionID: "ses_full_unit",
      capturedAt: 3,
      systemPrompt: "纯 systemPrompt 直连（无装配）。",
      assembly: null,
      messages: [{ role: "user", content: "喂", timestamp: 9 }],
      contextWindow: 1000,
    });
    expect(noAssembly.segments).toEqual([]);
    expect(noAssembly.prefixHash).toBe(noAssembly.systemPromptSha256);
    expect(noAssembly.prefixHash).toBe(sha256Prefixed(noAssembly.systemPrompt));
    expect(noAssembly.messages[0]!.offset).toBe(noAssembly.prefixByteLength + 1);
  });
});

/* ───────────────────────── 端点面：假模型全链 e2e ───────────────────────── */

interface CapturedCall {
  readonly systemPrompt?: string;
  readonly messages: readonly unknown[];
}

function convergeTurn(text: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
    ],
  };
}

let server: Server | null = null;
let baseUrl = "";
let stateRoot = "";

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-context-full-"));
});

afterEach(async () => {
  const s = server;
  server = null;
  if (s !== null) {
    s.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }
  rmSync(stateRoot, { recursive: true, force: true });
});

function makeRegistry(script: readonly FakeAssistantResponse[]): {
  registry: SessionRegistry;
  calls: () => CapturedCall[];
  teardown: () => void;
} {
  const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
  const model = createFakeModelFromConfig(cfg.models[0]!, [...script]);
  const registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    assembly: { plan: PLAN, reader: null },
  });
  const calls = (): CapturedCall[] =>
    (model as unknown as { getCalls(): CapturedCall[] }).getCalls();
  return { registry, calls, teardown: () => model.teardown() };
}

async function listen(deps: SessionApiDeps): Promise<void> {
  const router = new Router({ tokens: [GOOD_TOKEN] });
  registerSessionRoutes(router, deps);
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${GOOD_TOKEN}`, ...(init?.headers ?? {}) },
  });
}

async function sendTurn(sessionID: string, text: string): Promise<void> {
  const sent = await api(`/sessions/${encodeURIComponent(sessionID)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(sent.status).toBe(202);
}

async function waitForIdle(registry: SessionRegistry, sessionID: string): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  for (;;) {
    if (registry.statusView(sessionID)?.status === "idle" && registry.get(sessionID)?.running === null) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting idle for ${sessionID}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("W16-B /context/full 端点：字节面 vs 模型实收（fake 模型收包口）", () => {
  it("三轮主会话：响应 systemPrompt=模型实收字节；转录逐条等值进过请求面；transient 提醒发而不入视图", async () => {
    const { registry, calls, teardown } = makeRegistry([
      convergeTurn("首轮正文"),
      convergeTurn("次轮正文"),
      convergeTurn("三轮正文"),
    ]);
    await listen({ registry });
    try {
      const created = await api("/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(created.status).toBe(201);
      const { sessionID } = (await created.json()) as { sessionID: string };

      // 未跑轮：live 200（装配未发生 → segments 空、prefixHash 回退=发送字节哈希）。
      const pre = await api(`/sessions/${encodeURIComponent(sessionID)}/context/full`);
      expect(pre.status).toBe(200);
      const preView = (await pre.json()) as ContextFullView;
      expect(preView.basis).toBe("live");
      expect(preView.segments).toEqual([]);
      expect(preView.messages).toEqual([]);
      expect(preView.prefixHash).toBe(preView.systemPromptSha256);

      await sendTurn(sessionID, "取证第一轮");
      await waitForIdle(registry, sessionID);
      await sendTurn(sessionID, "取证第二轮");
      await waitForIdle(registry, sessionID);

      // W12 transient 通道：提醒入队，下一轮边界随注入发模型、绝不进 durable 转录。
      registry.queueReminder(sessionID, "W16-TRANSIENT-提醒随注入");
      await sendTurn(sessionID, "取证第三轮");
      await waitForIdle(registry, sessionID);

      const res = await api(`/sessions/${encodeURIComponent(sessionID)}/context/full`);
      expect(res.status).toBe(200);
      const view = (await res.json()) as ContextFullView;

      // ① 字节面全等：三轮模型实收 systemPrompt 彼此一致、且逐字等于响应 systemPrompt。
      const modelCalls = calls();
      expect(modelCalls.length).toBeGreaterThanOrEqual(3);
      const lastCall = modelCalls[modelCalls.length - 1]!;
      for (const call of modelCalls) {
        expect(call.systemPrompt).toBe(view.systemPrompt);
      }
      // ② 恒等式对模型收包口成立：sha256(实收 systemPrompt) = 响应 prefixHash = 装配声明。
      expect(view.systemPromptSha256).toBe(sha256Prefixed(lastCall.systemPrompt ?? ""));
      expect(view.prefixHash).toBe(view.systemPromptSha256);
      expect(view.systemPrompt).toContain("W16-B 全字节面哨兵"); // 装配前缀真进请求面（W15-B 语义）

      // ③ 转录完整且与请求面等值：除"末轮模型输出尾巴"（assistant + 其 toolResult，
      // 末次调用之后生成、不经任何请求重发）外，每条 durable 消息都原样进过模型收包
      // （provider 投影口径下结构等值：toolResult 的 harness 侧 details 不上线，见 jsonEquals）。
      const loop = registry.loopOf(sessionID)!;
      expect(view.messages.length).toBe(loop.session.messages.length);
      expect(view.messages.length).toBeGreaterThan(2);
      const allSent = modelCalls.flatMap((c) => Array.from(c.messages));
      for (const entry of view.messages.slice(0, -2)) {
        expect(allSent.some((m) => jsonEquals(entry.text, m)), `消息 #${String(entry.index)} 应进过模型收包`).toBe(true);
      }
      expect(view.messages.slice(-2).map((m) => m.role)).toEqual(["assistant", "toolResult"]);

      // transient 硬证：提醒随注入的那次调用收包恰好多出一条附件（模型确实收到），
      // 而端点视图如实排除（transientExcluded 语义）。
      const remCall = modelCalls.find((c) => JSON.stringify(c.messages).includes("W16-TRANSIENT-提醒随注入"));
      expect(remCall, "提醒应已随注入进过某次模型收包").toBeDefined();
      const sentExtras = remCall!.messages.filter((m) => !view.messages.some((v) => jsonEquals(v.text, m)));
      expect(sentExtras.length).toBe(1);
      expect(JSON.stringify(sentExtras[0])).toContain("W16-TRANSIENT-提醒随注入");
      expect(view.messages.every((v) => !v.text.includes("W16-TRANSIENT-"))).toBe(true);
      expect(view.transientExcluded).toBe(true);

      // ④ 偏移坐标系自洽：规范串切片回取 = 每条 text，总量字段与 Buffer 实测全等。
      const canonical = Buffer.from(view.systemPrompt + "\n" + view.messages.map((m) => m.text).join(""), "utf8");
      expect(canonical.byteLength).toBe(view.totalPromptByteLength);
      for (const seg of view.segments) {
        expect(canonical.slice(seg.offset, seg.offset + seg.byteLength).toString("utf8")).toBe(seg.text);
      }
      for (const entry of view.messages) {
        expect(canonical.slice(entry.offset, entry.offset + entry.byteLength).toString("utf8")).toBe(entry.text);
      }

      // ⑤ W13 /context 旧面共存且形状不变（additive 非破坏）。
      const old = await api(`/sessions/${encodeURIComponent(sessionID)}/context`);
      expect(old.status).toBe(200);
      const oldView = (await old.json()) as Record<string, unknown>;
      expect(oldView.basis).toBe("assembly");
      expect(Array.isArray(oldView.rows)).toBe(true);
      expect(Object.keys(oldView).sort()).toEqual(
        ["basis", "capturedAt", "contextWindow", "estimatedTokens", "note", "rows", "sessionID", "totalBytes", "totalLines", "turnIdx", "usageRatio"],
      );
    } finally {
      teardown();
    }
  });

  it("错误口径：无 live loop 的会话 404 context_full_not_found；非法 id 400 bad_session_id", async () => {
    const { registry, teardown } = makeRegistry([]);
    await listen({ registry });
    try {
      const res = await api("/sessions/ses_ghost_full/context/full");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("context_full_not_found");

      const bad = await api("/sessions/ses-bad%21id/context/full");
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_session_id");
    } finally {
      teardown();
    }
  });
});
