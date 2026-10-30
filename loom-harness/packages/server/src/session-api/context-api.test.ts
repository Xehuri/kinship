/**
 * W13 上下文预览端点验收：
 *   - buildContextView 纯函数：fake Assembly → 分段清单字段齐全（段名/来源/行数/字节/
 *     粗估 token/降级标注）+ 四段拆解正确 + 总量与占比；
 *   - 真注册表全链：装配接线的主会话跑一轮 → GET /sessions/:id/context 返回非空分段
 *     （内存快照，basis=assembly）；
 *   - fake provider 注入：路由原样透传预制快照（断言字段齐全）；
 *   - 副会话：当日 trace assembly span 反推（basis=trace，字节/token 如实 null）；
 *   - 未知会话 404。
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MemorySessionStore, localDateKey, type RunSpan } from "@axeuh/loom-core";
import type { Assembly, AssemblyPlan } from "@axeuh/loom-core/assembly";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { createFakeModelFromConfig, FAKE_PROVIDER } from "../fake-model/index.js";
import { Router } from "../http/router.js";
import { SessionRegistry, registerSessionRoutes, type ContextView, type SessionApiDeps } from "./index.js";
import { TOKEN_ESTIMATE_DIVISOR, buildContextView } from "./context.js";

const GOOD_TOKEN = "tok-context-test";
const FRAME_TIMEOUT_MS = 20_000;

const FAKE_YAML = [
  "server:",
  "  port: 5097",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-context-api-workspace",
  "models:",
  "  - id: fake-context",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
].join("\n");

const MAIN_OK = {
  status: "已完成" as const,
  digest: "已完成：上下文预览验收",
  body: "上下文预览验收通过。",
};

function convergeTurn(text: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
    ],
    textDeltas: [text],
  };
}

/** fake 装配快照：四段齐备 + 一条降级 memory 源 + increment 四槽。 */
function fakeAssembly(): Assembly {
  const enc = new TextEncoder();
  return {
    segments: [
      { name: "system", bytes: enc.encode("## system\n你是 loom 主会话。\n[convergence tools: not configured]\n"), stable: true },
      {
        name: "memory",
        bytes: enc.encode(
          "### memory[0] AGENTS.md\n# 工作区记忆\n记住一切\n" +
            "### memory[1] memory/notes.md\n[assembly: source missing, degraded]\n",
        ),
        stable: true,
      },
      { name: "workflow", bytes: enc.encode("## workflow quick\n快速通道。\n"), stable: true },
      {
        name: "increment",
        bytes: enc.encode("## increment\nhistory+ {\"role\":\"user\"}\nnudge: 快收\nreminder: 提醒\nuser: 你好\n"),
        stable: false,
      },
    ],
    prefixHash: "sha256:prefix",
    fullHash: "sha256:full",
    degrades: [{ segment: "memory", source: "memory/notes.md", reason: "missing", detail: null }],
    memorySourceCount: 2,
    incrementRows: 1,
    openedShards: 0,
  };
}

const PLAN: AssemblyPlan = {
  systemPrompt: "你是 loom 主会话。",
  memorySources: [{ source: "AGENTS.md", content: "# 工作区记忆\n记住一切\n", degrade: null }],
  workflows: [],
};

let server: Server | null = null;
let baseUrl = "";
let stateRoot = "";

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-context-api-"));
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

function makeRegistry(script: readonly FakeAssistantResponse[], withAssembly = false): {
  registry: SessionRegistry;
  teardown: () => void;
} {
  const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
  const model = createFakeModelFromConfig(cfg.models[0]!, [...script]);
  const registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    ...(withAssembly ? { assembly: { plan: PLAN, reader: null } } : {}),
  });
  return { registry, teardown: () => model.teardown() };
}

