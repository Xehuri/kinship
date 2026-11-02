import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

interface Booted {
  readonly app: LoomApp;
  readonly baseUrl: string;
  readonly token: string;
  close(): Promise<void>;
}

const opened: Booted[] = [];
let seq = 0;

const EXPECTED_IDS = ["todo", "pty", "task", "plan", "inbox"] as const;

function tempWork(): string {
  return mkdtempSync(join(tmpdir(), "loom-plugin-boot-"));
}

function yamlFor(work: string, plugins?: string): string {
  const lines = [
    "server:",
    "  port: 5111",
    "  hostname: 127.0.0.1",
    "workspace: WS_ROOT",
    "models:",
    "  - id: fake-plugin-boot",
    "    provider: fake",
    "    contextWindow: 200000",
    "    maxOutput: 4096",
    "    timeout: 60000",
    "pricing:",
    "  fake:",
    "    input: 0",
    "    output: 0",
  ];
  if (plugins !== undefined) lines.push(plugins);
  return lines.join("\n").replace("WS_ROOT", join(work, "ws"));
}

async function boot(work: string, plugins?: string): Promise<Booted> {
  const ws = join(work, "ws");
  const stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# plugin boot\n");
  const text = yamlFor(work, plugins);
  const store = new HotConfigStore({
    sink: createFileAuditSink(join(stateRoot, "config")),
    env: {},
  });
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const token = `tok-plugin-boot-${String(++seq)}`;
  const app = await (await import("./boot.js")).createLoomApp({
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
  let closed = false;
  const booted: Booted = {
    app,
    baseUrl: `http://127.0.0.1:${String(addr.port)}`,
    token,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.closeExtras();
      await new Promise<void>((resolve) => {
        app.server.closeAllConnections();
        app.server.close(() => resolve());
      });
      app.model.teardown();
      rmSync(work, { recursive: true, force: true });
    },
  };
  opened.push(booted);
  return booted;
}

async function status(
  booted: Booted,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${booted.baseUrl}/plugins/status`, {
    headers: { Authorization: `Bearer ${booted.token}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function pluginsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body["plugins"] as Array<Record<string, unknown>>;
}

afterEach(async () => {
  while (opened.length > 0) {
    const booted = opened.pop();
    if (booted !== undefined) await booted.close();
  }
});

describe("plugin host boot", () => {
  it("无 plugins 段：五个 builtin 全部 running", async () => {
    const booted = await boot(tempWork());
    const res = await status(booted);
    expect(res.status).toBe(200);
    expect(res.body["apiVersion"]).toBe(1);
    const plugins = pluginsOf(res.body);
    expect(plugins.map((plugin) => plugin["id"])).toEqual([...EXPECTED_IDS]);
    for (const plugin of plugins) {
      expect(plugin).toMatchObject({
        source: "builtin",
        trust: "builtin",
        enabled: true,
        state: "running",
      });
    }
  }, 40_000);

  it("plugins.todo.enabled=false：todo disabled，其余 running，工具面与缺省 boot 一致", async () => {
    const baseline = await boot(tempWork());
    const baselineNames = baseline.app.tools.map((tool) => tool.name);
    await baseline.close();

    const booted = await boot(tempWork(), "plugins:\n  todo:\n    enabled: false");
    const res = await status(booted);
    expect(res.status).toBe(200);
    const plugins = pluginsOf(res.body);
    expect(plugins.find((plugin) => plugin["id"] === "todo")).toMatchObject({
      enabled: false,
      state: "disabled",
    });
    for (const plugin of plugins.filter((candidate) => candidate["id"] !== "todo")) {
      expect(plugin).toMatchObject({ enabled: true, state: "running" });
    }
    expect(booted.app.tools.map((tool) => tool.name)).toEqual(baselineNames);
  }, 60_000);

  it("P0 contributions 为空：工具/Hook/路由均未被 Host 接管", async () => {
    const booted = await boot(tempWork());
    expect(booted.app.tools.length).toBeGreaterThan(0);
    const contributions = booted.app.pluginHost.contributions();
    expect(contributions.tools).toEqual([]);
    expect(contributions.hooks).toEqual([]);
    expect(contributions.routes).toEqual([]);
  }, 40_000);
});
