/**
 * T3 收件箱 HTTP 入口验收：校验/403/dedupe/coalesce/shadow/rate/status/digest 排班。
 *
 * 全部使用临时 stateRoot + ephemeral 端口；投递目标为记录调用的 fake registry，
 * 不启动模型、不触网。响应表逐条对照 docs/dev/loom-inbox-contract.md §6。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InboxConfig } from "../config/section-checks.js";
import { Router } from "../http/router.js";
import { InboxJournalStore } from "./journal-store.js";
import {
  createInboxPolicyEngine,
  registerInboxRoutes,
  type InboxRouteDeps,
} from "./routes.js";
import type { InboxDeliveryTarget } from "./router.js";
import type { SendOutcome } from "../session-api/types.js";

const TOKEN = "tok-inbox-routes";
const SESSION_ID = "ses_inbox_routes";
const NOW = Date.UTC(2026, 10, 2, 0, 0, 0);

interface Call {
  readonly sessionID: string;
  readonly text: string;
}

interface WakeCall extends Call {
  readonly props: Readonly<Record<string, unknown>> | undefined;
}

interface Harness {
  readonly store: InboxJournalStore;
  readonly registry: InboxDeliveryTarget;
  readonly sent: Call[];
  readonly wakes: WakeCall[];
  readonly reconciles: number[];
  sendOutcome: SendOutcome;
}

let server: Server | null = null;
let baseUrl = "";
let root = "";
let clock = NOW;
let harness: Harness;

function makeHarness(config: InboxConfig, mode: "off" | "shadow" | "live"): Harness {
  const state: Harness = {
    store: new InboxJournalStore({
      stateRoot: root,
      sessionId: SESSION_ID,
      now: () => clock,
    }),
    registry: {
      send: (sessionID, text) => {
        state.sent.push({ sessionID, text });
        return state.sendOutcome;
      },
      deliverWake: (sessionID, text, props) => {
        state.wakes.push({ sessionID, text, props });
      },
    },
    sent: [],
    wakes: [],
    reconciles: [],
    sendOutcome: { accepted: true, sessionID: SESSION_ID },
  };
  const deps: InboxRouteDeps = {
    store: state.store,
    policy: createInboxPolicyEngine(config),
    registry: state.registry,
    sessionID: SESSION_ID,
    mode,
    now: () => clock,
    digest: { reconcile: () => void state.reconciles.push(clock) },
  };
  const router = new Router({ tokens: [TOKEN] });
  registerInboxRoutes(router, deps);
  server = createServer(router.toRequestHandler());
  return state;
}

async function start(): Promise<void> {
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

function liveConfig(overrides: Partial<InboxConfig> = {}): InboxConfig {
  return {
    mode: "live",
    sources: {
      chat: { maxTrust: "user", maxClass: "interrupt" },
      ext: { maxTrust: "external", maxClass: "notify" },
    },
    ...overrides,
  };
}

function letter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "chat",
    kind: "system_note",
    class: "notify",
    trust: "user",
    principal: "test-user",
    title: "测试来信",
    body: "这是一封测试信件。",
    ...overrides,
  };
}

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${baseUrl}/inbox/letters`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function status(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/inbox/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-inbox-routes-"));
  clock = NOW;
  server = null;
});

afterEach(async () => {
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

describe("inbox mode gate", () => {
  it("off：POST/GET 均 503 inbox_disabled，且不创建 store", async () => {
    const state = makeHarness({ mode: "off" }, "off");
    await start();
    const posted = await post(letter());
    expect(posted.status).toBe(503);
    expect((posted.body["error"] as { code: string }).code).toBe("inbox_disabled");
    const got = await status();
    expect(got.status).toBe(503);
    expect(JSON.stringify(got.body)).not.toContain("pending");
    expect(state.store.size).toBe(0);
  });
});

describe("POST /inbox/letters validation and routing", () => {
  it("非法字段：400 invalid_letter + 逐字段 errors", async () => {
    makeHarness(liveConfig(), "live");
    await start();
    const res = await post({ source: "chat", class: "loud" });
    expect(res.status).toBe(400);
    expect((res.body["error"] as { code: string }).code).toBe("invalid_letter");
    const errors = res.body["errors"] as Array<{ field: string }>;
    expect(errors.map((item) => item.field)).toContain("class");
    expect(errors.map((item) => item.field)).toContain("body");
  });

  it("body 超 limits.maxBodyBytes：413 letter_body_too_large", async () => {
    makeHarness(liveConfig({ limits: { maxBodyBytes: 16 } }), "live");
    await start();
    const res = await post(letter({ body: "x".repeat(64) }));
    expect(res.status).toBe(413);
    expect((res.body["error"] as { code: string }).code).toBe("letter_body_too_large");
    expect(res.body["actual_bytes"]).toBe(64);
  });

  it("未注册来源：403 source_unregistered", async () => {
    const state = makeHarness(liveConfig(), "live");
    await start();
    const res = await post(letter({ source: "unknown" }));
    expect(res.status).toBe(403);
    expect((res.body["error"] as { code: string }).code).toBe("source_unregistered");
    expect(state.store.snapshot({ now: clock }).pending).toBe(0);
  });

  it("trust 高于来源上限：403 trust_ceiling，不静默钳制", async () => {
    const state = makeHarness(liveConfig(), "live");
    await start();
    const res = await post(letter({ source: "ext", trust: "user" }));
    expect(res.status).toBe(403);
    expect((res.body["error"] as { code: string }).code).toBe("trust_ceiling");
    expect(state.store.list()).toHaveLength(0);
  });

  it("notify accepted：202 route=deliver_wake，信封带 user-role 标签与 bounded preview", async () => {
    const state = makeHarness(liveConfig(), "live");
    await start();
    const res = await post(letter({ body: "A".repeat(900) }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, class: "notify", route: "deliver_wake" });
    const id = res.body["letter_id"] as string;
    expect(state.wakes).toHaveLength(1);
    expect(state.wakes[0]!.text).toContain(`[loom-inbox:letter=${id}]`);
    expect(state.wakes[0]!.text).toContain("source=chat trust=user principal=test-user");
    expect(state.wakes[0]!.text).toContain("…（已截断）");
    expect(state.wakes[0]!.props).toMatchObject({ title: "收件箱通知" });
    expect(state.store.get(id)?.state).toBe("routed");
    expect(state.sent).toHaveLength(0);
  });

  it("interrupt accepted：202 携 interrupted:true，走 send 且正文完整", async () => {
    const state = makeHarness(liveConfig(), "live");
    state.sendOutcome = { accepted: true, interrupted: true, sessionID: SESSION_ID };
    await start();
    const body = "B".repeat(900);
    const res = await post(letter({ class: "interrupt", trust: "user", body }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      accepted: true,
      class: "interrupt",
      route: "send",
      interrupted: true,
    });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.text).toContain(body);
    expect(state.wakes).toHaveLength(0);
  });

  it("interrupt 队列满：降级 notify（downgraded + 实际 route=deliver_wake）", async () => {
    const state = makeHarness(liveConfig(), "live");
    state.sendOutcome = {
      accepted: false,
      reason: "busy",
      sessionID: SESSION_ID,
      queueCapacity: 10,
      queueLength: 10,
    };
    await start();
    const res = await post(letter({ class: "interrupt", trust: "user" }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      accepted: true,
      class: "interrupt",
      route: "deliver_wake",
      downgraded: "notify",
    });
    expect(state.sent).toHaveLength(1);
    expect(state.wakes).toHaveLength(1);
  });

  it("dedupe：同键第二次 200 {duplicate:true}，返回既有 id/state", async () => {
    makeHarness(liveConfig(), "live");
    await start();
    const first = await post(letter({ dedupe_key: "same-key" }));
    expect(first.status).toBe(202);
    const second = await post(letter({ dedupe_key: "same-key" }));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      duplicate: true,
      letter_id: first.body["letter_id"],
      state: "routed",
    });
  });

  it("coalesce：同键第二次 202 {coalesced:true,target_id}", async () => {
    makeHarness(liveConfig(), "live");
    await start();
    const first = await post(letter({ coalesce_key: "same-coalesce" }));
    expect(first.status).toBe(202);
    const second = await post(letter({ coalesce_key: "same-coalesce" }));
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({
      accepted: true,
      coalesced: true,
      target_id: first.body["letter_id"],
    });
  });

  it("digest：202 route=digest，不立即投递，触发一次 reconcile", async () => {
    const state = makeHarness(liveConfig(), "live");
    await start();
    const res = await post(letter({ class: "digest" }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, class: "digest", route: "digest" });
    expect(state.sent).toHaveLength(0);
    expect(state.wakes).toHaveLength(0);
    expect(state.reconciles).toEqual([NOW]);
  });
});

describe("shadow / rate / status", () => {
  it("shadow：202 observed + decision，仅落 observed（不计 pending）", async () => {
    const state = makeHarness(liveConfig({ mode: "shadow" }), "shadow");
    await start();
    const res = await post(letter({ class: "interrupt" }));
    expect(res.status).toBe(202);
    expect(res.body["accepted"]).toBe(true);
    expect(res.body["observed"]).toBe(true);
    const decision = res.body["decision"] as Record<string, unknown>;
    expect(decision["class"]).toBe("interrupt");
    expect(decision["route"]).toBe("observed");
    expect(decision).not.toHaveProperty("weight");
    expect(state.store.snapshot({ now: clock }).pending).toBe(0);
    expect(state.store.list({ state: "observed" })).toHaveLength(1);
    expect(state.sent).toHaveLength(0);
    expect(state.wakes).toHaveLength(0);
  });

  it("trusted_user 限速：429 + Retry-After，且不产生新 pending", async () => {
    const state = makeHarness(
      liveConfig({
        sources: { chat: { maxTrust: "user", maxClass: "interrupt", ratePerMinute: 1 } },
      }),
      "live",
    );
    await start();
    expect((await post(letter())).status).toBe(202);
    const limited = await post(letter());
    expect(limited.status).toBe(429);
    expect((limited.body["error"] as { code: string }).code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(state.store.snapshot({ now: clock }).pending).toBe(1);
    expect(state.store.rateWindow("chat", clock).count).toBe(2);
  });

  it("external 限速：不回压，按 policy 降级 class 继续 202（确定性规则）", async () => {
    const state = makeHarness(
      liveConfig({
        sources: { ext: { maxTrust: "external", maxClass: "notify", ratePerMinute: 1 } },
      }),
      "live",
    );
    await start();
    const first = await post(letter({ source: "ext", class: "notify", trust: "external" }));
    expect(first.status).toBe(202);
    const downgraded = await post(letter({ source: "ext", class: "notify", trust: "external" }));
    expect(downgraded.status).toBe(202);
    expect(downgraded.body).toMatchObject({ accepted: true, class: "digest", route: "digest" });
    expect(state.reconciles.length).toBe(1);
  });

  it("status：返回积压/按类/按源/unknown/digest_due_at/session_id", async () => {
    const state = makeHarness(liveConfig(), "live");
    state.store.append({
      source: "legacy_source",
      kind: "system_note",
      class: "notify",
      trust: "external",
      principal: "legacy",
      body: "旧来源直接入账",
    });
    await start();
    const first = await post(letter());
    expect(first.status).toBe(202);
    const got = await status();
    expect(got.status).toBe(200);
    expect(got.body["mode"]).toBe("live");
    expect(got.body["session_id"]).toBe(SESSION_ID);
    expect(got.body["pending"]).toBe(2);
    expect(got.body["by_class"]).toMatchObject({ notify: 2, interrupt: 0, digest: 0 });
    expect(got.body["by_source"]).toMatchObject({ chat: 1, legacy_source: 1 });
    expect(got.body["unknown"]).toBe(1);
    expect(got.body["dead_letter"]).toBe(0);
  });
});
