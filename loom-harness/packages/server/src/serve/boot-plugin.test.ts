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
const PTY_NAMES = ["pty_kill", "pty_list", "pty_read", "pty_spawn", "pty_write"] as const;

const EXTERNAL_PLUGIN_SOURCE = [
  'const manifest = {"id":"ext","name":"Ext","version":"1.0.0","apiVersion":1,"permissions":["tools:register"]};',
  "const setup = (ctx) => {",
  "  ctx.tools.register({",
  '    name: "ext_echo",',
  '    description: "external echo tool",',
  '    parameters: { type: "object", properties: {}, additionalProperties: false },',
  "    async execute() {",
  '      return { content: [{ type: "text", text: "ext" }] };',
  "    },",
  "  });",
  "  return {};",
  "};",
  "export default { manifest, setup };",
  "",
].join("\n");

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
    const contributions = booted.app.pluginHost.contributions();
    expect(contributions.tools.map((tool) => tool.name).sort()).toEqual(
      ["todowrite", ...PTY_NAMES, "task_fetch"].sort(),
    );
    expect(contributions.hooks).toEqual([]);
    expect(contributions.routes).toEqual([]);
  }, 40_000);

  it("plugins.todo.enabled=false：todo disabled，其余 running，工具面仅少 todowrite", async () => {
    const baseline = await boot(tempWork());
    const baselineNames = baseline.app.tools.map((tool) => tool.name);
    expect(baselineNames).toContain("todowrite");
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
    const names = booted.app.tools.map((tool) => tool.name);
    expect(names).not.toContain("todowrite");
    for (const name of PTY_NAMES) expect(names).toContain(name);
    expect(names).toContain("task_fetch");
    expect(names).toEqual(baselineNames.filter((name) => name !== "todowrite"));
  }, 60_000);

  it("plugins.pty.enabled=false：pty disabled，五件套缺席，todowrite 仍在", async () => {
    const booted = await boot(tempWork(), "plugins:\n  pty:\n    enabled: false");
    const res = await status(booted);
    expect(res.status).toBe(200);
    const plugins = pluginsOf(res.body);
    expect(plugins.find((plugin) => plugin["id"] === "pty")).toMatchObject({
      enabled: false,
      state: "disabled",
    });
    const names = booted.app.tools.map((tool) => tool.name);
    expect(names).toContain("todowrite");
    expect(names).toContain("task_fetch");
    for (const name of PTY_NAMES) expect(names).not.toContain(name);
    const contributions = booted.app.pluginHost.contributions();
    expect(contributions.tools.map((tool) => tool.name)).toEqual(["todowrite", "task_fetch"]);
  }, 60_000);

  it("pty.enabled=false：既有 pty 配置同样关闭五件套，todowrite 仍在", async () => {
    const booted = await boot(tempWork(), "pty:\n  enabled: false");
    const res = await status(booted);
    expect(res.status).toBe(200);
    const plugins = pluginsOf(res.body);
    expect(plugins.find((plugin) => plugin["id"] === "pty")).toMatchObject({
      enabled: false,
      state: "disabled",
    });
    const names = booted.app.tools.map((tool) => tool.name);
    expect(names).toContain("todowrite");
    expect(names).toContain("task_fetch");
    for (const name of PTY_NAMES) expect(names).not.toContain(name);
  }, 60_000);

  it("plugins.task.enabled=false：task disabled，task_fetch 缺席，todowrite + pty 仍在", async () => {
    const booted = await boot(tempWork(), "plugins:\n  task:\n    enabled: false");
    const res = await status(booted);
    expect(res.status).toBe(200);
    const plugins = pluginsOf(res.body);
    expect(plugins.find((plugin) => plugin["id"] === "task")).toMatchObject({
      enabled: false,
      state: "disabled",
    });
    for (const plugin of plugins.filter((candidate) => candidate["id"] !== "task")) {
      expect(plugin).toMatchObject({ enabled: true, state: "running" });
    }
    const names = booted.app.tools.map((tool) => tool.name);
    expect(names).not.toContain("task_fetch");
    expect(names).toContain("todowrite");
    for (const name of PTY_NAMES) expect(names).toContain(name);
  }, 60_000);

  it("P1 contributions：todo + pty + task_fetch 提供工具，Hook/路由仍为空", async () => {
    const booted = await boot(tempWork());
    expect(booted.app.tools.length).toBeGreaterThan(0);
    const contributions = booted.app.pluginHost.contributions();
    expect(contributions.tools.map((tool) => tool.name).sort()).toEqual(
      ["todowrite", ...PTY_NAMES, "task_fetch"].sort(),
    );
    expect(contributions.hooks).toEqual([]);
    expect(contributions.routes).toEqual([]);
  }, 40_000);

  it("plugins.<id>.path：外部插件 running、source external、trust trusted 并贡献工具", async () => {
    const work = tempWork();
    const modulePath = join(work, "ext-plugin.mjs");
    writeFileSync(modulePath, EXTERNAL_PLUGIN_SOURCE);

    const booted = await boot(
      work,
      `plugins:\n  ext:\n    path: ${JSON.stringify(modulePath)}`,
    );
    const res = await status(booted);
    expect(res.status).toBe(200);
    const plugins = pluginsOf(res.body);
    expect(plugins.map((plugin) => plugin["id"])).toEqual([...EXPECTED_IDS, "ext"]);
    expect(plugins.find((plugin) => plugin["id"] === "ext")).toMatchObject({
      source: "external",
      trust: "trusted",
      enabled: true,
      state: "running",
    });

    const names = booted.app.tools.map((tool) => tool.name);
    expect(names).toContain("ext_echo");
    for (const name of ["todowrite", ...PTY_NAMES, "task_fetch"]) {
      expect(names).toContain(name);
    }
    const contributions = booted.app.pluginHost.contributions().tools.map((tool) => tool.name);
    expect(contributions.sort()).toEqual(
      ["todowrite", ...PTY_NAMES, "task_fetch", "ext_echo"].sort(),
    );
  }, 60_000);

  it("plugins.<id>.enabled=false：外部模块不 import，也不出现在 status", async () => {
    const work = tempWork();
    const modulePath = join(work, "disabled-plugin.mjs");
    writeFileSync(modulePath, 'throw new Error("disabled external plugin must not load");\n');

    const booted = await boot(
      work,
      `plugins:\n  ghost:\n    path: ${JSON.stringify(modulePath)}\n    enabled: false`,
    );
    const res = await status(booted);
    expect(res.status).toBe(200);
    expect(pluginsOf(res.body).map((plugin) => plugin["id"])).toEqual([...EXPECTED_IDS]);
    expect(booted.app.tools.map((tool) => tool.name)).not.toContain("ext_echo");
  }, 60_000);

  it("builtin id 带 path：boot fail-fast", async () => {
    const work = tempWork();
    const modulePath = join(work, "collision-plugin.mjs");
    writeFileSync(modulePath, EXTERNAL_PLUGIN_SOURCE);
    try {
      await expect(
        boot(work, `plugins:\n  todo:\n    path: ${JSON.stringify(modulePath)}`),
      ).rejects.toThrow(/builtin/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it("builtin id 带 path + enabled:false：仍 boot fail-fast", async () => {
    const work = tempWork();
    const modulePath = join(work, "collision-disabled-plugin.mjs");
    writeFileSync(modulePath, EXTERNAL_PLUGIN_SOURCE);
    try {
      await expect(
        boot(
          work,
          `plugins:\n  todo:\n    path: ${JSON.stringify(modulePath)}\n    enabled: false`,
        ),
      ).rejects.toThrow(/builtin/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
