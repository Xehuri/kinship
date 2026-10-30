/**
 * T3 验收：会话列表默认关闭门 + 主会话单端点。
 *
 * 用户决策：`server.sessionList` 键缺席 = disabled；GET /sessions 与 ?archived=1
 * 默认 404 `session_list_disabled`；GET /sessions/main 恒可用且恰回一个 SessionView。
 * 同时钉住：列表关闭不影响 POST /sessions 与逐会话端点；主会话归档仍返回；
 * 未注册主会话就地自愈；无从解析 = 503；boot 层配置接线。
 */

import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MemorySessionStore } from "@axeuh/loom-core";

import { parseLoomConfig } from "../config/loom-config.js";
import { createFakeModelFromConfig } from "../fake-model/index.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import { Router } from "../http/router.js";
import { SessionMetaStore } from "../session-meta.js";
import { SessionRegistry, registerSessionRoutes, type SessionApiDeps } from "./index.js";
import type { LoomApp } from "../serve/boot.js";

type CreateLoomApp = typeof import("../serve/boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

beforeAll(async () => {
  createLoomApp = (await import("../serve/boot.js")).createLoomApp;
});

const TOKEN = "tok-t3-session-list";

const FAKE_YAML = [
  "server:",
  "  port: 5119",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-t3-session-list-workspace",
  "models:",
  "  - id: fake-t3-list",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

let server: Server | null = null;
let baseUrl = "";
let stateRoot = "";
const teardowns: Array<() => void> = [];

function makeRegistry(opts: {
  mainSessionID?: string;
  meta?: SessionMetaStore;
} = {}): SessionRegistry {
  const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
  const model = createFakeModelFromConfig(cfg.models[0]!, []);
  teardowns.push(() => model.teardown());
  return new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    ...(opts.mainSessionID === undefined ? {} : { mainSessionID: opts.mainSessionID }),
    ...(opts.meta === undefined ? {} : { meta: opts.meta }),
  });
}

async function serve(
  registry: SessionRegistry,
  deps: Omit<SessionApiDeps, "registry"> = {},
): Promise<void> {
  const router = new Router({ tokens: [TOKEN] });
  registerSessionRoutes(router, { registry, ...deps });
  const s = createServer(router.toRequestHandler());
  server = s;
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const addr = s.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
}

async function call(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function errorCode(body: Record<string, unknown>): string {
  const error = body["error"];
  if (typeof error !== "object" || error === null) return "";
  return String((error as Record<string, unknown>)["code"]);
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-t3-session-list-"));
});

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) teardown();
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

describe("T3 列表门：默认关闭 / 显式开启", () => {
  it("键缺席：GET /sessions 与 ?archived=1 均 404 session_list_disabled", async () => {
    await serve(makeRegistry());
    for (const path of ["/sessions", "/sessions?archived=1"]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(errorCode(res.body), path).toBe("session_list_disabled");
    }
  });

  it("sessionList:false 同样关闭（与键缺席等价）", async () => {
    await serve(makeRegistry(), { sessionList: false });
    const res = await call("/sessions");
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("session_list_disabled");
  });

  it("sessionList:true 恢复原列表行为：默认排归档、?archived=1 反显", async () => {
    const meta = new SessionMetaStore({ file: join(stateRoot, "meta.json") });
    const registry = makeRegistry({ meta });
    const archived = registry.create();
    const active = registry.create();
    expect(registry.setArchived(archived.sessionID, true)).toBe(true);
    await serve(registry, { sessionList: true });

    const list = await call("/sessions");
    expect(list.status).toBe(200);
    expect(list.body["count"]).toBe(1);
    expect((list.body["sessions"] as Array<{ sessionID: string }>).map((s) => s.sessionID)).toEqual([
      active.sessionID,
    ]);

    const onlyArchived = await call("/sessions?archived=1");
    expect(onlyArchived.status).toBe(200);
    expect(
      (onlyArchived.body["sessions"] as Array<{ sessionID: string }>).map((s) => s.sessionID),
    ).toEqual([archived.sessionID]);
  });
});

