/**
 * W17-B /context/full v2 验收 —— 加性 wire/manifest 两键 + 脱敏 fail-closed。
 *
 * 三层钉：
 *   1) 单元：redactSecrets（键名命中凭据语义一律 "***"，深度含数组）/
 *      buildWireView（transient 尾标映射、缺席理由逐字、wire.model 冻结三键）/
 *      assembleContextManifest（memory 注入清单对齐——W33 实况单件，机制清单数量无关、skill degrade 入列、mcp config∪statuses
 *      左连接、maskApiKey 遮蔽形永不回含明文）；
 *   2) 端点面：fake 模型全链 e2e，seed llmOptions apiKey="sk-secret-123" →
 *      **整响应体 grep 零命中**（fail-closed 硬证）+ params.apiKey="***" +
 *      wire:null 诚实 200 + transient 尾徽章 + 缺席理由逐字在场；
 *   3) v1 冻结面：v2 响应的 v1 十四键值与 buildContextFull 直出**逐字段 deep 等值**
 *      （note 唯一例外 = v1 逐字前缀 + v2 尾句）；未知 sid 404 纪律原样。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  Type,
  canonicalJson,
  type HarnessTool,
  type WireRequestSnapshot,
} from "@axeuh/loom-core";
import type { AssemblyPlan } from "@axeuh/loom-core/assembly";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { createFakeModelFromConfig, FAKE_PROVIDER } from "../fake-model/index.js";
import { Router } from "../http/router.js";
import { SessionRegistry, registerSessionRoutes, type SessionApiDeps } from "./index.js";
import { buildContextFull, CONTEXT_FULL_NOTE } from "./context-full.js";
import {
  PROVIDER_PAYLOAD_ABSENT_REASON,
  buildWireView,
  redactSecrets,
} from "./wire-view.js";
import {
  assembleContextManifest,
  maskApiKey,
  type ContextManifest,
  type ContextManifestAssemblyInput,
} from "./context-manifest.js";

const GOOD_TOKEN = "tok-context-full-v2";
const IDLE_TIMEOUT_MS = 20_000;
const SEEDED_API_KEY = "sk-secret-123";

const FAKE_YAML = [
  "server:",
  "  port: 5104",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-context-full-v2-workspace",
  "models:",
  "  - id: fake-v2",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
].join("\n");

const PLAN: AssemblyPlan = {
  systemPrompt: "你是 loom 主会话。",
  memorySources: [{ source: "AGENTS.md", content: "# 工作区记忆\nW17-B v2 面哨兵\n", degrade: null }],
  workflows: [],
};

const probeTool: HarnessTool = {
  name: "probe-echo",
  description: "W17-B 工具面探针",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: String(args["msg"] ?? "") }] };
  },
};

/* ────────────── ① redactSecrets 单元 ────────────── */

describe("W17-B redactSecrets —— 出网唯一脱敏闸（键名 /key|token|secret/i，深度含数组）", () => {
  it("顶层/嵌套/数组内命中键一律换 ***；未命中键与结构原样；入参不改", () => {
    const raw = {
      apiKey: SEEDED_API_KEY,
      temperature: 0.4,
      API_KEY_UPPER: "x",
      headers: { "x-api-key": "leak", Accept: "application/json" },
      list: [{ secretA: 1 }, { plain: "keep" }, "scalar"],
      providerExtras: { nested: { access_token: "tok", clientSecret: { deep: "y" } } },
    };
    const frozenCopy = JSON.parse(JSON.stringify(raw)) as typeof raw;
    const out = redactSecrets(raw);
    // Then：命中键的值整体替换（不限类型：number 1 也换 "***"）。
    expect(out).toEqual({
      apiKey: "***",
      temperature: 0.4,
      API_KEY_UPPER: "***",
      headers: { "x-api-key": "***", Accept: "application/json" },
      list: [{ secretA: "***" }, { plain: "keep" }, "scalar"],
      providerExtras: { nested: { access_token: "***", clientSecret: "***" } },
    });
    // 纯函数纪律：入参逐字节不动（core 快照原文不可污染）。
    expect(raw).toEqual(frozenCopy);
  });

  it("键名子串即命中（大小写不敏感）：tokenizer 类误伤可接受（fail-closed 偏向多遮）", () => {
    const out = redactSecrets({ maxTokensPerKey: 9, neutralField: 3 });
    expect(out).toEqual({ maxTokensPerKey: "***", neutralField: 3 });
  });
});

