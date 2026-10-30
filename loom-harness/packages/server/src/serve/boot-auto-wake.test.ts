/**
 * 自动唤醒 boot 级 e2e —— converge 的 wake 参数 → WakeScheduler → registry.deliverWake 全链。
 *
 * Given: createLoomApp 全树（fake provider、独立 tmp workspace/stateRoot、server.listen(0)）。
 * Then:
 *   ① 缺省（server 段未声明 autoWakeEnabled）= 启用：converge 回执 wake="1s" 武装**真实未来轮**；
 *      sidecar（{stateRoot}/session/wake/{sid}.json）落盘即 {sessionID, at}（at 为未来时刻），
 *      到点投递后删除；唤醒轮以 durable user 消息「【自动唤醒】」起跑并收束；SSE 恰一帧
 *      delivery.notify（title=自动唤醒），绝无「PTY 退出通知」帧；会话回 idle。
 *   ② server.autoWakeEnabled:false：带 wake 的回执被收束工具拒收（缺失文案含「自动唤醒已禁用」），
 *      gate 催办后对话继续到无 wake 的第二轮并成功收束；全程不落 sidecar、不出现唤醒行。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomFrame } from "../events/index.js";
import type { LoomApp } from "./boot.js";

// 加载纪律（同 boot-wake/boot-reminder）：boot 图必须动态 import，
// 避免 core 桶经 server 环先实例化。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

interface TestApp {
  readonly app: LoomApp;
  readonly baseUrl: string;
  readonly stateRoot: string;
  readonly token: string;
  close(): Promise<void>;
}

const opened: TestApp[] = [];
let appSeq = 0;

/** 每个 app 独立 temp work/ws/stateRoot + 唯一 token（多 app 同文件并行造树互不污染）。 */
function fakeYaml(ws: string, autoWakeEnabled: boolean | undefined): string {
  return [
    "server:",
    "  port: 5110",
    "  hostname: 127.0.0.1",
    // 只在显式 false 时注入：缺省不出键 = 走 createLoomApp 的 enabled 缺省面。
    ...(autoWakeEnabled === false ? ["  autoWakeEnabled: false"] : []),
    "workspace: WS_ROOT",
    "models:",
    "  - id: fake-auto-wake",
    "    provider: fake",
    "    contextWindow: 200000",
    "    maxOutput: 4096",
    "    timeout: 60000",
    "pricing:",
    "  fake:",
    "    input: 0",
    "    output: 0",
  ]
    .join("\n")
    .replace("WS_ROOT", ws);
}

