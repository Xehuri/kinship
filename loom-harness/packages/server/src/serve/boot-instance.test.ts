/**
 * W27 实例化 —— boot 级 e2e：LOOM_INSTANCE 全链（解析 → loadServeConfig → 真树装配）。
 *
 * Given: 临时实例根 `<work>/instance`（=workspace：AGENTS.md+退役四件诱饵（W33 不注入）+skills 目录），
 *        `.loom/config.yaml` 落好（fake provider + skills allowlist，workspace 字段
 *        如实指向实例根——W27 冻结口径：workspace 值不由 LOOM_INSTANCE 反推）。
 * When:  resolveConfigPath/resolveStateRootFromEnv（env 只有 LOOM_INSTANCE）→
 *        loadServeConfig → createLoomApp（configPath 如实传）→ listen(0)：
 *        /health、GET /sessions、POST /skills/reload（W25 面在实例模式必须照活）、
 *        POST /sessions + 收束轮 + title、engine.dispatch 合法收束副 run。
 * Then:  session jsonl / ledger / trace / wire 目录 / meta.json / config 审计 /
 *        dead-letter+inbox 目录 全部落在 `<instance>/.loom/` 之下；
 *        /context/full 的 manifest.configPath == 实例 .loom/config.yaml（W17-B 观测面
 *        在实例模式说实话）；
 *        legacy 口径不回归：resolveStateRootFromEnv({}) == 仓库缺省（boot 尊重显式
 *        stateRoot 的既有行为由全部邻居 boot 测试钉着——本文件绝不往仓库 state/ 写盘）。
 *
 * 加载纪律同 boot-assembly：boot 图必须动态 import（SSR 环解析实测）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDateKey } from "@axeuh/loom-core";
import { stateDateKey } from "@axeuh/loom-adapters";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";
import type { RunRecord } from "@axeuh/loom-core/run-engine";

import {
  DEFAULT_STATE_ROOT,
  instanceConfigPath,
  loadServeConfig,
  resolveConfigPath,
  resolveStateRootFromEnv,
} from "./config-source.js";
import type { LoomApp } from "./boot.js";
import { wireCacheFileName } from "./wire-cache.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let instance = "";
let loom = "";
let configPath = "";
let skillsRoot = "";

const TOKEN = "tok-w27-instance";

/** 实例内配置文本：fake 通道 + skills 段（W25 端点在场）；workspace 字段如实写实例根。 */
const INSTANCE_YAML = [
  "server:",
  "  port: 5104",
  "  hostname: 127.0.0.1",
  "  sessionList: true",
  "workspace: INSTANCE_ROOT",
  "models:",
  "  - id: fake-w27",
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
].join("\n");