/* ────────────── ② buildWireView 单元 ────────────── */

function fixtureSnapshot(overrides: Partial<WireRequestSnapshot> = {}): WireRequestSnapshot {
  const snapshot: WireRequestSnapshot = {
    capturedAt: 1727000000000,
    turnIdx: 3,
    model: { id: "claude-x", api: "anthropic-messages", baseUrl: "https://api.example.com", provider: "anthropic" },
    systemPrompt: "BASE\n\n## Available skills\n- foo: desc\n",
    messagesText: canonicalJson([
      { role: "user", content: "hello", timestamp: 1 },
      { role: "user", content: "## 提醒", timestamp: 2 },
      { role: "assistant", content: "ok", timestamp: 3 },
    ]),
    tools: [{ name: "bash", description: "run shell", schemaText: '{"type":"object"}' }],
    optionsText: canonicalJson({ apiKey: "sk-unit-secret", temperature: 0.5 }),
    transientCount: 1,
    ...overrides,
  };
  return snapshot;
}

describe("W17-B buildWireView —— A1 快照到 Lane C 冻结契约的映射", () => {
  it("snapshot null → wire:null（loop 在场未跑轮的诚实面）", () => {
    expect(buildWireView(null, null)).toBeNull();
  });

  it("model 恰冻结三键 {id,api,provider}；baseUrl 不在 wire 面（manifest 才带）", () => {
    const wire = buildWireView(fixtureSnapshot(), "{}");
    expect(wire).not.toBeNull();
    expect(Object.keys(wire!.model).sort()).toEqual(["api", "id", "provider"]);
    expect(wire!.model.provider).toBe("anthropic");
  });

  it("transient 尾标：末 N 条 true；N=0 全 false；超界如实钳到全量（多标不多造）", () => {
    const one = buildWireView(fixtureSnapshot({ transientCount: 1 }), "{}")!;
    expect(one.request.messages.map((m) => m.transient)).toEqual([false, false, true]);
    const zero = buildWireView(fixtureSnapshot({ transientCount: 0 }), "{}")!;
    expect(zero.request.messages.map((m) => m.transient)).toEqual([false, false, false]);
    const over = buildWireView(fixtureSnapshot({ transientCount: 10 }), "{}")!;
    expect(over.request.messages.map((m) => m.transient)).toEqual([true, true, true]);
    // 五键形状 + byteLength 为 UTF-8 实测（CJK 三字节）。
    const row = one.request.messages[1]!;
    expect(Object.keys(row).sort()).toEqual(["byteLength", "index", "role", "text", "transient"]);
    const cjk = buildWireView(
      fixtureSnapshot({ messagesText: canonicalJson([{ role: "user", content: "汉字" }]), transientCount: 0 }),
      "{}",
    )!;
    expect(cjk.request.messages[0]!.byteLength).toBe(Buffer.byteLength(cjk.request.messages[0]!.text, "utf8"));
    // text = 条目 canonical 重序列化（与捕获原文切片等价的定点形）。
    const arr = JSON.parse(fixtureSnapshot().messagesText) as unknown[];
    expect(one.request.messages[0]!.text).toBe(canonicalJson(arr[0]));
  });

  it("params = optionsText 解析 + 深脱敏：apiKey ***、temperature 0.5 原样、零 key 明文", () => {
    const wire = buildWireView(fixtureSnapshot(), "{}")!;
    expect(wire.request.params).toEqual({ apiKey: "***", temperature: 0.5 });
    expect(JSON.stringify(wire)).not.toContain("sk-unit-secret");
  });

  it("载荷在场 → reason null；缺席 → 逐字中文理由（面板原样转呈，一字不可改）", () => {
    const present = buildWireView(fixtureSnapshot(), '{"model":"claude-x"}')!;
    expect(present.providerPayload).toBe('{"model":"claude-x"}');
    expect(present.providerPayloadAbsentReason).toBeNull();
    const absent = buildWireView(fixtureSnapshot(), null)!;
    expect(absent.providerPayload).toBeNull();
    expect(absent.providerPayloadAbsentReason).toBe("当前模型通道不触发 provider onPayload（如 fake api）");
    expect(PROVIDER_PAYLOAD_ABSENT_REASON).toBe("当前模型通道不触发 provider onPayload（如 fake api）");
  });

  it("快照形状违约响亮抛（core canonical 产物损坏 = 不变式破坏，绝不静默造面）", () => {
    expect(() => buildWireView(fixtureSnapshot({ optionsText: "[1,2]" }), "{}")).toThrow(/不变式破坏/);
    expect(() =>
      buildWireView(fixtureSnapshot({ messagesText: canonicalJson([1, 2]) }), "{}"),
    ).toThrow(/不变式破坏/);
  });
});

