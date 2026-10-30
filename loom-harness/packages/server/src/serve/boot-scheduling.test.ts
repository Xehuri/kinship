/**
 * T11a boot 接线验收：scheduling 段缺席/全 off 保持 legacy；shadow 只观测；
 * live 装配 WakeQueue + PlanScheduler + T07 plan 工具；boot 顺序；converge 特例 coexist。
 *
 * Given createLoomApp 真树（fake provider、独立 tmp workspace/stateRoot）；
 * When 配置 scheduling 各档位；
 * Then 工具面/队列 sidecar/plan shadow 文件/日志顺序与字段符合口径。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { MasterPlanDocument } from "../plan/master-plan.js";
import { zonedNow } from "../plan/timezone.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

interface SchedulingOptions {
  readonly wakeQueue?: "live" | "shadow" | "off";
  readonly planScheduler?: "live" | "shadow" | "off";
  readonly timezone?: string;
  readonly watchdogMs?: number;
  readonly sessionId?: string;
}

interface BootOptions {
  readonly planRoot?: string;
  readonly scheduling?: SchedulingOptions;
  readonly flow?: boolean;
  readonly listen?: boolean;
}

interface Booted {
  readonly app: LoomApp;
  readonly logs: LogLine[];
  readonly work: string;
  readonly stateRoot: string;
  readonly token: string;
  readonly baseUrl: string | undefined;
  close(): Promise<void>;
}

const opened: Booted[] = [];
const works: string[] = [];
let appSeq = 0;

function yamlFor(ws: string, opts: BootOptions): string {
  const lines = [
    "server:",
    "  port: 5110",
    "  hostname: 127.0.0.1",
    "workspace: WS_ROOT",
    "models:",
    "  - id: fake-scheduling",
    "    provider: fake",
    "    contextWindow: 200000",
    "    maxOutput: 4096",
    "    timeout: 60000",
    "pricing:",
    "  fake:",
    "    input: 0",
    "    output: 0",
  ];
  if (opts.planRoot !== undefined) {
    lines.push("plan:", `  root: ${JSON.stringify(opts.planRoot)}`);
  }
  if (opts.flow === true) {
    lines.push("flow:", "  enabled: true", "  retireConverge: true");
  }
  if (opts.scheduling !== undefined) {
    lines.push("scheduling:");
    const sched = opts.scheduling;
    if (sched.wakeQueue !== undefined) lines.push(`  wakeQueue: ${sched.wakeQueue}`);
    if (sched.planScheduler !== undefined) {
      lines.push(`  planScheduler: ${sched.planScheduler}`);
    }
    if (sched.timezone !== undefined) lines.push(`  timezone: ${JSON.stringify(sched.timezone)}`);
    if (sched.watchdogMs !== undefined) lines.push(`  watchdogMs: ${String(sched.watchdogMs)}`);
    if (sched.sessionId !== undefined) lines.push(`  sessionId: ${JSON.stringify(sched.sessionId)}`);
  }
  return lines.join("\n").replace("WS_ROOT", ws);
}

async function boot(work: string, opts: BootOptions = {}): Promise<Booted> {
  works.push(work);
  const ws = join(work, "ws");
  const stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# scheduling boot\n");

  const text = yamlFor(ws, opts);
  const store = new HotConfigStore({
    sink: createFileAuditSink(join(stateRoot, "config")),
    env: {},
  });
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);

  const logs: LogLine[] = [];
  const token = `tok-scheduling-${String(++appSeq)}`;
  const app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
    tokens: [token],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
  });
  let baseUrl: string | undefined;
  if (opts.listen === true) {
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const addr = app.server.address();
    if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  }
  const booted: Booted = {
    app,
    logs,
    work,
    stateRoot,
    token,
    baseUrl,
    close: async (): Promise<void> => {
      await app.closeExtras();
      if (app.server.listening) {
        await new Promise<void>((resolve) => {
          app.server.closeAllConnections();
          app.server.close(() => resolve());
        });
      }
      app.model.teardown();
      rmSync(work, { recursive: true, force: true });
    },
  };
  opened.push(booted);
  return booted;
}

function tempWork(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function futureSlot(): { readonly date: string; readonly time: string } {
  const at = Date.now() + 2 * 60 * 60 * 1000 + 5 * 60 * 1000;
  const zoned = zonedNow(at, "UTC");
  return {
    date: zoned.dateKey,
    time: `${String(zoned.hour).padStart(2, "0")}:${String(zoned.minute).padStart(2, "0")}`,
  };
}

function masterDoc(version = 9): MasterPlanDocument {
  const slot = futureSlot();
  return {
    schema: 1,
    kind: "master-plan",
    timezone: "UTC",
    version,
    created_at: Date.now(),
    updated_at: Date.now(),
    entries: [
      {
        id: "daily-check",
        kind: "fixed",
        title: "每日检查",
        enabled: true,
        action: "probe.run",
        schedule: { kind: "once", date: slot.date, at: slot.time },
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ],
  };
}

function seedMaster(planRoot: string, version = 9): void {
  mkdirSync(join(planRoot, "plan"), { recursive: true });
  writeFileSync(join(planRoot, "plan", "master.json"), JSON.stringify(masterDoc(version)));
}

interface QueueEntry {
  readonly id: string;
  readonly source: string;
  readonly at: number;
  readonly payload: unknown;
}

interface QueueSidecar {
  readonly entries: readonly QueueEntry[];
  readonly delivered: readonly { readonly id: string; readonly outcome?: string }[];
}

function readQueue(stateRoot: string, sessionID: string): QueueSidecar | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(stateRoot, "session", "wake-queue", `${sessionID}.json`), "utf8"),
    );
    if (typeof raw !== "object" || raw === null) return null;
    const entries = Reflect.get(raw, "entries");
    const delivered = Reflect.get(raw, "delivered");
    if (!Array.isArray(entries) || !Array.isArray(delivered)) return null;
    return { entries: entries as QueueEntry[], delivered: delivered as QueueSidecar["delivered"] };
  } catch {
    return null;
  }
}

async function waitFor(predicate: () => boolean, budgetMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function summaryOf(logs: readonly LogLine[]): LogLine | undefined {
  return logs.find((line) => line.msg === "loom scheduling");
}

async function waitSummary(h: Booted): Promise<LogLine> {
  const found: { line: LogLine | null } = { line: null };
  const ok = await waitFor(() => {
    found.line = summaryOf(h.logs) ?? null;
    return found.line !== null;
  });
  if (!ok || found.line === null) throw new Error("等待 loom scheduling 汇总行超时");
  return found.line;
}

function mainSessionID(h: Booted): string {
  const sid = h.app.registry.defaultMainSessionId();
  if (sid === undefined) throw new Error("调度主会话未登记");
  return sid;
}

function planToolOf(h: Booted): { description: string } {
  const tool = h.app.tools.find((candidate) => candidate.name === "plan");
  if (tool === undefined) throw new Error("工具面缺 plan");
  return tool;
}

function fake(h: Booted): {
  push(...resp: FakeAssistantResponse[]): void;
} {
  return h.app.model.model as unknown as {
    push(...resp: FakeAssistantResponse[]): void;
  };
}

async function postMessage(h: Booted, sessionID: string, text: string): Promise<void> {
  if (h.baseUrl === undefined) throw new Error("测试 app 未监听");
  const res = await fetch(`${h.baseUrl}/sessions/${sessionID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${h.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  expect(res.status).toBe(202);
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
});

afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
  while (works.length > 0) {
    const work = works.pop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
});

describe("scheduling boot 接线", () => {
  it("段缺席与 both off 均保留 legacy：loom auto wake、legacy plan 工具、无队列目录", async () => {
    const legacyWork = tempWork("loom-sched-off-absent-");
    const legacyPlanRoot = join(legacyWork, "plan-root");
    mkdirSync(legacyPlanRoot, { recursive: true });
    const legacy = await boot(legacyWork, { planRoot: legacyPlanRoot });
    expect(legacy.logs.some((line) => line.msg === "loom auto wake")).toBe(true);
    expect(summaryOf(legacy.logs)).toBeUndefined();
    expect(planToolOf(legacy).description).toContain("single writer");
    expect(existsSync(join(legacy.stateRoot, "session", "wake-queue"))).toBe(false);

    const offWork = tempWork("loom-sched-off-explicit-");
    const offPlanRoot = join(offWork, "plan-root");
    mkdirSync(offPlanRoot, { recursive: true });
    const off = await boot(offWork, {
      planRoot: offPlanRoot,
      scheduling: { wakeQueue: "off", planScheduler: "off" },
    });
    expect(off.logs.some((line) => line.msg === "loom auto wake")).toBe(true);
    expect(summaryOf(off.logs)).toBeUndefined();
    expect(planToolOf(off).description).toContain("single writer");
    expect(existsSync(join(off.stateRoot, "session", "wake-queue"))).toBe(false);
  });

  it("shadow 档位只写 plan/shadow 观察文件，不建队列、不产生投递", async () => {
    const work = tempWork("loom-sched-shadow-");
    const planRoot = join(work, "plan-root");
    seedMaster(planRoot);
    const h = await boot(work, {
      planRoot,
      scheduling: { wakeQueue: "shadow", planScheduler: "shadow", timezone: "UTC" },
    });
    const summary = await waitSummary(h);
    expect(String(summary.fields["engine"])).toContain("shadow");
    expect(Number(summary.fields["entries"])).toBeGreaterThan(0);
    expect(summary.fields["degraded"]).toBe(false);

    const shadowDir = join(h.stateRoot, "plan", "shadow");
    const shadowFiles = readdirSync(shadowDir).filter((name) => name.endsWith(".jsonl"));
    expect(shadowFiles.length).toBeGreaterThan(0);
    const shadowPath = join(shadowDir, shadowFiles[0] ?? "");
    const lines = readFileSync(shadowPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect((JSON.parse(line) as { source?: string }).source).toBe("plan");
    }
    expect(existsSync(join(h.stateRoot, "session", "wake-queue"))).toBe(false);
    expect(h.logs.some((line) => line.msg === "loom auto wake")).toBe(false);
  });

  it("live 装配队列与 T07 plan 工具并完成 boot 对账", async () => {
    const work = tempWork("loom-sched-live-");
    const planRoot = join(work, "plan-root");
    seedMaster(planRoot, 9);
    const h = await boot(work, {
      planRoot,
      scheduling: { wakeQueue: "live", planScheduler: "live", timezone: "UTC" },
    });
    const summary = await waitSummary(h);
    expect(String(summary.fields["engine"])).toContain("live");
    expect(summary.fields["master_version"]).toBe(9);
    expect(Number(summary.fields["entries"])).toBeGreaterThan(0);
    expect(summary.fields["degraded"]).toBe(false);

    expect(planToolOf(h).description).toContain("diff overlay");
    expect(h.app.tools.map((tool) => tool.name)).toContain("long_task");
    expect(h.logs.some((line) => line.msg === "loom auto wake")).toBe(false);

    const sid = mainSessionID(h);
    expect(
      h.logs.find((line) => line.msg === "loom scheduling session fallback to main session")
        ?.fields["sessionID"],
    ).toBe(sid);
    const queue = readQueue(h.stateRoot, sid);
    expect(queue).not.toBeNull();
    expect(queue?.entries.some((entry) => entry.source === "plan")).toBe(true);
    expect(h.logs.filter((line) => line.msg === "loom scheduling")).toHaveLength(1);
  });

  it("live 端点：/plan/reconcile 202 幂等，/plan/state 读母版/队列/账本", async () => {
    const work = tempWork("loom-sched-api-");
    const planRoot = join(work, "plan-root");
    seedMaster(planRoot, 9);
    const h = await boot(work, {
      planRoot,
      listen: true,
      scheduling: { wakeQueue: "live", planScheduler: "live", timezone: "UTC" },
    });
    await waitSummary(h);
    const baseUrl = h.baseUrl;
    if (baseUrl === undefined) throw new Error("测试 app 未监听");
    const sid = mainSessionID(h);
    const auth = { Authorization: `Bearer ${h.token}` };
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${baseUrl}/plan/reconcile`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    const first = await post({ anchor: "05:00" });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      ok: boolean;
      entries: number;
      enqueued: number;
      status: string;
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.entries).toBeGreaterThan(0);

    const second = await post({ anchor: "05:00" });
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as { enqueued: number };
    expect(secondBody.enqueued).toBe(0);

    const stateRes = await fetch(
      `${baseUrl}/plan/state?sessionId=${encodeURIComponent(sid)}`,
      { headers: auth },
    );
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as {
      master_version: number | null;
      overlay_version: number | null;
      queue: { pending: number; delivered_tail: readonly unknown[] };
      ledger_tail: readonly unknown[];
      degraded: boolean;
    };
    expect(state.master_version).toBe(9);
    expect(state.overlay_version).toBeNull();
    expect(state.queue.pending).toBeGreaterThan(0);
    expect(Array.isArray(state.queue.delivered_tail)).toBe(true);
    expect(Array.isArray(state.ledger_tail)).toBe(true);
    expect(state.degraded).toBe(false);

    const unauth = await fetch(`${baseUrl}/plan/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchor: "05:00" }),
    });
    expect(unauth.status).toBe(401);
  });

  it("scheduling 关闭时不注册 plan 端点", async () => {
    const work = tempWork("loom-sched-api-off-");
    const planRoot = join(work, "plan-root");
    mkdirSync(planRoot, { recursive: true });
    const h = await boot(work, { planRoot, listen: true });
    const baseUrl = h.baseUrl;
    if (baseUrl === undefined) throw new Error("测试 app 未监听");
    const post = await fetch(`${baseUrl}/plan/reconcile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ anchor: "05:00" }),
    });
    expect(post.status).toBe(404);
    const state = await fetch(`${baseUrl}/plan/state`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    expect(state.status).toBe(404);
  });

  it("scheduling.sessionId 覆盖默认主会话并写入新队列", async () => {
    const work = tempWork("loom-sched-session-");
    const planRoot = join(work, "plan-root");
    seedMaster(planRoot);
    const override = "ses_custom_override";
    const h = await boot(work, {
      planRoot,
      scheduling: {
        wakeQueue: "live",
        planScheduler: "live",
        timezone: "UTC",
        sessionId: override,
      },
    });
    await waitSummary(h);
    expect(
      h.logs.some((line) => line.msg === "loom scheduling session fallback to main session"),
    ).toBe(false);
    expect(h.app.registry.has(override)).toBe(true);
    expect(h.app.registry.defaultMainSessionId()).toBe(override);
    expect(readQueue(h.stateRoot, override)).not.toBeNull();
    expect(readQueue(h.stateRoot, "loom_main")).toBeNull();
  });

  it("boot 顺序：recover -> queue.restore -> plan.reconcile -> flow.reconcile -> start", async () => {
    const work = tempWork("loom-sched-order-");
    const planRoot = join(work, "plan-root");
    seedMaster(planRoot);
    const h = await boot(work, {
      planRoot,
      flow: true,
      scheduling: { wakeQueue: "live", planScheduler: "live", timezone: "UTC" },
    });
    await waitSummary(h);
    const steps = h.logs
      .filter((line) => line.msg === "loom scheduling boot step")
      .map((line) => String(line.fields["step"]));
    expect(steps).toEqual([
      "recover",
      "queue.restore",
      "plan.reconcile",
      "flow.reconcile",
      "start",
    ]);
  });

  it("converge onAutoWake 映射 special:converge:{at}，与 plan 条目共存并按时投递", async () => {
    const work = tempWork("loom-sched-converge-");
    const planRoot = join(work, "plan-root");
    seedMaster(planRoot);
    const h = await boot(work, {
      planRoot,
      listen: true,
      scheduling: { wakeQueue: "live", planScheduler: "live", timezone: "UTC" },
    });
    await waitSummary(h);
    const sid = mainSessionID(h);
    fake(h).push(
      {
        content: [
          { type: "text", text: "收口后 2 秒继续。" },
          {
            type: "toolCall",
            name: "converge",
            arguments: {
              status: "已完成",
              digest: "带唤醒收口",
              body: "已设置 2s 后自动唤醒。",
              wake: "2s",
            },
          },
        ],
      },
      {
        content: [
          { type: "text", text: "收到唤醒，收口。" },
          {
            type: "toolCall",
            name: "converge",
            arguments: { status: "已完成", digest: "唤醒收口", body: "唤醒后继续完毕。" },
          },
        ],
      },
    );

    await postMessage(h, sid, "先收口，2 秒后继续");

    const observed: { queue: QueueSidecar | null } = { queue: null };
    const enqueued = await waitFor(() => {
      observed.queue = readQueue(h.stateRoot, sid);
      return (
        observed.queue !== null &&
        observed.queue.entries.some((entry) => entry.id.startsWith("special:converge:"))
      );
    });
    expect(enqueued, "special converge 条目应入队").toBe(true);
    const queue = observed.queue;
    if (queue === null) throw new Error("unreachable: queue not observed");
    expect(queue.entries.some((entry) => entry.source === "plan")).toBe(true);

    expect(
      await waitFor(() => {
        const current = readQueue(h.stateRoot, sid);
        return current !== null &&
          current.delivered.some(
            (record) =>
              record.id.startsWith("special:converge:") && record.outcome === "delivered",
          );
      }),
      "special converge 条目应按时投递",
    ).toBe(true);
    expect(
      h.app.registry.get(sid)?.loop.messages.some((message) =>
        JSON.stringify(message.content).includes("【自动唤醒】"),
      ),
    ).toBe(true);
    expect(existsSync(join(h.stateRoot, "session", "wake", `${sid}.json`))).toBe(false);
  });

  it("planScheduler live 缺 live 队列或 planRoot 时 fail closed", async () => {
    const noQueueWork = tempWork("loom-sched-fail-queue-");
    const noQueueRoot = join(noQueueWork, "plan-root");
    mkdirSync(noQueueRoot, { recursive: true });
    await expect(
      boot(noQueueWork, {
        planRoot: noQueueRoot,
        scheduling: { planScheduler: "live", timezone: "UTC" },
      }),
    ).rejects.toThrow(/wakeQueue=live/);

    const noRootWork = tempWork("loom-sched-fail-root-");
    await expect(
      boot(noRootWork, {
        scheduling: { planScheduler: "shadow", wakeQueue: "shadow", timezone: "UTC" },
      }),
    ).rejects.toThrow(/planRoot/);
  });
});