async function makeApp(opts: { autoWakeEnabled?: boolean } = {}): Promise<TestApp> {
  const work = mkdtempSync(join(tmpdir(), "loom-auto-wake-"));
  const ws = join(work, "ws");
  const stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# 自动唤醒 boot e2e\n");

  const token = `tok-auto-wake-${String(++appSeq)}`;
  const text = fakeYaml(ws, opts.autoWakeEnabled);
  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
    tokens: [token],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");

  return {
    app,
    baseUrl: `http://127.0.0.1:${String(addr.port)}`,
    stateRoot,
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
}

function fake(h: TestApp): {
  push(...resp: FakeAssistantResponse[]): void;
  getCalls(): Array<{ messages: Array<{ role: string; content: unknown }> }>;
} {
  return h.app.model.model as unknown as {
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

async function api(
  h: TestApp,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${h.token}`, ...(init?.headers ?? {}) },
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

function convergeTurn(text: string, args: Record<string, unknown>): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: args },
    ],
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("\n");
  }
  return "";
}

/** 全部模型 call 里是否存在携带 needle 的 user-role 消息（durable 唤醒行即 user 字符串）。 */
function hasUserMessageWith(h: TestApp, needle: string): boolean {
  return fake(h)
    .getCalls()
    .some((call) => call.messages.some((m) => m.role === "user" && textOf(m.content).includes(needle)));
}

async function sseCollector(h: TestApp, sessionID: string): Promise<{ frames: LoomFrame[]; stop: () => Promise<void> }> {
  const ctrl = new AbortController();
  const res = await fetch(`${h.baseUrl}/events/stream?sessionId=${sessionID}`, {
    headers: { Authorization: `Bearer ${h.token}` },
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

function notifyFramesWithTitle(frames: readonly LoomFrame[], title: string): LoomFrame[] {
  return frames.filter((f) => f.payload.type === "delivery.notify" && f.payload.properties["title"] === title);
}

function wakeSidecarPath(h: TestApp, sessionID: string): string {
  return join(h.stateRoot, "session", "wake", `${sessionID}.json`);
}

interface WakeSidecar {
  readonly sessionID: string;
  readonly at: number;
}

function readWakeSidecar(h: TestApp, sessionID: string): WakeSidecar | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(wakeSidecarPath(h, sessionID), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const sidValue = Reflect.get(raw, "sessionID");
  const atValue = Reflect.get(raw, "at");
  if (typeof sidValue !== "string" || typeof atValue !== "number") return null;
  return { sessionID: sidValue, at: atValue };
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
});

afterEach(async () => {
  for (const h of opened.splice(0)) {
    await h.close();
  }
});

afterAll(async () => {
  for (const h of opened.splice(0)) {
    await h.close();
  }
});

describe("自动唤醒 boot 级 e2e：converge wake 参数驱动真实未来轮", () => {
  it(
    "缺省启用：wake=1s 落 sidecar（{sessionID, at 未来}）→ 到点投递并删除 → 唤醒轮收束、恰一帧通知、无 PTY 帧",
    async () => {
      const h = await makeApp(); // 不注入 autoWakeEnabled = 缺省启用
      opened.push(h);
      const main = h.app.registry.create();
      const collector = await sseCollector(h, main.sessionID);
      try {
        fake(h).push(
          // #0 首轮：正文 + converge 带 wake="1s" → 收束受理并武装 1s 后的未来轮。
          convergeTurn("先收口，1 秒后继续。", {
            status: "已完成",
            digest: "带唤醒收口",
            body: "已设置 1s 后自动唤醒。",
            wake: "1s",
          }),
          // #1 唤醒轮：不带 wake 的收束（收口）。
          convergeTurn("收到唤醒，继续处理完毕。", {
            status: "已完成",
            digest: "唤醒轮收口",
            body: "继续处理完毕。",
          }),
        );

        const postStartedAt = Date.now();
        const sent = await api(h, `/sessions/${main.sessionID}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "先做一件事，1 秒后继续" }),
        });
        expect(sent.status).toBe(202);

        // ① 真实未来轮：sidecar 落盘，内容 = {sessionID, at}，at 为未来时刻。
        // holder 对象承接回调内赋值（TS 控制流分析看不到闭包内对本地 let 的赋值）。
        const observed: { sidecar: WakeSidecar | null } = { sidecar: null };
        expect(
          await waitFor(() => {
            observed.sidecar = readWakeSidecar(h, main.sessionID);
            return observed.sidecar !== null;
          }, 15_000),
          "wake sidecar 应在预算内落盘",
        ).toBe(true);
        const armed = observed.sidecar;
        if (armed === null) throw new Error("unreachable: sidecar not observed");
        expect(armed.sessionID).toBe(main.sessionID);
        expect(armed.at).toBeGreaterThan(postStartedAt); // 武装点晚于请求发起 = 真未来时刻
        expect(armed.at).toBeGreaterThan(Date.now());

        // ① 到点投递：唤醒轮 prompt 以 durable user 消息「【自动唤醒】」抵达模型。
        expect(
          await waitFor(() => hasUserMessageWith(h, "【自动唤醒】"), 15_000),
          "唤醒轮应携「【自动唤醒】」user 消息",
        ).toBe(true);

        // ① 投递后 sidecar 删除（一次性）；唤醒驱动轮跑完、会话回 idle（turns=首轮+唤醒轮）。
        expect(await waitFor(() => !existsSync(wakeSidecarPath(h, main.sessionID)), 15_000), "投递后 sidecar 应删除").toBe(
          true,
        );
        expect(
          await waitFor(() => {
            const rec = h.app.registry.get(main.sessionID);
            return rec !== undefined && rec.running === null && rec.turns === 2;
          }, 15_000),
          "唤醒驱动轮应完成且会话回 idle",
        ).toBe(true);

        // ① 帧单点：恰一帧 delivery.notify（title=自动唤醒），绝无 PTY 退出通知帧。
        expect(
          await waitFor(() => notifyFramesWithTitle(collector.frames, "自动唤醒").length >= 1, 15_000),
          "唤醒到点应推 delivery.notify",
        ).toBe(true);
        const wakeFrames = notifyFramesWithTitle(collector.frames, "自动唤醒");
        expect(wakeFrames, "唤醒恰一帧 delivery.notify").toHaveLength(1);
        expect(wakeFrames[0]!.payload.properties["sessionID"]).toBe(main.sessionID);
        expect(notifyFramesWithTitle(collector.frames, "PTY 退出通知"), "不得出现 PTY 退出通知帧").toHaveLength(0);
      } finally {
        await collector.stop();
      }
    },
    120_000,
  );

  it(
    "autoWakeEnabled:false：带 wake 被拒收（自动唤醒已禁用）并继续到第二轮收束，不落 sidecar、无唤醒行",
    async () => {
      const h = await makeApp({ autoWakeEnabled: false });
      opened.push(h);
      const main = h.app.registry.create();

      fake(h).push(
        // #0 带 wake → parseReceiptArgs 以「wake（自动唤醒已禁用）」拒收（fields 催办）。
        convergeTurn("第一次带唤醒。", { status: "已完成", digest: "带唤醒", wake: "1s" }),
        // #1 无 wake → 合法收束。
        convergeTurn("第二次不带唤醒。", { status: "已完成", digest: "无唤醒" }),
      );

      const sent = await api(h, `/sessions/${main.sessionID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "禁用自动唤醒后收束" }),
      });
      expect(sent.status).toBe(202);

      expect(
        await waitFor(() => {
          const rec = h.app.registry.get(main.sessionID);
          return rec !== undefined && rec.running === null && rec.turns === 1;
        }, 15_000),
        "会话应在拒收催办后继续到第二轮并回 idle",
      ).toBe(true);

      // ① 对话继续：首轮拒收后同一 start 内推进到第二次模型 call（恰 2 次）。
      expect(fake(h).getCalls(), "拒收后对话继续到第二轮 = 恰 2 次模型调用").toHaveLength(2);

      // ① 拒收文案落 loop 消息（toolResult 文本经同一提取器可达）。
      const loopMessages = h.app.registry.get(main.sessionID)?.loop.messages ?? [];
      expect(loopMessages.map((m) => textOf(m.content)).join("\n")).toContain("自动唤醒已禁用");

      // ① 禁用面绝无唤醒副作用：不落 sidecar、不出现唤醒行。
      expect(existsSync(wakeSidecarPath(h, main.sessionID)), "禁用时绝不落 wake sidecar").toBe(false);
      expect(hasUserMessageWith(h, "【自动唤醒】"), "禁用时绝不出现唤醒行").toBe(false);
    },
    120_000,
  );
});
