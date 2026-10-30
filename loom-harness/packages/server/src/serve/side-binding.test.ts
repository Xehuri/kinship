/**
 * createSideBindingResolver 测试（B 面：workspace 角色自声明注入接线）。
 * Given: 临时 workspace（不写任何真实工作区文件）——AGENTS.md + memory 树 + agents/*.md
 *        三种形态：声明合法 glob / 无声明（缺省=只 AGENTS.md，W8' 收紧）/ 声明非法越界 glob；
 *        另有一组**只读**投影用例消费仓库 fixture-workspace（影子实例工作区，零写入）。
 * When:  resolver.resolve(ctx)（agent 引用与否）/ mainSessionMemorySources() 双跑
 * Then:  注入集形状 = 角色正文 + 声明序分组渲染块（W14 前缀纪律，唯一真源在声明层），缺省语义逐条钉死；
 *        非法 glob fail-soft（warn 留痕 + 跳过）；双跑 systemPrompt 字节全等。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import type { RunLaunchContext, RunRow } from "@axeuh/loom-core/run-engine";
import { loadAgentTypes } from "@axeuh/loom-core/subagent/agents";
import { createSideBindingResolver } from "./side-binding.js";
import { assembleContextManifest } from "../session-api/context-manifest.js";

let root = "";
let outside = "";

function row(): RunRow {
  return {
    run_id: "run_0123456789abcdef",
    workflow: "w",
    attempt: 1,
    trigger: "manual",
    parent_run: null,
    session_id: "ses_0123456789abcdef",
  };
}

function ctxFor(agent?: string): RunLaunchContext {
  return {
    row: row(),
    prompt: "任务正文",
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loom-sidebind-"));
  outside = mkdtempSync(join(tmpdir(), "loom-sidebind-out-"));
  mkdirSync(join(root, "memory", "fact"), { recursive: true });
  mkdirSync(join(root, "memory", "self"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# 一级记忆\n主会话与副会话共用的稳定背景。\n");
  writeFileSync(join(root, "memory", "fact", "f1.md"), "事实一。\n");
  writeFileSync(join(root, "memory", "fact", "f2.md"), "事实二。\n");
  writeFileSync(join(root, "memory", "self", "偏好.md"), "偏好：简洁。\n");
  writeFileSync(join(outside, "secret.md"), "越界机密，绝不可注入\n");

  // 形态 1：声明合法 glob（多声明，检验声明序分组）+ 指向 workspace 外的声明。
  writeFileSync(join(root, "agents", "checker.md"), [
    "---",
    "name: checker",
    "memory: [AGENTS.md, memory/fact/**, ../leak/**]",
    "---",
    "# 数据检查角色",
    "只做检查，不越界。",
  ].join("\n"));
  // 形态 2：无 memory 声明 → 缺省只注入 AGENTS.md（W8' 收紧语义 1）。
  writeFileSync(join(root, "agents", "plain.md"), ["---", "name: plain", "tags: [x]", "---", "# 无记忆角色"].join("\n"));
  // 形态 4：乱序+重叠声明 → 声明序分组 + 首次保留去重（W14 前缀纪律）。
  writeFileSync(join(root, "agents", "messy.md"), [
    "---",
    "name: messy",
    "memory: [memory/self/**, memory/fact/**, AGENTS.md, memory/fact/f1.md, memory/fact/**]",
    "---",
    "# 乱序声明角色",
  ].join("\n"));
  // 形态 3：声明文件不存在的路径（fail-soft 占位）。
  writeFileSync(join(root, "agents", "ghostmem.md"), ["---", "name: ghostmem", "memory: [missing/x.md]", "---", "# 幽灵引用角色"].join("\n"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolve: 角色引用（缺省语义 3 的引用侧）", () => {
  it("引用 checker：正文=systemPrompt 基底，注入集=声明序分组去重（本声明恰与组内字典序同形）", async () => {
    const warnings: Record<string, unknown>[] = [];
    const resolver = createSideBindingResolver({
      workspaceRoot: root,
      log: (_lvl, msg, fields) => {
        if (msg === "loom memory glob rejected") warnings.push(fields);
      },
    });
    const b = await resolver.resolve(ctxFor("checker.md"));
    if ("error" in b) throw new Error(`不应失败：${b.error}`);
    expect(b.systemPrompt).toContain("# 数据检查角色");
    expect(b.systemPrompt).toContain("### memory[0] AGENTS.md");
    expect(b.systemPrompt).toContain("### memory[1] memory/fact/f1.md");
    expect(b.systemPrompt).toContain("### memory[2] memory/fact/f2.md");
    expect(b.memorySources.map((s) => s.source)).toEqual(["AGENTS.md", "memory/fact/f1.md", "memory/fact/f2.md"]);
    // 越界声明：fail-soft 记警告，不注入任何越界内容。
    expect(warnings.length).toBe(1);
    expect(JSON.stringify(b.systemPrompt)).not.toContain("越界机密");
  });

  it("引用无 memory 声明的角色 = 恰 AGENTS.md 一个注入源、memory/** 零命中（缺省语义 1，W8' 收紧）", async () => {
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    const b = await resolver.resolve(ctxFor("plain"));
    if ("error" in b) throw new Error(`不应失败：${b.error}`);
    expect(b.memorySources.map((s) => s.source)).toEqual(["AGENTS.md"]);
    expect(b.memorySources.some((s) => s.source.startsWith("memory/"))).toBe(false);
    expect(b.systemPrompt).toContain("# 无记忆角色"); // 正文基底仍在
    expect(b.systemPrompt).toContain("### memory[0] AGENTS.md");
    expect(b.systemPrompt).not.toContain("事实一"); // memory/fact 零命中
    expect(b.systemPrompt).not.toContain("偏好：简洁"); // memory/self 零命中
  });

  it("引用乱序+重叠声明的角色 = 声明序分组注入 + 跨声明去重首次保留（W14 前缀纪律）", async () => {
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    const b = await resolver.resolve(ctxFor("messy"));
    if ("error" in b) throw new Error(`不应失败：${b.error}`);
    // 声明序 [self/**, fact/**, AGENTS.md, fact/f1.md, fact/**] ⇒ 组位=首次声明；
    // f1/f2 归 fact 组（第 2 声明），重复的 f1.md/fact/** 不再迁移组位。
    expect(b.memorySources.map((s) => s.source)).toEqual([
      "memory/self/偏好.md",
      "memory/fact/f1.md",
      "memory/fact/f2.md",
      "AGENTS.md",
    ]);
    expect(b.memorySources.every((s) => !s.source.startsWith("memory/archive"))).toBe(true);
  });

  it("声明的文件缺失 → MISSING 占位源（fail-soft，不 throw）", async () => {
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    const b = await resolver.resolve(ctxFor("ghostmem"));
    if ("error" in b) throw new Error(`不应失败：${b.error}`);
    expect(b.memorySources).toHaveLength(1);
    expect(b.memorySources[0]?.degrade?.reason).toBe("missing");
    expect(b.systemPrompt).toContain("[assembly: source missing, degraded]");
  });

  it("未知角色 → error（含可用提示），绝不静默起裸会话", async () => {
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    const b = await resolver.resolve(ctxFor("nope"));
    expect("error" in b ? b.error : "").toContain("nope");
  });

  it("引用 kind:main 声明件 → error \"is kind:main, not dispatchable\"（W17-E 派发面过滤；本测试自造件，不污染其余用例）", async () => {
    writeFileSync(join(root, "agents", "mainperson.md"), ["---", "name: mainperson", "kind: main", "---", "# 主人格声明"].join("\n"));
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    const b = await resolver.resolve(ctxFor("mainperson"));
    expect("error" in b ? b.error : "").toContain("is kind:main, not dispatchable");
  });
});

describe("resolve: 副会话基础集 + 主会话全量（缺省语义 3/2）", () => {
  it("无 agent 引用 → 只 AGENTS.md 基础集（无角色正文）", async () => {
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    const b = await resolver.resolve(ctxFor());
    if ("error" in b) throw new Error(`不应失败：${b.error}`);
    expect(b.memorySources.map((s) => s.source)).toEqual(["AGENTS.md"]);
    expect(b.systemPrompt).toContain("### memory[0] AGENTS.md");
  });

  it("mainSessionMemorySources 无声明 glob（含空数组）= 兜底仅 AGENTS.md 单件（W34：MAIN_SESSION_GLOBS 退役为缺省兜底，五件退役决策仍有效）", () => {
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    const sources = resolver.mainSessionMemorySources();
    // 清单=声明序：兜底恰一件，实载在场 ⇒ 零降级、零 MISSING 占位。
    expect(sources.map((s) => s.source)).toEqual(["AGENTS.md"]);
    expect(sources[0]?.degrade).toBeNull();
    // W34：kind:main 未声明 memory（undefined）或声明空数组时走本兜底；空数组不得展开成零注入。
    expect(resolver.mainSessionMemorySources([]).map((s) => s.source)).toEqual(["AGENTS.md"]);
    expect(resolver.mainSessionMemorySources(undefined).map((s) => s.source)).toEqual(["AGENTS.md"]);
    // 退役清单钉死：四件不再是主会话兜底源（"盘上在场也不注入"由 memory-declaration.test
    // 的展开用例钉；此处钉兜底常量本身——恢复注入的唯一路径是 kind:main 声明 memory
    // （见下方声明用例），或显式改 MAIN_SESSION_GLOBS，别无他路）。
    expect(sources.some((s) => s.source === "memory/README.md")).toBe(false);
    expect(sources.some((s) => s.source === "memory/self/必读.md")).toBe(false);
    expect(sources.some((s) => s.source === "memory/profile/core.md")).toBe(false);
    expect(sources.some((s) => s.source === "memory/fact/总目录.md")).toBe(false);
    // 旧全量病灶钉死不复返（W14 遗产）：memory/fact 流水件不在主会话兜底前缀。
    expect(sources.some((s) => s.source === "memory/fact/f1.md")).toBe(false);
    expect(sources.some((s) => s.source === "memory/self/偏好.md")).toBe(false);
  });

  it("mainSessionMemorySources(声明 glob) = 走 gatherSources 单链展开、声明序分组（W34：kind:main 声明是真源，与角色路径同口径）", () => {
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    // 声明序 [self/**, AGENTS.md, fact/f1.md] ⇒ 组位=首次声明；与 messy 角色用例同族形状，
    // 钉死"主会话消费复用同一 expandMemoryGlobs/resolveMemorySources 链"（禁第二展开实现）。
    const sources = resolver.mainSessionMemorySources(["memory/self/**", "AGENTS.md", "memory/fact/f1.md"]);
    expect(sources.map((s) => s.source)).toEqual(["memory/self/偏好.md", "AGENTS.md", "memory/fact/f1.md"]);
    expect(sources.every((s) => s.degrade === null)).toBe(true);
  });

  it("mainSessionMemorySources(声明含缺失文件) = MISSING 占位源 fail-soft（声明面与角色面同一降级纪律）", () => {
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    const sources = resolver.mainSessionMemorySources(["missing/main-note.md", "AGENTS.md"]);
    expect(sources.map((s) => s.source)).toEqual(["missing/main-note.md", "AGENTS.md"]);
    expect(sources[0]?.degrade?.reason).toBe("missing");
    expect(sources[1]?.degrade).toBeNull();
  });
});

describe("前缀纪律：双跑字节全等", () => {
  it("同一 resolver 两次 resolve 同一角色：systemPrompt 逐字节相等", async () => {
    const resolver = createSideBindingResolver({ workspaceRoot: root });
    const a = await resolver.resolve(ctxFor("checker"));
    const b = await resolver.resolve(ctxFor("checker.md")); // 归一化同目标
    if ("error" in a || "error" in b) throw new Error("双跑不应失败");
    expect(a.systemPrompt).toBe(b.systemPrompt);
    const m = await resolver.resolve(ctxFor());
    const m2 = await resolver.resolve(ctxFor());
    if ("error" in m || "error" in m2) throw new Error("双跑不应失败");
    expect(m.systemPrompt).toBe(m2.systemPrompt);
  });
});

describe("装配期 fail-loud：workspace 根非法", () => {
  it("根不存在 → 构造即抛（装配期响亮，不带病起服务）", () => {
    expect(() => createSideBindingResolver({ workspaceRoot: join(root, "no-such-root") })).toThrow(/workspace 根不可解析/);
  });
});

/**
 * W33 真树只读投影 —— 影子实例 fixture-workspace 上的清单/清单面终检（免 live boot，零写入）。
 * W34 增补声明路：fixture agents/main.md（kind:main）frontmatter memory 声明 11 件，
 * boot 同款姿势（loadAgentTypes 取 kind:main 条目的 memoryGlobs）喂 mainSessionMemorySources
 * ⇒ 清单 = 声明序 11 件；不传声明的旧调用逐字保持兜底 [AGENTS.md]。
 * Given: 仓库根 fixture-workspace（四件退役文件仍在盘上——用户"转按需读取"的实况；
 *        agents/main.md 声明 11 件且件件在盘）
 * When:  mainSessionMemorySources()（兜底）/ mainSessionMemorySources(声明 glob)（声明路）
 *        + assembleContextManifest（boot 同款种子口径现算）
 * Then:  兜底投影 = 恰 AGENTS.md 一件；声明投影 = 11 件声明序、零降级；manifest.memoryFiles
 *        与清单同形（LEAD 实况核验项的离线等价物）。
 */
