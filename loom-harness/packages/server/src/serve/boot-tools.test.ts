/**
 * T31 serve 工具面接线端到端（fake-model 离线，起真树走 HTTP）。
 * Given: 临时 workspace（AGENTS.md 基础集 + memory/fact + agents/01-data-check.md 角色声明）
 *        + fake provider 配置 + LOOM_FAKE_MODEL=1
 * When:  POST /runs 派发「把指定内容写入 <workspace>/out/x.md 并收束」；
 *        fake 模型脚本按序应答 toolCall(write)→toolCall(bash)→正文+converge(done)；
 *        POST /runs 带 agent=01_data_check 再派发一个纯收束 run
 * Then:  文件真实落盘（含 bash 经 D7 单缝起真子进程写的 out/note.txt）；
 *        run 终态 done（GET /runs/:id 视图 + 账本 actual）；
 *        detail.trace 出现 stage:"tool" 的 span 行（runId=账本行）；
 *        detail.trace 出现 stage:"assembly" 的 span 行（runId=账本行，
 *        attrs.injectedLines>0 = 装配写侧硬证；带 agent 行另有 attrs.agent 取证）；
 *        主会话消息路径持有同一工具集（registry.send → fake toolCall write 落盘）；
 *        越界写在工作区咽喉/缝上被响亮拒绝（含 default-deny 无规则拒）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type FakeAssistantResponse } from "@axeuh/loom-core/testing";
import { localDateKey, type HookContext } from "@axeuh/loom-core";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import { assertCommand, SeamDeniedError } from "@axeuh/loom-tools/seam";
import type { LoomApp } from "./boot.js";

// 加载纪律（同 boot-assembly.test）：boot/tool-wiring 图必须动态 import，
// 避免 core 桶经 server 环先实例化（ConvergenceGate "is not a constructor" 稳定复现）。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
type CreateWiring = typeof import("./tool-wiring.js").createServeToolWiring;
type MakeProfile = typeof import("./tool-wiring.js").makeServeSandboxProfile;
let createLoomApp!: CreateLoomApp;
let createServeToolWiring!: CreateWiring;
let makeServeSandboxProfile!: MakeProfile;

let work = "";
let ws = "";
let skillsDir = "";
let stateRoot = "";
let app: LoomApp;
let baseUrl = "";
const bootLogs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];

const TOKEN = "tok-tools-test";
const WS_MARK = "BOOT-TOOLS-副会话产物";
const MAIN_MARK = "BOOT-TOOLS-主会话产物";

const FAKE_YAML = [
  "server:",
  "  port: 5101",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-tools",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
    "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
  "skills:",
  "  allowlist:",
  "    - SKILLS_ROOT",
  "mcp:",
  "  servers:",
  "    - name: demo",
  "      cmd: NODE_BIN",
  "      args:",
  "        - MCP_FIXTURE",
].join("\n");

// W5 实测素材（tmp 目录真扫，语义复刻 fixture-workspace/skills 三态）：
const SKILL_POEM = [
  "---",
  "name: bt-poem",
  "description: 测试微诗技能（boot-tools 专用，把素材压成一行并回哨兵）。",
  "---",
  "# bt-poem",
  "BOOT-SKILL-BODY-正文哨兵",
].join("\n");
const SKILL_TOOLKIT = [
  "---",
  "name: bt-toolkit",
  "description: 测试激活集技能：声明 tools: [read, bash]，验 O1 deferred.activated 写入。",
  "tools: [read, bash]",
  "---",
  "# bt-toolkit",
  "BOOT-TOOLKIT-BODY",
].join("\n");
const SKILL_BAD = [
  "---",
  "name: bt-bad",
  "---",
  "# bt-bad 缺 description（degrade  bait）",
].join("\n");

/** handle.model 的运行时身份 = core/testing FakeModel（push/getCalls 面）。 */
function fake(): {
  push(...resp: FakeAssistantResponse[]): void;
  reset(): void;
  getCalls(): Array<{
    systemPrompt?: string;
    tools?: Array<{ name: string }>;
    messages: Array<{ role: string; content: unknown }>;
  }>;
} {
  return app.model.model as unknown as {
    push(...resp: FakeAssistantResponse[]): void;
    reset(): void;
    getCalls(): Array<{
      systemPrompt?: string;
      tools?: Array<{ name: string }>;
      messages: Array<{ role: string; content: unknown }>;
    }>;
  };
}

