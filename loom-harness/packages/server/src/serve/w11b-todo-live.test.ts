/**
 * W11b 定向验收（live-stack）—— fake 模型调 todowrite → SSE 流捕获 todo.updated 帧。
 *
 * 断言主轴（逐字对齐 mybot-web/docs/EVENT_API_DOC.md §4 + 前端消费真源
 * sse.js handleTodoUpdated）：properties 键集 = {sessionID, todos}（不多不少），
 * todos 逐项 {content,status,priority} 与入参表 deep-equal 且顺序保持；
 * 信封纪律复验（首帧 connected、seq 连续、properties 恒存在、无 event: 行）。
 * 装配姿势 = boot 同构双惰性（sink 闭包引 registry，wiring 先构造、首次调用在装配后）。
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MemorySessionStore } from "@axeuh/loom-core";
import { createFakeModel, type FakeAssistantResponse, type FakeModel } from "@axeuh/loom-core/testing";

import { Router } from "../http/router.js";
import {
  LOOM_ID_RE,
  SSE_EVENT_LINE_RE,
  createToolOutputStream,
  sseStreamHandler,
  type LoomFrame,
  type ToolOutputStream,
} from "../events/index.js";
import { registerSessionRoutes, SessionRegistry } from "../session-api/index.js";
import { createServeToolWiring, type ServeToolWiring } from "./tool-wiring.js";

const TOKEN = "tok-w11b-todo";
const READ_BUDGET_MS = 30_000;

const PLAN = [
  { content: "第一步：调研事件面", status: "in_progress", priority: "high" },
  { content: "第二步：实现工具", status: "pending", priority: "high" },
  { content: "第三步：补测试", status: "pending", priority: "medium" },
] as const;

function script(): FakeAssistantResponse[] {
  return [
    { content: [{ type: "toolCall", id: "todo-call-1", name: "todowrite", arguments: { todos: PLAN } }] },
    { content: [{ type: "text", text: "收到，计划已登记。" }] },
  ];
}

let server: Server;
let baseUrl: string;
let stateRoot: string;
let workspace: string;
let model: FakeModel;
let wiring: ServeToolWiring;
let registry: SessionRegistry;
let stream: ToolOutputStream;

beforeEach(async () => {
  stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "loom-w11b-state-")));
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "loom-w11b-ws-")));
  model = createFakeModel(script());
  // boot 同构：sink 运行期才消费 registry（此刻未赋值也不炸——首调在任何 HTTP 请求之后）。
  wiring = await createServeToolWiring({
    workspaceRoot: workspace,
    stateRoot,
    model,
    llmOptions: {},
    onToolOutput: (site, chunk) => {
      stream.onOutput(site, chunk);
    },
    onTodoUpdated: (sessionID, todos) => {
      registry.hubOf(sessionID)?.publish("todo.updated", sessionID, { todos });
    },
  });
  stream = createToolOutputStream({
    resolveHub: (sessionId) => registry.hubOf(sessionId),
    workspaceRoot: wiring.workspaceReal,
  });
  registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    tools: wiring.tools,
    hooks: [stream.hook],
    workspaceRoot: wiring.workspaceReal,
    version: "w11b-test",
  });
  const router = new Router({ tokens: [TOKEN] });
  registerSessionRoutes(router, { registry });
  router.add(
    "GET",
    "/events/stream",
    sseStreamHandler((sessionId) => {
      const hub = sessionId === undefined ? undefined : registry.hubOf(sessionId);
      if (hub === undefined) throw new Error("no hub");
      return hub;
    }),
  );
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  model.teardown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function postJson(path: string, body?: unknown): Promise<{ status: number; json: Promise<Record<string, unknown>> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: res.json() as Promise<Record<string, unknown>> };
}

interface RawFrame {
  readonly raw: string;
  readonly frame: LoomFrame;
}

/** 读到谓词满足（保留原始帧文本——无 event: 行断言的取证面）。 */
async function captureStream(res: Response, until: (frames: readonly RawFrame[]) => boolean): Promise<RawFrame[]> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const decoder = new TextDecoder();
  const out: RawFrame[] = [];
  let raw = "";
  const deadline = Date.now() + READ_BUDGET_MS;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined) {
        raw += decoder.decode(value, { stream: true });
        const parts = raw.split("\n\n");
        raw = parts.pop() ?? "";
        for (const p of parts) {
          const trimmed = p.trim();
          if (trimmed === "" || trimmed.startsWith(":")) continue;
          if (trimmed.startsWith("data:")) {
            out.push({ raw: trimmed, frame: JSON.parse(trimmed.slice("data:".length)) as LoomFrame });
          }
        }
      }
      if (until(out)) return out;
      if (done) throw new Error(`stream ended early; types=${JSON.stringify(out.map((t) => t.frame.payload.type))}`);
      if (Date.now() > deadline) throw new Error("capture budget exhausted");
    }
  } finally {
    void reader.cancel();
  }
}