/* ────────────── ③ assembleContextManifest 单元 ────────────── */

function manifestInput(overrides: Partial<ContextManifestAssemblyInput> = {}): ContextManifestAssemblyInput {
  return {
    memorySources: [
      { source: "AGENTS.md", content: "# 主记忆\n", degrade: null },
      {
        source: "memory/notes.md",
        content: "",
        degrade: { segment: "memory", source: "memory/notes.md", reason: "missing", detail: null },
      },
    ],
    memorySeeds: [
      { relPath: "AGENTS.md", bootHash: "sha256:aaa", mtimeMs: 1, size: 6 },
      { relPath: "memory/notes.md", bootHash: null, mtimeMs: null, size: null },
    ],
    skillEntries: [{ name: "foo", file: "/skills/foo/SKILL.md" }],
    skillDegrades: [
      { dir: "/skills/bar", file: "/skills/bar/SKILL.md" },
      { dir: "/skills/unreadable-dir" },
    ],
    mcpServers: [
      { name: "ctx7", cmd: "npx", args: ["-y", "mcp"], cwd: "/srv" },
      { name: "dead", cmd: "bin", args: [] },
    ],
    mcpStatuses: [{ name: "ctx7", ok: true, toolNames: ["a", "b"] }],
    agentRoleFiles: [
      { name: "explore", file: "", builtin: true, kind: "sub" },
      { name: "custom", file: "/ws/agents/custom.md", builtin: false, kind: "sub" },
    ],
    model: { id: "claude-x", api: "anthropic-messages", baseUrl: "https://api.example.com" },
    apiKeyRaw: "sk-secret-1234567890",
    configPath: "/etc/kinship-loom/loom.yaml",
    workspaceRoot: "/ws",
    ...overrides,
  };
}

describe("W17-B assembleContextManifest —— boot 一次装配的只读清单", () => {
  it("memoryFiles：relPath+bytes（UTF-8 实测）+bootHash 对齐+degrade 理由；缺席件 bootHash=\"\"", () => {
    const m = assembleContextManifest(manifestInput());
    expect(m.memoryFiles[0]).toEqual({
      relPath: "AGENTS.md",
      bytes: Buffer.byteLength("# 主记忆\n", "utf8"),
      bootHash: "sha256:aaa",
      degrade: null,
    });
    expect(m.memoryFiles[1]).toEqual({
      relPath: "memory/notes.md",
      bytes: 0,
      bootHash: "",
      degrade: "missing",
    });
  });

  it("skillFiles：健康件 degraded:false；文件级坏件入列 degraded:true（stem 名）；目录级不伪造", () => {
    const m = assembleContextManifest(manifestInput());
    expect(m.skillFiles).toEqual([
      { name: "foo", file: "/skills/foo/SKILL.md", degraded: false },
      { name: "SKILL", file: "/skills/bar/SKILL.md", degraded: true },
    ]);
  });

  it("mcpServers：config∪statuses 左连接——声明恒全列，结局缺席=未启动如实 ok:false", () => {
    const m = assembleContextManifest(manifestInput());
    expect(m.mcpServers).toEqual([
      { name: "ctx7", cmd: "npx", args: ["-y", "mcp"], cwd: "/srv", ok: true, toolNames: ["a", "b"] },
      { name: "dead", cmd: "bin", args: [], cwd: "", ok: false, toolNames: [] },
    ]);
  });

  it("model 恰四键、零 key 字段；apiKeyMasked 遮蔽形永不回含明文 seed", () => {
    const m = assembleContextManifest(manifestInput());
    expect(Object.keys(m.model).sort()).toEqual(["api", "apiKeyMasked", "baseUrl", "id"]);
    expect(m.model.apiKeyMasked).toBe("sk-***7890");
    expect(m.model.apiKeyMasked).not.toContain("secret-1234");
    expect(JSON.stringify(m)).not.toContain("sk-secret-1234567890");
    expect(m.configPath).toBe("/etc/kinship-loom/loom.yaml");
    expect(m.workspaceRoot).toBe("/ws");
    expect(m.agentRoleFiles).toEqual(manifestInput().agentRoleFiles);
  });

  it("maskApiKey 遮蔽口径：缺=空串 / 短=*** / 长=首3***末4（fake 通道无 key 诚实呈现）", () => {
    expect(maskApiKey(undefined)).toBe("");
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey("abc123")).toBe("***");
    expect(maskApiKey("abcdefgh")).toBe("abc***efgh");
  });
});

