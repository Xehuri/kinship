/**
 * system-prompt-resync 单测（真 fs 临时工作区，无网络）。
 *
 * Given: boot plan（persona 正文 + AGENTS.md 注入源）落盘后的稳定状态；
 * When:  文件不变 / memory 变更 / persona 变更 / 新源出现 / 首次读时就地写 /
 *        持续 unreadable / persona 读失败 / 同 session 并发调用 / 源缺失；
 * Then:  返回新 AssemblyPlan 或抛 SystemPromptResyncUnavailableError；并发单飞、
 *        稳定读两次快照、missing 可采纳、unreadable 绝不采纳。
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFsAssemblyReader,
  renderAssemblyPrefix,
  resolveMemorySources,
  type AssemblyPlan,
  type MemorySource,
} from "@axeuh/loom-core/assembly";

import {
  SystemPromptResyncUnavailableError,
  createSystemPromptResync,
  type SystemPromptResyncOptions,
  type SystemPromptResyncProvider,
  type SystemPromptResyncResult,
} from "./system-prompt-resync.js";

const PERSONA_OLD = "# 主会话人格\n旧人格正文。\n";
const AGENTS_OLD = "# 一级记忆\n旧记忆正文。\n";

let root = "";
let personaFile = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-spr-"));
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "memory", "fact"), { recursive: true });
  personaFile = join(root, "agents", "main.md");
  writeFileSync(personaFile, PERSONA_OLD);
  writeFileSync(join(root, "AGENTS.md"), AGENTS_OLD);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readSources(paths: readonly string[]): readonly MemorySource[] {
  return resolveMemorySources(createFsAssemblyReader({ workspaceRoot: root, shards: null }), paths).sources;
}

function makePlan(): AssemblyPlan {
  return {
    systemPrompt: PERSONA_OLD,
    convergenceToolNote: "[convergence tools: resync-test]",
    memorySources: readSources(["AGENTS.md"]),
    workflows: [{ name: "w", prompt: "任务模板" }],
  };
}

interface LogRecord {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

function makeProvider(
  plan: AssemblyPlan,
  sessionID: string,
  overrides: Partial<Omit<SystemPromptResyncOptions, "workspaceRoot" | "plan">> = {},
): { readonly provider: SystemPromptResyncProvider; readonly logs: readonly LogRecord[] } {
  const logs: LogRecord[] = [];
  const provider = createSystemPromptResync({
    workspaceRoot: root,
    plan,
    personaFile,
    loadMemorySources: () => readSources(["AGENTS.md"]),
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
    ...overrides,
  })(sessionID);
  return { provider, logs };
}

function requireResult(result: SystemPromptResyncResult | null): SystemPromptResyncResult {
  if (result === null) throw new Error("expected a resynced result");
  return result;
}

function requirePlan(result: SystemPromptResyncResult | null): AssemblyPlan {
  return requireResult(result).plan;
}

describe("createSystemPromptResync", () => {
  it("文件未变：两次稳定快照返回与 boot plan 深度相等的计划，并记录 hash/bytes/count", async () => {
    const plan = makePlan();
    const { provider, logs } = makeProvider(plan, "ses_unchanged");
    const result = requirePlan(await provider("session-start"));

    expect(result).toEqual(plan);
    expect(renderAssemblyPrefix(result)).toBe(renderAssemblyPrefix(plan));

    const applied = logs.find((entry) => entry.msg === "loom system prompt resync applied");
    expect(applied).toBeDefined();
    expect(applied?.fields["reason"]).toBe("session-start");
    expect(applied?.fields["attempts"]).toBe(1);
    expect(applied?.fields["sourceCount"]).toBe(1);
    expect(applied?.fields["bytes"]).toBe(Buffer.byteLength(renderAssemblyPrefix(result), "utf8"));
    expect(applied?.fields["sha256"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("memory 文件变更：返回新内容，renderAssemblyPrefix(result) 含 sentinel", async () => {
    const plan = makePlan();
    const sentinel = "MEMORY-CHANGED-SENTINEL-9f3a";
    writeFileSync(join(root, "AGENTS.md"), `# 一级记忆\n${sentinel}\n`);

    const { provider } = makeProvider(plan, "ses_memory_changed");
    const result = requirePlan(await provider("compaction"));

    expect(result.memorySources).toHaveLength(1);
    expect(result.memorySources[0]?.content).toContain(sentinel);
    expect(renderAssemblyPrefix(result)).toContain(sentinel);
    expect(result.systemPrompt).toBe(PERSONA_OLD);
  });

  it("persona 文件变更：返回的 systemPrompt 含新人格正文", async () => {
    const plan = makePlan();
    const sentinel = "PERSONA-NEW-SENTINEL-4c1d";
    writeFileSync(personaFile, `# 主会话人格\n${sentinel}\n`);

    const { provider } = makeProvider(plan, "ses_persona_changed", {
      loadPersona: () => readFile(personaFile, "utf8"),
    });
    const result = requirePlan(await provider("session-start"));

    expect(result.systemPrompt).toContain(sentinel);
    expect(result.systemPrompt).not.toBe(plan.systemPrompt);
    expect(result.memorySources).toEqual(plan.memorySources);
  });

  it("新源文件出现：首次 attempt 列表变化触发重试，最终纳入新源", async () => {
    const plan = makePlan();
    const sentinel = "NEW-SOURCE-SENTINEL-77aa";
    writeFileSync(join(root, "memory", "fact", "new.md"), `# 新事实\n${sentinel}\n`);

    let calls = 0;
    const { provider, logs } = makeProvider(plan, "ses_new_source", {
      loadMemorySources: () => {
        calls += 1;
        const paths = calls === 1 ? ["AGENTS.md"] : ["AGENTS.md", "memory/fact/new.md"];
        return readSources(paths);
      },
    });
    const result = requirePlan(await provider("session-start"));

    expect(calls).toBeGreaterThanOrEqual(3);
    const added = result.memorySources.find((source) => source.source === "memory/fact/new.md");
    expect(added?.content).toContain(sentinel);
    expect(renderAssemblyPrefix(result)).toContain(sentinel);
    const applied = logs.find((entry) => entry.msg === "loom system prompt resync applied");
    expect(applied?.fields["attempts"]).toBe(2);
  });

  it("半写不稳定：首读返回旧内容后立即改文件，重试后采用稳定第二快照", async () => {
    const plan = makePlan();
    const sentinel = "WRITE-IN-FLIGHT-SENTINEL-2b8e";
    let calls = 0;
    const { provider } = makeProvider(plan, "ses_unstable", {
      loadMemorySources: () => {
        const sources = readSources(["AGENTS.md"]);
        calls += 1;
        if (calls === 1) writeFileSync(join(root, "AGENTS.md"), `# 写入中\n${sentinel}\n`);
        return sources;
      },
    });
    const result = requirePlan(await provider("session-start"));

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(result.memorySources[0]?.content).toContain(sentinel);
    expect(renderAssemblyPrefix(result)).toContain(sentinel);
  });

  it("持续 unreadable 降级：maxAttempts 后拒绝为 SystemPromptResyncUnavailableError", async () => {
    const plan = makePlan();
    const bad: MemorySource = {
      source: "memory/x.md",
      content: "[assembly: source unreadable, degraded]",
      degrade: {
        segment: "memory",
        source: "memory/x.md",
        reason: "unreadable",
        detail: "EACCES",
      },
    };
    let calls = 0;
    const { provider } = makeProvider(plan, "ses_unreadable", {
      loadMemorySources: () => {
        calls += 1;
        return [bad];
      },
      maxAttempts: 2,
      timeoutMs: 500,
    });

    await expect(provider("session-start")).rejects.toBeInstanceOf(
      SystemPromptResyncUnavailableError,
    );
    expect(calls).toBe(2);
  });

  it("persona 读取失败：重试耗尽后拒绝", async () => {
    const plan = makePlan();
    let calls = 0;
    const { provider } = makeProvider(plan, "ses_persona_fail", {
      loadPersona: () => {
        calls += 1;
        return Promise.reject(new Error("EACCES persona"));
      },
      maxAttempts: 2,
      timeoutMs: 500,
    });

    await expect(provider("session-start")).rejects.toBeInstanceOf(
      SystemPromptResyncUnavailableError,
    );
    expect(calls).toBe(2);
  });

  it("同 session 并发调用：共享 in-flight promise，活跃读峰值不超过 1", async () => {
    const plan = makePlan();
    let active = 0;
    let peak = 0;
    let memoryCalls = 0;
    const { provider } = makeProvider(plan, "ses_concurrent", {
      loadPersona: async () => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          return PERSONA_OLD;
        } finally {
          active -= 1;
        }
      },
      loadMemorySources: () => {
        memoryCalls += 1;
        return readSources(["AGENTS.md"]);
      },
    });

    const [first, second] = await Promise.all([
      provider("session-start"),
      provider("compaction"),
    ]);

    expect(peak).toBe(1);
    expect(memoryCalls).toBe(2);
    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  it("源缺失：missing 降级被采纳，不抛错", async () => {
    const plan = makePlan();
    const paths = ["AGENTS.md", "memory/ghost.md"];
    const { provider } = makeProvider(plan, "ses_missing", {
      loadMemorySources: () => readSources(paths),
    });
    const result = requirePlan(await provider("session-start"));

    const ghost = result.memorySources.find((source) => source.source === "memory/ghost.md");
    expect(ghost?.degrade?.reason).toBe("missing");
    expect(result.memorySources).toHaveLength(2);
  });

  it("稳定快照返回与 plan 同源的 contextBaseline（relPath/content/mtimeMs/size）", async () => {
    const plan = makePlan();
    const { provider } = makeProvider(plan, "ses_baseline");
    const result = requireResult(await provider("session-start"));
    const info = statSync(join(root, "AGENTS.md"));

    expect(result.contextBaseline).toHaveLength(1);
    const entry = result.contextBaseline[0]!;
    expect(entry.relPath).toBe("AGENTS.md");
    expect(entry.content).toBe(AGENTS_OLD);
    expect(entry.mtimeMs).toBe(info.mtimeMs);
    expect(entry.size).toBe(info.size);
    expect(result.plan.memorySources[0]?.content).toBe(entry.content);
  });

  it("缺失源不进 contextBaseline（plan 仍保留 missing 降级占位）", async () => {
    const plan = makePlan();
    const { provider } = makeProvider(plan, "ses_baseline_missing", {
      loadMemorySources: () => readSources(["AGENTS.md", "memory/ghost.md"]),
    });
    const result = requireResult(await provider("session-start"));

    expect(result.plan.memorySources).toHaveLength(2);
    expect(result.contextBaseline.map((entry) => entry.relPath)).toEqual(["AGENTS.md"]);
  });

  it("persona-only 变更不追加 baseline 条目（baseline 只来自 memorySources）", async () => {
    const plan = makePlan();
    const sentinel = "PERSONA-ONLY-BASELINE-SENTINEL-5e2f";
    writeFileSync(personaFile, `# 主会话人格\n${sentinel}\n`);
    const { provider } = makeProvider(plan, "ses_baseline_persona", {
      loadPersona: () => readFile(personaFile, "utf8"),
    });
    const result = requireResult(await provider("session-start"));

    expect(result.plan.systemPrompt).toContain(sentinel);
    expect(result.contextBaseline.map((entry) => entry.relPath)).toEqual(["AGENTS.md"]);
    expect(result.contextBaseline[0]?.content).toBe(AGENTS_OLD);
  });
});
