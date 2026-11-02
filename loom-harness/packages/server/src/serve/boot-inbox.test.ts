/**
 * T3/T4 boot 接线验收：off/shadow/live 三档、POST/status 面、boot 摘要 reconcile、
 * live 前置条件（必须共用 wakeQueue 会话）、主会话 inbox 工具面与批量生命周期，
 * 以及用户聊天仍走 session 路由（不进 inbox）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { HarnessTool } from "@axeuh/loom-core";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import { InboxJournalStore } from "../inbox/journal-store.js";
import type { LoomApp } from "./boot.js";

interface BootOptions {
  readonly inbox?: string;
  readonly scheduling?: string;
}

interface Booted {
  readonly app: LoomApp;
  readonly logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }>;
  readonly work: string;
  readonly stateRoot: string;
  readonly baseUrl: string;
  readonly token: string;
  close(): Promise<void>;
}

const opened: Booted[] = [];
let seq = 0;

function yamlFor(work: string, opts: BootOptions): string {
  const ws = join(work, "ws");
  const lines = [
    "server:",
    "  port: 5110",
    "  hostname: 127.0.0.1",
    "workspace: WS_ROOT",
    "models:",
    "  - id: fake-inbox-boot",
    "    provider: fake",
    "    contextWindow: 200000",
    "    maxOutput: 4096",
    "    timeout: 60000",
    "pricing:",
    "  fake:",
    "    input: 0",
    "    output: 0",
  ];
  if (opts.scheduling !== undefined) lines.push(opts.scheduling);
  if (opts.inbox !== undefined) lines.push(opts.inbox);
  return lines.join("\n").replace("WS_ROOT", ws);
}

async function boot(work: string, opts: BootOptions): Promise<Booted> {
  const ws = join(work, "ws");
  const stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# inbox boot\n");
  const text = yamlFor(work, opts);
  const store = new HotConfigStore({
    sink: createFileAuditSink(join(stateRoot, "config")),
    env: {},
  });
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const token = `tok-inbox-boot-${String(++seq)}`;
  const app = await (await import("./boot.js")).createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
    tokens: [token],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
  const booted: Booted = {
    app,
    logs,
    work,
    stateRoot,
    baseUrl: `http://127.0.0.1:${String(addr.port)}`,
    token,
    close: async (): Promise<void> => {
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

function tempWork(): string {
  return mkdtempSync(join(tmpdir(), "loom-inbox-boot-"));
}

async function api(
  booted: Booted,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${booted.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${booted.token}`,
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function letter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "svc",
    kind: "note",
    class: "digest",
    trust: "user",
    principal: "boot-test",
    title: "boot letter",
    body: "boot body",
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met before deadline");
}

function sidecar(booted: Booted, sessionID: string): string {
  return join(booted.stateRoot, "session", "wake-queue", `${sessionID}.json`);
}

function sidecarEntries(booted: Booted, sessionID: string): unknown[] {
  const path = sidecar(booted, sessionID);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown[] };
  return parsed.entries ?? [];
}

function inboxEvents(booted: Booted, sessionID: string): Array<Record<string, unknown>> {
  const path = join(booted.stateRoot, "inbox", `${sessionID}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventsFor(booted: Booted, sessionID: string, id: string): Array<Record<string, unknown>> {
  return inboxEvents(booted, sessionID).filter((event) => event["id"] === id);
}

function inboxLiveYaml(sessionID: string, extra: readonly string[] = []): string {
  return [
    "inbox:",
    "  mode: live",
    `  sessionId: ${sessionID}`,
    "  digest:",
    "    cadenceMs: 200",
    "    maxAgeMs: 60000",
    "  sources:",
    "    svc:",
    "      maxTrust: user",
    "      maxClass: interrupt",
    ...extra,
  ].join("\n");
}

function schedulingYaml(sessionID: string): string {
  return [
    "scheduling:",
    "  wakeQueue: live",
    "  planScheduler: off",
    "  timezone: UTC",
    `  sessionId: ${sessionID}`,
  ].join("\n");
}

function seedDigest(
  stateRoot: string,
  sessionID: string,
  id: string,
  overrides: Record<string, unknown> = {},
): void {
  mkdirSync(join(stateRoot, "inbox"), { recursive: true });
  const store = new InboxJournalStore({
    stateRoot,
    sessionId: sessionID,
    now: () => Date.now(),
    idFactory: () => id,
  });
  store.append(
    {
      source: "svc",
      kind: "action",
      class: "digest",
      trust: "user",
      principal: "boot-test",
      not_before: Date.now() + 500,
      title: "seeded digest",
      body: "seeded digest body",
      ...overrides,
    },
    { now: Date.now() },
  );
}

afterEach(async () => {
  while (opened.length > 0) {
    const booted = opened.pop();
    if (booted !== undefined) await booted.close();
  }
});

describe("inbox boot modes", () => {
  it("off（整段缺席）：路由仍注册但一律 503，inbox 工具不挂面，且无账本文件", async () => {
    const booted = await boot(tempWork(), {
      inbox: "inbox:\n  mode: off\n",
      scheduling: "scheduling:\n  wakeQueue: off\n  planScheduler: off\n",
    });
    expect(booted.app.tools.map((tool) => tool.name).filter((name) => name.startsWith("inbox_"))).toEqual(
      [],
    );
    const posted = await api(booted, "/inbox/letters", {
      method: "POST",
      body: JSON.stringify(letter()),
    });
    expect(posted.status).toBe(503);
    expect((posted.body["error"] as { code: string }).code).toBe("inbox_disabled");
    const status = await api(booted, "/inbox/status");
    expect(status.status).toBe(503);
    const inboxDir = join(booted.stateRoot, "inbox");
    expect(existsSync(inboxDir) ? readdirSync(inboxDir) : []).toEqual([]);
  });

  it("shadow：202 observed，status 可读但 pending 恒 0", async () => {
    const booted = await boot(tempWork(), {
      inbox: [
        "inbox:",
        "  mode: shadow",
        "  sessionId: ses_inbox_shadow",
        "  sources:",
        "    svc:",
        "      maxTrust: user",
        "      maxClass: interrupt",
      ].join("\n"),
    });
    const posted = await api(booted, "/inbox/letters", {
      method: "POST",
      body: JSON.stringify(letter({ class: "interrupt" })),
    });
    expect(posted.status).toBe(202);
    expect(posted.body["observed"]).toBe(true);
    const status = await api(booted, "/inbox/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      mode: "shadow",
      pending: 0,
      session_id: "ses_inbox_shadow",
    });
  });

  it("live：boot reconcile 为预置 digest 信排入唯一 inbox 队列条目；POST/status 可用", async () => {
    const work = tempWork();
    const stateRoot = join(work, "state");
    const sessionID = "ses_inbox_boot";
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });
    const seeded = new InboxJournalStore({
      stateRoot,
      sessionId: sessionID,
      now: () => Date.now(),
    });
    seeded.append({
      source: "svc",
      kind: "note",
      class: "digest",
      trust: "user",
      principal: "boot-test",
      not_before: Date.now() + 60_000,
      body: "pre-seeded digest",
    });
    const booted = await boot(work, {
      inbox: [
        "inbox:",
        "  mode: live",
        `  sessionId: ${sessionID}`,
        "  digest:",
        "    cadenceMs: 200",
        "    maxAgeMs: 60000",
        "  sources:",
        "    svc:",
        "      maxTrust: user",
        "      maxClass: interrupt",
      ].join("\n"),
      scheduling: [
        "scheduling:",
        "  wakeQueue: live",
        "  planScheduler: off",
        "  timezone: UTC",
        `  sessionId: ${sessionID}`,
        "  watchdogMs: 60000",
      ].join("\n"),
    });

    await waitFor(() => sidecarEntries(booted, sessionID).length > 0);
    const entry = sidecarEntries(booted, sessionID)[0] as {
      id: string;
      source: string;
      action: string;
    };
    expect(entry.source).toBe("inbox");
    expect(entry.action).toBe("inbox.digest");
    expect(entry.id).toMatch(/^inbox:digest:\d+$/);

    const status = await api(booted, "/inbox/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ mode: "live", pending: 1, session_id: sessionID });
    expect((status.body["by_source"] as Record<string, number>)["svc"]).toBe(1);

    const posted = await api(booted, "/inbox/letters", {
      method: "POST",
      body: JSON.stringify(letter({ body: "posted body", not_before: Date.now() + 60_000 })),
    });
    expect(posted.status).toBe(202);
    expect(posted.body).toMatchObject({ accepted: true, route: "digest" });

    const inboxLog = booted.logs.find((line) => line.msg === "loom inbox");
    expect(inboxLog?.fields).toMatchObject({ mode: "live", sessionID, sources: 1 });
    expect(JSON.stringify(inboxLog?.fields)).not.toContain("posted body");
    expect(JSON.stringify(inboxLog?.fields)).not.toContain(booted.token);
  });

  it("live：inbox 工具只挂主会话面，digest 唤醒可 list → read → ack", async () => {
    const work = tempWork();
    const stateRoot = join(work, "state");
    const sessionID = "ses_inbox_tools_e2e";
    seedDigest(stateRoot, sessionID, "l1");
    const booted = await boot(work, {
      inbox: inboxLiveYaml(sessionID),
      scheduling: schedulingYaml(sessionID),
    });
    const names = booted.app.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["inbox_list", "inbox_read", "inbox_ack", "inbox_defer"]),
    );

    booted.app.registry.ensure(sessionID);
    const fake = booted.app.model.model as unknown as { push(...responses: unknown[]): void };
    fake.push({
      content: [{ type: "toolCall", name: "inbox_list", arguments: { state: "pending" } }],
    });
    fake.push({
      content: [{ type: "toolCall", name: "inbox_read", arguments: { ids: ["l1"] } }],
    });
    fake.push({
      content: [
        {
          type: "toolCall",
          name: "inbox_ack",
          arguments: { ids: ["l1"], outcome: "acted", evidence_ref: "e2e:read" },
        },
      ],
    });
    fake.push({
      content: [
        { type: "text", text: "已处理" },
        { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: "d", body: "b" } },
      ],
    });

    await waitFor(
      () => eventsFor(booted, sessionID, "l1").some((event) => event["event"] === "letter.acked"),
      25_000,
    );
    const events = eventsFor(booted, sessionID, "l1");
    expect(events.some((event) => event["event"] === "letter.read")).toBe(true);
    expect(events.find((event) => event["event"] === "letter.acked")).toMatchObject({
      ack_outcome: "acted",
      evidence_ref: "e2e:read",
    });
    expect(events.some((event) => event["event"] === "letter.dead_letter")).toBe(false);
  }, 40_000);

  it("live：未 ack action 经提醒重投后 dead-letter（无 ack）", async () => {
    const work = tempWork();
    const stateRoot = join(work, "state");
    const sessionID = "ses_inbox_deadletter_e2e";
    seedDigest(stateRoot, sessionID, "l2");
    const booted = await boot(work, {
      inbox: inboxLiveYaml(sessionID, [
        "  redelivery:",
        "    maxAttempts: 2",
        "    backoffMs: 5",
        "  ackGraceTurns: 2",
      ]),
      scheduling: schedulingYaml(sessionID),
    });
    booted.app.registry.ensure(sessionID);
    const fake = booted.app.model.model as unknown as { push(...responses: unknown[]): void };
    for (let i = 0; i < 2; i += 1) {
      fake.push({
        content: [
          { type: "text", text: "未处理" },
          { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: "d", body: "b" } },
        ],
      });
    }

    await waitFor(
      () =>
        eventsFor(booted, sessionID, "l2").some(
          (event) => event["event"] === "letter.dead_letter",
        ),
      25_000,
    );
    const events = eventsFor(booted, sessionID, "l2");
    const redelivered = events.find((event) => event["event"] === "letter.redelivered");
    expect(redelivered).toMatchObject({ attempts: 2 });
    expect(events.find((event) => event["event"] === "letter.dead_letter")).toMatchObject({
      reason: "unacked_at_run_end",
    });
    expect(events.some((event) => event["event"] === "letter.acked")).toBe(false);
  }, 40_000);

  it("live 但 wakeQueue 非 live：boot 以可操作错误失败", async () => {
    const work = tempWork();
    await expect(
      boot(work, {
        inbox: "inbox:\n  mode: live\n  sessionId: ses_inbox_live\n",
        scheduling: "scheduling:\n  wakeQueue: off\n  planScheduler: off\n",
      }),
    ).rejects.toThrow(/inbox\.mode=live 需要 scheduling\.wakeQueue=live/);
    rmSync(work, { recursive: true, force: true });
  });

  it("live 且 inbox.sessionId 与 wakeQueue 会话冲突：boot 失败", async () => {
    const work = tempWork();
    await expect(
      boot(work, {
        inbox: "inbox:\n  mode: live\n  sessionId: ses_a\n",
        scheduling: [
          "scheduling:",
          "  wakeQueue: live",
          "  planScheduler: off",
          "  sessionId: ses_b",
        ].join("\n"),
      }),
    ).rejects.toThrow(/与唤醒队列会话 ses_b 不一致/);
    rmSync(work, { recursive: true, force: true });
  });

  it("用户聊天仍走 /sessions/:id/messages，不进 inbox", async () => {
    const booted = await boot(tempWork(), {
      inbox: [
        "inbox:",
        "  mode: live",
        "  sessionId: ses_inbox_chat",
        "  sources:",
        "    svc:",
        "      maxTrust: user",
        "      maxClass: interrupt",
      ].join("\n"),
      scheduling: [
        "scheduling:",
        "  wakeQueue: live",
        "  planScheduler: off",
        "  timezone: UTC",
        "  sessionId: ses_inbox_chat",
      ].join("\n"),
    });
    const fake = booted.app.model.model as unknown as {
      push(...responses: unknown[]): void;
    };
    fake.push({
      content: [
        { type: "text", text: "聊天回复" },
        { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: "d", body: "b" } },
      ],
    });
    const created = await api(booted, "/sessions", { method: "POST", body: "{}" });
    expect(created.status).toBe(201);
    const sessionID = created.body["sessionID"] as string;
    const sent = await api(booted, `/sessions/${sessionID}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "用户聊天" }),
    });
    expect(sent.status).toBe(202);
    await waitFor(() => {
      const view = booted.app.registry.statusView(sessionID);
      return view?.status === "idle";
    }, 20_000);
    const status = await api(booted, "/inbox/status");
    expect(status.body["pending"]).toBe(0);
  }, 30_000);
});

describe("main-only tool wiring", () => {
  it("mainOnlyTools 只进 mainTools，绝不进共享 tools（child/side 面源）", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-main-only-tools-"));
    const ws = join(root, "ws");
    const stateRoot = join(root, "state");
    mkdirSync(ws, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "# main-only tool wiring\n");
    const { createServeToolWiring } = await import("./tool-wiring.js");
    const { createFakeModel } = await import("@axeuh/loom-core/testing");
    const { Type } = await import("@axeuh/loom-core");
    const model = createFakeModel([]);
    try {
      const mainOnly: HarnessTool = {
        name: "inbox_test_only",
        description: "test-only main tool",
        parameters: Type.Object({}),
        async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
          return { content: [{ type: "text", text: "ok" }] };
        },
      };
      const wiring = await createServeToolWiring({
        workspaceRoot: ws,
        stateRoot,
        model,
        llmOptions: {},
        pty: { enabled: false },
        mainOnlyTools: [mainOnly],
      });
      expect(wiring.tools.map((tool) => tool.name)).not.toContain("inbox_test_only");
      expect(wiring.mainTools.map((tool) => tool.name)).toContain("inbox_test_only");
    } finally {
      model.teardown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
