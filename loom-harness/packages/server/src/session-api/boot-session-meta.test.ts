/**
 * W23-B 会话列表域三件套 —— meta sidecar 单测 + registry 视图单元钉 + boot 级双 boot e2e。
 *
 * 覆盖任务验收清单：
 *  A. SessionMetaStore roundtrip（同文件重装载全等 / 坏文件=空表 fail-soft / 清除语义 /
 *     空条目自动删键）；
 *  B. registry list() 视图：createdAt **倒序**（新→旧，含"重水化 sid 带旧转录时间戳"格）、
 *     title 回落链（meta > undefined）、archive 隐藏/反显、**defaultMainSessionId()
 *     插入序命门不动钉**（视图倒序不撼动首注册语义）、未接 meta = 命令面 false；
 *  C. boot 级：标题/归档**跨两次 boot 持久**；?archived=1 过滤反转；title trim/120 码点上限/
 *     空串清除；未知 sid 404；非字符串 title 400；归档会话重启后仍不在默认列表。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemorySessionStore } from "@axeuh/loom-core";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import { createFakeModelFromConfig } from "../fake-model/index.js";
import { SessionMetaStore } from "../session-meta.js";
import { SessionRegistry } from "./index.js";
import type { LoomApp } from "../serve/boot.js";

type CreateLoomApp = typeof import("../serve/boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

const FAKE_YAML = [
  "server:",
  "  port: 5112",
  "  hostname: 127.0.0.1",
  "  sessionList: true",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w23b",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

function mainConverge(text: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
    ],
  };
}

/* ────────────────────────── A. SessionMetaStore 单测 ────────────────────────── */

