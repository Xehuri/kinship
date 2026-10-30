/**
 * 记忆注入声明层单测（B 面：角色自声明 + glob 展开 + 缺省语义 + 前缀纪律）。
 * Given: 临时 workspace（不碰任何真实工作区文件）
 * When:  expandMemoryGlob(s) / 缺省常量 / resolveMemorySources 双跑
 * Then:  命中清单/拒绝形状/字节全等——只断言可被机器消费的结果。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAIN_SESSION_GLOBS,
  SIDE_SESSION_BASE_GLOBS,
  dedupeSort,
  expandMemoryGlob,
  expandMemoryGlobs,
} from "./memory-declaration.js";
import { createFsAssemblyReader } from "./fs-reader.js";
import { renderMemorySegment, resolveMemorySources } from "./assembler.js";

let root = "";
let outside = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loom-memdec-"));
  outside = mkdtempSync(join(tmpdir(), "loom-memdec-out-"));
  mkdirSync(join(root, "memory", "fact"), { recursive: true });
  mkdirSync(join(root, "memory", "archive", "旧日志"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# 一级记忆\n稳定正文。\n");
  writeFileSync(join(root, "memory", "README.md"), "index\n");
  writeFileSync(join(root, "memory", "fact", "f1.md"), "fact1\n");
  writeFileSync(join(root, "memory", "fact", "f2.txt"), "fact2\n");
  writeFileSync(join(root, "memory", "archive", "旧日志", "2026-06-20.md"), "old\n");
  writeFileSync(join(root, "agents", "01-data-check.md"), "---\ntags: [a]\n---\nbody\n");
  // workspace 外的敏感文件（经符号链接尝试越界用）。
  writeFileSync(join(outside, "secret.md"), "outside-secret\n");
  try {
    symlinkSync(join(outside, "secret.md"), join(root, "memory", "leak.md"));
  } catch {
    /* Windows/Linux 无符号链接权限时跳过，测试以可创建为前提降级断言 */
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("expandMemoryGlob: 模式匹配", () => {
  it("memory/** 命中全目录递归（含中文段），不含点文件", () => {
    const r = expandMemoryGlob(root, "memory/**");
    expect(r.paths).toEqual([
      "memory/README.md",
      "memory/archive/旧日志/2026-06-20.md",
      "memory/fact/f1.md",
      "memory/fact/f2.txt",
    ]);
    expect(r.rejected).toEqual([]);
  });

  it("单段 * 不跨目录；? 匹配单字符", () => {
    expect(expandMemoryGlob(root, "memory/*").paths).toEqual(["memory/README.md"]);
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "a1.md"), "");
    writeFileSync(join(root, "data", "a2.md"), "");
    expect(expandMemoryGlob(root, "data/a?.md").paths).toEqual(["data/a1.md", "data/a2.md"]);
  });

  it("*.md 顶层匹配任意 .md 文件（不递归）", () => {
    const r = expandMemoryGlob(root, "*.md");
    expect(r.paths).toContain("AGENTS.md");
    expect(r.paths.every((p) => !p.includes("/"))).toBe(true);
  });

  it("目录前缀（无元字符无扩展名）自动等价递归：memory/fact → 全部后代", () => {
    expect(expandMemoryGlob(root, "memory/fact").paths).toEqual([
      "memory/fact/f1.md",
      "memory/fact/f2.txt",
    ]);
  });

  it("精确文件路径：存在即单命中，缺失保留声明（走 MISSING 占位，对齐 assembler 纪律）", () => {
    expect(expandMemoryGlob(root, "AGENTS.md").paths).toEqual(["AGENTS.md"]);
    expect(expandMemoryGlob(root, "missing.md").paths).toEqual(["missing.md"]);
  });

  it("目录前缀 0 命中 = 空清单（模式不占位）", () => {
    expect(expandMemoryGlob(root, "emptydir").paths).toEqual([]);
    expect(expandMemoryGlob(root, "*.nomatch").paths).toEqual([]);
  });
});

