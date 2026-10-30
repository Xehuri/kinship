/**
 * W12→W21 副会话终态提醒 —— boot 级 e2e（fake-model 离线起真树走 HTTP）。
 *
 * W21 语义改写（推送取代拉取）：run 盖棺的提醒不再"滞留到主会话下一轮手动送才随边界注入"，
 * 而是**终态即发 delivery.notify 帧 + 空闲目标自动起唤醒轮**（提醒行即该轮 durable user 消息，
 * 模型即刻见）。本面走 POST /runs（run 面，非 kind=sub）三条路径逐一定死：
 *  Given: 临时 workspace + fake provider + LOOM_FAKE_MODEL=1；主会话 A（首注册=缺省主会话）/ B
 *  Then:
 *   ① 空闲目标 + 无 parent 的 run 盖棺 → 不经任何手动 send，A **自动 +1 轮**（唤醒），
 *      其模型 call 的 user 消息即提醒行；A 转录现**含**该行（唤醒=durable prompt，与旧 transient
 *      注入相反=W21 预期变更）；行内不含 digest 哨兵（取件走工具）；
 *   ② 帧单点：该终态恰一 delivery.notify（发射时刻），drain 时刻发帧路径已下线（无第二帧）；
 *   ③ 归属：parentSessionId=B 的 run 盖棺唤醒 **B 非 A**（A 轮数不因它增加）——parent 在册投它；
 *   ④ 忙目标滞留：A 跑一轮延迟占位轮期间 run 盖棺 → 不额外起轮、行 transient 滞留边界队列，
 *      A 下轮随边界注入、**绝不进转录**（W12 busy 路径逐字节不变）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import { SSE_EVENT_LINE_RE, type LoomFrame } from "../events/index.js";
import type { LoomApp } from "./boot.js";

// 加载纪律（同 boot-tools/boot-transcript）：boot 图必须动态 import，
// 避免 core 桶经 server 环先实例化。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";
let app: LoomApp;
let baseUrl = "";

const TOKEN = "tok-w21-reminder";
const MAIN_FIRST_TEXT = "W21-主会话首轮正文";
const RUN1_DIGEST = "RUN1-DIGEST-哨兵-绝不进提醒";
const RUN2_DIGEST = "RUN2-DIGEST-哨兵-绝不进提醒";
const RUN4_DIGEST = "RUN4-DIGEST-哨兵-绝不进提醒";

const FAKE_YAML = [
  "server:",
  "  port: 5101",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w21",
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

/** 主会话收束轮（kind=main 回执形状）。可选延迟 = 令会话在该轮内滞留（忙目标滞留用例）。 */
function mainConverge(text: string, delayMs?: number): FakeAssistantResponse {
  const r: FakeAssistantResponse = {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
    ],
  };
  return delayMs === undefined ? r : { ...r, delayMs };
}

/** 副会话收束轮（side 回执形状，digest 带哨兵——只进账本/取件面，不进提醒）。 */
function sideConverge(workflow: string, digest: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text: "干活完毕，收束。" },
      {
        type: "toolCall",
        name: "converge",
        arguments: {
          status: "done",
          runId: "run_selfreport_w21",
          workflow,
          attempt: 1,
          digest,
          pointers: [],
          blockers: [],
        },
      },
    ],
  };
}

/** 目标会话最近一轮模型收到的 messages 全文（按 call 归属：只查含 prompt 文本的 call）。 */
function callTextsIncluding(promptNeedle: string): string {
  const hit = fake()
    .getCalls()
    .filter((c) => c.messages.some((m) => textOf(m).includes(promptNeedle)))
    .slice(-1)[0];
  if (hit === undefined) throw new Error(`no llm call contains prompt marker: ${promptNeedle}`);
  return hit.messages.map((m) => textOf(m)).join("\n");
}

function textOf(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  return JSON.stringify(m.content);
}

/** 全部模型 call 里含某 needle 的 call 数（每终态恰一份的计数面）。 */
function callCountIncluding(needle: string): number {
  return fake().getCalls().filter((c) => c.messages.some((m) => textOf(m).includes(needle))).length;
}

/**
 * 后台 SSE 帧采集器：起 reader 累积到数组，stop() 中止收尾。
 * 帧取证不靠"读到目标帧即收流"的时序赌注（W21 发射时刻发帧更早于任何 drain），
 * 改为常驻采集 + waitFor 目标帧数达标。
 */
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

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w21-reminder-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# W21 提醒推送底座\n");

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

