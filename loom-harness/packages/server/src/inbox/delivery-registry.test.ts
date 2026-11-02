/**
 * T3 投递通道表征：interrupt 走 registry.send（interruptOnSend=true 时 abort 当前轮），
 * notify 走 registry.deliverWake（busy 时不 abort，只排队等当前轮收尾）。
 *
 * 真 SessionRegistry + fake model；只经 HTTP /inbox/letters 入口，不伪造投递结果。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySessionStore } from "@axeuh/loom-core";
import type { FakeAssistantResponse, FakeModel } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { createFakeModelFromConfig, FAKE_PROVIDER } from "../fake-model/index.js";
import { Router } from "../http/router.js";
import { InboxJournalStore } from "./journal-store.js";
import { createInboxPolicyEngine, registerInboxRoutes } from "./routes.js";
import { SessionRegistry } from "../session-api/registry.js";

const TOKEN = "tok-inbox-delivery";
const FAKE_YAML = [
  "server:",
  "  port: 5097",
  "  hostname: 127.0.0.1",
  "workspace: /tmp/loom-inbox-delivery-workspace",
  "models:",
  "  - id: fake-inbox-delivery",
  `    provider: ${FAKE_PROVIDER}`,
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    vision: false",
  "    timeout: 60000",
].join("\n");

let server: Server | null = null;
let baseUrl = "";
let root = "";
let models: FakeModel[] = [];

function makeRegistry(
  script: readonly FakeAssistantResponse[],
  interruptOnSend: boolean,
): { registry: SessionRegistry; model: FakeModel; teardown: () => void } {
  const cfg = parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
  const model = createFakeModelFromConfig(cfg.models[0]!, [...script]);
  models.push(model);
  const registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot: root,
    interruptOnSend,
  });
  return { registry, model, teardown: () => model.teardown() };
}

async function listen(registry: SessionRegistry, registrySessionID: string): Promise<void> {
  const store = new InboxJournalStore({
    stateRoot: root,
    sessionId: "ses_inbox_delivery",
    now: () => Date.now(),
  });
  const router = new Router({ tokens: [TOKEN] });
  registerInboxRoutes(router, {
    store,
    policy: createInboxPolicyEngine({
      mode: "live",
      sources: { chat: { maxTrust: "user", maxClass: "interrupt" } },
    }),
    registry,
    sessionID: registrySessionID,
    mode: "live",
  });
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function postInbox(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/inbox/letters`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function inboxLetter(letterClass: "interrupt" | "notify", body: string): Record<string, unknown> {
  return {
    source: "chat",
    kind: "system_note",
    class: letterClass,
    trust: "user",
    principal: "delivery-test",
    title: letterClass,
    body,
  };
}

async function waitFor(predicate: () => boolean, budgetMs = 20_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met before deadline");
}

async function waitIdleTurns(registry: SessionRegistry, sessionID: string, turns: number): Promise<void> {
  await waitFor(() => {
    const view = registry.statusView(sessionID);
    return view?.status === "idle" && view.turns === turns;
  }, 30_000);
}

async function userTexts(registry: SessionRegistry, sessionID: string): Promise<string[]> {
  const page = await registry.history(sessionID, { limit: 200 });
  return page.messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-inbox-delivery-"));
  models = [];
  server = null;
});

afterEach(async () => {
  for (const model of models) model.teardown();
  const s = server;
  server = null;
  if (s !== null) {
    s.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }
  rmSync(root, { recursive: true, force: true });
});

describe("inbox delivery through SessionRegistry", () => {
  it("interrupt：send 路径可 abort 当前轮，下一轮 prompt 是收件箱信封", async () => {
    const { registry } = makeRegistry(
      [
        { content: [{ type: "text", text: "慢跑" }], delayMs: 3000 },
        {
          content: [
            { type: "text", text: "下一轮" },
            { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: "x", body: "x" } },
          ],
        },
      ],
      true,
    );
    const rec = registry.create();
    registry.send(rec.sessionID, "第一句");
    await waitFor(() => registry.get(rec.sessionID)?.running !== null);
    await listen(registry, rec.sessionID);

    const res = await postInbox(inboxLetter("interrupt", "INTERRUPT-BODY"));
    expect(res.status).toBe(202);
    expect(res.json["interrupted"]).toBe(true);
    expect(res.json["route"]).toBe("send");

    await waitIdleTurns(registry, rec.sessionID, 2);
    const texts = await userTexts(registry, rec.sessionID);
    expect(texts[0]).toBe("第一句");
    const inboxText = texts.find((text) => text.includes("[loom-inbox:letter="));
    expect(inboxText).toBeDefined();
    expect(inboxText).toContain("INTERRUPT-BODY");
  }, 30_000);

  it("notify：deliverWake 路径不 abort，busy 时排到当前轮收尾后的下一轮", async () => {
    const { registry } = makeRegistry(
      [
        { content: [{ type: "text", text: "慢跑" }], delayMs: 1200 },
        {
          content: [
            { type: "text", text: "唤醒轮" },
            { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: "x", body: "x" } },
          ],
        },
      ],
      true,
    );
    const rec = registry.create();
    registry.send(rec.sessionID, "第一句");
    await waitFor(() => registry.get(rec.sessionID)?.running !== null);
    await listen(registry, rec.sessionID);

    const res = await postInbox(inboxLetter("notify", "NOTIFY-BODY"));
    expect(res.status).toBe(202);
    expect(res.json["interrupted"]).toBeUndefined();
    expect(res.json["route"]).toBe("deliver_wake");
    expect(registry.get(rec.sessionID)?.running !== null).toBe(true);

    await waitIdleTurns(registry, rec.sessionID, 2);
    const texts = await userTexts(registry, rec.sessionID);
    expect(texts[0]).toBe("第一句");
    const inboxText = texts.find((text) => text.includes("[loom-inbox:letter="));
    expect(inboxText).toBeDefined();
    expect(inboxText).toContain("NOTIFY-BODY");
  }, 30_000);
});
