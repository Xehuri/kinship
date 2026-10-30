/**
 * 主会话 per-session context watcher —— boot 端到端与准入 null 抑制。
 *
 * 场景：
 *   1. 基线轮零 notice → 改 AGENTS.md → 下一轮恰一条 durable diff notice，且准入帧先于 busy；
 *   2. 文件在 boot 与首轮之间变更：session-start resync 把新内容吸收进 systemPrompt，
 *      准入预览的 stale notice 仍交付（至多一条），帧/转录并行保持；
 *   3. 无变更准入（preview null）抑制 run-start 重检：skills 合成源 rescan 只发生一次。
 *
 * boot 图动态 import（SSR 环解析，同 context-change-boot）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemorySessionStore } from "@axeuh/loom-core";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import { createFakeModelFromConfig, FAKE_PROVIDER } from "../fake-model/index.js";
import type { LoomFrame } from "../events/index.js";
import { SessionRegistry } from "../session-api/index.js";
import type { SkillsSniff } from "../session-api/types.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";

const FAKE_YAML = [
  "server:",
  "  port: 5105",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-main-ctx",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

function agentsBytes(extra: string): string {
  const fill = Array.from({ length: 60 }, (_, i) => `CTX-MAIN-FILL-${String(i).padStart(2, "0")}`).join("\n");
  return `# 一级记忆\nCTX-MAIN-BASELINE\n${fill}\nCTX-MAIN-TAIL\n${extra}`;
}

interface FakeHandle {
  push(...r: FakeAssistantResponse[]): void;
  getCalls(): readonly { systemPrompt?: string; messages: readonly MsgLike[] }[];
  teardown(): void;
}

interface MsgLike {
  readonly role: string;
  readonly content: unknown;
}

function userText(m: MsgLike): string | null {
  return m.role === "user" && typeof m.content === "string" ? m.content : null;
}

function isNotice(m: MsgLike): boolean {
  return (userText(m) ?? "").startsWith("<system-reminder>");
}

function mainConverge(text: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
    ],
  };
}

async function waitFor(predicate: () => boolean, budgetMs = 8000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

function fakeSubscriber(): { res: ServerResponse; frames: () => LoomFrame[] } {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const chunks: string[] = [];
  res.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof res.write;
  return {
    res,
    frames: () => {
      const out: LoomFrame[] = [];
      for (const piece of chunks.join("").split("\n\n")) {
        const trimmed = piece.trim();
        if (trimmed === "" || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
        out.push(JSON.parse(trimmed.slice("data:".length)) as LoomFrame);
      }
      return out;
    },
  };
}

function framesOfType(frames: readonly LoomFrame[], type: string): LoomFrame[] {
  return frames.filter((f) => f.payload.type === type);
}

function noticeEntriesOf(frame: LoomFrame): readonly Record<string, unknown>[] {
  const raw: unknown = frame.payload.properties["notices"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
}

function config(): LoomConfig {
  return parseLoomConfig(FAKE_YAML.replace("WS_ROOT", ws), "<test>", { env: {} });
}

async function makeApp(): Promise<{ app: LoomApp; fake: FakeHandle }> {
  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const app = await createLoomApp({
    config: config(),
    store,
    stateRoot,
    tokens: ["tok-main-ctx"],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
  });
  const fake = app.model.model as unknown as FakeHandle;
  return { app, fake };
}

async function sendTurn(
  app: LoomApp,
  fake: FakeHandle,
  sessionID: string,
  prompt: string,
  reply: string,
): Promise<void> {
  fake.push(mainConverge(reply));
  const outcome = app.registry.send(sessionID, prompt);
  expect(outcome.accepted, `send "${prompt}" 应被受理`).toBe(true);
  expect(await waitFor(() => app.registry.get(sessionID)?.running === null), `轮 "${prompt}" 应收尾`).toBe(true);
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-main-ctx-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(join(ws, "memory", "fact"), { recursive: true });
  mkdirSync(join(ws, "memory", "self"), { recursive: true });
  mkdirSync(join(ws, "memory", "profile"), { recursive: true });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("主会话 per-session watcher：准入预览 + 单帧单 notice", () => {
  it("基线轮零通知 → 改 AGENTS.md → 恰一条 durable diff + 一帧（先于 busy 帧）", async () => {
    writeFileSync(join(ws, "AGENTS.md"), agentsBytes(""));
    const { app, fake } = await makeApp();
    try {
      const rec = app.registry.create();
      const sid = rec.sessionID;
      const hub = app.registry.hubOf(sid);
      if (hub === undefined) throw new Error("hubOf 必命中刚注册会话");
      const sub = fakeSubscriber();
      const unsubscribe = hub.subscribe(sub.res);
      try {
        await sendTurn(app, fake, sid, "基线轮", "基线正文");
        const baseline = fake.getCalls()[0]!;
        expect(baseline.messages.filter(isNotice)).toHaveLength(0);
        const sysBaseline = baseline.systemPrompt;
        if (sysBaseline === undefined) throw new Error("装配接线请求必须携 systemPrompt");
        expect(framesOfType(sub.frames(), "context.notice")).toHaveLength(0);

        writeFileSync(join(ws, "AGENTS.md"), agentsBytes("CTX-MAIN-APPENDED\n"));
        await sendTurn(app, fake, sid, "变更轮", "变更正文");

        const messages = fake.getCalls()[1]!.messages;
        const userIdx = messages.findIndex((m) => userText(m) === "变更轮");
        expect(userIdx).toBeGreaterThan(0);
        const notice = messages[userIdx - 1]!;
        expect(isNotice(notice)).toBe(true);
        const noticeText = userText(notice) ?? "";
        expect(noticeText).toContain("Updated instructions from: AGENTS.md");
        expect(noticeText).toContain("@@ -");
        expect(noticeText).toContain("+CTX-MAIN-APPENDED");
        expect(noticeText).not.toContain("CTX-MAIN-FILL-00");
        expect(messages.filter(isNotice)).toHaveLength(1);
        expect(fake.getCalls()[1]!.systemPrompt).toBe(sysBaseline);

        const frames = sub.frames();
        const noticeFrames = framesOfType(frames, "context.notice");
        expect(noticeFrames).toHaveLength(1);
        const frame = noticeFrames[0]!;
        expect(noticeEntriesOf(frame)).toEqual([
          { action: "replace", relPath: "AGENTS.md", bytes: Buffer.byteLength(noticeText, "utf8") },
        ]);
        const busyIndices = frames.reduce<number[]>((acc, f, i) => {
          if (f.payload.type === "session.status") acc.push(i);
          return acc;
        }, []);
        const noticeIdx = frames.indexOf(frame);
        expect(busyIndices.length).toBeGreaterThanOrEqual(2);
        expect(noticeIdx).toBeGreaterThan(busyIndices[0]!);
        expect(noticeIdx).toBeLessThan(busyIndices[1]!);
      } finally {
        unsubscribe();
      }
    } finally {
      app.model.teardown();
    }
  });

  it("boot 与首轮之间的变更：至多一条 notice，且新 systemPrompt 已被采用", async () => {
    writeFileSync(join(ws, "AGENTS.md"), agentsBytes(""));
    const { app, fake } = await makeApp();
    try {
      const sid = app.registry.create().sessionID;
      writeFileSync(join(ws, "AGENTS.md"), agentsBytes("CTX-MAIN-RACE\n"));
      await sendTurn(app, fake, sid, "首轮竞态", "竞态正文");

      const call = fake.getCalls()[0]!;
      expect(call.systemPrompt).toContain("CTX-MAIN-RACE");
      const notices = call.messages.filter(isNotice);
      expect(notices.length).toBeLessThanOrEqual(1);
      if (notices.length === 1) {
        expect(userText(notices[0]!)).toContain("CTX-MAIN-RACE");
      }
    } finally {
      app.model.teardown();
    }
  });
});

describe("主会话 watcher：preview null 抑制 run-start 重检", () => {
  it("无变更准入后 skills 合成源 rescan 只发生一次（session 不重复 check）", async () => {
    writeFileSync(join(ws, "AGENTS.md"), agentsBytes(""));
    let rescans = 0;
    const skillsSniff: SkillsSniff = {
      rescan(): void {
        rescans += 1;
      },
      snapshot: () => ({ text: "catalog", generation: 0 }),
    };
    const cfg = parseLoomConfig(FAKE_YAML.replace("WS_ROOT", ws), "<test>", { env: {} });
    const fake = createFakeModelFromConfig(cfg.models[0]!, [mainConverge("无变更轮")]);
    const registry = new SessionRegistry({
      model: fake,
      store: new MemorySessionStore(),
      stateRoot,
      skillsSniff,
    });
    try {
      const sid = registry.create().sessionID;
      const outcome = registry.send(sid, "无变更轮");
      expect(outcome.accepted).toBe(true);
      expect(await waitFor(() => registry.get(sid)?.running === null)).toBe(true);
      expect(rescans).toBe(1);
    } finally {
      fake.teardown();
    }
  });
});