describe("T3 GET /sessions/main：恒可用单对象", () => {
  it("列表关闭时仍 200，body 恰一个 SessionView（无 sessions/count 包裹）", async () => {
    const registry = makeRegistry({ mainSessionID: "main_t3" });
    registry.ensure("main_t3");
    await serve(registry);

    const res = await call("/sessions/main");
    expect(res.status).toBe(200);
    expect(res.body["sessionID"]).toBe("main_t3");
    expect(res.body["status"]).toBe("idle");
    expect(res.body["archived"]).toBe(false);
    expect(typeof res.body["createdAt"]).toBe("number");
    expect("sessions" in res.body).toBe(false);
    expect("count" in res.body).toBe(false);
  });

  it("主会话已归档仍返回（archived:true）", async () => {
    const meta = new SessionMetaStore({ file: join(stateRoot, "meta.json") });
    const registry = makeRegistry({ mainSessionID: "main_arch", meta });
    registry.ensure("main_arch");
    expect(registry.setArchived("main_arch", true)).toBe(true);
    await serve(registry);

    const res = await call("/sessions/main");
    expect(res.status).toBe(200);
    expect(res.body["sessionID"]).toBe("main_arch");
    expect(res.body["archived"]).toBe(true);
  });

  it("未注册主会话自愈：ensure 后返回视图", async () => {
    const registry = makeRegistry({ mainSessionID: "main_ghost" });
    expect(registry.has("main_ghost")).toBe(false);
    await serve(registry);

    const res = await call("/sessions/main");
    expect(res.status).toBe(200);
    expect(res.body["sessionID"]).toBe("main_ghost");
    expect(registry.has("main_ghost")).toBe(true);
  });

  it("无从解析主会话：503 main_session_unavailable", async () => {
    const registry = makeRegistry();
    await serve(registry);

    const res = await call("/sessions/main");
    expect(res.status).toBe(503);
    expect(errorCode(res.body)).toBe("main_session_unavailable");
  });

  it("deps.mainSessionId 优先于 registry 缺省主会话", async () => {
    const registry = makeRegistry({ mainSessionID: "fallback_sid" });
    registry.ensure("fallback_sid");
    registry.ensure("explicit_sid");
    await serve(registry, { mainSessionId: "explicit_sid" });

    const res = await call("/sessions/main");
    expect(res.status).toBe(200);
    expect(res.body["sessionID"]).toBe("explicit_sid");
  });

  it("列表关闭不影响 POST /sessions（201）与逐会话 status（200）", async () => {
    await serve(makeRegistry());

    const created = await call("/sessions", { method: "POST" });
    expect(created.status).toBe(201);
    const sid = String(created.body["sessionID"]);

    const status = await call(`/sessions/${sid}/status`);
    expect(status.status).toBe(200);
    expect(status.body["sessionID"]).toBe(sid);
  });
});

describe("T3 boot 接线：配置缺省关闭 / true 开启", () => {
  function bootYaml(ws: string, sessionList: boolean | undefined): string {
    return [
      "server:",
      "  port: 5119",
      "  hostname: 127.0.0.1",
      ...(sessionList === undefined ? [] : [`  sessionList: ${String(sessionList)}`]),
      `workspace: ${ws}`,
      "models:",
      "  - id: fake-t3-boot",
      "    provider: fake",
      "    contextWindow: 200000",
      "    maxOutput: 4096",
      "    timeout: 60000",
      "pricing:",
      "  fake:",
      "    input: 0",
      "    output: 0",
    ].join("\n");
  }

  async function bootApp(sessionList: boolean | undefined): Promise<LoomApp> {
    const ws = join(stateRoot, "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "# T3 session-list\n");
    const text = bootYaml(ws, sessionList);
    const store = new HotConfigStore({
      sink: createFileAuditSink(join(stateRoot, "config")),
      env: {},
    });
    const applied = store.apply(text, "<test>");
    if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
    const app = await createLoomApp({
      config: parseLoomConfig(text, "<test>", { env: {} }),
      store,
      stateRoot: join(stateRoot, "state"),
      tokens: [TOKEN],
      version: "test",
      env: { LOOM_FAKE_MODEL: "1" },
    });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    return app;
  }

  async function disposeApp(app: LoomApp): Promise<void> {
    await app.closeExtras();
    await new Promise<void>((resolve) => {
      app.server.closeAllConnections();
      app.server.close(() => resolve());
    });
    app.model.teardown();
  }

  function baseUrlOf(app: LoomApp): string {
    const addr = app.server.address();
    if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
    return `http://127.0.0.1:${String(addr.port)}`;
  }

  async function bootCall(
    app: LoomApp,
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrlOf(app)}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  }

  it("缺省配置：两列表路径 404；/sessions/main 200；POST 201 且逐会话 status 200", async () => {
    const app = await bootApp(undefined);
    try {
      for (const path of ["/sessions", "/sessions?archived=1"]) {
        const res = await bootCall(app, path);
        expect(res.status, path).toBe(404);
        expect(errorCode(res.body), path).toBe("session_list_disabled");
      }

      const main = await bootCall(app, "/sessions/main");
      expect(main.status).toBe(200);
      expect(main.body["sessionID"]).toBe(app.registry.defaultMainSessionId());
      expect("sessions" in main.body).toBe(false);

      const created = await bootCall(app, "/sessions", { method: "POST" });
      expect(created.status).toBe(201);
      const sid = String(created.body["sessionID"]);
      expect((await bootCall(app, `/sessions/${sid}/status`)).status).toBe(200);
    } finally {
      await disposeApp(app);
    }
  }, 60_000);

  it("sessionList:true 配置：GET /sessions 200 且 body 含 sessions/count", async () => {
    const app = await bootApp(true);
    try {
      const list = await bootCall(app, "/sessions");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body["sessions"])).toBe(true);
      expect(typeof list.body["count"]).toBe("number");
    } finally {
      await disposeApp(app);
    }
  }, 60_000);
});