describe("expandMemoryGlob: 声明合法性（fail-soft，绝不 throw）", () => {
  it("绝对路径 / 盘符 / .. 段 / ~ 展开 → rejected 记录原因", () => {
    for (const bad of ["/etc/passwd", "C:/Windows/x.md", "../outside/secret.md", "~/a.md", "memory/../x.md"]) {
      const r = expandMemoryGlob(root, bad);
      expect(r.paths, bad).toEqual([]);
      expect(r.rejected.length, bad).toBe(1);
      expect(r.rejected[0]?.pattern, bad).toBe(bad);
    }
  });

  it("workspace 根不存在 → rejected（unreadable 形状），不抛", () => {
    const r = expandMemoryGlob(join(root, "no-such-dir"), "AGENTS.md");
    expect(r.paths).toEqual([]);
    expect(r.rejected[0]?.detail).toContain("workspace");
  });

  it("符号链接越界文件不进清单（walk 跳过 symlink + realpath 断言双保险）", () => {
    const r = expandMemoryGlob(root, "memory/**");
    expect(r.paths.some((p) => p.includes("leak"))).toBe(false);
  });
});

describe("expandMemoryGlobs / dedupeSort: 跨声明纪律（W14 声明序分组）", () => {
  it("多声明 = 声明序分组拼接 + 跨声明去重首次保留（组位不迁移，禁全局重排）", () => {
    const a = expandMemoryGlobs(root, ["memory/fact/**", "AGENTS.md", "memory/fact/f1.md"]);
    expect(a.paths).toEqual(["memory/fact/f1.md", "memory/fact/f2.txt", "AGENTS.md"]); // f1 归首声明组位
    const b = expandMemoryGlobs(root, ["AGENTS.md", "memory/fact/**"]);
    expect(b.paths).toEqual(["AGENTS.md", "memory/fact/f1.md", "memory/fact/f2.txt"]); // 声明序=清单序
    expect(a.paths).not.toEqual(b.paths); // 声明序不同 ⇒ 清单不同（归一责任在声明层）
    // dedupeSort=组内口径（去重+字典序），只服务单声明展开；合并清单不再排序。
    expect(dedupeSort(["memory/fact/f2.txt", "memory/fact/f1.md", "memory/fact/f1.md"])).toEqual([
      "memory/fact/f1.md",
      "memory/fact/f2.txt",
    ]);
  });

  it("0 匹配 glob → 不进清单（前缀零污染）", () => {
    const r = expandMemoryGlobs(root, ["nothing/**/*.md", "AGENTS.md"]);
    expect(r.paths).toEqual(["AGENTS.md"]);
  });
});

describe("声明序分组专测（W14 钉死：慢→快前缀纪律）", () => {
  let oroot = "";
  const renderOf = (paths: readonly string[]): string => {
    const reader = createFsAssemblyReader({ workspaceRoot: oroot, shards: null });
    const { sources } = resolveMemorySources(reader, paths);
    return renderMemorySegment(sources);
  };

  beforeAll(() => {
    oroot = mkdtempSync(join(tmpdir(), "loom-memdec-order-"));
    mkdirSync(join(oroot, "memory", "fact"), { recursive: true });
    mkdirSync(join(oroot, "memory", "self"), { recursive: true });
    writeFileSync(join(oroot, "memory", "self", "必读.md"), "慢层：热快照 v1。\n");
    writeFileSync(join(oroot, "memory", "fact", "当月.md"), "快层：当月流水 v1。\n");
  });
  afterAll(() => {
    rmSync(oroot, { recursive: true, force: true });
  });

  it("快变文件后置于声明尾：其新增不改动既有前缀字节（字典序口径会把它埋进慢层之前——fact<self）", () => {
    const slowOnly = renderOf(expandMemoryGlobs(oroot, ["memory/self/**"]).paths);
    const withFast = renderOf(expandMemoryGlobs(oroot, ["memory/self/**", "memory/fact/**"]).paths);
    expect(withFast.startsWith(slowOnly)).toBe(true); // 前缀字节全等，快层只追加在尾
    // 对照组：旧全局字典序会把 memory/fact/当月.md 排到 memory/self/必读.md 之前。
    expect([...expandMemoryGlobs(oroot, ["memory/self/**", "memory/fact/**"]).paths]).not.toEqual(
      [...expandMemoryGlobs(oroot, ["memory/self/**", "memory/fact/**"]).paths].sort(),
    );
  });

  it("快变文件自身变更：只截断其后的 cache，其前的慢层字节不变", () => {
    const paths = expandMemoryGlobs(oroot, ["memory/self/**", "memory/fact/**"]).paths;
    const before = renderOf(paths);
    writeFileSync(join(oroot, "memory", "fact", "当月.md"), "快层：当月流水 v2（变更）。\n");
    const after = renderOf(paths);
    const slowBlock = "### memory[0] memory/self/必读.md\n慢层：热快照 v1。\n";
    expect(after.startsWith(slowBlock)).toBe(true); // 慢层前缀完好
    expect(before.startsWith(slowBlock)).toBe(true);
    expect(after.slice(slowBlock.length)).not.toBe(before.slice(slowBlock.length)); // 快层块变更
    expect(after.slice(0, slowBlock.length)).toBe(before.slice(0, slowBlock.length)); // 截断点=快层起点
  });
});

