/**
 * W21 后台 sub 终态改推送 —— boot 级 e2e（真 task 工具后台派发、fake-model 全局 FIFO）。
 *
 * 直击用户 10:19 实测缺陷：主会话让派一个 background 子会话，子跑完后主会话**什么都没发生**
 * （既无 toast、也无唤醒）。W21 后：子盖棺 → onRunTerminal → deliverReminder(派发方) → 发射即发
 * delivery.notify 帧 + 派发方空闲则自动起唤醒轮（提醒行=durable user 消息，模型即刻见）。
 *
 * Given: createLoomApp 全树（fake 模型、tmp workspace）
 * Then:
 *  ① 空闲派发方 + bg sub 终态 → **无新 send** 派发方自动 +1 轮（唤醒），其模型 call 的 user 消息
 *     即 kind=sub 提醒行（含 task_fetch 取件指引、不含子正文）；发射时刻恰一 delivery.notify 帧；
 *     提醒行跨全部模型 call 恰一次（唤醒 prompt 一份，无"再入边界队列"双份）；行 durable 落转录。
 *  ② 结构归属（① 接线实证）：A 先注册（=缺省主会话）、B 后注册并从 B 派发 bg sub → 终态唤醒 **B 非 A**
 *     （parentSessionId 是 kernel 登记的 SubTaskRecord 结构事实，不经 noteParent/缺省回落）；
 *     A 的 hub 零帧、轮数不动；B 恰一帧 + 自动 +1 轮。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomFrame } from "../events/index.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";
let app: LoomApp;
let baseUrl = "";

const TOKEN = "tok-w21-wake";
const FAKE_YAML = [
  "server:",
  "  port: 5110",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w21wake",
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

function mainConverge(text: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
    ],
  };
}

/** 主会话派发轮首 call：发一个 background task 工具调用（即返、子会话后台跑）。 */
function dispatchBgToolCall(callId: string, agentType: string, task: string): FakeAssistantResponse {
  return {
    content: [
      { type: "toolCall", id: callId, name: "task", arguments: { agent_type: agentType, task, background: true } },
    ],
  };
}

function textOf(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) => (typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("\n");
  }
  return JSON.stringify(m.content);
}

/** 首个（也是应有唯一一个）含 needle 的模型 call 全文。 */
function callTextsIncluding(needle: string): string {
  const hit = fake()
    .getCalls()
    .find((c) => c.messages.some((m) => textOf(m).includes(needle)));
  if (hit === undefined) throw new Error(`no llm call contains marker: ${needle}`);
  return hit.messages.map((m) => textOf(m)).join("\n");
}

function callCountIncluding(needle: string): number {
  return fake().getCalls().filter((c) => c.messages.some((m) => textOf(m).includes(needle))).length;
}

/** 某模型 call 里是否存在携带 needle 的 user-role 字符串正文（唤醒=durable user 消息）。 */
function hasUserMessageWith(needle: string): boolean {
  return fake()
    .getCalls()
    .some((c) =>
      c.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(needle)),
    );
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

function notifyFramesFor(frames: readonly LoomFrame[], needle: string): LoomFrame[] {
  return frames.filter((f) => f.payload.type === "delivery.notify" && JSON.stringify(f.payload.properties).includes(needle));
}

