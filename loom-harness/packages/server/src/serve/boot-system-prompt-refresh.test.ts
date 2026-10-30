/**
 * boot 级 systemPrompt / memory 重读 e2e（fake model + 真 HTTP + 临时 workspace）。
 *
 * Given: agents/main.md（kind:main, memory: [AGENTS.md, memory/state.md]）+ AGENTS.md +
 *        memory/state.md 的 boot 快照；boot 完成后改写 state.md（并追加 AGENTS.md 哨兵），
 *        使 boot plan 成为过期快照。
 * When:  POST /sessions → 首轮 send（session-start 触发重读）→ 次轮 send（文件不再变）。
 * Then:  ① 首跑前 /context/full 仍为 pre-first-run 形状：segments []、prefixHash=systemPrompt 哈希；
 *        ② 首跑后请求面 = 重读后的 plan：systemPrompt/记忆段含 STATE-V2 哨兵、与 prefixHash 全等、
 *           字节长度如实、fake 模型首调用收到新前缀；
 *        ③ 次轮无文件变更：systemPrompt 字节逐字不变（不重复重读换前缀）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";

const TOKEN = "tok-boot-prompt-refresh";
const IDLE_TIMEOUT_MS = 20_000;
const PERSONA_SENTINEL = "PERSONA-BOOT-SENTINEL";
const AGENTS_BOOT_SENTINEL = "BOOT-WORKSPACE-SENTINEL";
const AGENTS_RELOAD_SENTINEL = "AGENTS-V2-RELOAD-SENTINEL";
const STATE_V1 = "STATE-V1";
const STATE_V2 = "STATE-V2-RELOAD-SENTINEL";

const FAKE_YAML = [
  "server:",
  "  port: 5105",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-refresh",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

interface ContextFullBody {
  readonly systemPrompt: string;
  readonly prefixHash: string;
  readonly systemPromptSha256: string;
  readonly prefixByteLength: number;
  readonly segments: readonly { readonly label: string; readonly text: string }[];
}

function convergeTurn(text: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
    ],
  };
}

function fakeCalls(app: LoomApp): readonly { readonly systemPrompt?: string }[] {
  return (app.model.model as unknown as { getCalls(): readonly { systemPrompt?: string }[] }).getCalls();
}

function pushFake(app: LoomApp, response: FakeAssistantResponse): void {
  (app.model.model as unknown as { push(...r: FakeAssistantResponse[]): void }).push(response);
}

function memoryTextOf(view: ContextFullBody): string {
  return view.segments.find((segment) => segment.label === "memory")?.text ?? "";
}

async function bootApp(): Promise<{ app: LoomApp; baseUrl: string }> {
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
    log: () => {},
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
  return { app, baseUrl: `http://127.0.0.1:${String(addr.port)}` };
}

async function disposeApp(app: LoomApp): Promise<void> {
  await app.closeExtras();
  await new Promise<void>((resolve) => {
    app.server.closeAllConnections();
    app.server.close(() => resolve());
  });
  app.models.teardownAll();
}

async function waitForIdle(app: LoomApp, sessionID: string): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  for (;;) {
    if (app.registry.get(sessionID)?.running === null) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting idle for ${sessionID}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-boot-spr-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(join(ws, "agents"), { recursive: true });
  mkdirSync(join(ws, "memory"), { recursive: true });
  writeFileSync(
    join(ws, "agents", "main.md"),
    [
      "---",
      "name: main",
      "kind: main",
      "memory: [AGENTS.md, memory/state.md]",
      "---",
      `# ${PERSONA_SENTINEL}`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(ws, "AGENTS.md"), `# 工作区记忆\n${AGENTS_BOOT_SENTINEL}\n`);
  writeFileSync(join(ws, "memory", "state.md"), `${STATE_V1}\n`);
});

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe("boot 级 systemPrompt/memory 重读：session-start 生效、无变更不重载", () => {
  it("boot 后改盘的 memory/persona 源在首轮进请求面；次轮字节不变", async () => {
    const { app, baseUrl } = await bootApp();
    try {
      // boot plan 已成过期快照：改盘发生在 boot 之后。
      writeFileSync(join(ws, "memory", "state.md"), `${STATE_V2}\n`);
      writeFileSync(
        join(ws, "AGENTS.md"),
        `# 工作区记忆\n${AGENTS_BOOT_SENTINEL}\n${AGENTS_RELOAD_SENTINEL}\n`,
      );

      const created = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(created.status).toBe(201);
      const { sessionID } = (await created.json()) as { sessionID: string };
      const encoded = encodeURIComponent(sessionID);
      const contextFull = async (): Promise<ContextFullBody> => {
        const res = await fetch(`${baseUrl}/sessions/${encoded}/context/full`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(200);
        return (await res.json()) as ContextFullBody;
      };
      const send = async (text: string): Promise<void> => {
        const res = await fetch(`${baseUrl}/sessions/${encoded}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        expect(res.status).toBe(202);
      };

      // ① pre-first-run：装配未发生 → segments 空、prefixHash 回退=发送字节哈希；
      //    systemPrompt 仍是 boot 期 plan（STATE-V1 在场、重读哨兵绝迹）。
      const pre = await contextFull();
      expect(pre.segments).toEqual([]);
      expect(pre.prefixHash).toBe(pre.systemPromptSha256);
      expect(pre.systemPrompt).toContain(PERSONA_SENTINEL);
      expect(pre.systemPrompt).toContain(AGENTS_BOOT_SENTINEL);
      expect(pre.systemPrompt).toContain(STATE_V1);
      expect(pre.systemPrompt).not.toContain(STATE_V2);

      // ② 首轮 send：session-start 重读 → 请求面换成新 plan。
      pushFake(app, convergeTurn("首轮收口"));
      await send("首轮取证");
      await waitForIdle(app, sessionID);

      const first = await contextFull();
      expect(first.systemPrompt).toContain(PERSONA_SENTINEL);
      expect(first.systemPrompt).toContain(AGENTS_RELOAD_SENTINEL);
      expect(first.systemPrompt).toContain(STATE_V2);
      expect(first.systemPrompt).not.toContain(STATE_V1);
      expect(memoryTextOf(first)).toContain(AGENTS_RELOAD_SENTINEL);
      expect(memoryTextOf(first)).toContain(STATE_V2);
      expect(first.systemPromptSha256).toBe(first.prefixHash);
      expect(first.prefixByteLength).toBe(Buffer.byteLength(first.systemPrompt, "utf8"));
      expect(first.segments.length).toBeGreaterThan(0);

      const calls = fakeCalls(app);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstRequest = calls[0]?.systemPrompt ?? "";
      expect(firstRequest).toContain(STATE_V2);
      expect(firstRequest).toContain(AGENTS_RELOAD_SENTINEL);

      // ③ 次轮无文件变更：字节逐字不变（session-start 每会话只重读一次）。
      pushFake(app, convergeTurn("次轮收口"));
      await send("次轮取证");
      await waitForIdle(app, sessionID);

      const second = await contextFull();
      expect(second.systemPrompt).toBe(first.systemPrompt);
      expect(second.prefixHash).toBe(first.prefixHash);
      expect(second.segments).toEqual(first.segments);
      expect(fakeCalls(app).length).toBeGreaterThanOrEqual(2);
      expect(fakeCalls(app)[1]?.systemPrompt).toBe(first.systemPrompt);
    } finally {
      await disposeApp(app);
    }
  });
});