describe("缺省语义（硬编码规则钉死，W8' 收紧语义 1 / W33 主会话单件清单）", () => {
  it("主会话 = 仅 AGENTS.md 单件（W33 用户决策 2026-10-12：五件退役转按需读取）；副会话基础集 = 只 AGENTS.md", () => {
    expect(MAIN_SESSION_GLOBS).toEqual(["AGENTS.md"]);
    expect(SIDE_SESSION_BASE_GLOBS).toEqual(["AGENTS.md"]);
    // 冻结形态：单条显式声明（无 glob 元字符）——恢复注入=在此常量加行，绝不吃 glob。
    expect(MAIN_SESSION_GLOBS.length).toBe(1);
    expect(Object.isFrozen(MAIN_SESSION_GLOBS)).toBe(true);
    // 角色文件缺省不存在独立常量：未声明 = SIDE_SESSION_BASE_GLOBS 同集（唯一口径，不许第二常量）。
    expect(MAIN_SESSION_GLOBS.some((g) => g.startsWith("agents"))).toBe(false);
    // W14 钉死、W33 延续：递归 glob 绝不进主会话前缀（archive/月度流水裸吃病灶）。
    expect(MAIN_SESSION_GLOBS.some((g) => g.includes("**"))).toBe(false);
  });

  it("缺省语义 1（钉死）：未声明角色按 SIDE_SESSION_BASE_GLOBS 展开 = 恰 AGENTS.md 一个注入源，memory/** 零命中", () => {
    const expanded = expandMemoryGlobs(root, SIDE_SESSION_BASE_GLOBS);
    expect(expanded.paths).toEqual(["AGENTS.md"]);
    expect(expanded.paths.some((p) => p.startsWith("memory/"))).toBe(false);
    expect(expanded.rejected).toEqual([]);
  });
});

describe("前缀纪律：双跑字节全等", () => {
  it("同 workspace 双跑：展开→resolveMemorySources→renderMemorySegment 字节全等，清单=声明序", () => {
    const runOnce = (): string => {
      const expanded = expandMemoryGlobs(root, MAIN_SESSION_GLOBS);
      const reader = createFsAssemblyReader({ workspaceRoot: root, shards: null });
      const { sources } = resolveMemorySources(reader, expanded.paths);
      return renderMemorySegment(sources);
    };
    expect(runOnce()).toBe(runOnce());
    const text = runOnce();
    expect(text).toContain("### memory[0] AGENTS.md");
    expect(text).toContain("# 一级记忆");
    expect(text.split("### memory[").length - 1).toBe(MAIN_SESSION_GLOBS.length); // W33：清单=单件，前缀恰一件
    // 清单序=声明序（W33 单件序平凡成立），resolve 边界不重排（第二口径=事故）。
    const expanded = expandMemoryGlobs(root, MAIN_SESSION_GLOBS);
    expect(expanded.paths).toEqual([...MAIN_SESSION_GLOBS]);
    // W33 收缩后唯一钉件 AGENTS.md 在本 tmp 树在场 ⇒ 零降级（旧五件时代的三 MISSING 形态退役）。
    // 退役件（memory/README.md 等）此刻只是盘上 inert 文件：不在清单 ⇒ 不进前缀，非"缺位走占位"。
    const reader = createFsAssemblyReader({ workspaceRoot: root, shards: null });
    const { sources, degrades } = resolveMemorySources(reader, expanded.paths);
    expect(sources.map((s) => s.source)).toEqual(["AGENTS.md"]);
    expect(degrades).toEqual([]);
  });
});