describe("W33/W34 fixture-workspace 只读投影：兜底 [AGENTS.md]，声明路 = main.md 11 件声明序", () => {
  const repoFixtureWs = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixture-workspace");

  it("不传声明 glob（兜底路）：四件在场（按需可读）但注入清单与 manifest 投影均只剩 AGENTS.md", () => {
    // 前提只读核验：fixture-workspace 与四件确实存在（存在性=决策"只停注入不删文件"的载体）。
    expect(existsSync(join(repoFixtureWs, "AGENTS.md"))).toBe(true);
    for (const retired of ["memory/README.md", "memory/self/必读.md", "memory/profile/core.md", "memory/fact/总目录.md"]) {
      expect(existsSync(join(repoFixtureWs, retired))).toBe(true);
    }
    const resolver = createSideBindingResolver({ workspaceRoot: repoFixtureWs });
    const sources = resolver.mainSessionMemorySources();
    expect(sources.map((s) => s.source)).toEqual(["AGENTS.md"]);
    expect(sources[0]?.degrade).toBeNull();
    // boot 同款种子口径（boot.ts contextSeedFiles 映射）→ assembleContextManifest 只读投影。
    const seeds = sources.map((s) => {
      const st = statSync(join(repoFixtureWs, ...s.source.split("/")));
      return {
        relPath: s.source,
        bootHash: `sha256:${createHash("sha256").update(s.content, "utf8").digest("hex")}`,
        mtimeMs: st.mtimeMs,
        size: st.size,
        content: s.content,
      };
    });
    const manifest = assembleContextManifest({
      memorySources: sources,
      memorySeeds: seeds,
      skillEntries: [],
      skillDegrades: [],
      mcpServers: [],
      mcpStatuses: [],
      agentRoleFiles: [],
      model: { id: "proj", api: "fake", baseUrl: "" },
      apiKeyRaw: undefined,
      configPath: "",
      workspaceRoot: repoFixtureWs,
    });
    expect(manifest.memoryFiles.map((f) => f.relPath)).toEqual(["AGENTS.md"]);
    expect(manifest.memoryFiles[0]?.degrade).toBeNull();
    expect(manifest.memoryFiles[0]?.bytes).toBe(Buffer.byteLength(sources[0]!.content, "utf8"));
  });

  it("声明路：agents/main.md 的 11 件 memory 声明 ⇒ 注入清单 = 声明序 11 件（boot 同款取声明姿势）", async () => {
    // 声明取自 loadAgentTypes（与 boot 的 toolWiring.agentTypeDefs 同源），不硬写 glob 集：
    // 钉的是"消费链"，声明本身由 fixture 文件承载（用户 2026-10-14 配置的 11 件实况）。
    const scan = await loadAgentTypes({ dirs: [join(repoFixtureWs, "agents")], includeBuiltins: false });
    const personaDef = scan.entries.find((e) => e.kind === "main");
    expect(personaDef?.memoryGlobs).toEqual([
      "AGENTS.md",
      "memory/self/必读.md",
      "memory/self/关系.md",
      "memory/self/价值校准.md",
      "memory/self/纠错.md",
      "memory/self/认知.md",
      "memory/self/任务.md",
      "memory/self/身份.md",
      "memory/self/SELF-INDEX.md",
      "memory/profile/core.md",
      "memory/profile/state.md",
    ]);
    const resolver = createSideBindingResolver({ workspaceRoot: repoFixtureWs });
    const sources = resolver.mainSessionMemorySources(personaDef?.memoryGlobs);
    // 顺序 = 声明序（复用 expandMemoryGlobs 单链，组内字典序不跨组重排）。
    expect(sources.map((s) => s.source)).toEqual([
      "AGENTS.md",
      "memory/self/必读.md",
      "memory/self/关系.md",
      "memory/self/价值校准.md",
      "memory/self/纠错.md",
      "memory/self/认知.md",
      "memory/self/任务.md",
      "memory/self/身份.md",
      "memory/self/SELF-INDEX.md",
      "memory/profile/core.md",
      "memory/profile/state.md",
    ]);
    // 11 件全在盘 ⇒ 零 missing/unreadable；仅有的降级只可能是字节契约闸（易变时间戳
    // "YYYY-MM-DD HH:MM" 判 invalid → 占位）——那是 W14 前缀缓存既有纪律，副会话同闸，
    // 不属本接线面。不断言"零降级"是因为 fixture 实况确实触发它（如实钉降级类型而非削足）。
    expect(sources.every((s) => s.degrade === null || s.degrade.reason === "invalid")).toBe(true);
  });

  it("声明路越界/缺失件 = fail-soft 占位，主会话装配绝不 throw（与副会话同纪律）", () => {
    const resolver = createSideBindingResolver({ workspaceRoot: repoFixtureWs });
    const warnings: Record<string, unknown>[] = [];
    const guarded = createSideBindingResolver({
      workspaceRoot: repoFixtureWs,
      log: (_lvl, msg, fields) => {
        if (msg === "loom memory glob rejected") warnings.push(fields);
      },
    });
    const sources = guarded.mainSessionMemorySources(["AGENTS.md", "../../etc/passwd", "memory/nope/x.md"]);
    expect(warnings.length).toBe(1);
    expect(sources.map((s) => s.source)).toEqual(["AGENTS.md", "memory/nope/x.md"]);
    expect(sources[0]?.degrade).toBeNull();
    expect(sources[1]?.degrade?.reason).toBe("missing");
    // 未声明态兜底面不受声明路影响（同一 resolver 双跑：兜底仍是单件）。
    expect(resolver.mainSessionMemorySources().map((s) => s.source)).toEqual(["AGENTS.md"]);
  });
});

