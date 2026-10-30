/**
 * W9 事故补测（S05 金丝雀假绿盲区）—— boot 级 run e2e 的 prompt 送达硬断言。
 * Given: 临时 workspace + fake provider（LOOM_FAKE_MODEL=1）+ 起真树走 HTTP；
 *        fake 脚本按 S05 姿势应答 toolCall(bash echo marker) → toolCall(converge digest=marker)
 * When:  POST /runs 提交含多行/引号/反斜杠/${} 字面量的刁钻 prompt，连发两个 run
 * Then:  fake 模型**每一轮调用记录**里 user 消息与派发 prompt 逐字节全等（第一/第二轮都在）；
 *        第二个 run 的首调用携带的是第二个 prompt（反旧值粘滞/串台钉）；
 *        run 终态 done 且 digest 含 marker（既有 S05 判据形状在 fake 面的复刻）。
 * 决策：既有 boot-tools 测试只断 systemPrompt/tools 面，对「收到的 prompt 是否正确」是盲区
 *      ——本文件专补请求 messages 的 prompt 文本断言（fake 模型也能抓）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";
import type { LoomApp } from "./boot.js";
import type { LoomConfig } from "../config/loom-config.js";

// 加载纪律同 boot-tools：boot 图动态 import 破 core↔server 桶环。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";
let app: LoomApp;
let baseUrl = "";

const TOKEN = "tok-prompt-e2e";

const FAKE_YAML = [
  "server:",
  "  port: 5101",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-prompt",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

/**
 * 刁钻派发文本：换行/制表/引号/反斜杠/${} 字面量/CJK。
 * 断言以「=== 逐字节」执行：任何 JSON 往返损伤、字段替换、粘滞旧值都会破等。
 */
function nastyPrompt(tag: string, marker: string): string {
  const nl = "\n";
  return (
    `用 bash 工具执行命令：echo "${marker}" 。` +
    nl +
    "第二行：引号 \" ' 反斜杠 \\\\ 制表\t必须原样送达，" +
    "模板占位 ${" + tag + "_EXPAND} 不许展开。" +
    nl +
    `然后调用收束工具，把命令输出原样写进 digest。除 bash 和收束外不要调用其他工具。`
  );
}

interface SeenCall {
  messages: Array<{ role: string; content: unknown }>;
}

function modelCalls(): SeenCall[] {
  const m = app.model.model as unknown as { getCalls(): SeenCall[] };
  return m.getCalls();
}

/** user 消息文本提取（pi-ai 用户消息 content 为 string 或 text 块数组两态）。 */
function userTextOf(msg: SeenCall["messages"][number] | undefined): string {
  if (msg === undefined) return "\u0000MISSING\u0000";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return "\u0000UNSHAPE\u0000";
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

async function waitForRunTerminal(runId: string, budgetMs = 20_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const d = await api(`/runs/${runId}`);
    const st = String(d.json["status"]);
    if (st === "done" || st === "failed" || st === "partial") return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  return "timeout";
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-prompt-e2e-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(join(ws, "memory"), { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# prompt e2e 记忆底座\nPROMPT-E2E-稳定段\n");

  const { parseLoomConfig } = await import("../config/loom-config.js");
  const { HotConfigStore, createFileAuditSink } = await import("../hotreload/index.js");
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }) as LoomConfig,
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

beforeEach(async () => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !app.registry.list().every((s) => s.status === "idle")) {
    await new Promise((r) => setTimeout(r, 25));
  }
  (app.model.model as unknown as { reset(): void }).reset();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    app?.server.closeAllConnections();
    app?.server.close(() => resolve());
  });
  app?.model.teardown();
  rmSync(work, { recursive: true, force: true });
});