function skillMd(name: string, description: string): string {
  return ["---", `name: ${name}`, `description: ${description}`, "---", "W27 正文。"].join("\n");
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w27-boot-"));
  // 实例根 = workspace 目录本体（W27 语义：一个 workspace 目录就是一个 loom 实例）。
  instance = join(work, "instance");
  loom = join(instance, ".loom");
  skillsRoot = join(instance, "skills");
  mkdirSync(join(instance, "memory", "fact"), { recursive: true });
  mkdirSync(join(instance, "memory", "self"), { recursive: true });
  mkdirSync(join(instance, "memory", "profile"), { recursive: true });
  mkdirSync(loom, { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });
  writeFileSync(join(instance, "AGENTS.md"), "W27-实例记忆\n");
  writeFileSync(join(instance, "memory", "README.md"), "W27-索引\n");
  writeFileSync(join(instance, "memory", "self", "必读.md"), "W27-快照\n");
  writeFileSync(join(instance, "memory", "profile", "core.md"), "W27-画像\n");
  writeFileSync(join(instance, "memory", "fact", "总目录.md"), "W27-事实\n");
  writeFileSync(join(skillsRoot, "alpha.md"), skillMd("alpha", "W27-ALPHA-DESC"));
  configPath = instanceConfigPath(instance);
  writeFileSync(configPath, INSTANCE_YAML.replace("INSTANCE_ROOT", instance).replace("SKILLS_ROOT", skillsRoot), "utf8");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, budgetMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe("W27 实例模式 boot e2e：数据全落 .loom，观测面照活", () => {
  it(
    "LOOM_INSTANCE 解析 → 装配 → 六面落盘 .loom + manifest.configPath 说实话",
    async () => {
      // ── 解析层（env 只有 LOOM_INSTANCE：真实部署 systemd 就长这样）──
      const env = { LOOM_INSTANCE: instance };
      const warns: string[] = [];
      const resolvedConfig = resolveConfigPath(undefined, env, (m) => warns.push(m));
      const stateRoot = resolveStateRootFromEnv(env);
      expect(resolvedConfig).toBe(join(loom, "config.yaml"));
      expect(stateRoot).toBe(loom);
      expect(warns).toHaveLength(0); // 实例命中绝不报 legacy

      // ── 装配层：走 config-source 全链（loadServeConfig 建基线 + 审计落 .loom/config）──
      const { config, store } = loadServeConfig({ configPath: resolvedConfig, stateRoot, env: {} });
      // store.get() = 生效基线（apply 走的是 .loom/config.yaml 文本，非仓库 legacy）。
      expect(store.get().server.port).toBe(5104);
      const app = await createLoomApp({
        config,
        store,
        stateRoot,
        tokens: [TOKEN],
        version: "test-w27",
        env: { LOOM_FAKE_MODEL: "1" },
        log: () => {},
        // W17-B 观测面：cli 把解析真值透传——这里模拟 cli 接线，manifest 必须还以颜色。
        configPath: resolvedConfig,
      });
      await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));

      try {
        const addr = app.server.address();
        if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
        const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
        const api = async (path: string, init?: RequestInit) => {
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
        };

        // ── 观测面三拍：health / sessions 列表 / W25 热重载端点（实例模式必须照活）──
        expect((await api("/health")).status).toBe(200);
        expect((await api("/sessions")).status).toBe(200);
        const reload = await api("/skills/reload", { method: "POST" });
        expect(reload.status).toBe(200);
        expect(reload.json["ok"]).toBe(true);
        expect(reload.json["entries"]).toBe(1);

        // ── 主会话：建会话 → 收束轮 → 标题（三样各钉一个 .loom 落盘面）──
        const created = await api("/sessions", { method: "POST" });
        expect(created.status).toBe(201);
        const sid = String(created.json["sessionID"]);
        const fake = app.model.model as unknown as {
          push(...r: FakeAssistantResponse[]): void;
        };
        fake.push({
          content: [
            { type: "text", text: "W27 实例轮" },
            { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: "W27 实例轮", body: "收口。" } },
          ],
        });
        const sent = await api(`/sessions/${sid}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "W27 实例收束轮" }),
        });
        expect(sent.status).toBe(202);
        expect(await waitFor(() => app.registry.get(sid)?.running === null)).toBe(true);

        expect((await api(`/sessions/${sid}/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "W27-实例标题" }),
        })).status).toBe(200);

        // ── 副 run：合法收束（W16-F4 形状）钉账本与 loom-sessions 转录落盘位置 ──
        fake.push({
          content: [
            { type: "text", text: "W27 副会话干活。" },
            {
              type: "toolCall",
              name: "converge",
              arguments: {
                status: "done",
                runId: "run_w27sideSelfreport",
                workflow: "w-w27",
                attempt: 1,
                digest: "done：W27 实例账本取证",
                pointers: [],
                blockers: [],
              },
            },
          ],
          usage: { input: 11, output: 7 },
        });
        const launched = await app.engine.dispatch({ workflow: "w-w27", prompt: "W27 实例副 run", trigger: "manual" });
        expect(launched.kind).toBe("launched");
        if (launched.kind !== "launched") throw new Error("副 run 未起飞");
        const rec: RunRecord = await launched.completion;
        expect(rec.state).toBe("done");

        // ── 落盘位置总验收：一切从 .loom 派生，仓库 state/ 零沾笔 ──
        expect(existsSync(join(loom, "session", "loom-main.jsonl"))).toBe(true);
        expect(readFileSync(join(loom, "session", "loom-main.jsonl"), "utf8")).toContain(sid);
        expect(existsSync(join(loom, "session", "wire", wireCacheFileName(sid)))).toBe(true);
        expect(readFileSync(join(loom, "session", "meta.json"), "utf8")).toContain("W27-实例标题");
        const ledgerDay = join(loom, "ledger", `${stateDateKey(Date.now())}.jsonl`);
        expect(existsSync(ledgerDay)).toBe(true);
        expect(readFileSync(ledgerDay, "utf8")).toContain(rec.row.run_id);
        expect(existsSync(join(loom, "session", "loom-sessions.jsonl"))).toBe(true);
        expect(readFileSync(join(loom, "session", "loom-sessions.jsonl"), "utf8")).toContain(rec.row.session_id);
        expect(existsSync(join(loom, "trace", `${localDateKey(Date.now())}.jsonl`))).toBe(true);
        // 六子目录齐（ensureDirs 从解析根派生）+ config 审计日分片在场（loadServeConfig 落的）。
        for (const d of ["session", "ledger", "trace", "dead-letter", "inbox", "config"]) {
          expect(existsSync(join(loom, d)), `子目录 ${d} 必在 .loom 下`).toBe(true);
        }
        expect(readdirSync(join(loom, "config")).some((n) => n.endsWith(".jsonl"))).toBe(true);

        // ── W17-B 观测面：manifest.configPath = 实例真路径（不是仓库 legacy）──
        const ctx = await api(`/sessions/${sid}/context/full`);
        expect(ctx.status).toBe(200);
        const manifest = ctx.json["manifest"] as Record<string, unknown>;
        expect(manifest["configPath"]).toBe(join(loom, "config.yaml"));
      } finally {
        await app.closeExtras();
        app.server.closeAllConnections();
        await new Promise<void>((resolve) => app.server.close(() => resolve()));
        app.model.teardown();
      }
    },
    90_000,
  );

  it("legacy 口径不回归：无 env 解析 = 仓库缺省 state 根（boot 尊重显式 stateRoot 由邻居 boot 测试钉死）", () => {
    // 本文件（与所有 W27 新测试）绝不往仓库 state/ 写盘——落盘面验收全在 mkdtemp 内；
    // "boot 写到传入 stateRoot" 的既有行为由 boot-assembly/boot-transcript/W23/W25 套件持续钉着。
    expect(resolveStateRootFromEnv({})).toBe(DEFAULT_STATE_ROOT);
  });
});