/**
 * W35 字节契约开关（server.sourceContract: "strict" | "off"）—— 解析器面接线实测。
 * Given: 独立 tmp 树：memory/self/时戳.md 含 "2026-10-14 08:00"（strict 面必降级的实况形状），
 *        memory/self/nul.md 含 \u0000（二进制面），agents/tsrole.md 声明时戳件（副会话路同闸核验）。
 * When:  同一棵树分别以 sourceContract:"off" / 缺省（strict）构造 resolver，主清单路与 resolve 副路各跑。
 * Then:  off 面：时戳件全文注入（degrade=null、content 逐字节=盘上文本）；
 *        缺省面：时戳件仍 invalid（既有 W14 纪律字节保真，上方 fixture 用例已钉实况降级）；
 *        off 面 NUL 件仍 invalid——二进制闸两 mode 同闸，开关只豁免易变时间戳条款（用户 2026-10-14 决策）。
 */
describe("W35 sourceContract：off 豁免易变时间戳条款、NUL 二进制闸两模式同闸", () => {
  let w35Root = "";

  const TS_TEXT = "## 纠错时间线\n- 2026-10-14 08:00 修正一处口径漂移。\n";
  const NUL_TEXT = "损坏\u0000内容，二进制噪声。\n";

  beforeAll(() => {
    w35Root = mkdtempSync(join(tmpdir(), "loom-w35-"));
    mkdirSync(join(w35Root, "memory", "self"), { recursive: true });
    mkdirSync(join(w35Root, "agents"), { recursive: true });
    writeFileSync(join(w35Root, "AGENTS.md"), "# W35 一级记忆\n");
    writeFileSync(join(w35Root, "memory", "self", "时戳.md"), TS_TEXT);
    writeFileSync(join(w35Root, "memory", "self", "nul.md"), NUL_TEXT);
    writeFileSync(join(w35Root, "agents", "tsrole.md"), [
      "---",
      "name: tsrole",
      "memory: [memory/self/时戳.md]",
      "---",
      "# W35 时戳声明角色",
    ].join("\n"));
  });

  afterAll(() => {
    rmSync(w35Root, { recursive: true, force: true });
  });

  it('主清单路 off：时戳件全文注入（degrade=null，content 逐字节=盘上文本）', () => {
    const resolver = createSideBindingResolver({ workspaceRoot: w35Root, sourceContract: "off" });
    const sources = resolver.mainSessionMemorySources(["memory/self/时戳.md"]);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.degrade).toBeNull();
    expect(sources[0]?.content).toBe(TS_TEXT);
  });

  it("主清单路 缺省 resolver：同件仍 invalid（配对钉死开关面；strict 行为=今日逐字节）", () => {
    const resolver = createSideBindingResolver({ workspaceRoot: w35Root });
    const sources = resolver.mainSessionMemorySources(["memory/self/时戳.md"]);
    expect(sources[0]?.degrade?.reason).toBe("invalid");
    expect(sources[0]?.content).toBe("[assembly: source missing, degraded]");
  });

  it('显式 sourceContract:"strict" = 缺省面逐字节（开关三值语义钉两态一物）', () => {
    const resolver = createSideBindingResolver({ workspaceRoot: w35Root, sourceContract: "strict" });
    const sources = resolver.mainSessionMemorySources(["memory/self/时戳.md"]);
    expect(sources[0]?.degrade?.reason).toBe("invalid");
  });

  it('off 不豁免二进制闸：NUL 件仍 invalid（NUL/binary guard 两模式同闸，决策红线）', () => {
    const resolver = createSideBindingResolver({ workspaceRoot: w35Root, sourceContract: "off" });
    const sources = resolver.mainSessionMemorySources(["memory/self/nul.md"]);
    expect(sources[0]?.degrade?.reason).toBe("invalid");
    expect(sources[0]?.content).not.toContain("\u0000");
  });

  it('副会话 resolve 路同闸：off 下声明时戳件的角色全文注入（gatherSources 单闸覆盖主/副口径）', async () => {
    const off = createSideBindingResolver({ workspaceRoot: w35Root, sourceContract: "off" });
    const b = await off.resolve(ctxFor("tsrole"));
    if ("error" in b) throw new Error(`不应失败：${b.error}`);
    expect(b.systemPrompt).toContain("2026-10-14 08:00 修正一处口径漂移");
    expect(b.systemPrompt).not.toContain("[assembly: source missing, degraded]");
    const strict = createSideBindingResolver({ workspaceRoot: w35Root });
    const s = await strict.resolve(ctxFor("tsrole"));
    if ("error" in s) throw new Error(`不应失败：${s.error}`);
    expect(s.systemPrompt).not.toContain("2026-10-14 08:00");
    expect(s.systemPrompt).toContain("[assembly: source missing, degraded]");
  });
});