async function waitFor(predicate: () => boolean, budgetMs = 20_000): Promise<boolean> {
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

function ctxStub(sessionId: string): HookContext {
  return { sessionId } as unknown as HookContext;
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  createServeToolWiring = (await import("./tool-wiring.js")).createServeToolWiring;
  makeServeSandboxProfile = (await import("./tool-wiring.js")).makeServeSandboxProfile;
  work = mkdtempSync(join(tmpdir(), "loom-boot-tools-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(join(ws, "memory", "fact"), { recursive: true });
  mkdirSync(join(ws, "agents"), { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# 工具面接线的记忆底座\nBOOT-TOOLS-稳定段\n");
  // 真 workspace 语义复刻（主会话清单 W33 起仅 AGENTS.md 单件在场；角色经 frontmatter 声明注入集）：
  // assembly span 的 attrs.injectedLines 硬证面（GET /runs/:id trace join，副会话侧不受主会话清单影响）。
  writeFileSync(join(ws, "memory", "fact", "f1.md"), "BOOT-TOOLS-FACT-注入行\n");
  writeFileSync(join(ws, "agents", "01-data-check.md"), [
    "---",
    "tags: [测试]",
    "memory: [AGENTS.md, memory/fact/**]",
    "---",
    "# BOOT-TOOLS-角色正文",
  ].join("\n"));

  // W5 skills allowlist = tmp 目录真扫（三态：正文/激活集/degrade）。
  skillsDir = join(work, "skills");
  mkdirSync(join(skillsDir, "bt-poem"), { recursive: true });
  mkdirSync(join(skillsDir, "bt-toolkit"), { recursive: true });
  mkdirSync(join(skillsDir, "bt-bad"), { recursive: true });
  writeFileSync(join(skillsDir, "bt-poem", "SKILL.md"), SKILL_POEM);
  writeFileSync(join(skillsDir, "bt-toolkit", "SKILL.md"), SKILL_TOOLKIT);
  writeFileSync(join(skillsDir, "bt-bad", "SKILL.md"), SKILL_BAD);
  const mcpFixture = fileURLToPath(
    new URL("../../../core/src/mcp/__fixtures__/fake-mcp-server.mjs", import.meta.url),
  );

  const envConfig = (yaml: string): LoomConfig => parseLoomConfig(yaml, "<test>", { env: {} });
  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws)
    .replace("SKILLS_ROOT", skillsDir)
    .replace("NODE_BIN", process.execPath)
    .replace("MCP_FIXTURE", mcpFixture);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  app = await createLoomApp({
    config: envConfig(text),
    store,
    stateRoot,
    tokens: [TOKEN],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
    log: (level, msg, fields) => {
      bootLogs.push({ level, msg, fields });
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
});

beforeEach(async () => {
  await waitFor(() => app.registry.list().every((s) => s.status === "idle"), 5_000);
  fake().reset();
});

afterAll(async () => {
  await app?.closeExtras(); // W5-B：MCP 子进程收尸（不留孤儿进 rmSync）
  await new Promise<void>((resolve) => {
    app?.server.closeAllConnections();
    app?.server.close(() => resolve());
  });
  app?.model.teardown();
  rmSync(work, { recursive: true, force: true });
});

describe("serve 工具面接线：POST /runs 副会话真干活", () => {
  it(
    "fake toolCall(write→bash)→converge：文件落盘、run done、trace 出现 tool span",
    async () => {
      fake().push(
        {
          content: [
            { type: "text", text: "按任务要求写入产物文件。" },
            { type: "toolCall", id: "bt-write", name: "write", arguments: { path: "out/x.md", content: WS_MARK } },
          ],
        },
        {
          content: [
            { type: "toolCall", id: "bt-bash", name: "bash", arguments: { command: "echo seam-note > out/note.txt" } },
          ],
        },
        {
          content: [
            { type: "text", text: "产物已落盘，收束。" },
            {
              type: "toolCall",
              id: "bt-conv",
              name: "converge",
              arguments: {
                status: "done",
                runId: "run_selfreported0001",
                workflow: "w-tools",
                attempt: 1,
                digest: "done：写入 out/x.md 与 out/note.txt",
                pointers: ["file:out/x.md", "file:out/note.txt"],
                blockers: [],
              },
            },
          ],
        },
      );

      const launched = await api("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: "w-tools", prompt: `把 ${WS_MARK} 写入 out/x.md 并收束` }),
      });
      expect(launched.status).toBe(202);
      const runId = String(launched.json["run_id"]);
      expect(runId).toMatch(/^run_[0-9a-f]{16}$/);

      const settled = await waitFor(() => ["done", "failed", "partial"].includes(String(detailStatus(runId))));
      expect(settled, "run 应在预算内到终态").toBe(true);

      const detail = await api(`/runs/${runId}`);
      expect(detail.json["status"]).toBe("done");
      const ledger = detail.json["ledger"] as Record<string, unknown>;
      const actual = ledger?.["actual"] as Record<string, unknown> | null;
      expect(actual?.["status"]).toBe("done"); // 账本盖棺与视图一致

      // 文件真实落盘（write 走 resolveToolPath 咽喉；bash 走 D7 单缝真子进程）。
      const outX = join(ws, "out", "x.md");
      expect(existsSync(outX)).toBe(true);
      expect(readFileSync(outX, "utf8")).toBe(WS_MARK);
      const note = join(ws, "out", "note.txt");
      expect(existsSync(note)).toBe(true);
      expect(readFileSync(note, "utf8")).toContain("seam-note");

      // trace join：本 run 的 tool span 行（stage:"tool"，name=write/bash，runId=账本行）。
      const spans = (detail.json["trace"] as Record<string, unknown>[]) ?? [];
      const toolSpans = spans.filter((s) => s["kind"] === "span" && s["stage"] === "tool");
      expect(toolSpans.length).toBeGreaterThanOrEqual(2);
      for (const name of ["write", "bash"]) {
        const hit = toolSpans.find((s) => s["name"] === name);
        expect(hit, `trace 应含 tool span: ${name}`).toBeDefined();
        expect(hit?.["runId"]).toBe(runId);
        const attrs = hit?.["attrs"] as Record<string, unknown>;
        expect(attrs["result"]).toBe("ok");
      }

      // 装配写侧硬证：同 runId join 出 stage:"assembly" 行，attrs.injectedLines>0
      // （副会话无角色引用 = AGENTS.md 基础集，fixture 里 2 行非空）。
      const asm = spans.filter((s) => s["kind"] === "span" && s["stage"] === "assembly");
      expect(asm.length, "trace 应含 assembly span").toBe(1);
      expect(asm[0]?.["runId"]).toBe(runId);
      expect(asm[0]?.["sessionId"]).toBe(String(detail.json["session_id"]));
      const asmAttrs = asm[0]?.["attrs"] as Record<string, unknown>;
      expect(Number(asmAttrs["injectedLines"])).toBeGreaterThanOrEqual(2);
      expect(asmAttrs["result"]).toBe("ok");
      expect(asmAttrs["workflow"]).toBe("w-tools");
      expect("agent" in asmAttrs).toBe(false); // 无角色引用不留 agent 字段（不猜）
      expect(Number(asm[0]?.["assemblyRowCount"])).toBe(1); // AGENTS.md 基础集 = 1 源

      // W5-A 副会话 catalog 硬证：side port 挂 skills hook 后，发给模型的
      // systemPrompt 含 "## Available skills"（仅 name+description，绝无正文哨兵）。
      const sideCtx = fake().getCalls()[0];
      expect(sideCtx?.systemPrompt ?? "").toContain("## Available skills");
      expect(sideCtx?.systemPrompt ?? "").toContain("bt-poem:");
      expect(sideCtx?.systemPrompt ?? "").not.toContain("BOOT-SKILL-BODY");
      expect(sideCtx?.systemPrompt ?? "").not.toContain("bt-bad");
      // 副会话工具面 = 同一缝数组：skill 与 mcp 映射工具必须在发模型的 tools 里。
      const sideToolNames = (sideCtx?.tools ?? []).map((t) => t.name);
      expect(sideToolNames).toContain("skill");
      expect(sideToolNames).toContain("mcp_demo_send_notification");
    },
    30_000,
  );

  it(
    "POST /runs 带 agent：assembly span 的 injectedLines 含角色声明的 memory/fact 注入（真 workspace 语义）",
    async () => {
      fake().push({
        content: [
          { type: "text", text: "按角色职责一句话概述，收束。" },
          {
            type: "toolCall",
            id: "bt-conv-agent",
            name: "converge",
            arguments: {
              status: "done",
              runId: "run_selfreported0002",
              workflow: "w-agent",
              attempt: 1,
              digest: "done：角色视角一句话概述",
              pointers: [],
              blockers: [],
            },
          },
        ],
      });

      const launched = await api("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: "w-agent",
          prompt: "按你的角色职责一句话概述并收束",
          agent: "01_data_check", // 引用形照 fleet 漂移4：sanitizeType 后下划线名
        }),
      });
      expect(launched.status).toBe(202);
      const runId = String(launched.json["run_id"]);

      const settled = await waitFor(() => ["done", "failed", "partial"].includes(String(detailStatus(runId))));
      expect(settled, "run 应在预算内到终态").toBe(true);

      const detail = await api(`/runs/${runId}`);
      expect(detail.json["status"]).toBe("done");
      const spans = (detail.json["trace"] as Record<string, unknown>[]) ?? [];
      const asm = spans.filter((s) => s["kind"] === "span" && s["stage"] === "assembly");
      expect(asm.length).toBe(1);
      expect(asm[0]?.["runId"]).toBe(runId);
      const asmAttrs = asm[0]?.["attrs"] as Record<string, unknown>;
      expect(asmAttrs["agent"]).toBe("01_data_check");
      expect(asmAttrs["workflow"]).toBe("w-agent");
      // AGENTS.md(2 行) + memory/fact/f1.md(1 行)：注入清单行数直取 memorySources 内容。
      expect(Number(asmAttrs["injectedLines"])).toBeGreaterThanOrEqual(3);
      expect(Number(asm[0]?.["assemblyRowCount"])).toBe(2);
    },
    30_000,
  );
});

describe("serve 工具面接线：主会话同一缝", () => {
  it("registry.send：fake toolCall(write) 落盘主会话产物（同一工具集、同一边界）", async () => {
    expect(app.tools.map((t) => t.name).sort()).toEqual(
      [
        "bash", "compact_context", "edit", "find", "grep", "ls", "read", "task", "task_fetch", "task_cancel", "todowrite", "write",
        // pty 五件套：缺省启用，与其余工具同一缝面。
        "pty_spawn", "pty_write", "pty_read", "pty_list", "pty_kill",
        // W5 两线：skill 工具 + MCP 映射工具（mcp_<server>_<tool> 命名）进同一缝面。
        "skill", "mcp_demo_send_notification", "mcp_demo_tts_speak",
      ].sort(),
    );
    fake().push(
      {
        content: [
          { type: "toolCall", id: "bt-main", name: "write", arguments: { path: "out/main-note.md", content: MAIN_MARK } },
        ],
      },
      { content: [{ type: "text", text: "已写入。" }] },
    );
    const rec = app.registry.create();
    app.registry.send(rec.sessionID, `把 ${MAIN_MARK} 写入 out/main-note.md`);
    const settled = await waitFor(() => app.registry.get(rec.sessionID)?.running === null);
    expect(settled, "主会话轮应在预算内收尾").toBe(true);
    const status = app.registry.statusView(rec.sessionID);
    expect(status?.status).toBe("idle");

    const file = join(ws, "out", "main-note.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(MAIN_MARK);
  }, 30_000);
});

describe("serve 工具面接线：主派副（task 派发子会话，摘要回灌 + trace 子 run 取证）", () => {
  const TASK_MARK = "BOOT-TASK-子会话摘要";
  const MAIN_TASK_MARK = "BOOT-TASK-主会话派出的子摘要";

  it(
    "POST /runs：父 turn1 task(explore) → 子会话产摘要 → 父 toolResult 见摘要+<task_metadata> 再收束；trace 落 task 与 task.subagent start/end 行（runId join）",
    async () => {
      fake().push(
        {
          content: [
            {
              type: "toolCall",
              id: "bt-task-parent1",
              name: "task",
              arguments: { agent_type: "explore", task: "读 AGENTS.md 并一句话总结" },
            },
          ],
        },
        { content: [{ type: "text", text: TASK_MARK }] },
        {
          content: [
            { type: "text", text: "子会话已返回摘要，收束。" },
            {
              type: "toolCall",
              id: "bt-conv-task",
              name: "converge",
              arguments: {
                status: "done",
                runId: "run_selfreported0003",
                workflow: "w-task",
                attempt: 1,
                digest: "done：已收到子会话摘要",
                pointers: [],
                blockers: [],
              },
            },
          ],
        },
      );

      const launched = await api("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: "w-task", prompt: `派一个探索子会话总结 AGENTS.md，据其摘要收束` }),
      });
      expect(launched.status).toBe(202);
      const runId = String(launched.json["run_id"]);
      const settled = await waitFor(() => ["done", "failed", "partial"].includes(String(detailStatus(runId))));
      expect(settled, "主派副 run 应在预算内到终态").toBe(true);

      const detail = await api(`/runs/${runId}`);
      expect(detail.json["status"]).toBe("done");

      // 回灌硬证：父会话的请求上下文里，task 的 toolResult 同时带子摘要与字面元数据块。
      const refluxed = fake().getCalls().some((c) =>
        c.messages.some((m) => {
          if (m.role !== "toolResult") return false;
          const text = JSON.stringify(m.content);
          return text.includes(TASK_MARK) && text.includes("<task_metadata>") && /ses_[0-9a-f]{16}/.test(text);
        }),
      );
      expect(refluxed, "子会话摘要必须以 toolResult 形态回灌父会话").toBe(true);

      // trace 取证：task tool span（派发本体）+ task.subagent start/end 两行（子 run），
      // runId join 到本 run（GET /runs/:id 的 trace 视图即真源文件行）。
      const spans = (detail.json["trace"] as Record<string, unknown>[]) ?? [];
      const taskSpans = spans.filter((s) => s["kind"] === "span" && s["stage"] === "tool" && s["name"] === "task");
      expect(taskSpans).toHaveLength(1);
      expect(taskSpans[0]?.["runId"]).toBe(runId);
      expect((taskSpans[0]?.["attrs"] as Record<string, unknown>)["result"]).toBe("ok");

      const subSpans = spans.filter((s) => s["name"] === "task.subagent") as Record<string, any>[];
      const startRow = subSpans.find((s) => s["attrs"]?.["phase"] === "start");
      const endRow = subSpans.find((s) => s["attrs"]?.["phase"] === "end");
      expect(startRow, "trace 应有子派发 start 行").toBeDefined();
      expect(endRow, "trace 应有子派发 end 行").toBeDefined();
      for (const row of [startRow!, endRow!]) {
        expect(row["runId"]).toBe(runId);
        expect(String(row["attrs"]["agentId"])).toMatch(/^ses_[0-9a-f]{16}$/);
        expect(row["attrs"]["depth"]).toBe(1);
      }
      expect(endRow!["attrs"]["reason"]).toBe("done");
      expect(endRow!["attrs"]["turns"]).toBe(1);
      expect(Number(endRow!["attrs"]["summaryLen"])).toBeGreaterThan(TASK_MARK.length - 1);
    },
    30_000,
  );

  it(
    "主会话 registry.send 派子：toolResult 进主会话 messages（摘要+元数据），trace 落主会话 task.subagent 行",
    async () => {
      fake().push(
        {
          content: [
            {
              type: "toolCall",
              id: "bt-main-task",
              name: "task",
              arguments: { agent_type: "general", task: "给一句话结论" },
            },
          ],
        },
        { content: [{ type: "text", text: MAIN_TASK_MARK }] },
        { content: [{ type: "text", text: "子会话已返回，主会话收口。" }] },
      );
      const rec = app.registry.create();
      app.registry.send(rec.sessionID, "用 task 派一个子智能体拿结论");
      const settled = await waitFor(() => app.registry.get(rec.sessionID)?.running === null);
      expect(settled, "主派副轮应在预算内收尾").toBe(true);
      expect(app.registry.statusView(rec.sessionID)?.status).toBe("idle");

      const tr = rec.loop!.session.messages.filter((m) => m.role === "toolResult");
      const text = JSON.stringify(tr.map((m) => (m as { content: unknown }).content));
      expect(tr.length).toBeGreaterThanOrEqual(1);
      expect(text).toContain(MAIN_TASK_MARK);
      expect(text).toContain("<task_metadata>");
      expect(text).toMatch(/ses_[0-9a-f]{16}/);

      // 主会话侧 trace：伪 runId 无妨，sessionId=主会话 sid 可取证（与 assembly span 同处置）。
      const traceFile = join(stateRoot, "trace", `${localDateKey(Date.now())}.jsonl`);
      const rows = readFileSync(traceFile, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, any>);
      const mine = rows.filter(
        (r) => r["name"] === "task.subagent" && r["sessionId"] === rec.sessionID,
      );
      expect(mine.length, "主会话应有 start+end 两行 subagent span").toBeGreaterThanOrEqual(2);
      expect(mine.some((r) => r["attrs"]["phase"] === "start")).toBe(true);
      expect(mine.some((r) => r["attrs"]["phase"] === "end" && r["attrs"]["reason"] === "done")).toBe(true);
    },
    30_000,
  );
});

describe("serve W6：副会话起点深链（副(0)→子(1)→孙(2)）与 cancel 副→子一跳", () => {
  const GC_MARK = "W6-GC-孙级产物";
  const CHILD_RELAY = "W6-CHILD-中继";

  it(
    "POST /runs：父 turn1 task → 子 turn1 task → 孙文本收尾 → 子中继 → 父 converge done；trace 两对 depth=1/2 的 task.subagent 行（runId join），账本 digest 含孙摘要",
    async () => {
      // 共享 fake 队列 = 严格串链消费序（父→子→孙→子→父），无并发分支。
      fake().push(
        {
          content: [
            {
              type: "toolCall",
              id: "w6-parent-t1",
              name: "task",
              arguments: { agent_type: "explore", task: "再派一个 general 子智能体产一个标记" },
            },
          ],
        },
        {
          content: [
            {
              type: "toolCall",
              id: "w6-child-t1",
              name: "task",
              arguments: { agent_type: "general", task: "产一个孙级标记文本" },
            },
          ],
        },
        { content: [{ type: "text", text: GC_MARK }] },
        { content: [{ type: "text", text: `${CHILD_RELAY}：${GC_MARK}` }] },
        {
          content: [
            { type: "text", text: "孙级产物已沿链回传，收束。" },
            {
              type: "toolCall",
              id: "w6-conv",
              name: "converge",
              arguments: {
                status: "done",
                runId: "run_selfreported0006",
                workflow: "w6-depth",
                attempt: 1,
                digest: `done：子中继「${CHILD_RELAY}」且孙原文「${GC_MARK}」两代摘要均在父 toolResult`,
                pointers: [],
                blockers: [],
              },
            },
          ],
        },
      );

      const launched = await api("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: "w6-depth", prompt: "派子，子再派孙，把两代摘要都带回收束" }),
      });
      expect(launched.status).toBe(202);
      const runId = String(launched.json["run_id"]);
      const settled = await waitFor(() => ["done", "failed", "partial"].includes(String(detailStatus(runId))));
      expect(settled, "三代深链应在预算内到终态").toBe(true);

      const detail = await api(`/runs/${runId}`);
      expect(detail.json["status"]).toBe("done");
      // 盖棺 digest（账本 join 视图的 terminal 真源）必须含两代摘要原文——
      // 说≠做：digest 由脚本父模型填入，只有回灌真实存在它才可能含 GC 标记。
      const terminal = detail.json["terminal"] as Record<string, unknown>;
      expect(JSON.stringify(terminal)).toContain(GC_MARK);
      expect(JSON.stringify(terminal)).toContain(CHILD_RELAY);

      const spans = (detail.json["trace"] as Record<string, unknown>[]) ?? [];
      const sub = spans.filter((s) => s["name"] === "task.subagent") as Record<string, any>[];
      const starts = sub.filter((s) => s["attrs"]?.["phase"] === "start");
      const ends = sub.filter((s) => s["attrs"]?.["phase"] === "end");
      // runId join 面 = 父 run 直派一层（depth=1 对）；嵌套层观测面按既有设计挂父会话身份，
      // 孙级行按「sessionId=子会话 id（= depth=1 行的 agentId）」直读 trace 文件取证。
      expect(starts.map((s) => s["attrs"]["depth"])).toEqual([1]);
      expect(ends.map((s) => s["attrs"]["depth"])).toEqual([1]);
      for (const row of [...starts, ...ends]) {
        expect(row["runId"], "父直派行必须 join 本 run").toBe(runId);
      }
      expect(ends[0]!["attrs"]["reason"]).toBe("done");

      const childAgentId = String(ends[0]!["attrs"]["agentId"]);
      expect(childAgentId).toMatch(/^ses_[0-9a-f]{16}$/);
      const traceFile = join(stateRoot, "trace", `${localDateKey(Date.now())}.jsonl`);
      const gcRows = readFileSync(traceFile, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, any>)
        .filter((r) => r["name"] === "task.subagent" && r["sessionId"] === childAgentId);
      const gcStarts = gcRows.filter((r) => r["attrs"]?.["phase"] === "start");
      const gcEnds = gcRows.filter((r) => r["attrs"]?.["phase"] === "end");
      expect(gcStarts.map((r) => r["attrs"]["depth"])).toEqual([2]);
      expect(gcEnds.map((r) => r["attrs"]["depth"])).toEqual([2]);
      expect(gcEnds[0]!["attrs"]["reason"]).toBe("done");
      expect(String(gcEnds[0]!["attrs"]["agentId"])).toMatch(/^ses_[0-9a-f]{16}$/);
      // 孙级行以父（=子会话）身份登记，runId 为观测伪号（与主会话路径同处置，属预期非缺陷）。
      expect(String(gcStarts[0]!["runId"])).toMatch(/^run_[0-9a-f]{16}$/);
      // 父侧 task span（派发本体）result=ok。
      const taskSpans = spans.filter((s) => s["stage"] === "tool" && s["name"] === "task" && s["runId"] === runId);
      expect(taskSpans.length).toBeGreaterThanOrEqual(1);
      expect((taskSpans[0] as Record<string, any>)["attrs"]["result"]).toBe("ok");

      // 回灌硬证：孙级元数据 depth=2 进过子的上下文；父 toolResult 带 depth=1 中继文本。
      const allTr = fake()
        .getCalls()
        .flatMap((c) => c.messages)
        .filter((m) => m.role === "toolResult")
        .map((m) => JSON.stringify(m.content));
      expect(allTr.some((t) => t.includes(GC_MARK) && t.includes("depth: 2"))).toBe(true);
      expect(allTr.some((t) => t.includes(CHILD_RELAY) && t.includes("depth: 1"))).toBe(true);
    },
    40_000,
  );

  it(
    "热载 maxDepth：派发时刻现读——在飞子会话深度已到热改后的闸（2→1）时其再派被挡，改回即刻可派（serve 面 limits 与 core 同实例语义）",
    async () => {
      const wiring = await createServeToolWiring({
        workspaceRoot: ws,
        stateRoot,
        model: app.model.model,
        llmOptions: app.model.llmOptions,
      });
      expect(wiring.subagentLimits.maxDepth).toBe(2); // 装配缺省
      const sig = new AbortController().signal;

      // 合成 depth=2 现场（与 core「直接 execute」同技法：真 ctx + state 注入）。
      const { ctx } = createTestContext();
      ctx.state.set("subAgent.depth", 2);
      const task = wiring.tools.find((t) => t.name === "task");
      expect(task).toBeDefined();
      await expect(
        task!.execute({ agent_type: "general", task: "x" }, ctx, sig),
      ).rejects.toThrow(/depth limit \(maxDepth=2\) reached/);

      wiring.subagentLimits.maxDepth = 3; // 热载：同一可变对象改字段
      const r = await task!.execute({ agent_type: "general", task: "y" }, ctx, sig);
      const text = JSON.stringify(r.content);
      expect(text).toContain("<task_metadata>"); // depth 2 < 3 → 放行，真派发
    },
    40_000,
  );

  /**
   * W40 后台 deadline 接线钉（工单口径=最小诚实测试，不重复机制覆盖）：
   * Given: createServeToolWiring 双路——声明 subagentBackgroundDeadlineSeconds: 40 / 键缺席。
   *  When:  装配完成，读 wiring.subagentLimits（= createTaskTool limits 位的同一可变实例）。
   * Then:  声明路 backgroundDeadlineMs=40000（秒×1000 换算+写进同一对象）；
   *         缺省路字段不物化（undefined-honest，core 派发时刻 ?? 兜 15min）。
   * 计时器到点收口（failed+cancelRequested=deadline）与"派发时刻现读同一实例"的语义
   * 已由 core task-background.test.ts「deadline 热载（注入 40ms）」用例 + 上方 maxDepth
   * 热载测试钉死；本片 server 面只钉 config→opts→limits 字段这条接线，机制面不重复。
   */
  it(
    "W40 接线：subagentBackgroundDeadlineSeconds=40 → subagentLimits.backgroundDeadlineMs=40000；键缺席=字段不物化",
    async () => {
      const wiring = await createServeToolWiring({
        workspaceRoot: ws,
        stateRoot,
        model: app.model.model,
        llmOptions: app.model.llmOptions,
        subagentBackgroundDeadlineSeconds: 40,
      });
      expect(wiring.subagentLimits.backgroundDeadlineMs).toBe(40_000);
      const plain = await createServeToolWiring({
        workspaceRoot: ws,
        stateRoot,
        model: app.model.model,
        llmOptions: app.model.llmOptions,
      });
      expect("backgroundDeadlineMs" in plain.subagentLimits).toBe(false);
    },
    20_000,
  );

  /**
   * W42c 派发闸三键接线钉（W40 同款最小诚实测试）：
   * Given: createServeToolWiring 双路——声明 subagentMaxFanout/MaxDepth/MaxInflightTotal / 三键缺席。
   *  When: 装配完成，读 wiring.subagentLimits（= createTaskTool limits 位的同一可变实例）。
   * Then: 声明路三字段=声明值（覆写 8/2 + 可选字段物化 32）；
   *        缺省路 maxFanout/maxDepth 保 DEFAULT_SUBAGENT_LIMITS 冻结值 8/2（必给字段覆写语义），
   *        maxInflightTotal 字段不物化（undefined-honest，core 派发时刻 ?? 兜 16）。
   * 横/纵/总量闸到点裁决与"派发时刻现读同一实例"机制由 core task-tool 既有测试钉死；
   * 本面只钉 config→opts→limits 字段这条接线。
   */
  it(
    "W42c 接线：subagentMaxFanout/MaxDepth/MaxInflightTotal 声明 → 同一可变 subagentLimits 覆写/物化",
    async () => {
      const wiring = await createServeToolWiring({
        workspaceRoot: ws,
        stateRoot,
        model: app.model.model,
        llmOptions: app.model.llmOptions,
        subagentMaxFanout: 5,
        subagentMaxDepth: 3,
        subagentMaxInflightTotal: 32,
      });
      expect(wiring.subagentLimits.maxFanout).toBe(5);
      expect(wiring.subagentLimits.maxDepth).toBe(3);
      expect(wiring.subagentLimits.maxInflightTotal).toBe(32);
    },
    20_000,
  );

  it(
    "W42c 缺省：三键缺席 → maxFanout/maxDepth 保冻结值 8/2、maxInflightTotal 字段不物化",
    async () => {
      const plain = await createServeToolWiring({
        workspaceRoot: ws,
        stateRoot,
        model: app.model.model,
        llmOptions: app.model.llmOptions,
      });
      expect(plain.subagentLimits.maxFanout).toBe(8);
      expect(plain.subagentLimits.maxDepth).toBe(2);
      expect("maxInflightTotal" in plain.subagentLimits).toBe(false);
    },
    20_000,
  );

  /**
   * subagentMaxTurns 接线钉（3 轮封顶=最小诚实证据；生产 150 值另验，此处不跑大轮数）：
   * Given: createServeToolWiring({ subagentMaxTurns: 3 }) + fake 队列连压 3 条 toolCall(ls)。
   *  When:  直接 execute task（general）——子每轮都以 toolCall 续命，绝不自终止。
   * Then:  第 3 轮末内核按 maxTurns 封顶：task_metadata reason=max_turns / turns: 3。
   *        该有效值同时进 task 默认子路径与 childSessionFactory；键缺席回 SERVE_SUB_MAX_TURNS=50。
   */
  it(
    "subagentMaxTurns=3：真子会话 3 轮封顶 → task_metadata reason=max_turns / turns: 3",
    async () => {
      const wiring = await createServeToolWiring({
        workspaceRoot: ws,
        stateRoot,
        model: app.model.model,
        llmOptions: app.model.llmOptions,
        subagentMaxTurns: 3,
      });
      const { ctx } = createTestContext();
      const sig = new AbortController().signal;
      try {
        fake().push(
          { content: [{ type: "toolCall", id: "w59-t1", name: "ls", arguments: { path: "." } }] },
          { content: [{ type: "toolCall", id: "w59-t2", name: "ls", arguments: { path: "." } }] },
          { content: [{ type: "toolCall", id: "w59-t3", name: "ls", arguments: { path: "." } }] },
        );
        const task = wiring.tools.find((t) => t.name === "task");
        expect(task).toBeDefined();
        const r = await task!.execute(
          { agent_type: "general", task: "连续三轮 ls 空转，不要收束" },
          ctx,
          sig,
        );
        const text = JSON.stringify(r.content);
        expect(text).toContain("<task_metadata>");
        expect(text).toContain("reason: max_turns");
        expect(text).toContain("turns: 3");
      } finally {
        fake().reset(); // 共享 fake：清残留脚本与调用账，避免污染后续用例
      }
    },
    20_000,
  );

  it(
    "POST /runs 在飞 cancel：父 task 已派发、子挂 6s 模型延迟——cancel → 子当轮 aborted、end 行 reason=aborted（runId join）、终态 failed + cancel_requested 置位",
    async () => {
      fake().push(
        {
          content: [
            {
              type: "toolCall",
              id: "w6c-parent-t1",
              name: "task",
              arguments: { agent_type: "explore", task: "长任务：只回一个字" },
            },
          ],
        },
        // 子在飞硬证：delayMs 挂模型侧 6s；signal abort 后 kernel 于响应落地即转终
        // （abort 检查先于工具执行，ls 永不落地）——绝不靠时序运气。
        { delayMs: 6000, content: [{ type: "toolCall", id: "w6c-child-t1", name: "ls", arguments: { path: "." } }] },
      );

      const launched = await api("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: "w6-cancel", prompt: "派一个子智能体干活，据其结果收束" }),
      });
      expect(launched.status).toBe(202);
      const runId = String(launched.json["run_id"]);

      // cancel 必须命中 running 窗口（引擎契约）：先等子派发 start 行落盘再开枪。
      const traceFile = join(stateRoot, "trace", `${localDateKey(Date.now())}.jsonl`);
      const startSeen = await waitFor(() => {
        try {
          return readFileSync(traceFile, "utf8").includes(`"runId":"${runId}"`)
            && readFileSync(traceFile, "utf8").includes('"task.subagent"');
        } catch {
          return false;
        }
      }, 5_000);
      expect(startSeen, "cancel 前应见 task.subagent start 行（子已派发）").toBe(true);
      expect(detailStatus(runId)).toBe("running");

      const cancelled = await api(`/runs/${runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "w6-cancel-test" }),
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.json["accepted"]).toBe(true);

      const settled = await waitFor(() => ["done", "failed", "partial"].includes(String(detailStatus(runId))), 20_000);
      expect(settled, "取消后 run 应在预算内盖棺").toBe(true);

      const detail = await api(`/runs/${runId}`);
      expect(detail.json["status"]).toBe("failed");
      expect(detail.json["cancel_requested"]).toBe("w6-cancel-test");

      const spans = (detail.json["trace"] as Record<string, unknown>[]) ?? [];
      const ends = spans.filter(
        (s) => s["name"] === "task.subagent" && (s as Record<string, any>)["attrs"]?.["phase"] === "end",
      ) as Record<string, any>[];
      expect(ends.length, "取消轮也必有 end 行（Start↔End 配对，不留悬挂子）").toBeGreaterThanOrEqual(1);
      expect(ends[0]!["attrs"]["reason"]).toBe("aborted");
      expect(ends[0]!["runId"]).toBe(runId);
    },
    40_000,
  );
});

describe("serve 工具面接线：越界与 default-deny 响亮拒绝", () => {
  it("文件咽喉拒绝工作区外路径（绝对/相对 ../）", async () => {
    const write = app.tools.find((t) => t.name === "write");
    expect(write).toBeDefined();
    const outside = join(work, "escape-abs.md");
    await expect(write!.execute({ path: outside, content: "x" }, ctxStub("ses_boundary"), new AbortController().signal)).rejects.toThrow(
      /escapes cwd/,
    );
    await expect(
      write!.execute({ path: "../escape-rel.md", content: "x" }, ctxStub("ses_boundary"), new AbortController().signal),
    ).rejects.toThrow(/escapes cwd/);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(ws, "..", "escape-rel.md"))).toBe(false);
  });

  it("W36 缝本体：显式 sandbox{net:deny,deny:旧内置全表} 下 cwd 越界/黑名单/net deny/无规则命中一律 SeamDeniedError（机制钉，配置驱动）", async () => {
    // W36 旧钉翻新：本条钉的是"拒绝引擎机制"本身——旧内置面（net:deny + 21 条前缀表）
    // 已按用户 2026-10-14 决策移出缺省、改由 config 声明才生效；故此处显式给旧内置全表
    // 等价 sandbox 配置，机制断言逐条保真，只是触发条件由内置默认变显式声明。
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: app.model.model,
      llmOptions: app.model.llmOptions,
      sandbox: {
        net: "deny",
        deny: [
          "sudo", "su", "shutdown", "reboot", "halt", "poweroff", "mkfs",
          "dd", "mount", "umount", "kill", "pkill", "killall", "systemctl", "service",
          "crontab", "nsenter", "docker", "podman", "chown", "git push",
        ],
      },
    });
    const sig = new AbortController().signal;

    // 正例：工作区内 echo 真跑（缝放行）。
    const ok = await wiring.executor.exec("echo seam-ok", wiring.workspaceReal, undefined, 10, []);
    expect(ok.exitCode).toBe(0);

    // cwd 越界 → sandbox 断言拒。
    await expect(wiring.executor.exec("echo hi", work, undefined, 10, [])).rejects.toBeInstanceOf(SeamDeniedError);
    // 显式黑名单前缀（sudo）→ 拒。
    await expect(wiring.executor.exec("sudo ls", wiring.workspaceReal, undefined, 10, [])).rejects.toBeInstanceOf(SeamDeniedError);
    // 显式 net:"deny"（curl 首词）→ 拒。
    await expect(
      wiring.executor.exec("curl http://example.invalid", wiring.workspaceReal, undefined, 10, []),
    ).rejects.toBeInstanceOf(SeamDeniedError);
    // default-deny：未知工具名无规则命中 → permission 拒。
    const permErr = await wiring
      .executor.exec("echo hi", wiring.workspaceReal, undefined, 10, [], { tool: "mystery" })
      .catch((e: unknown) => e);
    expect(permErr).toBeInstanceOf(SeamDeniedError);
    expect((permErr as SeamDeniedError).kind).toBe("permission");

    // bash 工具面（经缝）：拒绝以异常上浮，kernel 侧转 isError——这里直调断言抛。
    const bash = wiring.tools.find((t) => t.name === "bash");
    expect(bash).toBeDefined();
    await expect(bash!.execute({ command: "sudo reboot" }, ctxStub("ses_boundary"), sig)).rejects.toBeInstanceOf(SeamDeniedError);

    const audit = wiring.seamAudit();
    expect(audit.some((e) => e.verdict === "allow")).toBe(true);
    expect(audit.filter((e) => e.verdict === "deny").length).toBeGreaterThanOrEqual(4);
  });

  it("W4 bashShell 注入链：createServeToolWiring({bashShell}) → 缝内真进程吃到指定 shell（POSIX bashism）", async () => {
    if (process.platform === "win32") return; // win32 组装口径由 seam 纯函数测钉死
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: app.model.model,
      llmOptions: app.model.llmOptions,
      bashShell: { program: "/bin/bash", args: ["-c"] },
    });
    const r = await wiring.executor.exec('[[ -n "$BASH_VERSION" ]] && echo BASH-SHELL-OK', wiring.workspaceReal, undefined, 10, []);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("BASH-SHELL-OK");
    // bash 工具面同链生效（asBashOperations → 同一 runner）。
    const bash = wiring.tools.find((t) => t.name === "bash");
    expect(bash).toBeDefined();
    const viaTool = await bash!.execute(
      { command: 'echo "v=$BASH_VERSION"' },
      ctxStub("ses_w4_shell"),
      new AbortController().signal,
    );
    expect(JSON.stringify(viaTool.content)).toMatch(/v=\d/);
  });

  it("坏 workspace 装配响亮失败（不静默降级）", async () => {
    await expect(
      createServeToolWiring({
        workspaceRoot: join(work, "no-such-dir"),
        stateRoot,
        model: app.model.model,
        llmOptions: app.model.llmOptions,
      }),
    ).rejects.toThrow(/workspace 根不可解析/);
  });
});

describe("serve W36 沙箱配置驱动：拒绝引擎默认空转 + 围栏 strict 缺省", () => {
  it("W36 makeServeSandboxProfile(undefined) = 新缺省面：net allow + deny 空 + fs 空（旧内置表已移出缺省）", () => {
    const p = makeServeSandboxProfile(undefined);
    expect(p.net).toBe("allow");
    expect(p.deny).toEqual([]);
    expect(p.cmd_allow).toEqual([]);
    expect(p.fs).toEqual({ read: [], write: [] });
  });

  it("W36 makeServeSandboxProfile 显式 net/deny 逐值入档案（含旧内置表等价配置）", () => {
    const p = makeServeSandboxProfile({ net: "deny", deny: ["sudo", "git push"] });
    expect(p.net).toBe("deny");
    expect(p.deny).toEqual(["sudo", "git push"]);
  });

  it("W36 缺省 net allow：curl 命令过引擎不拒；deny 空：sudo 过引擎不拒（引擎默认空转）", async () => {
    const p = makeServeSandboxProfile(undefined);
    expect(() => assertCommand("curl http://example.invalid", p)).not.toThrow();
    expect(() => assertCommand("sudo ls", p)).not.toThrow();
    // 真缝端到端：缺省配置的 wiring 下 curl 过沙箱断言真执行（--version 无外联）；
    // 若被引擎拒会抛 SeamDeniedError，此处 exitCode 非 null 即证走完 runner。
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: app.model.model,
      llmOptions: app.model.llmOptions,
    });
    const r = await wiring.executor.exec("curl --version", wiring.workspaceReal, undefined, 10, []);
    expect(r.exitCode).not.toBeNull();
  });

  it("W36 显式 deny 前缀：sudo 命中即拒；显式 net deny：curl 首词命中即拒", () => {
    const p = makeServeSandboxProfile({ net: "deny", deny: ["sudo"] });
    expect(() => assertCommand("sudo ls", p)).toThrow(SeamDeniedError);
    expect(() => assertCommand("curl http://example.invalid", p)).toThrow(SeamDeniedError);
    expect(() => assertCommand("echo ok", p)).not.toThrow();
  });

  it("W36 containment 缺省 strict：文件工具写工作区外仍被 realpath 围栏拒（escapes cwd）", async () => {
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: app.model.model,
      llmOptions: app.model.llmOptions,
    });
    const write = wiring.tools.find((t) => t.name === "write");
    expect(write).toBeDefined();
    const outside = join(work, "w36-strict-out.md");
    await expect(
      write!.execute({ path: outside, content: "x" }, ctxStub("ses_w36_strict"), new AbortController().signal),
    ).rejects.toThrow(/escapes cwd/);
    expect(existsSync(outside)).toBe(false);
  });

  it("W36 containment off：文件工具可写工作区外绝对路径（围栏关）", async () => {
    const wiring = await createServeToolWiring({
      workspaceRoot: ws,
      stateRoot,
      model: app.model.model,
      llmOptions: app.model.llmOptions,
      sandbox: { containment: "off" },
    });
    const write = wiring.tools.find((t) => t.name === "write");
    expect(write).toBeDefined();
    const outside = join(work, "w36-off-out.md");
    await write!.execute({ path: outside, content: "W36-CONTAINMENT-OFF" }, ctxStub("ses_w36_off"), new AbortController().signal);
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("W36-CONTAINMENT-OFF");
    rmSync(outside, { force: true });
  });
});

describe("serve W5 两线：skills 装配结局 + 直调硬证（tmp allowlist 真扫）", () => {
  it("loader 结局：3 扫 2 有效 1 degrade，degrade 走 warn 留痕且带坏因", () => {
    expect(app.skillsWiring, "loom.yaml 有 skills 段 → wiring 必在").toBeDefined();
    const names = app.skillsWiring!.entries.map((e) => e.name).sort();
    expect(names).toEqual(["bt-poem", "bt-toolkit"]);
    expect(app.skillsWiring!.degraded).toHaveLength(1);
    const bad = app.skillsWiring!.degraded[0]!;
    expect(bad.file).toContain("bt-bad");
    expect(bad.reason).toContain("缺少 description");

    const degradeLog = bootLogs.find((l) => l.msg === "loom skills degrade");
    expect(degradeLog, "degrade 必须落 warn 观测面（journalctl 可查）").toBeDefined();
    expect(degradeLog!.level).toBe("warn");
    expect(String(degradeLog!.fields["reason"])).toContain("缺少 description");
  });

  it("skill 工具直调：正文懒读回灌 + frontmatter tools 进 O1 激活集（deferred.activated）", async () => {
    const skillTool = app.tools.find((t) => t.name === "skill");
    expect(skillTool).toBeDefined();
    const sig = new AbortController().signal;

    const { ctx: poemCtx } = createTestContext();
    const poem = await skillTool!.execute({ name: "bt-poem" }, poemCtx, sig);
    const poemText = (poem.content[0] as { text: string }).text;
    expect(poemText).toContain("BOOT-SKILL-BODY"); // 正文懒读（扫描期零驻留，invoke 才进内存）
    expect(poemText).not.toContain("activated tools"); // 未声明 tools 不写激活集

    const { ctx: kitCtx } = createTestContext();
    const kit = await skillTool!.execute({ name: "bt-toolkit" }, kitCtx, sig);
    const kitText = (kit.content[0] as { text: string }).text;
    expect(kitText).toContain("BOOT-TOOLKIT-BODY");
    expect(kitText).toContain("activated tools: read, bash"); // O1 哨兵行
    const activated = (kitCtx.state as unknown as Map<string, Set<string>>).get("deferred.activated");
    expect(activated, "skill tools 声明必须写进 deferred.activated 激活集").toBeDefined();
    expect([...activated!.values()].sort()).toEqual(["bash", "read"]);
  });

  it("主会话 registry.send：发模型 systemPrompt 含 catalog（name+description、绝不含正文）", async () => {
    fake().push({ content: [{ type: "text", text: "收到。" }] });
    const rec = app.registry.create();
    app.registry.send(rec.sessionID, "只回一个字");
    const settled = await waitFor(() => app.registry.get(rec.sessionID)?.running === null);
    expect(settled).toBe(true);
    const mainCtx = fake().getCalls().slice(-1)[0];
    expect(mainCtx?.systemPrompt ?? "").toContain("## Available skills");
    expect(mainCtx?.systemPrompt ?? "").toContain("bt-toolkit:");
    expect(mainCtx?.systemPrompt ?? "").not.toContain("BOOT-TOOLKIT-BODY");
  }, 30_000);
});

describe("serve W5 两线：MCP 映射工具实调 + trace 包痕", () => {
  it("mcp_demo_send_notification 实调回声，且 tool span 已包痕落 trace（extraTools 同批 wrapAll）", async () => {
    expect(app.mcpWiring.statuses[0]?.ok).toBe(true);
    expect(app.mcpWiring.statuses[0]?.serverInfoName).toBe("fake-ai-mcp");

    const notify = app.tools.find((t) => t.name === "mcp_demo_send_notification");
    expect(notify).toBeDefined();
    const res = await notify!.execute(
      { title: "boot-e2e", content: "副线程回声" },
      ctxStub("ses_w5_mcp"),
      new AbortController().signal,
    );
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toContain("通知已发送: boot-e2e");

    const traceFile = join(stateRoot, "trace", `${localDateKey(Date.now())}.jsonl`);
    const rows = readFileSync(traceFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const span = rows.find(
      (r) => r["name"] === "mcp_demo_send_notification" && r["sessionId"] === "ses_w5_mcp",
    );
    expect(span, "MCP 映射工具必须进 trace.wrapAll 包痕面").toBeDefined();
    expect((span!.attrs as Record<string, unknown>)["result"]).toBe("ok");
    expect(span!["stage"]).toBe("tool");
  }, 30_000);
});

describe("serve W11a3：task_fetch 取件（主派子 → 反解子 sid → 次轮取回子正文）", () => {
  const FETCH_MARK = "W11A3-子会话正文哨兵";

  it(
    "轮A：主 send task 派子（子转录落 loom-sessions）→ 父 toolResult 反解 session_id；轮B：同一主会话次轮 task_fetch(clean) 拿到子正文 + trace task_fetch span 包痕",
    async () => {
      // 轮A：父 turn1 派子 → 子单轮文本收尾 → 父 turn2 converge 收束（fake 队列严格串链）。
      fake().push(
        {
          content: [
            {
              type: "toolCall",
              id: "w11a3-task",
              name: "task",
              arguments: { agent_type: "general", task: `只读回答一句话：${FETCH_MARK}` },
            },
          ],
        },
        { content: [{ type: "text", text: FETCH_MARK }] },
        {
          content: [
            { type: "text", text: "已派子并收到摘要。" },
            {
              type: "toolCall",
              id: "w11a3-conv-a",
              name: "converge",
              arguments: { status: "已完成", digest: "已完成：派子并收摘要", body: "轮A收口。" },
            },
          ],
        },
      );
      const rec = app.registry.create();
      app.registry.send(rec.sessionID, "用 task 派一个只读子会话");
      expect(await waitFor(() => app.registry.get(rec.sessionID)?.running === null)).toBe(true);

      // 模型侧 sid 到手 = task toolResult 的 <task_metadata> session_id（前端契约通路，不靠 trace）。
      const taskTr = rec.loop!.session.messages
        .map((m) => m as unknown as { role: string; toolName?: string; content: unknown })
        .filter((m) => m.role === "toolResult" && m.toolName === "task");
      expect(taskTr.length).toBe(1);
      const meta = /session_id: (ses_[0-9a-f]{16})/.exec(String(JSON.stringify(taskTr[0]!.content)));
      expect(meta, "task_metadata 必须含子 session_id").not.toBeNull();
      const childSid = meta![1]!;

      // 轮B（次轮，同一主会话）：task_fetch(clean) 按 sid 取件。
      fake().push(
        {
          content: [
            { type: "toolCall", id: "w11a3-fetch", name: "task_fetch", arguments: { session_id: childSid, mode: "clean" } },
          ],
        },
        {
          content: [
            { type: "text", text: "已取回子正文，收束。" },
            {
              type: "toolCall",
              id: "w11a3-conv-b",
              name: "converge",
              arguments: { status: "已完成", digest: `已完成：task_fetch 取回 ${childSid} 正文`, body: "轮B收口。" },
            },
          ],
        },
      );
      app.registry.send(rec.sessionID, "用 task_fetch 取回子会话正文");
      expect(await waitFor(() => app.registry.get(rec.sessionID)?.running === null)).toBe(true);

      // 取件硬证：fetch 的 toolResult = 子正文 + 头部状态行；clean 档剔工具块痕迹。
      const fetchTr = rec.loop!.session.messages
        .map((m) => m as unknown as { role: string; toolName?: string; content: unknown })
        .filter((m) => m.role === "toolResult" && m.toolName === "task_fetch");
      expect(fetchTr.length).toBe(1);
      const out = String(JSON.stringify(fetchTr[0]!.content));
      expect(out).toContain(FETCH_MARK); // 子正文原文到手
      expect(out).toContain("sid 存在；条目数"); // 头部状态行
      expect(out).not.toContain("toolCall"); // clean 档口径

      // trace 包痕：task_fetch tool span 行（wrapAll 既有通路，sessionId=主会话 sid）。
      const traceFile = join(stateRoot, "trace", `${localDateKey(Date.now())}.jsonl`);
      const rows = readFileSync(traceFile, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, any>);
      const span = rows.find(
        (r) => r["name"] === "task_fetch" && r["sessionId"] === rec.sessionID && r["stage"] === "tool",
      );
      expect(span, "task_fetch 必须进 trace.wrapAll 包痕面").toBeDefined();
      expect((span!["attrs"] as Record<string, unknown>)["result"]).toBe("ok");
    },
    40_000,
  );
});

/** 引擎登记的当下状态（waitFor 谓词需同步；HTTP 谓词异步不可用）。 */
function detailStatus(runId: string): string {
  const rec = app.engine.get(runId);
  return rec?.state ?? "unknown";
}
