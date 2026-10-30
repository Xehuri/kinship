/**
 * T2 boot 级验收：主会话解析结果进入 registry、先于任何请求存在，且跨两次 boot 稳定。
 * 全是临时 stateRoot；生产会话 id 不出现。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { JsonlSessionStore } from "@axeuh/loom-adapters";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";
import { mainSessionMarkerPath } from "./main-session.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

interface Booted {
  readonly app: LoomApp;
  readonly logs: LogLine[];
  readonly stateRoot: string;
  close(): Promise<void>;
}

const opened: Booted[] = [];
const works: string[] = [];

function tempWork(): string {
  const work = mkdtempSync(join(tmpdir(), "loom-boot-main-"));
  works.push(work);
  return work;
}

function yamlFor(ws: string, mainSessionId?: string): string {
  return [
    "server:",
    "  port: 5110",
    "  hostname: 127.0.0.1",
    ...(mainSessionId === undefined ? [] : [`  mainSessionId: ${mainSessionId}`]),
    "workspace: WS_ROOT",
    "models:",
    "  - id: fake-main-session",
    "    provider: fake",
    "    contextWindow: 200000",
    "    maxOutput: 4096",
    "    timeout: 60000",
    "pricing:",
    "  fake:",
    "    input: 0",
    "    output: 0",
  ]
    .join("\n")
    .replace("WS_ROOT", ws);
}

function readMarker(stateRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(mainSessionMarkerPath(stateRoot), "utf8")) as Record<string, unknown>;
}

async function boot(work: string, mainSessionId?: string): Promise<Booted> {
  const ws = join(work, "ws");
  const stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# T2 主会话 boot\n");

  const text = yamlFor(ws, mainSessionId);
  const store = new HotConfigStore({
    sink: createFileAuditSink(join(stateRoot, "config")),
    env: {},
  });
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);

  const logs: LogLine[] = [];
  const app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
    tokens: ["tok-boot-main"],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
  });
  const booted: Booted = {
    app,
    logs,
    stateRoot,
    close: async (): Promise<void> => {
      await app.closeExtras();
      app.model.teardown();
    },
  };
  opened.push(booted);
  return booted;
}

function mainLog(booted: Booted): LogLine | undefined {
  return booted.logs.find((line) => line.msg === "loom main session");
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
});

afterEach(async () => {
  for (const booted of opened.splice(0)) await booted.close();
  for (const work of works.splice(0)) rmSync(work, { recursive: true, force: true });
});

describe("boot 主会话解析与登记", () => {
  it(
    "空库首启：生成主会话并登记，defaultMainSessionId 返回它；二次 boot 同一 id（标记来源）",
    async () => {
      const work = tempWork();
      const first = await boot(work);
      const mainID = first.app.registry.defaultMainSessionId();
      if (mainID === undefined) throw new Error("boot 主会话未解析");
      expect(first.app.registry.has(mainID)).toBe(true);
      expect(first.app.registry.viewOf(mainID)).toMatchObject({
        sessionID: mainID,
        status: "idle",
        archived: false,
      });
      expect(first.app.registry.viewOf("ses_unknown")).toBeUndefined();
      expect(mainLog(first)?.fields).toEqual({
        sessionID: mainID,
        source: "generated",
        ensured: true,
      });
      expect(readMarker(first.stateRoot)).toMatchObject({
        sessionID: mainID,
        source: "generated",
      });
      await first.close();

      const second = await boot(work);
      expect(second.app.registry.defaultMainSessionId()).toBe(mainID);
      expect(second.app.registry.has(mainID)).toBe(true);
      expect(mainLog(second)?.fields).toEqual({
        sessionID: mainID,
        source: "marker",
        ensured: true,
      });
      expect(readMarker(second.stateRoot)).toMatchObject({
        sessionID: mainID,
        source: "marker",
      });
    },
    90_000,
  );

  it(
    "server.mainSessionId 优先：boot 直接登记配置 id，并覆盖已有标记",
    async () => {
      const work = tempWork();
      const first = await boot(work);
      const generated = first.app.registry.defaultMainSessionId();
      expect(generated).toBeDefined();
      await first.close();

      const second = await boot(work, "ses_cfgboot");
      expect(second.app.registry.defaultMainSessionId()).toBe("ses_cfgboot");
      expect(second.app.registry.has("ses_cfgboot")).toBe(true);
      expect(mainLog(second)?.fields).toEqual({
        sessionID: "ses_cfgboot",
        source: "config",
        ensured: true,
      });
      expect(readMarker(second.stateRoot)).toMatchObject({
        sessionID: "ses_cfgboot",
        source: "config",
      });
      await second.close();

      const third = await boot(work);
      expect(third.app.registry.defaultMainSessionId()).toBe("ses_cfgboot");
      expect(mainLog(third)?.fields["source"]).toBe("marker");
    },
    90_000,
  );

  it(
    "空库无配置：主 store 已有 sid 时选首个并登记（不新造）",
    async () => {
      const work = tempWork();
      const stateRoot = join(work, "state");
      mkdirSync(join(stateRoot, "session"), { recursive: true });
      const store = new JsonlSessionStore(join(stateRoot, "session", "loom-main.jsonl"));
      await store.appendEntry("ses_storeboot", {
        kind: "message",
        message: { role: "user", content: "旧主会话", timestamp: 1 },
      });

      const booted = await boot(work);
      expect(booted.app.registry.defaultMainSessionId()).toBe("ses_storeboot");
      expect(booted.app.registry.has("ses_storeboot")).toBe(true);
      expect(mainLog(booted)?.fields["source"]).toBe("store");
      expect(readMarker(booted.stateRoot)).toMatchObject({
        sessionID: "ses_storeboot",
        source: "store",
      });
    },
    90_000,
  );
});