async function listen(deps: SessionApiDeps): Promise<void> {
  const router = new Router({ tokens: [GOOD_TOKEN] });
  registerSessionRoutes(router, deps);
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${GOOD_TOKEN}` };
}

async function jsonFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...auth(), ...(init?.headers ?? {}) } });
}

async function waitForIdle(registry: SessionRegistry, sessionID: string): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    if (registry.statusView(sessionID)?.status === "idle" && registry.get(sessionID)?.running === null) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting idle for ${sessionID}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("W13 context：buildContextView 纯函数（fake 装配快照）", () => {
  it("四段拆解 + 字段齐全 + 降级标注 + 总量/占比（token 粗估 bytes/3.5）", () => {
    const assembly = fakeAssembly();
    const view = buildContextView({
      sessionID: "ses_ctx_01",
      assembly,
      turnIdx: 2,
      capturedAt: 12345,
      contextWindow: 200000,
    });

    expect(view.basis).toBe("assembly");
    expect(view.sessionID).toBe("ses_ctx_01");
    expect(view.turnIdx).toBe(2);
    expect(view.capturedAt).toBe(12345);

    // 每行字段齐全（段名/来源/行数/字节/粗估 token/降级）
    for (const row of view.rows) {
      expect(Object.keys(row).sort()).toEqual(["bytes", "degraded", "estimatedTokens", "label", "lines", "segment", "source"]);
      expect(typeof row.label).toBe("string");
      expect(typeof row.source).toBe("string");
      expect(typeof row.lines).toBe("number");
      expect(typeof row.bytes).toBe("number");
      expect(typeof row.estimatedTokens).toBe("number");
    }

    const system = view.rows.find((r) => r.segment === "system")!;
    expect(system.label).toBe("系统提示（身份框）");
    expect(system.source).toBe("systemPrompt");

    const memory = view.rows.filter((r) => r.segment === "memory");
    expect(memory.map((r) => r.source)).toEqual(["AGENTS.md", "memory/notes.md"]);
    expect(memory[1]!.degraded).toBe("missing");
    expect(memory[0]!.degraded).toBeNull();

    expect(view.rows.find((r) => r.segment === "workflow")!.source).toBe("quick");

    const increment = view.rows.filter((r) => r.segment === "increment");
    expect(increment.map((r) => r.label)).toEqual(["历史增量", "nudge 槽", "reminder 槽", "本轮消息"]);
    expect(increment.every((r) => r.bytes !== null && r.lines !== null)).toBe(true);

    const totalBytes = assembly.segments.reduce((n, s) => n + s.bytes.byteLength, 0);
    expect(view.totalBytes).toBe(totalBytes);
    expect(view.estimatedTokens).toBe(Math.round(totalBytes / TOKEN_ESTIMATE_DIVISOR));
    expect(view.contextWindow).toBe(200000);
    expect(view.usageRatio).toBeCloseTo(Math.round(totalBytes / TOKEN_ESTIMATE_DIVISOR) / 200000, 10);
    expect(view.note).toContain("粗估");
  });

  it("空段/无降级时不出行、degraded 恒 null（形状不塌）", () => {
    const enc = new TextEncoder();
    const view = buildContextView({
      sessionID: "ses_ctx_02",
      assembly: {
        segments: [
          { name: "system", bytes: enc.encode("## system\nsys\n"), stable: true },
          { name: "memory", bytes: new Uint8Array(0), stable: true },
          { name: "workflow", bytes: new Uint8Array(0), stable: true },
          { name: "increment", bytes: enc.encode("## increment\nuser: hi\n"), stable: false },
        ],
        prefixHash: "sha256:a",
        fullHash: "sha256:b",
        degrades: [],
        memorySourceCount: 0,
        incrementRows: 0,
        openedShards: 0,
      },
      turnIdx: 0,
      capturedAt: 1,
      contextWindow: null,
    });
    expect(view.rows.map((r) => r.segment)).toEqual(["system", "increment"]);
    expect(view.rows.every((r) => r.degraded === null)).toBe(true);
    expect(view.usageRatio).toBeNull();
  });
});

describe("W13 context 端点：真注册表 / fake provider / 副会话反推 / 404", () => {
  it("装配接线的主会话跑一轮 → GET context 返回非空分段清单（basis=assembly）", async () => {
    const { registry, teardown } = makeRegistry([convergeTurn("上下文验收")], true);
    await listen({ registry });
    try {
      const created = await jsonFetch("/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(created.status).toBe(201);
      const { sessionID } = (await created.json()) as { sessionID: string };
      const sent = await jsonFetch(`/sessions/${encodeURIComponent(sessionID)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "跑一轮" }),
      });
      expect(sent.status).toBe(202);
      await waitForIdle(registry, sessionID);

      const res = await jsonFetch(`/sessions/${encodeURIComponent(sessionID)}/context`);
      expect(res.status).toBe(200);
      const view = (await res.json()) as ContextView;
      expect(view.sessionID).toBe(sessionID);
      expect(view.basis).toBe("assembly");
      expect(view.rows.length).toBeGreaterThan(0);
      expect(view.rows.some((r) => r.segment === "system")).toBe(true);
      expect(view.rows.some((r) => r.segment === "memory" && r.source === "AGENTS.md")).toBe(true);
      expect(view.rows.some((r) => r.segment === "increment" && r.label === "本轮消息")).toBe(true);
      expect(view.totalBytes).toBeGreaterThan(0);
      expect(view.estimatedTokens).toBeGreaterThan(0);
      expect(view.contextWindow).toBe(200000);
      expect(view.usageRatio).toBeCloseTo(view.estimatedTokens! / 200000, 10);
      expect(view.note).toContain("粗估");
      expect(view.note).toContain("重启");
    } finally {
      teardown();
    }
  });

  it("fake provider 注入：路由原样透传预制分段清单（字段齐全）", async () => {
    const { registry, teardown } = makeRegistry([]);
    const fakeView: ContextView = {
      sessionID: "ses_fake_01",
      basis: "assembly",
      capturedAt: 7,
      turnIdx: 1,
      rows: [
        {
          segment: "system",
          label: "系统提示（身份框）",
          source: "systemPrompt",
          lines: 1,
          bytes: 9,
          estimatedTokens: 3,
          degraded: null,
        },
      ],
      totalBytes: 9,
      totalLines: 1,
      estimatedTokens: 3,
      contextWindow: 1000,
      usageRatio: 0.003,
      note: "token 为粗估（UTF-8 字节 / 3.5）",
    };
    await listen({ registry, context: { contextView: async () => fakeView } });
    try {
      const res = await jsonFetch("/sessions/ses_fake_01/context");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(fakeView);
    } finally {
      teardown();
    }
  });

  it("副会话：当日 trace assembly span 反推（basis=trace；字节/token 如实 null）", async () => {
    const { registry, teardown } = makeRegistry([]);
    await listen({ registry });
    try {
      const span: RunSpan = {
        kind: "span",
        runId: "run_side_0000000000000001",
        sessionId: "ses_side_ctx_01",
        spanId: "spn_side_0000000000000001",
        stage: "assembly",
        start: 10,
        end: 12,
        durationMs: 2,
        assemblyRowCount: 3,
        attrs: { result: "ok", workflow: "quick", injectedLines: 12 },
      };
      const dir = join(stateRoot, "trace");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${localDateKey(Date.now())}.jsonl`), `${JSON.stringify(span)}\n`, "utf8");

      const res = await jsonFetch("/sessions/ses_side_ctx_01/context");
      expect(res.status).toBe(200);
      const view = (await res.json()) as ContextView;
      expect(view.basis).toBe("trace");
      expect(view.rows[0]!.lines).toBe(12);
      expect(view.rows[0]!.bytes).toBeNull();
      expect(view.rows[0]!.estimatedTokens).toBeNull();
      expect(view.rows[0]!.source).toContain("trace");
      expect(view.note).toContain("反推");
    } finally {
      teardown();
    }
  });

  it("未知会话（无内存快照且当日 trace 无 assembly span）→ 404", async () => {
    const { registry, teardown } = makeRegistry([]);
    await listen({ registry });
    try {
      const res = await jsonFetch("/sessions/ses_none_01/context");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("context_not_found");
    } finally {
      teardown();
    }
  });
});