describe("W21 副会话终态推送：唤醒轮 + 发射即发帧 + 归属 + 忙滞留", () => {
  it(
    "空闲唤醒（无 send 自动起轮/帧单点/每终态一份/durable 落转录）+ 归属投 parent 非缺省 + 忙则滞留注入不落转录",
    async () => {
      // T2：缺省主会话 = boot 解析并登记的主会话（不再取首个 create）。
      const bootMainID = app.registry.defaultMainSessionId();
      if (bootMainID === undefined) throw new Error("boot 主会话未解析");
      const mainA = app.registry.ensure(bootMainID);
      const mainB = app.registry.create(); // B 后注册：缺省主会话仍是 A（boot 主会话）

      const collectorA = await sseCollector(mainA.sessionID);
      const collectorB = await sseCollector(mainB.sessionID);
      try {
        // ① A 首轮基线：无提醒在场（占位轮，正常收尾）。
        fake().push(mainConverge(MAIN_FIRST_TEXT));
        app.registry.send(mainA.sessionID, "第一问");
        expect(await waitFor(() => app.registry.get(mainA.sessionID)?.running === null)).toBe(true);
        expect(callTextsIncluding("第一问")).not.toContain("[run-reminder]");
        const aTurnsBaseline = app.registry.get(mainA.sessionID)?.turns ?? 0;

        // ── ②/①/④ 空闲唤醒：run1 无 parent → 缺省主会话 A（此刻空闲）→ 自动唤醒 ──
        // 队列序（全局 FIFO，shift 时刻）：POST 派发期 side 先 shift；A 唤醒轮后 shift。
        fake().push(sideConverge("w-rem1", RUN1_DIGEST), mainConverge("A 后台唤醒收口"));
        const r1 = await api("/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow: "w-rem1", prompt: "干活一" }),
        });
        expect(r1.status).toBe(202);
        const run1 = String(r1.json["run_id"]);

        // 不经任何手动 send：A 轮数自动 +1 且再次空闲（=唤醒轮跑完）。
        expect(
          await waitFor(() => {
            const rec = app.registry.get(mainA.sessionID);
            return rec !== undefined && rec.running === null && rec.turns === aTurnsBaseline + 1;
          }),
        ).toBe(true);

        // ① 唤醒轮的模型 call 以提醒行为 user 消息收到（content model-facing）。
        const wakePrompt = callTextsIncluding(`run=${run1}`);
        expect(wakePrompt).toContain(`[run-reminder] run=${run1} workflow=w-rem1 status=done`);
        expect(wakePrompt).toContain(`task_fetch(session_id=`);
        expect(wakePrompt).toContain(`GET /runs/${run1}`);
        expect(wakePrompt).not.toContain(RUN1_DIGEST); // digest 绝不进提醒行（取件走工具）
        // 每终态恰一份：run1 提醒行只在唤醒 prompt 现一次（无"边界注入+唤醒 prompt"双份）。
        expect(callCountIncluding(run1), "run1 提醒行跨全部模型 call 恰一次").toBe(1);

        // ① durable 落转录：W21 空闲唤醒 = 提醒行即 durable user 消息，进主 store（与旧 transient 相反）。
        const mainFile = join(stateRoot, "session", "loom-main.jsonl");
        expect(existsSync(mainFile)).toBe(true);
        const mainRawAfterWake = readFileSync(mainFile, "utf8");
        expect(mainRawAfterWake).toContain(`run=${run1}`);
        expect(mainRawAfterWake, "digest 绝不随提醒进转录").not.toContain(RUN1_DIGEST);
        // 唤醒后无滞留（行已成 prompt，未再入边界队列）。
        expect(app.registry.pendingReminderCount(mainA.sessionID)).toBe(0);

        // ② 帧单点：run1 终态恰一 delivery.notify（发射时刻），且形状/信封达标。
        expect(
          await waitFor(() => notifyFramesFor(collectorA.frames, run1).length >= 1),
        ).toBe(true);
        expect(notifyFramesFor(collectorA.frames, run1), "每终态恰一个 delivery.notify 帧").toHaveLength(1);
        const n1 = notifyFramesFor(collectorA.frames, run1)[0]!;
        expect(n1.payload.properties.sessionID).toBe(mainA.sessionID);
        expect(n1.payload.properties.variant).toBe("success");
        expect(String(n1.payload.properties.message)).toContain("w-rem1");
        expect(typeof n1.payload.properties.title).toBe("string");
        // 信封纪律：loom SSE 帧绝不含旧式 `event:` 行（W12 硬契约延续到发射时刻帧）。
        expect(
          collectorA.frames.some((f) => SSE_EVENT_LINE_RE.test(JSON.stringify(f))),
          "delivery.notify 帧不得携 event: 行（信封纪律）",
        ).toBe(false);

        // ── ③ 归属：parentSessionId=B 的 run2 → 唤醒 B（非缺省 A）──
        const aTurnsBeforeR2 = app.registry.get(mainA.sessionID)?.turns ?? 0;
        const bTurnsBefore = app.registry.get(mainB.sessionID)?.turns ?? 0;
        fake().push(sideConverge("w-rem2", RUN2_DIGEST), mainConverge("B 后台唤醒收口"));
        const r2 = await api("/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow: "w-rem2", prompt: "干活二", parentSessionId: mainB.sessionID }),
        });
        expect(r2.status).toBe(202);
        const run2 = String(r2.json["run_id"]);
        expect(
          await waitFor(() => {
            const rec = app.registry.get(mainB.sessionID);
            return rec !== undefined && rec.running === null && rec.turns === bTurnsBefore + 1;
          }),
        ).toBe(true);
        expect(
          await waitFor(() => notifyFramesFor(collectorB.frames, run2).length >= 1),
        ).toBe(true);
        expect(notifyFramesFor(collectorB.frames, run2)).toHaveLength(1);
        // B 的唤醒 prompt 只见 run2，不含 run1（缺省主会话面）/不含后续 run4。
        const bPrompt = callTextsIncluding(`run=${run2}`);
        expect(bPrompt).toContain(`[run-reminder] run=${run2} workflow=w-rem2 status=done`);
        expect(bPrompt).not.toContain(RUN2_DIGEST);
        // A 不因 run2（parent=B）多起一轮——归属直投派发方，不落缺省主会话。
        expect(app.registry.get(mainA.sessionID)?.turns).toBe(aTurnsBeforeR2);
        expect(notifyFramesFor(collectorA.frames, run2), "run2 的帧不投 A").toHaveLength(0);

        // ── ④ 忙目标滞留：A 跑延迟占位轮期间 run4 盖棺 → 不起额外轮、行滞留边界、下轮注入不落转录 ──
        // A 占位轮 shift 一条 600ms 延迟 converge ⇒ A 在该窗口内 busy；期间 POST run4。
        fake().push(
          mainConverge("A 占位忙碌轮", 600),
          sideConverge("w-rem4", RUN4_DIGEST),
          mainConverge("A 滞留取回轮"),
        );
        app.registry.send(mainA.sessionID, "占位一问");
        expect(await waitFor(() => app.registry.get(mainA.sessionID)?.running !== null)).toBe(true);
        const aTurnsBusy = app.registry.get(mainA.sessionID)?.turns ?? 0;
        const r4 = await api("/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow: "w-rem4", prompt: "干活四" }),
        });
        expect(r4.status).toBe(202);
        const run4 = String(r4.json["run_id"]);
        expect(await waitFor(() => app.engine.get(run4)?.state === "done")).toBe(true);
        // run4 盖棺时 A busy → 无额外轮（占位轮收尾后仍 = aTurnsBusy，非 +1）+ 行滞留边界队列。
        expect(
          await waitFor(() => {
            const rec = app.registry.get(mainA.sessionID);
            return rec !== undefined && rec.running === null && rec.turns === aTurnsBusy;
          }),
        ).toBe(true);
        expect(app.registry.pendingReminderCount(mainA.sessionID), "忙目标：run4 行滞留边界队列").toBe(1);
        // 发射帧照旧（忙也发，一帧）——不等 drain。
        expect(await waitFor(() => notifyFramesFor(collectorA.frames, run4).length >= 1)).toBe(true);
        expect(notifyFramesFor(collectorA.frames, run4), "忙目标也恰一个发射帧").toHaveLength(1);
        // 占位轮已结束，滞留行未进转录（此刻转录只应有唤醒 run1 行，绝不含 run4）。
        expect(readFileSync(mainFile, "utf8")).not.toContain(run4);

        // A 下一轮随边界注入 run4（transient：模型收得到、转录不留）。
        app.registry.send(mainA.sessionID, "滞留取回一问");
        expect(await waitFor(() => app.registry.get(mainA.sessionID)?.running === null)).toBe(true);
        const drainPrompt = callTextsIncluding("滞留取回一问");
        expect(drainPrompt).toContain(`[run-reminder] run=${run4} workflow=w-rem4 status=done`);
        expect(drainPrompt).not.toContain(RUN4_DIGEST);
        expect(app.registry.pendingReminderCount(mainA.sessionID)).toBe(0);
        // 滞留边界注入 = transient，绝不进主 store（与 W12 busy 路径逐字节一致）。
        expect(readFileSync(mainFile, "utf8")).not.toContain(run4);
        // 每终态恰一份（busy 路径：只在取回轮 prompt 现一次）。
        expect(callCountIncluding(run4), "run4 提醒行跨全部模型 call 恰一次").toBe(1);
      } finally {
        await collectorA.stop();
        await collectorB.stop();
      }
    },
    120_000,
  );
});
