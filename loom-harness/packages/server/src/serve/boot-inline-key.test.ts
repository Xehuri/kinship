// providers[].apiKey 内联密钥的 boot 面脱敏硬证：日志/manifest/model 序列化零命中，
// manifest 只保留 maskApiKey 遮蔽形（首3***末4）。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { ServeLog } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

const INLINE_KEY = "sk-inline-boot-canary-5e8a";
const YAML = [
  "server:",
  "  port: 5101",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "providers:",
  "  - provider: eflowcode",
  "    baseUrl: https://inline.example/v1",
  `    apiKey: ${INLINE_KEY}`,
  "models:",
  "  - id: inline-boot",
  "    provider: eflowcode",
  "    contextWindow: 1000",
  "    maxOutput: 100",
  "    timeout: 5000",
  "pricing:",
  "  eflowcode:",
  "    input: 0",
  "    output: 0",
].join("\n");

let root = "";
let stateRoot = "";

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  root = mkdtempSync(join(tmpdir(), "loom-inline-boot-"));
  stateRoot = join(root, "state");
  mkdirSync(join(root, "ws"), { recursive: true });
  writeFileSync(join(root, "ws", "AGENTS.md"), "# workspace\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createLoomApp: providers[].apiKey boot 脱敏", () => {
  it("日志/manifest/model 序列化均不含内联密钥；manifest 只留 mask 形", async () => {
    const ws = join(root, "ws");
    const text = YAML.replace("WS_ROOT", ws);
    const config = parseLoomConfig(text, "<test>", { env: {} });
    const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
    expect(store.apply(text, "<test>").ok).toBe(true);

    const logs: string[] = [];
    const log: ServeLog = (level, msg, fields) => {
      logs.push(JSON.stringify({ level, msg, ...fields }));
    };
    const app = await createLoomApp({
      config,
      store,
      stateRoot,
      tokens: ["tok-inline-boot"],
      version: "test",
      env: {},
      log,
    });
    try {
      expect(app.model.llmOptions.apiKey).toBe(INLINE_KEY);
      expect(logs.join("\n")).not.toContain(INLINE_KEY);
      expect(JSON.stringify(app.contextManifest)).not.toContain(INLINE_KEY);
      expect(JSON.stringify(app.model.model)).not.toContain(INLINE_KEY);
      expect(app.contextManifest.model.apiKeyMasked).toBe("sk-***5e8a");
    } finally {
      app.models.teardownAll();
      await app.closeExtras();
    }
  });
});