describe("W11b live-stack —— todowrite → todo.updated 帧形状逐字断言", () => {
  it("fake 模型调 todowrite：SSE 帧 properties = {sessionID, todos} 全量对齐 + 信封纪律", async () => {
    const created = await postJson("/sessions");
    expect(created.status).toBe(201);
    const sid = String((await created.json).sessionID);

    const res = await fetch(`${baseUrl}/events/stream?sessionId=${sid}`, { headers: auth() });
    expect(res.status).toBe(200);

    const sending = postJson(`/sessions/${sid}/messages`, { text: "用 todo 工具列三步计划" });
    expect((await sending).status).toBe(202);

    const caps = await captureStream(res, (fs) => fs.some((t) => t.frame.payload.type === "session.idle"));
    const frames = caps.map((t) => t.frame);

    // ── 信封纪律（全帧）──
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    expect(frames[0]!.payload.type).toBe("server.connected");
    for (const f of frames) {
      expect(typeof f.payload.properties.sessionID).toBe("string");
    }
    for (const c of caps) expect(SSE_EVENT_LINE_RE.test(c.raw)).toBe(false);

    // ── 主角：todo.updated 恰好一帧（模型只调一次），形状逐字断言 ──
    const todoFrames = frames.filter((f) => f.payload.type === "todo.updated");
    expect(todoFrames, "fake 模型单次调用应只发一帧").toHaveLength(1);
    const props = todoFrames[0]!.payload.properties;
    expect(Object.keys(props).sort()).toEqual(["sessionID", "todos"]); // 不多不少两键
    expect(props.sessionID).toBe(sid);
    expect(props.sessionID).toMatch(LOOM_ID_RE);
    expect(props.todos).toEqual(PLAN.map((t) => ({ content: t.content, status: t.status, priority: t.priority })));

    // 工具卡同帧族佐证：todowrite 的 message.part.updated 卡走到 completed
    const cards = frames
      .filter((f) => f.payload.type === "message.part.updated")
      .map((f) => f.payload.properties.part as Record<string, unknown>)
      .filter((p) => p !== undefined && p.tool === "todowrite");
    expect(cards.length, "todowrite 工具卡帧在场（共用面 wrapAll/tool-stream 覆盖）").toBeGreaterThan(0);
    const lastState = cards[cards.length - 1]!.state as Record<string, unknown>;
    expect(lastState.status).toBe("completed");
    expect(String(lastState.output)).toContain("已登记 3 项");

    // 收尾：idle 为最后一帧（todo.updated 在其前——run 内发射）
    expect(frames.at(-1)!.payload.type).toBe("session.idle");
    const idleIdx = frames.findIndex((f) => f.payload.type === "session.idle");
    const todoIdx = frames.findIndex((f) => f.payload.type === "todo.updated");
    expect(todoIdx).toBeLessThan(idleIdx);
  }, 60_000);
});