/** 后台 sub 终态落册并取回其 task_id（kind=sub 提醒行以此为主键）。 */
async function settledTaskId(agentType: string, expectCount: number): Promise<string> {
  const ok = await waitFor(() => {
    const subs = app.kernel.listSubRuns().filter((r) => r.agentType === agentType);
    return subs.length === expectCount && subs.every((r) => r.state === "done" || r.state === "failed");
  });
  expect(ok, "后台 sub 应在预算内盖棺").toBe(true);
  const subs = app.kernel.listSubRuns().filter((r) => r.agentType === agentType);
  return subs[subs.length - 1]!.taskId;
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w21-wake-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# W21 唤醒底座\n");

  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
    tokens: [TOKEN],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
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

describe("W21 后台 sub 终态推送：唤醒轮 + 结构归属 + 发射即发帧", () => {
  it(
    "空闲派发方 + bg sub 盖棺 → 无新 send 自动唤醒、发射恰一帧、提醒行 durable 且每终态一份",
    async () => {
      const main = app.registry.create(); // 首注册 = 缺省主会话，也是唯一派发方
      const collector = await sseCollector(main.sessionID);
      try {
        const turnsBaseline = app.registry.get(main.sessionID)?.turns ?? 0;

        // 全局 FIFO 编排：
        //  #0 派发轮 call1 → task(bg) 即返；#1 子会话唯一 call（120ms 慢完，正文哨兵）；
        //  #2 派发轮 call2 → converge（派发方随即 idle）；#3 唤醒轮唯一 call（应消费唤醒 prompt 后收口）。
        fake().push(
          dispatchBgToolCall("wake-bg", "explore", "读一句：1+1=2"),
          { content: [{ type: "text", text: "W21-子会话正文-1+1=2" }], delayMs: 120 },
          mainConverge("已在后台派发，等完成通知。"),
          mainConverge("收到后台完成，正文待取件。"),
        );

        const sent = await api(`/sessions/${main.sessionID}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "后台派一个子会话读一句话" }),
        });
        expect(sent.status).toBe(202);

        // 等派发轮收尾（call2 converge → 主会话 idle，此刻子会话尚在 120ms 延迟中）。
        expect(await waitFor(() => app.registry.get(main.sessionID)?.running === null)).toBe(true);
        const taskId = await settledTaskId("explore", 1);

        // ① 唤醒：子盖棺后派发方**无新 send** 自动 +1 轮（#3 被唤醒轮消费）并再次 idle。
        expect(
          await waitFor(() => {
            const rec = app.registry.get(main.sessionID);
            return rec !== undefined && rec.running === null && rec.turns === turnsBaseline + 2;
          }),
          "空闲派发方应被子终态自动唤醒（+2 轮=派发轮+唤醒轮）",
        ).toBe(true);

        // ① 唤醒轮的 user 消息即 kind=sub 提醒行（durable user，非 transient 边界注入）。
        // 搜索锚点用 `kind=sub task=`（提醒行独有），非裸 taskId（派发工具回执亦含裸 taskId）。
        const wakePrompt = callTextsIncluding(`kind=sub task=${taskId}`);
        expect(wakePrompt).toContain(`[run-reminder] kind=sub task=${taskId}`);
        expect(wakePrompt).toContain("kind=sub");
        expect(wakePrompt).toContain(`task_fetch(task_id="${taskId}")`);
        expect(
          hasUserMessageWith(`[run-reminder] kind=sub task=${taskId}`),
          "提醒行应作为 user-role 字符串消息发给模型",
        ).toBe(true);
        // 取件走工具：子正文绝不随提醒行进 prompt。
        expect(wakePrompt).not.toContain("W21-子会话正文");

        // 每终态恰一份：kind=sub 提醒行跨全部模型 call 只现一次（唤醒 prompt 一份，无边界双注）。
        expect(callCountIncluding("[run-reminder] kind=sub"), "kind=sub 提醒行恰一份").toBe(1);

        // ① durable 落转录：唤醒 = 正常主会话轮，提醒行进 loom-main.jsonl（与 busy transient 相反）。
        const mainRaw = readFileSync(join(stateRoot, "session", "loom-main.jsonl"), "utf8");
        expect(mainRaw).toContain(`task=${taskId}`);
        expect(mainRaw).not.toContain("W21-子会话正文");

        // ② 帧单点：该终态恰一 delivery.notify（发射时刻），variant 对齐 done=success。
        expect(await waitFor(() => notifyFramesFor(collector.frames, taskId).length >= 1)).toBe(true);
        expect(notifyFramesFor(collector.frames, taskId), "每终态恰一个 delivery.notify 帧").toHaveLength(1);
        const props = notifyFramesFor(collector.frames, taskId)[0]!.payload.properties;
        expect(props.sessionID).toBe(main.sessionID);
        expect(props.variant).toBe("success");
        expect(String(props.title)).toBe("后台任务完成");
      } finally {
        await collector.stop();
      }
    },
    120_000,
  );

  it(
    "结构归属：A 先注册（缺省）、B 后注册并派发 bg sub → 终态唤醒 B 非 A（parentSessionId 直通派发方）",
    async () => {
      // A 是本用例前第一个已存在主会话（上一 it 的 main = 缺省主会话），B 新注册且后于 A。
      // W23-B 改钉（带原因）：list() 已翻为视图级倒序，**不再**反映插入序——本行意图
      // （首注册=缺省主会话）改由命门 API defaultMainSessionId() 直取（其 #records
      // 插入序语义有独立新钉，见 boot-session-meta.test.ts）。
      const mainA = { sessionID: app.registry.defaultMainSessionId() ?? "" };
      expect(mainA.sessionID.length).toBeGreaterThan(0);
      const mainB = app.registry.create(); // 后注册；派发方，绝不该被缺省回落吞进 A
      expect(mainB.sessionID).not.toBe(mainA.sessionID);

      const collectorA = await sseCollector(mainA.sessionID);
      const collectorB = await sseCollector(mainB.sessionID);
      try {
        const aTurnsBaseline = app.registry.get(mainA.sessionID)?.turns ?? 0;
        const bTurnsBaseline = app.registry.get(mainB.sessionID)?.turns ?? 0;

        fake().push(
          dispatchBgToolCall("attr-bg", "general", "归属测试任务"),
          { content: [{ type: "text", text: "W21-归属子正文" }], delayMs: 120 },
          mainConverge("B 派发完毕。"),
          mainConverge("B 收到完成。"),
        );

        const sent = await api(`/sessions/${mainB.sessionID}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "从 B 后台派一个子会话" }),
        });
        expect(sent.status).toBe(202);

        expect(await waitFor(() => app.registry.get(mainB.sessionID)?.running === null)).toBe(true);
        const taskId = await settledTaskId("general", 1);

        // B 被唤醒（+2 轮），A 轮数纹丝不动（归属直投派发方，不落缺省主会话）。
        expect(
          await waitFor(() => {
            const rec = app.registry.get(mainB.sessionID);
            return rec !== undefined && rec.running === null && rec.turns === bTurnsBaseline + 2;
          }),
          "派发方 B 应自动唤醒",
        ).toBe(true);
        expect(app.registry.get(mainA.sessionID)?.turns, "A（缺省主会话）绝不被 B 的子终态唤醒").toBe(aTurnsBaseline);

        // 提醒行落 B 的唤醒 prompt，A 全模型 call 无此 task（归属不渗缺省主会话）。
        const bPrompt = callTextsIncluding(`kind=sub task=${taskId}`);
        expect(bPrompt).toContain(`[run-reminder] kind=sub task=${taskId}`);

        // 帧归属：B 恰一帧，A 零帧。
        expect(await waitFor(() => notifyFramesFor(collectorB.frames, taskId).length >= 1)).toBe(true);
        expect(notifyFramesFor(collectorB.frames, taskId)).toHaveLength(1);
        expect(notifyFramesFor(collectorA.frames, taskId), "run2 的帧不投缺省主会话 A").toHaveLength(0);
      } finally {
        await collectorA.stop();
        await collectorB.stop();
      }
    },
    120_000,
  );
});
