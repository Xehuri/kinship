/**
 * GAP-3/GAP-4 boot 接线真值表。
 * Given createLoomApp 真树（fake provider、独立 tmp workspace/stateRoot）；
 * When LOOM_PLAN_ROOT / config plan.root 给出显式绝对根，或两者皆缺；
 * Then 工具面分别含/不含 plan、long_task，且缺省时输出 disabled 原因；工具可直调。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessTool, HookContext } from "@axeuh/loom-core";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import { resolvePlanRoot } from "./config-source.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

interface Booted {
  readonly app: LoomApp;
  readonly logs: LogLine[];
}

const opened: Booted[] = [];
const works: string[] = [];
let appSeq = 0;

function yamlFor(ws: string, planRoot: string | undefined): string {
  const lines = [
    "server:",
    "  port: 5119",
    "  hostname: 127.0.0.1",
    "workspace: WS_ROOT",
    "models:",
    "  - id: fake-plan",
    "    provider: fake",
    "    contextWindow: 200000",
    "    maxOutput: 4096",
    "    timeout: 60000",
    "pricing:",
    "  fake:",
    "    input: 0",
    "    output: 0",
  ];
  if (planRoot !== undefined) {
    lines.push("plan:", `  root: ${JSON.stringify(planRoot)}`);
  }
  return lines.join("\n").replace("WS_ROOT", ws);
}

async function boot(
  work: string,
  opts: { readonly planRootConfig?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<Booted> {
  works.push(work);
  const ws = join(work, "ws");
  const stateRoot = join(work, "state");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# plan boot\n");

  const text = yamlFor(ws, opts.planRootConfig);
  const env: NodeJS.ProcessEnv = { LOOM_FAKE_MODEL: "1", ...opts.env };
  const store = new HotConfigStore({
    sink: createFileAuditSink(join(stateRoot, "config")),
    env: {},
  });
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);

  const logs: LogLine[] = [];
  const app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
    tokens: [`tok-plan-${String(++appSeq)}`],
    version: "test",
    env,
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
  });
  const booted = { app, logs };
  opened.push(booted);
  return booted;
}

afterAll(async () => {
  for (const { app } of opened) {
    await app.closeExtras();
    app.model.teardown();
  }
  for (const work of works) rmSync(work, { recursive: true, force: true });
});

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
});

function names(app: LoomApp): string[] {
  return app.tools.map((t) => t.name);
}

function toolOf(app: LoomApp, name: string): HarnessTool {
  const tool = app.tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`工具面缺 ${name}`);
  return tool;
}

const ctx = {} as HookContext;
const signal = new AbortController().signal;

function textOf(result: Awaited<ReturnType<HarnessTool["execute"]>>): string {
  const block = result.content[0];
  return block !== undefined && block.type === "text" ? block.text : "";
}

describe("planRoot boot 接线", () => {
  it("LOOM_PLAN_ROOT 显式根：plan/long_task 进工具面且可直调", async () => {
    const work = mkdtempSync(join(tmpdir(), "loom-plan-boot-env-"));
    const planRoot = join(work, "plan-root");
    mkdirSync(planRoot, { recursive: true });
    const { app, logs } = await boot(work, { env: { LOOM_PLAN_ROOT: planRoot } });

    expect(names(app)).toContain("plan");
    expect(names(app)).toContain("long_task");
    const enabled = logs.find((l) => l.msg === "loom plan tools enabled");
    expect(enabled?.level).toBe("info");
    expect(enabled?.fields["planRoot"]).toBe(planRoot);
    expect(enabled?.fields["source"]).toBe("env");

    const read = await toolOf(app, "plan").execute(
      { action: "read", date: "2026-10-27" },
      ctx,
      signal,
    );
    expect(read.isError).toBe(true);
    expect(textOf(read)).toContain("PlanNotFoundError");

    const list = await toolOf(app, "long_task").execute({ action: "list", due: "today" }, ctx, signal);
    expect(list.isError).toBeUndefined();
    const listText = textOf(list);
    expect(listText).toContain("long_task list due=today");
    expect(listText).toContain("count=0");
    expect(listText).toContain("(no tasks)");
  });

  it("config plan.root 也能启用（env 缺席）", async () => {
    const work = mkdtempSync(join(tmpdir(), "loom-plan-boot-config-"));
    const planRoot = join(work, "plan-root");
    mkdirSync(planRoot, { recursive: true });
    const { app, logs } = await boot(work, { planRootConfig: planRoot });

    expect(names(app)).toEqual(expect.arrayContaining(["plan", "long_task"]));
    const enabled = logs.find((l) => l.msg === "loom plan tools enabled");
    expect(enabled?.fields["planRoot"]).toBe(planRoot);
    expect(enabled?.fields["source"]).toBe("config");
  });

  it("LOOM_PLAN_ROOT 压过 config plan.root（env 优先）", async () => {
    const work = mkdtempSync(join(tmpdir(), "loom-plan-boot-precedence-"));
    const configRoot = join(work, "config-plan-root");
    const envRoot = join(work, "env-plan-root");
    mkdirSync(configRoot, { recursive: true });
    mkdirSync(envRoot, { recursive: true });
    const { app, logs } = await boot(work, {
      planRootConfig: configRoot,
      env: { LOOM_PLAN_ROOT: envRoot },
    });

    expect(names(app)).toEqual(expect.arrayContaining(["plan", "long_task"]));
    const enabled = logs.find((l) => l.msg === "loom plan tools enabled");
    expect(enabled?.fields["planRoot"]).toBe(envRoot);
    expect(enabled?.fields["source"]).toBe("env");
  });

  it("两者皆缺：两工具均不挂面，并输出 disabled 原因", async () => {
    const work = mkdtempSync(join(tmpdir(), "loom-plan-boot-disabled-"));
    const { app, logs } = await boot(work);

    expect(names(app)).not.toContain("plan");
    expect(names(app)).not.toContain("long_task");
    const disabled = logs.find((l) => l.msg === "loom plan tools disabled");
    expect(disabled?.level).toBe("info");
    expect(String(disabled?.fields["reason"])).toContain("plan.root");
    expect(String(disabled?.fields["reason"])).toContain("LOOM_PLAN_ROOT");
    expect(String(disabled?.fields["reason"])).toContain("绝不猜 ai/data");
  });
});

describe("resolvePlanRoot 绝对路径纪律", () => {
  it("config 相对根响亮拒绝", () => {
    expect(() => resolvePlanRoot("relative/plan", {})).toThrow(/绝对路径/);
  });

  it("env 相对根响亮拒绝（不回落 config）", () => {
    expect(() => resolvePlanRoot("/abs/config", { LOOM_PLAN_ROOT: "relative/env" })).toThrow(
      /绝对路径/,
    );
  });

  it("env 空串视为未设，回落 config", () => {
    expect(resolvePlanRoot("/abs/config", { LOOM_PLAN_ROOT: "   " })).toEqual({
      planRoot: "/abs/config",
      source: "config",
    });
  });
});