describe("W23-B SessionMetaStore：原子覆盖 + fail-soft + 清除语义", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-w23b-meta-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("roundtrip：mutate → 新实例读同文件全等；跨 boot 持久面成立", () => {
    const file = join(dir, "meta_a.json");
    const store = new SessionMetaStore({ file });
    store.mutate("sid_1", { title: "标题一", archived: true });
    store.mutate("sid_2", { pinned: true });
    const reloaded = new SessionMetaStore({ file });
    expect(reloaded.get("sid_1")).toEqual({ title: "标题一", archived: true });
    expect(reloaded.get("sid_2")).toEqual({ pinned: true });
    expect(readFileSync(file, "utf8")).toContain("标题一");
  });

  it("undefined 补丁值 = 删除声明；条目全空 ⇒ 键整体移除（文件不积垃圾）", () => {
    const file = join(dir, "meta_b.json");
    const store = new SessionMetaStore({ file });
    store.mutate("sid_x", { title: "T" });
    store.mutate("sid_x", { title: undefined });
    expect(store.get("sid_x")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  it("坏文件 = 空表 fail-soft + warn；文件缺失 = 静默空表", () => {
    const file = join(dir, "meta_c.json");
    const warns: string[] = [];
    writeFileSync(file, "{broken", "utf8");
    const store = new SessionMetaStore({ file, warn: (m) => warns.push(m) });
    expect(store.entries().size).toBe(0);
    expect(warns.length).toBe(1);
    const missing = new SessionMetaStore({ file: join(dir, "never.json"), warn: (m) => warns.push(m) });
    expect(missing.entries().size).toBe(0);
    expect(warns.length).toBe(1); // 缺失不 warn（常态）
  });

  it("形状不合条目（title 非 string 等）⇒ 整表弃（半表生效不可解释）", () => {
    const file = join(dir, "meta_d.json");
    writeFileSync(file, JSON.stringify({ a: { title: 42 } }), "utf8");
    const warns: string[] = [];
    const store = new SessionMetaStore({ file, warn: (_m, f) => warns.push(String(f.error)) });
    expect(store.entries().size).toBe(0);
    expect(warns.length).toBe(1);
  });
});

/* ────────────────────────── B. registry list 视图单元钉 ────────────────────────── */

describe("W23-B registry list()：倒序视图 + title/archived + 插入序命门", () => {
  const convergeScript: readonly FakeAssistantResponse[] = [mainConverge("占位")];

  function makeReg(opts?: {
    meta?: SessionMetaStore;
    createdAtOf?: (sid: string) => number | null;
  }): { registry: SessionRegistry; dispose: () => void } {
    const cfg = parseLoomConfig(FAKE_YAML.replace("WS_ROOT", mkdtempSync(join(tmpdir(), "loom-w23b-ws-"))), "<test>", { env: {} });
    const model = createFakeModelFromConfig(cfg.models[0]!, convergeScript);
    let seq = 0;
    const registry = new SessionRegistry({
      model,
      store: new MemorySessionStore(),
      now: () => 5_000_000, // 新会话诞生时刻定值（可比对排序）
      newSessionID: () => `sid_new${String(++seq)}`,
      ...(opts?.meta === undefined ? {} : { meta: opts.meta }),
      ...(opts?.createdAtOf === undefined ? {} : { createdAtOf: opts.createdAtOf }),
    });
    return { registry, dispose: () => model.teardown() };
  }

  it("createdAt 视图倒序（新→旧，重水化旧转录时间戳居中）；#records 插入序命门不动", () => {
    const { registry, dispose } = makeReg({
      createdAtOf: (sid) => (sid === "old_a" ? 1000 : sid === "old_b" ? 2000 : null),
    });
    try {
      registry.ensure("old_a");
      registry.ensure("old_b");
      const fresh = registry.create(); // createdAt = now 5_000_000
      const views = registry.list();
      expect(views.map((v) => v.sessionID)).toEqual([fresh.sessionID, "old_b", "old_a"]);
      expect(views.map((v) => v.createdAt)).toEqual([5_000_000, 2000, 1000]);
      // 命门钉：list 倒序只是视图面；defaultMainSessionId()=首注册（old_a），不受排序波及。
      expect(registry.defaultMainSessionId()).toBe("old_a");
    } finally {
      dispose();
    }
  });

  it("title 回落链：meta > undefined（键缺席，绝不造空串/占位）；清除后回到缺席", () => {
    const dirB = mkdtempSync(join(tmpdir(), "loom-w23b-reg-"));
    const meta = new SessionMetaStore({ file: join(dirB, "meta.json") });
    const { registry, dispose } = makeReg({ meta });
    try {
      const rec = registry.create();
      expect(registry.list()[0]!.title).toBeUndefined();
      expect(registry.setTitle(rec.sessionID, "我的会话")).toBe(true);
      expect(registry.list()[0]!.title).toBe("我的会话");
      expect(registry.setTitle(rec.sessionID, null)).toBe(true);
      expect("title" in (registry.list()[0] ?? {})).toBe(false);
    } finally {
      dispose();
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('archive 隐藏/反显：默认列表排除；only 反显；unarchive 回归；停机面 all 不遗漏', () => {
    const dirC = mkdtempSync(join(tmpdir(), "loom-w23b-reg-"));
    const meta = new SessionMetaStore({ file: join(dirC, "meta.json") });
    const { registry, dispose } = makeReg({ meta });
    try {
      const a = registry.create();
      const b = registry.create();
      expect(registry.setArchived(a.sessionID, true)).toBe(true);
      expect(registry.list().map((v) => v.sessionID)).toEqual([b.sessionID]); // 默认排归档
      expect(registry.list({ archived: "only" }).map((v) => v.sessionID)).toEqual([a.sessionID]);
      expect(registry.list({ archived: "only" })[0]!.archived).toBe(true);
      expect(registry.list({ archived: "all" }).map((v) => v.sessionID).sort()).toEqual([a.sessionID, b.sessionID].sort());
      expect(registry.setArchived(a.sessionID, false)).toBe(true);
      expect(registry.list().length).toBe(2);
    } finally {
      dispose();
      rmSync(dirC, { recursive: true, force: true });
    }
  });

  it("未知 sid 命令面 false（路由转 404）；未接 meta 命令面同样 false（视图 archived 恒 false）", () => {
    const { registry, dispose } = makeReg(); // 无 meta
    try {
      const rec = registry.create();
      expect(registry.setTitle(rec.sessionID, "T")).toBe(false);
      expect(registry.setArchived(rec.sessionID, true)).toBe(false);
      expect(registry.setTitle("ghost_sid", "T")).toBe(false);
      const view = registry.list()[0]!;
      expect(view.archived).toBe(false);
      expect(view.title).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("meta 独有条目（归档后重启未重水化的 sid）仍是已知 sid（isKnownSession 双面取）", () => {
    const dirD = mkdtempSync(join(tmpdir(), "loom-w23b-reg-"));
    const file = join(dirD, "meta.json");
    const writer = new SessionMetaStore({ file });
    writer.mutate("ghost_archived", { archived: true, title: "旧归档" });
    const meta = new SessionMetaStore({ file });
    const { registry, dispose } = makeReg({ meta });
    try {
      expect(registry.has("ghost_archived")).toBe(false); // 不在内存册
      expect(registry.isKnownSession("ghost_archived")).toBe(true); // meta 有条目 = 已知
      expect(registry.setArchived("ghost_archived", false)).toBe(true); // 可解档
    } finally {
      dispose();
      rmSync(dirD, { recursive: true, force: true });
    }
  });
});

/* ────────────────────────── C. boot 级双 boot e2e ────────────────────────── */

let work = "";
let ws = "";
let stateRoot = "";
const TOKEN = "tok-w23b-meta";

async function bootApp(): Promise<LoomApp> {
  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
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

async function api(app: LoomApp, path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrlOf(app)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function waitFor(predicate: () => boolean, budgetMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

async function runTurn(app: LoomApp, sid: string, text: string, reply: string): Promise<void> {
  (app.model.model as unknown as { push(...r: FakeAssistantResponse[]): void }).push(mainConverge(reply));
  const sent = await api(app, `/sessions/${sid}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(sent.status).toBe(202);
  expect(await waitFor(() => app.registry.get(sid)?.running === null)).toBe(true);
}

beforeAll(async () => {
  createLoomApp = (await import("../serve/boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w23b-boot-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# W23-B meta 底座\n");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("W23-B boot 级：标题/归档跨双 boot 持久 + 端点边界", () => {
  it(
    "首 boot 标题+归档 → 拆树 → 二次 boot：默认列表排归档、?archived=1 反显带标题、新会话置顶（createdAt 倒序）",
    async () => {
      const app1 = await bootApp();
      let sid1 = "";
      let sid2 = "";
      try {
        sid1 = String((await api(app1, "/sessions", { method: "POST" })).json.sessionID);
        sid2 = String((await api(app1, "/sessions", { method: "POST" })).json.sessionID);
        // 两会话各跑一轮 ⇒ 转录落主 store（重水化与旧时间戳 createdAt 的数据前提）。
        await runTurn(app1, sid1, "第一问", "W23B-一");
        await runTurn(app1, sid2, "第二问", "W23B-二");

        const titled = await api(app1, `/sessions/${sid1}/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "  重要会话  " }),
        });
        expect(titled.status).toBe(200);
        expect(titled.json.ok).toBe(true);
        // 120 码点上限：200 字 → 截 120。
        await api(app1, `/sessions/${sid2}/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "长".repeat(200) }),
        });
        const archived = await api(app1, `/sessions/${sid1}/archive`, { method: "POST" });
        expect(archived.status).toBe(200);
      } finally {
        await disposeApp(app1);
      }

      const app2 = await bootApp();
      try {
        // 默认列表：sid1 归档隐身（meta 跨 boot 持久）；sid2 重水化 + 标题截断持久。
        const list = await api(app2, "/sessions");
        const sessions = list.json.sessions as Array<Record<string, unknown>>;
        const ids = sessions.map((s) => s.sessionID);
        expect(ids).not.toContain(sid1);
        expect(ids).toContain(sid2);
        const view2 = sessions.find((s) => s.sessionID === sid2)!;
        expect(view2.title).toBe("长".repeat(120));
        expect(typeof view2.createdAt).toBe("number");
        expect(view2.archived).toBe(false);

        // ?archived=1 只列归档：sid1 反显、标题 trim 持久（"  重要会话  " → "重要会话"）。
        const archList = await api(app2, "/sessions?archived=1");
        const arch = archList.json.sessions as Array<Record<string, unknown>>;
        expect(arch.map((s) => s.sessionID)).toEqual([sid1]);
        expect(arch[0]!.title).toBe("重要会话");
        expect(arch[0]!.archived).toBe(true);

        // 倒序格：二次 boot 新建会话 = 新 createdAt，压过重水化旧转录时间戳会话。
        const sid3 = String((await api(app2, "/sessions", { method: "POST" })).json.sessionID);
        const after = await api(app2, "/sessions");
        const ids3 = (after.json.sessions as Array<Record<string, unknown>>).map((s) => s.sessionID);
        expect(ids3[0]).toBe(sid3);

        // unarchive 回归默认列表；重复 unarchive 幂等 200。
        expect((await api(app2, `/sessions/${sid1}/unarchive`, { method: "POST" })).status).toBe(200);
        expect((await api(app2, `/sessions/${sid1}/unarchive`, { method: "POST" })).status).toBe(200);
        const back = await api(app2, "/sessions");
        expect((back.json.sessions as Array<Record<string, unknown>>).map((s) => s.sessionID)).toContain(sid1);

        // 未知 sid 404（三端点）；非字符串 title 400；空串 title = 清除（回到无 title 键）。
        expect((await api(app2, "/sessions/ghost_sid_x/title", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "t" }),
        })).status).toBe(404);
        expect((await api(app2, "/sessions/ghost_sid_x/archive", { method: "POST" })).status).toBe(404);
        expect((await api(app2, "/sessions/ghost_sid_x/unarchive", { method: "POST" })).status).toBe(404);
        expect((await api(app2, `/sessions/${sid2}/title`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: 42 }),
        })).status).toBe(400);
        expect((await api(app2, `/sessions/${sid2}/title`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "   " }),
        })).status).toBe(200);
        const cleared = await api(app2, "/sessions");
        const cv = (cleared.json.sessions as Array<Record<string, unknown>>).find((s) => s.sessionID === sid2)!;
        expect("title" in cv).toBe(false);
      } finally {
        await disposeApp(app2);
      }
    },
    120_000,
  );
});
