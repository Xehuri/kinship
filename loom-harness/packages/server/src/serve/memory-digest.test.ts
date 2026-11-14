import { describe, expect, it } from "vitest";
import type { MemorySource } from "@axeuh/loom-core/assembly";

import {
  appendMemoryDigestSource,
  buildMemoryDigestSource,
  MEMORY_DIGEST_SOURCE,
  type MemoryDigestLog,
  type MemoryDigestRunOptions,
} from "./memory-digest.js";

const WORKSPACE = "/tmp/loom-digest-ws";

interface RunCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: MemoryDigestRunOptions;
}

function capturingRun(output: string, calls: RunCall[]) {
  return (command: string, args: readonly string[], options: MemoryDigestRunOptions): string => {
    calls.push({ command, args, options });
    return output;
  };
}

interface LogEntry {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

function capturingLog(entries: LogEntry[]): MemoryDigestLog {
  return (level, msg, fields) => {
    entries.push({ level, msg, fields });
  };
}

describe("buildMemoryDigestSource", () => {
  it("disabled 返回 null 且绝不执行命令", () => {
    const calls: RunCall[] = [];
    const source = buildMemoryDigestSource({
      workspaceRoot: WORKSPACE,
      enabled: false,
      run: capturingRun("不该被调用", calls),
    });
    expect(source).toBeNull();
    expect(calls).toEqual([]);
  });

  it("成功：source/content 契约、trim、结尾换行、无 degrade", () => {
    const calls: RunCall[] = [];
    const source = buildMemoryDigestSource({
      workspaceRoot: WORKSPACE,
      enabled: true,
      run: capturingRun("  我记得 11-13 那天去复查了。\n\n", calls),
    });
    expect(source).toEqual({
      source: "memory/.digest",
      content: "# Wake Digest\n\n我记得 11-13 那天去复查了。\n",
      degrade: null,
    });
    expect(source?.content.endsWith("\n")).toBe(true);
    expect(MEMORY_DIGEST_SOURCE).toBe("memory/.digest");
  });

  it("命令参数/cwd/timeout/encoding/maxBuffer 精确", () => {
    const calls: RunCall[] = [];
    buildMemoryDigestSource({
      workspaceRoot: WORKSPACE,
      enabled: true,
      run: capturingRun("摘要", calls),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("stratum");
    expect(calls[0]?.args).toEqual(["memory", "digest", "--days", "30", "--budget", "3000"]);
    expect(calls[0]?.options).toEqual({
      cwd: WORKSPACE,
      timeout: 5_000,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
  });

  it("同一 stdout 得到逐字节相同的 content（确定性，无生成时间）", () => {
    const run = capturingRun("稳定摘要行\n", []);
    const first = buildMemoryDigestSource({ workspaceRoot: WORKSPACE, enabled: true, run });
    const second = buildMemoryDigestSource({ workspaceRoot: WORKSPACE, enabled: true, run });
    expect(first).toEqual(second);
  });

  it("空输出/纯空白 → null + warn", () => {
    for (const output of ["", "   \n\t  "]) {
      const logs: LogEntry[] = [];
      const source = buildMemoryDigestSource({
        workspaceRoot: WORKSPACE,
        enabled: true,
        run: capturingRun(output, []),
        log: capturingLog(logs),
      });
      expect(source).toBeNull();
      expect(
        logs.some((entry) => entry.level === "warn" && entry.msg === "loom memory digest empty"),
      ).toBe(true);
    }
  });

  it("stratum 输出 `无`（含 trim）→ null + warn", () => {
    for (const output of ["无", "  无\n"]) {
      const logs: LogEntry[] = [];
      const source = buildMemoryDigestSource({
        workspaceRoot: WORKSPACE,
        enabled: true,
        run: capturingRun(output, []),
        log: capturingLog(logs),
      });
      expect(source).toBeNull();
      expect(
        logs.some((entry) => entry.level === "warn" && entry.msg === "loom memory digest empty"),
      ).toBe(true);
    }
  });

  it("runner 抛错（missing stratum / timeout / 非零退出）→ null + warn，绝不 throw", () => {
    const logs: LogEntry[] = [];
    const source = buildMemoryDigestSource({
      workspaceRoot: WORKSPACE,
      enabled: true,
      run: () => {
        throw new Error("spawnSync stratum ENOENT");
      },
      log: capturingLog(logs),
    });
    expect(source).toBeNull();
    const warn = logs.find((entry) => entry.msg === "loom memory digest unavailable");
    expect(warn?.level).toBe("warn");
    expect(String(warn?.fields["error"])).toContain("ENOENT");
  });
});

describe("appendMemoryDigestSource", () => {
  const staticSources: readonly MemorySource[] = [
    { source: "AGENTS.md", content: "# 记忆\n", degrade: null },
  ];
  const digest: MemorySource = {
    source: MEMORY_DIGEST_SOURCE,
    content: "# Wake Digest\n\n我记得。\n",
    degrade: null,
  };

  it("null 时原样返回同一数组（disabled/fail 面零扰动）", () => {
    expect(appendMemoryDigestSource(staticSources, null)).toBe(staticSources);
  });

  it("digest 追加在清单最后且保持静态源顺序", () => {
    const merged = appendMemoryDigestSource(staticSources, digest);
    expect(merged.map((source) => source.source)).toEqual(["AGENTS.md", "memory/.digest"]);
    expect(merged.at(-1)).toBe(digest);
  });

  it("同一 digest 对象跨多次合并保持身份与 content（resync 字节稳定）", () => {
    const first = appendMemoryDigestSource(staticSources, digest);
    const second = appendMemoryDigestSource(staticSources, digest);
    expect(second.at(-1)).toBe(digest);
    expect(second.at(-1)?.content).toBe(first.at(-1)?.content);
  });
});
