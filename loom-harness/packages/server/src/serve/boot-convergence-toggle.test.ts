/**
 * W26 主会话收束强制开关 —— boot 级 e2e（配置面 → registry → MainSessionLoop 全链）。
 *
 * 用户决策（2026-10-10 10:19）："主会话增加 converge 开关，可以选择关闭这个强制要求，
 * 但仅限主会话"。Given: loom.yaml `server.convergenceEnforced: false` 起真树
 * （fake 模型、tmp state）；
 * Then:
 *  ① schema 透传：parseLoomConfig 物化 false（键缺席形态由 loom-config.test.ts 钉）；
 *  ② 主会话轮自然收尾即终局：text-only 应答 → idle，模型 call 恰 +1（零催办轮、
 *     零自动续跑）；捕获的 SSE 流零【收束催办】/【强制收束】帧面；主转录 terminal
 *     落盘 reason 保持内核自然值 "done"（W16-F3 终审改标门面未包 = 逐字段透传）；
 *     loop 账本/事件面诚实空（无 outcome、无 loop-forced）；
 *  ③ side 纪律照旧（仅限主会话的镜像钉）：同树 POST /runs 纯文本 side → 照旧
 *     催办链到 forceEnded（run failed + terminal.forceReason "nudge-limit"、
 *     side 转录含【收束催办】、trace 出现 kind:"nudge" 行）——本配置键绝不松动侧会话。
 *
 * 编排注：② 在主会话注册后执行；③ 的 side 终态会经 run-reminder 投缺省主会话
 * （W21 唤醒轮）——该轮落在本文件断言窗口之外，fake FIFO 余料天然承接，不干扰判据。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDateKey } from "@axeuh/loom-core";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomFrame } from "../events/index.js";
import type { LoomApp } from "./boot.js";
import type { LoomConfig } from "../config/loom-config.js";

// 加载纪律同 boot-prompt-e2e：boot 图动态 import 破 core↔server 桶环。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";
let app: LoomApp;
let baseUrl = "";
let mainSessionID = "";

const TOKEN = "tok-w26-toggle";
const NUDGE_MARK = "【收束催办】";
const FORCE_MARK = "【强制收束】";

/** W26 免强制实例配置（server.convergenceEnforced:false；生效 = 改配置 + 重启，W27 部署模型）。 */
const FAKE_YAML = [
  "server:",
  "  port: 5112",
  "  hostname: 127.0.0.1",
  "  convergenceEnforced: false",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w26",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

function fake(): {
  push(...resp: FakeAssistantResponse[]): void;
  getCalls(): Array<{ messages: Array<{ role: string; content: unknown }> }>;
} {
  return app.model.model as unknown as {
    push(...resp: FakeAssistantResponse[]): void;
    getCalls(): Array<{ messages: Array<{ role: string; content: unknown }> }>;
  };
}

function textTurn(t: string): FakeAssistantResponse {
  return { content: [{ type: "text", text: t }] };
}

async function waitFor(predicate: () => boolean, budgetMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function sseCollector(sessionID: string): Promise<{ frames: LoomFrame[]; stop: () => Promise<void> }> {
  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl}/events/stream?sessionId=${sessionID}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: ctrl.signal,
  });
  if (res.status !== 200 || res.body === null) throw new Error("SSE 订阅未起流");
  const frames: LoomFrame[] = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  const run = (async (): Promise<void> => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value !== undefined) {
          buffer += dec.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const p of parts) {
            const trimmed = p.trim();
            if (trimmed === "" || !trimmed.startsWith("data:")) continue;
            frames.push(JSON.parse(trimmed.slice("data:".length)) as LoomFrame);
          }
        }
        if (done) break;
      }
    } catch {
      /* abort 收尾：忽略 */
    }
  })();
  return {
    frames,
    stop: async (): Promise<void> => {
      ctrl.abort();
      await run;
    },
  };
}

