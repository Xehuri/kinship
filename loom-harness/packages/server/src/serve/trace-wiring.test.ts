/**
 * trace 观测面生产接线集成验收（A/B/C 三处断链的 server 装配同树证明）。
 * Given: createLoomApp 真树（fake provider、临时 workspace/state 根）
 * When:  engine.dispatch 一轮副会话（fake 模型耗尽脚本=纯文本 turn 空转）
 * Then:  当日 trace jsonl 出现 kind:"nudge" 行（gate 催办过程落盘）与恰一条
 *        kind:"run_end" 行（终态盖棺，status=error——非收束通道 failed 映射）；
 *        failed 盖棺经 DeadLetterSink 在 state/dead-letter/{UTC日}.jsonl 落一行，
 *        run_id 与账本行一致（死信不再凭空消失）；
 *        既有 assembly span 不受影响（观测面只增不断）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localDateKey } from "@axeuh/loom-core";
import { stateDateKey } from "@axeuh/loom-adapters";
import type { RunRecord } from "@axeuh/loom-core/run-engine";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

// 加载纪律同 boot-assembly.test.ts：boot 图必须动态 import（SSR 环解析实测，静态会丢构造绑定）。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";

const FAKE_YAML = [
  "server:",
  "  port: 5102",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-trace",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-trace-wiring-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(join(ws, "memory"), { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# 一级记忆\nTRACE-WIRING-稳定段\n");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

async function makeApp(): Promise<{ app: LoomApp; dispose: () => void }> {
  const config = parseLoomConfig(FAKE_YAML.replace("WS_ROOT", ws), "<test>", {
    env: { LOOM_FAKE_MODEL: "1" },
  });
  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const applied = store.apply(FAKE_YAML.replace("WS_ROOT", ws), "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const app = await createLoomApp({
    config,
    store,
    stateRoot,
    tokens: ["tok-trace-test"],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
  });
  return { app, dispose: () => app.model.teardown() };
}

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("trace 观测面接线：nudge 实时行 + run_end 盖棺 + 死信分片", () => {
  it("空转副会话 run 终局：三类行同日齐落，run_id 账本 join 一致", async () => {
    const { app, dispose } = await makeApp();
    try {
      const launched = await app.engine.dispatch({
        workflow: "w-trace",
        prompt: "空转触发催办与死信",
        trigger: "manual",
      });
      expect(launched.kind).toBe("launched");
      if (launched.kind !== "launched") return;
      const rec: RunRecord = await launched.completion;

      const tracePath = join(stateRoot, "trace", `${localDateKey(rec.dispatchedAt)}.jsonl`);
      expect(existsSync(tracePath)).toBe(true);
      const rows = readJsonl(tracePath);
      const mine = rows.filter((r) => r["runId"] === rec.row.run_id);

      const nudges = mine.filter((r) => r["kind"] === "nudge");
      expect(nudges.length, "催办过程必须落 trace nudge 行").toBeGreaterThan(0);
      expect(nudges[0]?.["event"]).toBe("text-only");
      expect(String(nudges[0]?.["detail"])).toMatch(/^nudgeCount=\d+$/);

      const ends = mine.filter((r) => r["kind"] === "run_end");
      expect(ends).toHaveLength(1);
      expect(ends[0]?.["status"]).toBe("error");
      expect(ends[0]?.["workflow"]).toBe("w-trace");
      expect(ends[0]?.["sessionId"]).toBe(rec.row.session_id);
      const totals = ends[0]?.["totals"] as Record<string, number>;
      expect(totals).toEqual({ input: 0, output: 0, cacheRead: 0, spans: 0 });

      // 观测面只增不断：assembly span（f5d60d0 接线）仍在同文件同 runId 下可 join。
      const spans = mine.filter((r) => r["kind"] === "span");
      expect(spans.some((s) => s["stage"] === "assembly")).toBe(true);

      // 死信落盘：failed 盖棺 → DeadLetterSink → dead-letter/{UTC日}.jsonl 一行同 run_id。
      const dlPath = join(stateRoot, "dead-letter", `${stateDateKey(rec.terminalAt ?? Date.now())}.jsonl`);
      expect(existsSync(dlPath)).toBe(true);
      const dl = readJsonl(dlPath);
      expect(dl).toHaveLength(1);
      expect(dl[0]?.["kind"]).toBe("dead-letter");
      expect(dl[0]?.["run_id"]).toBe(rec.row.run_id);
      expect(rec.state).toBe("failed");
    } finally {
      dispose();
    }
  }, 30_000);

  it("W16-F4 run_end totals 对齐会话 terminal usage（真收束副会话，boot 级假模型）", async () => {
    const { app, dispose } = await makeApp();
    try {
      // 脚本注入带实测 usage 的合法 side 收束（fake push 通道同 boot-transcript）。
      const fake = app.model.model as unknown as {
        push(...resp: Array<{ content: unknown[]; usage?: { input: number; output: number } }>): void;
      };
      fake.push({
        content: [
          { type: "text", text: "副会话干活并收束。" },
          {
            type: "toolCall",
            name: "converge",
            arguments: {
              status: "done",
              runId: "run_w16f4selfreport",
              workflow: "w-usage",
              attempt: 1,
              digest: "done：W16-F4 usage 对齐",
              pointers: [],
              blockers: [],
            },
          },
        ],
        usage: { input: 197, output: 18 },
      });
      const launched = await app.engine.dispatch({
        workflow: "w-usage",
        prompt: "干活并给出合法回执",
        trigger: "manual",
      });
      expect(launched.kind).toBe("launched");
      if (launched.kind !== "launched") return;
      const rec: RunRecord = await launched.completion;
      expect(rec.state).toBe("done");
      expect(rec.usage, "执行端口实测 usage 上抛登记面").toEqual(expect.objectContaining({ input: 197, output: 18 }));

      // 会话 terminal 条目真源：loom-sessions.jsonl 该 sid 的 terminal result.usage。
      const sessionRows = readJsonl(join(stateRoot, "session", "loom-sessions.jsonl"));
      const term = sessionRows
        .filter((r) => r["sid"] === rec.row.session_id)
        .map((r) => (r["e"] as { entry?: { kind?: string; result?: { usage?: Record<string, number> } } }).entry)
        .filter((e) => e?.kind === "terminal")
        .at(-1);
      const terminalUsage = term?.["result"]?.["usage"];
      expect(terminalUsage, "副会话转录必含 terminal usage").toBeDefined();

      const rows = readJsonl(join(stateRoot, "trace", `${localDateKey(rec.dispatchedAt)}.jsonl`));
      const end = rows.filter((r) => r["runId"] === rec.row.run_id && r["kind"] === "run_end").at(-1);
      expect(end, "盖棺行必落").toBeDefined();
      expect(end!["status"]).toBe("ok");
      expect(end!["totals"], "run_end totals 与 terminal usage 同源对齐（修复前恒 0）").toEqual({
        input: terminalUsage!["input"],
        output: terminalUsage!["output"],
        cacheRead: terminalUsage!["cacheRead"],
        spans: 0,
      });
      expect(end!.totals).toEqual({ input: 197, output: 18, cacheRead: 0, spans: 0 });
    } finally {
      dispose();
    }
  }, 30_000);
});
