/**
 * L6 flow boot 级 e2e：配置开关 / JsonFlowStore / flow 唤醒 / 重启恢复 / closed 清理 / 禁用面。
 *
 * Given createLoomApp 全树（fake provider、独立 tmp workspace/stateRoot）；When 模型
 * flow_commit waiting_user 带 next_decision_at；Then 到点投递【心流唤醒】并起真实轮；
 * 重启后从 stateRoot 恢复；closed/禁用面绝不武装或落地 flow 面。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

interface TestApp {
  readonly app: LoomApp;
  readonly baseUrl: string;
  readonly work: string;
  readonly stateRoot: string;
  readonly token: string;
  close(options?: { readonly keepWork?: boolean }): Promise<void>;
}

const opened: TestApp[] = [];
let appSeq = 0;

interface FlowYamlOptions {
  readonly flow?: { readonly enabled: boolean; readonly retireConverge: boolean };
  readonly convergenceEnforced?: boolean;
}

function yamlFor(ws: string, opts: FlowYamlOptions): string {
  const lines = [
    "server:",
    "  port: 5110",
    "  hostname: 127.0.0.1",
    ...(opts.convergenceEnforced === false ? ["  convergenceEnforced: false"] : []),
    "workspace: WS_ROOT",
    "models:",
    "  - id: fake-flow",
    "    provider: fake",
    "    contextWindow: 200000",
    "    maxOutput: 4096",
    "    timeout: 60000",
    "pricing:",
    "  fake:",
    "    input: 0",
    "    output: 0",
  ];
  if (opts.flow !== undefined) {
    lines.push("flow:", `  enabled: ${String(opts.flow.enabled)}`);
    lines.push(`  retireConverge: ${String(opts.flow.retireConverge)}`);
  }
  return lines.join("\n").replace("WS_ROOT", ws);
}

async function makeApp(
  opts: FlowYamlOptions & { readonly work?: string } = {},
): Promise<TestApp> {
  const work = opts.work ?? mkdtempSync(join(tmpdir(), "loom-flow-boot-"));
  const ws = join(work, "ws");
  const stateRoot = join(work, "state");
  if (opts.work === undefined) {
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "# flow boot e2e\n");
  }

  const token = `tok-flow-${String(++appSeq)}`;
  const text = yamlFor(ws, opts);
  const store = new HotConfigStore({
    sink: createFileAuditSink(join(stateRoot, "config")),
    env: {},
  });
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
    tokens: [token],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");

  const h: TestApp = {
    app,
    baseUrl: `http://127.0.0.1:${String(addr.port)}`,
    work,
    stateRoot,
    token,
    close: async (closeOpts: { readonly keepWork?: boolean } = {}): Promise<void> => {
      await app.closeExtras();
      await new Promise<void>((resolve) => {
        app.server.closeAllConnections();
        app.server.close(() => resolve());
      });
      app.model.teardown();
      if (closeOpts.keepWork !== true) rmSync(work, { recursive: true, force: true });
    },
  };
  opened.push(h);
  return h;
}

function fake(h: TestApp): {
  push(...resp: FakeAssistantResponse[]): void;
  getCalls(): Array<{ messages: Array<{ role: string; content: unknown }> }>;
} {
  return h.app.model.model as unknown as {
    push(...resp: FakeAssistantResponse[]): void;
    getCalls(): Array<{ messages: Array<{ role: string; content: unknown }> }>;
  };
}

async function waitFor(predicate: () => boolean, budgetMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

async function api(
  h: TestApp,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${h.token}`, ...(init?.headers ?? {}) },
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

function flowTurn(text: string, args: Record<string, unknown>): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "flow_commit", arguments: args },
    ],
  };
}

function textTurn(text: string): FakeAssistantResponse {
  return { content: [{ type: "text", text }] };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("\n");
  }
  return "";
}

function hasUserMessageWith(h: TestApp, needle: string): boolean {
  return fake(h)
    .getCalls()
    .some((call) =>
      call.messages.some((m) => m.role === "user" && textOf(m.content).includes(needle)),
    );
}

function wakeSidecarPath(h: TestApp, sessionID: string): string {
  return join(h.stateRoot, "session", "wake", `${sessionID}.json`);
}

function readWakeSidecar(h: TestApp, sessionID: string): { at: number } | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(wakeSidecarPath(h, sessionID), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const at = Reflect.get(raw, "at");
    return typeof at === "number" ? { at } : null;
  } catch {
    return null;
  }
}

async function waitRunIdle(
  h: TestApp,
  sessionID: string,
  turns: number,
  budgetMs = 30_000,
): Promise<boolean> {
  return waitFor(() => {
    const rec = h.app.registry.get(sessionID);
    return rec !== undefined && rec.running === null && rec.turns >= turns;
  }, budgetMs);
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
});

afterEach(async () => {
  for (const h of opened.splice(0)) {
    await h.close();
  }
});

describe("flow boot 接线", () => {
  it(
    "flow enabled：waiting_user + 5s → sidecar 落盘 → 到点【心流唤醒】起真实轮 → 回 idle",
    async () => {
      const h = await makeApp({ flow: { enabled: true, retireConverge: true } });
      const main = h.app.registry.create();
      fake(h).push(
        flowTurn("挂起等待", {
          subject_name: "主线",
          state: "waiting_user",
          next_decision_at: "5s",
        }),
        textTurn("收到心流唤醒，继续处理。"),
      );

      const startedAt = Date.now();
      const sent = await api(h, `/sessions/${main.sessionID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "先挂起，5 秒后继续" }),
      });
      expect(sent.status).toBe(202);

      const observed: { sidecar: { at: number } | null } = { sidecar: null };
      expect(
        await waitFor(() => {
          observed.sidecar = readWakeSidecar(h, main.sessionID);
          return observed.sidecar !== null;
        }, 10_000),
        "flow 唤醒 sidecar 应落盘",
      ).toBe(true);
      const sidecar = observed.sidecar;
      if (sidecar === null) throw new Error("unreachable: sidecar not observed");
      expect(sidecar.at).toBeGreaterThan(startedAt);
      expect(existsSync(join(h.stateRoot, "session", main.sessionID, "flow", "subjects"))).toBe(true);

      expect(
        await waitFor(() => hasUserMessageWith(h, "【心流唤醒】"), 15_000),
        "唤醒轮应携【心流唤醒】user 消息",
      ).toBe(true);
      expect(
        await waitFor(() => !existsSync(wakeSidecarPath(h, main.sessionID)), 10_000),
        "投递后 sidecar 应删除",
      ).toBe(true);
      expect(await waitRunIdle(h, main.sessionID, 2, 15_000)).toBe(true);
      expect(
        hasUserMessageWith(h, "【自动唤醒】"),
        "flow 接线后不再投递 converge 自动唤醒文案",
      ).toBe(false);
    },
    120_000,
  );

  it(
    "重启恢复：重启后从 JsonFlowStore 重建并到点起轮",
    async () => {
      const first = await makeApp({ flow: { enabled: true, retireConverge: true } });
      const main = first.app.registry.create();
      fake(first).push(
        flowTurn("重启前挂起", {
          subject_name: "主线",
          state: "waiting_user",
          next_decision_at: "5s",
        }),
      );
      const sent = await api(first, `/sessions/${main.sessionID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "挂起后重启" }),
      });
      expect(sent.status).toBe(202);
      expect(
        await waitFor(() => readWakeSidecar(first, main.sessionID) !== null, 10_000),
        "重启前应已有 sidecar",
      ).toBe(true);
      const sessionID = main.sessionID;
      await first.close({ keepWork: true });
      const firstIndex = opened.indexOf(first);
      if (firstIndex >= 0) opened.splice(firstIndex, 1);

      const second = await makeApp({
        flow: { enabled: true, retireConverge: true },
        work: first.work,
      });
      fake(second).push(textTurn("重启后收到心流唤醒。"));
      await waitFor(() => second.app.registry.has(sessionID), 5_000);
      expect(
        await waitFor(() => hasUserMessageWith(second, "【心流唤醒】"), 20_000),
        "重启后应按 flow 真源恢复唤醒并起轮",
      ).toBe(true);
      expect(await waitRunIdle(second, sessionID, 1, 15_000)).toBe(true);
    },
    120_000,
  );

  it(
    "closed 清理：waiting 先武装，随后 closed 提交删除 sidecar 且不再唤醒",
    async () => {
      const h = await makeApp({ flow: { enabled: true, retireConverge: true } });
      const main = h.app.registry.create();
      fake(h).push(
        flowTurn("先挂起", {
          subject_name: "主线",
          state: "waiting_user",
          next_decision_at: "5s",
        }),
      );
      await api(h, `/sessions/${main.sessionID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "先挂起" }),
      });
      expect(
        await waitFor(() => readWakeSidecar(h, main.sessionID) !== null, 10_000),
        "waiting 提交应武装 sidecar",
      ).toBe(true);

      const subject = await h.app.flowStore?.findByName(main.sessionID, "主线");
      if (subject === undefined || subject === null) throw new Error("subject 未创建");
      fake(h).push(
        flowTurn("收口", {
          subject_id: subject.subject_id,
          expected_version: subject.version,
          state: "closed",
        }),
        textTurn("不应被唤醒"),
      );
      await api(h, `/sessions/${main.sessionID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "收口" }),
      });

      expect(
        await waitFor(() => !existsSync(wakeSidecarPath(h, main.sessionID)), 10_000),
        "closed 后应清除 sidecar",
      ).toBe(true);
      expect(await waitRunIdle(h, main.sessionID, 2, 15_000)).toBe(true);
      expect(
        hasUserMessageWith(h, "【心流唤醒】"),
        "closed 后不得再出现唤醒行",
      ).toBe(false);
    },
    120_000,
  );

  it(
    "flow 禁用：无 flow store / 无 flow 目录 / idle 帧无 flow 字段",
    async () => {
      const h = await makeApp({ convergenceEnforced: false });
      expect(h.app.flowStore).toBeUndefined();
      const main = h.app.registry.create();
      const publish = vi.spyOn(main.hub, "publish");
      fake(h).push(textTurn("普通回答"));

      await api(h, `/sessions/${main.sessionID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "普通提问" }),
      });
      expect(await waitRunIdle(h, main.sessionID, 1, 15_000)).toBe(true);

      expect(existsSync(join(h.stateRoot, "session", main.sessionID, "flow"))).toBe(false);
      expect(existsSync(wakeSidecarPath(h, main.sessionID))).toBe(false);
      const idle = publish.mock.calls.find((call) => call[0] === "session.idle");
      expect(idle).toBeDefined();
      expect(idle?.[2] !== undefined && Object.hasOwn(idle[2], "flow")).toBe(false);
    },
    120_000,
  );
});