/** loom-main.jsonl 里该 sid 的 terminal result 快照（落盘持久副本 = 改标判定的观测面）。 */
function mainTerminals(sid: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(join(stateRoot, "session", "loom-main.jsonl"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const parsed = JSON.parse(line) as {
      sid: string;
      e: { entry: { kind: string; result?: Record<string, unknown> } };
    };
    if (parsed.sid === sid && parsed.e.entry.kind === "terminal") {
      const result = parsed.e.entry.result;
      if (result !== undefined) out.push(result);
    }
  }
  return out;
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w26-toggle-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# W26 免强制底座\n");

  const cfg = parseLoomConfig(FAKE_YAML.replace("WS_ROOT", ws), "<test>", { env: {} }) as LoomConfig;
  // ① 配置面透传：键在场=布尔 false 物化（缺席形态见 loom-config.test.ts，非布尔=报错同彼）。
  expect(cfg.server.convergenceEnforced).toBe(false);

  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  app = await createLoomApp({
    config: cfg,
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
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await app?.closeExtras();
  await new Promise<void>((resolve) => {
    app?.server.closeAllConnections();
    app?.server.close(() => resolve());
  });
  app?.model.teardown();
  rmSync(work, { recursive: true, force: true });
});

describe("W26 boot e2e：convergenceEnforced:false 的全链形态", () => {
  it(
    "主会话 text-only 轮自然收尾即终局：零催办帧、call 恰 +1、terminal 保持 done 不改标",
    async () => {
      const rec = app.registry.create();
      mainSessionID = rec.sessionID;
      const collector = await sseCollector(mainSessionID);
      try {
        const marker = "W26-BOOT-NATURAL-STOP-正文";
        const callsBefore = fake().getCalls().length;
        fake().push(textTurn(marker));

        const sent = await api(`/sessions/${mainSessionID}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "说一句话就行，不用收束" }),
        });
        expect(sent.status).toBe(202);
        expect(await waitFor(() => app.registry.get(mainSessionID)?.running === null)).toBe(true);
        expect(await waitFor(() => collector.frames.some((f) => f.payload.type === "session.idle"))).toBe(true);

        // ② 零催办轮 + 零自动续跑：恰一次模型 call（强制在位时 text-only 会烧满
        // nudgeLimit 次 call 再走预算/强制链——那正是本开关摘掉的东西）。
        expect(fake().getCalls().length - callsBefore, "免强制轮 = 单次 LLM call").toBe(1);

        // ② SSE 诚实面：本开关关掉后主会话不可能出现催办/强制帧（零新事件名，纯缺席断言）。
        const framesText = JSON.stringify(collector.frames);
        expect(framesText).not.toContain(NUDGE_MARK);
        expect(framesText).not.toContain(FORCE_MARK);

        // ② 转录：正文落盘、无催办注入行、无强制 marker；terminal 持久副本 reason 自然值。
        const mainRaw = readFileSync(join(stateRoot, "session", "loom-main.jsonl"), "utf8");
        expect(mainRaw).toContain(marker);
        expect(mainRaw).not.toContain(NUDGE_MARK);
        expect(mainRaw).not.toContain(FORCE_MARK);
        const terminals = mainTerminals(mainSessionID);
        expect(terminals).toHaveLength(1);
        expect(terminals[0]?.["reason"], "W16-F3 改标门面未包：reason 保持内核自然值").toBe("done");
        expect(String(terminals[0]?.["abortReason"] ?? "")).not.toContain("convergence");

        // ② loop 观测面诚实空：gate 账本无条目、事件流无 outcome 记账、无 loop-forced。
        const loop = app.registry.loopOf(mainSessionID);
        expect(loop).toBeDefined();
        expect(loop!.outcomes()).toEqual([]);
        expect(loop!.events().filter((e) => e.type === "outcome")).toEqual([]);
        expect(loop!.events().filter((e) => e.type === "loop-forced")).toEqual([]);
      } finally {
        await collector.stop();
      }
    },
    60_000,
  );

  it(
    "side 纪律照旧（仅限主会话镜像钉）：同树 POST /runs 纯文本 → 催办链 forceEnded(nudge-limit)",
    async () => {
      // side 端口自建 gate（kind:"side"），不读 W26 配置键——纯文本 side 照旧被催满。
      fake().push(...Array.from({ length: 8 }, (_, i) => textTurn(`W26-side-空转-${String(i)}`)));
      const launched = await api("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: "w-w26-side", prompt: "只回文本永不收束（side 纪律探针）", actor: "script", trigger: "manual" }),
      });
      expect(launched.status).toBe(202);
      const runId = String(launched.json["run_id"]);

      let st = "timeout";
      let terminal: Record<string, unknown> | null = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const d = await api(`/runs/${runId}`);
        const s = String(d.json["status"]);
        if (s === "done" || s === "failed" || s === "partial") {
          st = s;
          terminal = (d.json["terminal"] as Record<string, unknown> | null) ?? null;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(st, "side 纯文本应被强制收束为 failed（绝非自然 done）").toBe("failed");
      expect(String(terminal?.["forceReason"]), "分级强制原因照常出自 side gate").toBe("nudge-limit");

      // side 转录仍含催办注入（执行面活着）；主转录仍零催办（免强制未被串台）。
      const sideRaw = readFileSync(join(stateRoot, "session", "loom-sessions.jsonl"), "utf8");
      expect(sideRaw).toContain(NUDGE_MARK);
      expect(readFileSync(join(stateRoot, "session", "loom-main.jsonl"), "utf8")).not.toContain(NUDGE_MARK);

      // trace nudge 行仍生产（side onNudge 接线活着；主会话免强制轮不产 nudge 行）。
      const traceFile = join(stateRoot, "trace", `${localDateKey(Date.now())}.jsonl`);
      const nudgeRows = readFileSync(traceFile, "utf8")
        .split("\n")
        .filter((l) => {
          if (l.trim() === "") return false;
          const rec = JSON.parse(l) as Record<string, unknown>;
          return rec["kind"] === "nudge";
        });
      expect(nudgeRows.length, "side 催办应照旧落 trace nudge 行").toBeGreaterThan(0);

      // 收尾：side 终态提醒唤醒主会话（W21 链）——等它把 fake 余料消化完再退场。
      expect(await waitFor(() => app.registry.get(mainSessionID)?.running === null, 30_000)).toBe(true);
    },
    90_000,
  );
});