/** S05 姿势脚本：bash echo marker → converge（digest=marker 原样）。 */
function s05Script(marker: string): FakeAssistantResponse[] {
  return [
    {
      content: [
        { type: "text", text: `按任务执行 echo。` },
        { type: "toolCall", id: `pe-bash-${marker.slice(-4)}`, name: "bash", arguments: { command: `echo ${marker}` } },
      ],
    },
    {
      content: [
        {
          type: "toolCall",
          id: `pe-conv-${marker.slice(-4)}`,
          name: "converge",
          arguments: {
            status: "done",
            runId: "run_promptselfreported",
            workflow: "w-prompt-e2e",
            attempt: 1,
            digest: marker,
            pointers: [],
            blockers: [],
          },
        },
      ],
    },
  ];
}

describe("boot 级 run e2e：POST /runs 的 prompt 逐字节送达模型（含跨轮保持）", () => {
  it(
    "run A：模型每一轮调用记录里 user 消息 === 派发原文；终态 done 且 digest 含 marker",
    async () => {
      const marker = "PROMPT-E2E-MARKER-a1b2c3d4";
      const prompt = nastyPrompt("A", marker);
      (app.model.model as unknown as { push(...r: FakeAssistantResponse[]): void }).push(...s05Script(marker));

      const base = modelCalls().length;
      const launched = await api("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: "w-prompt-e2e", prompt, actor: "script", trigger: "manual" }),
      });
      expect(launched.status).toBe(202);
      const runId = String(launched.json["run_id"]);
      const st = await waitForRunTerminal(runId);
      expect(st, "run 应在预算内到终态").toBe("done");

      const calls = modelCalls();
      expect(calls.length - base, "两回合 = 两次模型调用").toBeGreaterThanOrEqual(2);
      // 第一轮请求：user 原文逐字节在场。
      expect(calls[base]?.messages[0]?.role).toBe("user");
      expect(userTextOf(calls[base]?.messages[0])).toBe(prompt);
      // 第二轮请求（tool 结果回喂后）：user 原文仍逐字节在场（跨轮不丢）。
      expect(calls[base + 1]?.messages[0]?.role).toBe("user");
      expect(userTextOf(calls[base + 1]?.messages[0])).toBe(prompt);
      // S05 根因面钉：无角色副会话 systemPrompt = 身份框在前、记忆注入在后
      // （AGENTS.md 降为背景参考；缺框=模型代入主智能体人格的回归现场）。
      const sys = String((calls[base] as { systemPrompt?: string }).systemPrompt ?? "");
      expect(sys.startsWith("你是 loom 副会话"), "身份框必须是 systemPrompt 第一段").toBe(true);
      expect(sys.indexOf("### memory[0] AGENTS.md")).toBeGreaterThan(0);

      const detail = await api(`/runs/${runId}`);
      const terminal = detail.json["terminal"] as Record<string, unknown> | null;
      expect(String(terminal?.["digest"])).toContain(marker);
      expect(detail.json["session_id"]).toMatch(/^ses_[0-9a-f]{16}$/);
    },
    40_000,
  );

  it(
    "run B（同引擎连发）：模型首轮携带的是 B 原文而非 A 残留（反粘滞/串台钉）",
    async () => {
      const markerB = "PROMPT-E2E-MARKER-9f8e7d6c";
      const promptB = nastyPrompt("B", markerB);
      (app.model.model as unknown as { push(...r: FakeAssistantResponse[]): void }).push(...s05Script(markerB));

      const base = modelCalls().length;
      const launched = await api("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: "w-prompt-e2e", prompt: promptB, actor: "script", trigger: "manual" }),
      });
      expect(launched.status).toBe(202);
      const runId = String(launched.json["run_id"]);
      expect(await waitForRunTerminal(runId)).toBe("done");

      const firstCall = modelCalls()[base];
      expect(firstCall?.messages[0]?.role).toBe("user");
      const got = userTextOf(firstCall?.messages[0]);
      expect(got).toBe(promptB);
      expect(got).not.toContain("PROMPT-E2E-MARKER-a1b2c3d4"); // 非前 run 粘滞
    },
    40_000,
  );
});