/* ────────────── ④ 端点面：全链 e2e（seed key 零命中硬证） ────────────── */

let server: Server | null = null;
let baseUrl = "";
let stateRoot = "";

const E2E_MANIFEST: ContextManifest = assembleContextManifest(
  manifestInput({ apiKeyRaw: SEEDED_API_KEY }),
);

function makeRegistry(script: readonly FakeAssistantResponse[]): {
  registry: SessionRegistry;
  teardown: () => void;
} {
  const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
  const model = createFakeModelFromConfig(cfg.models[0]!, [...script]);
  const registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    tools: [probeTool],
    assembly: { plan: PLAN, reader: null },
    // W17-B fail-closed 试验田：明文 key 从装配面流入 core 捕获口，出网必须被闸拦住。
    llmOptions: { apiKey: SEEDED_API_KEY, temperature: 0.4 },
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

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${GOOD_TOKEN}`, ...(init?.headers ?? {}) },
  });
}

async function waitForIdle(registry: SessionRegistry, sessionID: string): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  for (;;) {
    if (registry.statusView(sessionID)?.status === "idle" && registry.get(sessionID)?.running === null) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting idle for ${sessionID}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const textTurn = (t: string): FakeAssistantResponse => ({
  content: [{ type: "text", text: t }],
});

/** converge 收束轮（同 W16-B 姿势）：turn0 一调即止 ⇒ 末次快照 = 带提醒附件的那一次。 */
const convergeTurn = (t: string): FakeAssistantResponse => ({
  content: [
    { type: "text", text: t },
    { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: t, body: "收口。" } },
  ],
});

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-context-full-v2-"));
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

describe("W17-B /context/full v2 端点：加性两键 + fail-closed 零命中 + v1 值等值", () => {
  it("loop 在场未跑轮：200 且 wire:null 诚实面；manifest 从 deps 在场", async () => {
    const { registry, teardown } = makeRegistry([]);
    await listen({ registry, manifest: E2E_MANIFEST });
    try {
      const created = await api("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const { sessionID } = (await created.json()) as { sessionID: string };
      const res = await api(`/sessions/${encodeURIComponent(sessionID)}/context/full`);
      expect(res.status).toBe(200);
      const view = (await res.json()) as Record<string, unknown>;
      expect("wire" in view).toBe(true);
      expect("manifest" in view).toBe(true);
      expect(view.wire).toBeNull();
      expect(view.manifest).not.toBeNull();
    } finally {
      teardown();
    }
  });

  it("提醒随注入轮：transient 尾徽章 + params 脱敏 + 缺席理由逐字 + **整响应 seed-key 零命中**", async () => {
    const { registry, teardown } = makeRegistry([convergeTurn("v2 首轮正文")]);
    await listen({ registry, manifest: E2E_MANIFEST });
    try {
      const created = await api("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const { sessionID } = (await created.json()) as { sessionID: string };

      registry.queueReminder(sessionID, "W17B-TRANSIENT-TAIL");
      const sent = await api(`/sessions/${encodeURIComponent(sessionID)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "取证 v2 轮" }),
      });
      expect(sent.status).toBe(202);
      await waitForIdle(registry, sessionID);

      const res = await api(`/sessions/${encodeURIComponent(sessionID)}/context/full`);
      expect(res.status).toBe(200);
      const rawBody = await res.text();

      // ① fail-closed 硬证：seed 明文在整个响应体中零命中（params 闸 + 无旁路）。
      expect(rawBody.includes(SEEDED_API_KEY)).toBe(false);

      const view = JSON.parse(rawBody) as Record<string, unknown>;
      const wire = view.wire as NonNullable<ReturnType<typeof buildWireView>>;

      // ② 冻结契约面：wire.request.params 脱敏 + 非敏感原样。
      expect(wire.request.params.apiKey).toBe("***");
      expect(wire.request.params.temperature).toBe(0.4);

      // ③ transient 尾标：末条 = 提醒附件（进发线不进转录，徽章数据源）。
      const rows = wire.request.messages;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows[rows.length - 1]!.transient).toBe(true);
      expect(rows[rows.length - 1]!.text).toContain("W17B-TRANSIENT-TAIL");
      expect(rows.slice(0, -1).every((r) => r.transient === false)).toBe(true);

      // ④ post-pipe 提示词真值（装配前缀在场）+ 工具面非空（探针在场）。
      expect(wire.request.systemPrompt).toContain("W17-B v2 面哨兵");
      expect(wire.request.tools.some((t) => t.name === "probe-echo")).toBe(true);

      // ⑤ fake 通道载荷如实缺席：逐字中文理由进响应体（面板 #ctxPayloadAbsent 转呈）。
      expect(wire.providerPayload).toBeNull();
      expect(wire.providerPayloadAbsentReason).toBe(PROVIDER_PAYLOAD_ABSENT_REASON);
      expect(rawBody).toContain("当前模型通道不触发 provider onPayload（如 fake api）");

      // ⑥ manifest 回声（deps 注入对象原样出网）+ model 四键零 key 字段。
      expect(view.manifest).toEqual(JSON.parse(JSON.stringify(E2E_MANIFEST)));
      const model = (view.manifest as ContextManifest).model;
      expect(Object.keys(model).sort()).toEqual(["api", "apiKeyMasked", "baseUrl", "id"]);

      // ⑦ v1 十四键**值等值钉**：与 buildContextFull 直出逐字段 deep 等（note/capturedAt 除外）。
      const loop = registry.loopOf(sessionID)!;
      const assemblies = loop.assemblies();
      const lastAssembly = assemblies.length > 0 ? assemblies[assemblies.length - 1]! : null;
      const v1Direct = buildContextFull({
        sessionID,
        capturedAt: 0,
        systemPrompt: loop.session.systemPrompt,
        assembly: lastAssembly,
        messages: loop.session.messages,
        contextWindow: loop.session.model.contextWindow,
      });
      const stripV1Only = (o: object): Record<string, unknown> => {
        const out: Record<string, unknown> = { ...o };
        delete out.wire;
        delete out.manifest;
        delete out.note;
        delete out.capturedAt;
        return out;
      };
      expect(stripV1Only(view)).toEqual(stripV1Only(v1Direct));
      expect(Object.keys(view).filter((k) => k !== "wire" && k !== "manifest").sort()).toEqual(
        Object.keys(v1Direct).sort(),
      );

      // ⑧ note v2 口径：v1 全文逐字前缀 + v2 尾句（transientExcluded:true 语义文本冻结）。
      expect((view.note as string).startsWith(CONTEXT_FULL_NOTE)).toBe(true);
      expect((view.note as string)).toContain("v2 加性面");
      expect(view.transientExcluded).toBe(true);
    } finally {
      teardown();
    }
  });

  it("未传 manifest 的旧调用面：{registry} 单键 deps 照常 200，manifest:null 诚实缺席", async () => {
    const { registry, teardown } = makeRegistry([textTurn("旧面")]);
    await listen({ registry });
    try {
      const created = await api("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const { sessionID } = (await created.json()) as { sessionID: string };
      await api(`/sessions/${encodeURIComponent(sessionID)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "旧调用面" }),
      });
      await waitForIdle(registry, sessionID);
      const res = await api(`/sessions/${encodeURIComponent(sessionID)}/context/full`);
      expect(res.status).toBe(200);
      const view = (await res.json()) as Record<string, unknown>;
      expect(view.manifest).toBeNull();
      expect(view.wire).not.toBeNull();
    } finally {
      teardown();
    }
  });

  it("404 纪律不动：无 live loop 的 sid 仍 context_full_not_found", async () => {
    const { registry, teardown } = makeRegistry([]);
    await listen({ registry, manifest: E2E_MANIFEST });
    try {
      const res = await api("/sessions/ses_ghost_v2/context/full");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("context_full_not_found");
    } finally {
      teardown();
    }
  });
});
