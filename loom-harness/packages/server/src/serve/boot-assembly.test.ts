/**
 * createLoomApp 主会话记忆注入接线测试（B 面装配侧，端到端起停真树、假模型零凭据）。
 * Given: 临时 workspace（AGENTS.md 单件前缀（W33）+ 退役四件镜像仍写盘作在场诱饵：
 *        memory README/self 必读/profile core/fact 总目录 + 月度流水 f1 + agents/checker.md 带 memory 声明）
 *        + 临时 state 根 + fake provider 配置
 * When:  registry.send 一轮 → idle；engine.dispatch 带 agent 的 run
 * Then:  主会话 assembly span 行数>0 且 memory 段含真实 workspace 内容；
 *        trace jsonl 落 kind:"span"/stage:"assembly" 行；
 *        副会话按角色声明装配（fake model 收到的 systemPrompt 可证）。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";

// 加载纪律（vitest 2.x SSR 环解析实测）：boot 图**必须动态 import**（在 barrel 图
// 完整实例化之后加载）。静态 `import { createLoomApp } from "./boot.js"` 会让
// core 桶经 server 环先实例化，ConvergenceGate 绑定残缺——"is not a constructor"，
// 稳定复现且与行序无关。动态入口 = 本文件唯一可靠姿势。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";

/** handle.model 的运行时身份 = core/testing FakeModel（fake 通道唯一 provider）。 */
function fakeModel(app: LoomApp): { getCalls(): readonly { systemPrompt?: string }[] } {
  return app.model.model as unknown as { getCalls(): readonly { systemPrompt?: string }[] };
}

function textOfSegment(segment: { readonly bytes: Uint8Array } | undefined): string {
  return segment === undefined ? "" : new TextDecoder().decode(segment.bytes);
}

const FAKE_YAML = [
  "server:",
  "  port: 5101",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-boot",
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
  work = mkdtempSync(join(tmpdir(), "loom-boot-asm-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(join(ws, "memory", "fact"), { recursive: true });
  mkdirSync(join(ws, "memory", "self"), { recursive: true });
  mkdirSync(join(ws, "memory", "profile"), { recursive: true });
  mkdirSync(join(ws, "agents"), { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# 一级记忆\nBOOT-WORKSPACE-稳定段\nUNIT-B-REQUEST-FACE-MARKER\n");
  // W33 诱饵镜像：退役四件仍写在盘上——唯一真源清单只剩 AGENTS.md，四件必须现形为"不注入"。
  writeFileSync(join(ws, "memory", "README.md"), "BOOT-INDEX-记忆导航\n");
  writeFileSync(join(ws, "memory", "self", "必读.md"), "BOOT-SNAP-热快照\n");
  writeFileSync(join(ws, "memory", "profile", "core.md"), "BOOT-CORE-画像核心\n");
  writeFileSync(join(ws, "memory", "fact", "总目录.md"), "BOOT-FACTINDEX-月度指针\n");
  // 月度流水件在场但绝不进主会话前缀（③出走证明）：只随角色声明注入。
  writeFileSync(join(ws, "memory", "fact", "f1.md"), "BOOT-FACT-一\n");
  writeFileSync(join(ws, "agents", "checker.md"), [
    "---",
    "name: checker",
    "memory: [memory/fact/**]",
    "---",
    "# CHECKER-角色正文",
  ].join("\n"));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function configWithEnv(env: Record<string, string | undefined>): LoomConfig {
  return parseLoomConfig(FAKE_YAML.replace("WS_ROOT", ws), "<test>", { env });
}

async function makeApp(config: LoomConfig): Promise<{ app: LoomApp; store: HotConfigStore; dispose: () => void }> {

  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const app = await createLoomApp({
    config,
    store,
    stateRoot,
    tokens: ["tok-boot-test"],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
  });
  return { app, store, dispose: () => app.model.teardown() };
}

async function waitFor(predicate: () => boolean, budgetMs = 8000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe("createLoomApp：主会话装配前缀 = 真实 workspace 记忆（W33 单件清单）", () => {
  it("send 一轮后 assemblies() 的 memory 段=仅 AGENTS.md；退役四件盘上在场也绝不注入；trace 落 assembly span 行", async () => {
    const cfg = configWithEnv({});
    const { app, dispose } = await makeApp(cfg);
    try {
      const rec = app.registry.create();
      app.registry.send(rec.sessionID, "只作装配触发");
      const settled = await waitFor(() => app.registry.get(rec.sessionID)?.running === null);
      expect(settled, "主会话 run 应在预算内收尾").toBe(true);

      const loop = app.registry.loopOf(rec.sessionID);
      expect(loop).toBeDefined();
      const assemblies = loop?.assemblies() ?? [];
      expect(assemblies.length).toBeGreaterThan(0);
      const first = assemblies[0]!;
      const memoryText = textOfSegment(first.segments.find((s) => s.name === "memory"));
      expect(memoryText).toContain("BOOT-WORKSPACE-稳定段");
      // W33 反向硬证：四件哨兵仍在盘上（beforeAll 诱饵），但一件都不许进前缀。
      expect(memoryText).not.toContain("BOOT-INDEX-记忆导航");
      expect(memoryText).not.toContain("BOOT-SNAP-热快照");
      expect(memoryText).not.toContain("BOOT-CORE-画像核心");
      expect(memoryText).not.toContain("BOOT-FACTINDEX-月度指针");
      expect(memoryText).not.toContain("BOOT-FACT-一"); // ③钉死：月度 fact 流水绝不再裸进前缀
      // 清单=前缀：恰 memory[0] 一件，无 memory[1] 起步的任何尾件。
      expect(memoryText).toContain("### memory[0] AGENTS.md");
      expect(memoryText).not.toContain("### memory[1]");
      expect(first.memorySourceCount).toBe(1);
      // W33 manifest 投影钉：/context/full 面的 memoryFiles = boot 实载只读清单 = 恰 AGENTS.md 一件
      // （单元级真树投影，免 live boot；LEAD 实况核对项 1 的离线等价物）。
      expect(app.contextManifest.memoryFiles.map((f) => f.relPath)).toEqual(["AGENTS.md"]);

      // trace 侧证明：state/trace/{date}.jsonl 有 stage:"assembly" 且 assemblyRowCount>0，
      // attrs.injectedLines>0 = 记忆注入行数硬证（fleet S02 判据口径）。
      const day = new Date();
      const dayKey = `${String(day.getFullYear())}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const tracePath = join(stateRoot, "trace", `${dayKey}.jsonl`);
      expect(existsSync(tracePath)).toBe(true);
      const lines = readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const asm = lines.filter((l) => l["kind"] === "span" && l["stage"] === "assembly");
      expect(asm.length).toBeGreaterThan(0);
      expect(Number(asm[0]?.["assemblyRowCount"])).toBeGreaterThan(0);
      expect(asm[0]?.["sessionId"]).toBe(rec.sessionID);
      const asmAttrs = asm[0]?.["attrs"] as Record<string, unknown>;
      // memory 段 = W33 单件渲染（段头 1 行 + AGENTS.md 3 行），非空行恰 4（旧五件口径退役）。
      expect(Number(asmAttrs["injectedLines"])).toBe(4);
    } finally {
      dispose();
    }
  });

  it("双装配 run：前缀字节跨 run 恒定（同 plan 同 reader ⇒ 同 prefixHash）", async () => {
    const cfg = configWithEnv({});
    const { app, dispose } = await makeApp(cfg);
    try {
      const rec = app.registry.create();
      app.registry.send(rec.sessionID, "第一轮");
      await waitFor(() => app.registry.get(rec.sessionID)?.running === null);
      app.registry.send(rec.sessionID, "第二轮");
      await waitFor(() => app.registry.get(rec.sessionID)?.running === null);
      const assemblies = app.registry.loopOf(rec.sessionID)?.assemblies() ?? [];
      expect(assemblies.length).toBeGreaterThanOrEqual(2);
      const hashes = new Set(assemblies.map((a) => a.prefixHash));
      expect(hashes.size).toBe(1); // 记忆+系统段全恒定，增量只在段3
    } finally {
      dispose();
    }
  });
});

describe("createLoomApp：副会话角色声明接线（engine → binding → fake model）", () => {
  it("dispatch 带 agent 的 run：fake model 收到的 systemPrompt = 角色正文 + 声明注入集", async () => {
    const cfg = configWithEnv({});
    const { app, dispose } = await makeApp(cfg);
    try {
      const launched = await app.engine.dispatch({ workflow: "w-check", prompt: "执行检查", trigger: "manual", agent: "checker" });
      expect(launched.kind).toBe("launched");
      const rec = launched.kind === "launched" ? await launched.completion : null;
      expect(rec?.state).toBe("failed"); // 空脚本 fake 不收敛 → 如实终态（引擎语义，非缺陷）
      const calls = fakeModel(app).getCalls();
      const side = calls.at(-1);
      expect(side?.systemPrompt).toContain("# CHECKER-角色正文");
      expect(side?.systemPrompt).toContain("BOOT-FACT-一");
      expect(side?.systemPrompt).not.toContain("BOOT-WORKSPACE-稳定段"); // 只注入声明的 memory/fact/**
    } finally {
      dispose();
    }
  });

  it("dispatch 无 agent：副会话只 AGENTS.md 基础集（缺省语义 3）", async () => {
    const cfg = configWithEnv({});
    const { app, dispose } = await makeApp(cfg);
    try {
      const launched = await app.engine.dispatch({ workflow: "w-plain", prompt: "无角色任务", trigger: "manual" });
      if (launched.kind === "launched") await launched.completion;
      const calls = fakeModel(app).getCalls();
      const side = calls.at(-1);
      expect(side?.systemPrompt).toContain("BOOT-WORKSPACE-稳定段"); // AGENTS.md 基础集在
      expect(side?.systemPrompt).not.toContain("BOOT-FACT-一"); // 不含 memory/** 全量
      expect(side?.systemPrompt).not.toContain("CHECKER");
    } finally {
      dispose();
    }
  });
});

/**
 * Unit B 请求面（request face）硬证 —— 装配字节此前只进 events/trace（簿记面，
 * S02 假绿的来源），模型实际收到的 Context 从未含 54.7KB 前缀。本 describe 用
 * 假模型的 getCalls()（provider 侧真收包口）钉死接线结局：
 *  Given: 同一棵 boot 树（AGENTS.md 带 UNIT-B-REQUEST-FACE-MARKER 哨兵）
 *  When:  主会话两轮（各 converge 收束）
 *  Then:  ① 每轮 systemPrompt 含 AGENTS.md 哨兵 + W33 单件 memory 渲染 + 身份段（退役四件绝迹）；
 *        ② 跨轮 systemPrompt 逐字节全等（W14 前缀纪律的请求面形态），对话只在尾增长；
 *        ③ sha256(上送 systemPrompt) === 装配事件 prefixHash（发模型的字节 =
 *           trace 声明的前缀，单真源）；本轮 prompt 文本绝不在 systemPrompt（易变不进前缀）。
 */
describe("createLoomApp：主会话装配字节真进 LLM 请求（Unit B 请求面）", () => {
  /** 收束轮（单 turn 收口，一轮恰好一次 LLM call，请求取证序标可控）。 */
  function mainConverge(text: string): FakeAssistantResponse {
    return {
      content: [
        { type: "text", text },
        { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
      ],
    };
  }

  interface CapturedCall {
    readonly systemPrompt?: string;
    readonly messages: readonly unknown[];
  }

  function captureCalls(app: LoomApp): CapturedCall[] {
    return (app.model.model as unknown as {
      push(...r: FakeAssistantResponse[]): void;
      getCalls(): CapturedCall[];
    }).getCalls();
  }

  it("两轮主会话：每轮请求 systemPrompt 含请求面哨兵、跨轮字节全等、sha256=prefixHash", async () => {
    const cfg = configWithEnv({});
    const { app, dispose } = await makeApp(cfg);
    try {
      const fake = app.model.model as unknown as { push(...r: FakeAssistantResponse[]): void };
      const rec = app.registry.create();

      fake.push(mainConverge("Unit B 首轮正文"));
      app.registry.send(rec.sessionID, "取证第一轮");
      expect(await waitFor(() => app.registry.get(rec.sessionID)?.running === null)).toBe(true);

      fake.push(mainConverge("Unit B 次轮正文"));
      app.registry.send(rec.sessionID, "取证第二轮");
      expect(await waitFor(() => app.registry.get(rec.sessionID)?.running === null)).toBe(true);

      // ① 请求面在场：带哨兵的 systemPrompt 进了 provider（非簿记面）。
      const marked = captureCalls(app).filter(
        (c) => (c.systemPrompt ?? "").includes("UNIT-B-REQUEST-FACE-MARKER"),
      );
      expect(marked.length, "两轮请求的 systemPrompt 都必须含 AGENTS.md 哨兵").toBeGreaterThanOrEqual(2);
      const sys0 = marked[0]?.systemPrompt;
      if (sys0 === undefined) throw new Error("unreachable：marked 已证非空");
      expect(sys0).toContain("你是 loom 主会话。"); // 身份段
      expect(sys0).toContain("UNIT-B-REQUEST-FACE-MARKER"); // W33 单件清单 = AGENTS.md 全文进请求面
      // 慢前缀"全量重发"实况：systemPrompt 每轮都携带**新（瘦身后）前缀全文**——W33 升级后
      // 首轮起就是单件全量，退役四件哨兵在请求面绝迹（无 diff 通道可谎报已注入）。
      expect(sys0).not.toContain("BOOT-INDEX-记忆导航");
      expect(sys0).not.toContain("### memory[1]");

      // ② 跨轮字节全等（前缀稳定）：全部带哨兵请求同一串字节。
      for (const call of marked) {
        expect(call.systemPrompt).toBe(sys0);
      }
      // ②' 易变不混前缀：本轮 prompt 文本在 messages 尾，不在 systemPrompt。
      expect(sys0).not.toContain("取证第一轮");
      expect(marked[marked.length - 1]!.messages.length).toBeGreaterThan(marked[0]!.messages.length);

      // ③ 请求字节 = trace 声明前缀：sha256(systemPrompt) 与装配事件 prefixHash 全等。
      const assemblies = app.registry.loopOf(rec.sessionID)?.assemblies() ?? [];
      expect(assemblies.length).toBeGreaterThan(0);
      const hash = `sha256:${createHash("sha256").update(Buffer.from(sys0, "utf8")).digest("hex")}`;
      expect(assemblies[0]!.prefixHash).toBe(hash);
    } finally {
      dispose();
    }
  });
});

/**
 * W17-E 主次声明 —— kind:main 人格绑定与派发拒绝（tmp 工作区 only，零 fixture 人格文件）。
 *  Given: tmp 树 A = AGENTS.md+退役四件诱饵（W33 后仅 AGENTS.md 注入）+ agents/persona.md(kind:main)
 *         + agents/helper.md(缺省 sub)；
 *         tmp 树 B = 双 main（fm1/fm2，清单序取首）
 *  When:  boot（收集 log）→ registry.send 一轮装配 / engine.dispatch(agent=persona|helper)
 *  Then:  ① 装配段0 字节含 persona 正文、占位文案绝迹、frontmatter 键值绝迹（去 frontmatter 实证）；
 *         ② contextManifest.agentRoleFiles persona 条 kind="main"、helper/内置 kind="sub"；
 *         ③ dispatch agent=persona → run 如实 failed + error "kind:main, not dispatchable"（无 500、
 *            不起静默会话）；agent=helper 正常绑定（角色面不动，现状保真）；
 *         ④ 双 main → warn 留痕（files 两件）且段0 = 首个 main 正文；
 *         ⑤ 无 main 现状占位逐字已由上方 Unit B 钉（line "你是 loom 主会话。"断言）。
 */
describe("createLoomApp：W17-E kind:main 主会话人格绑定", () => {
  interface LogEntry {
    readonly level: string;
    readonly msg: string;
    readonly fields: Record<string, unknown>;
  }

  /** AGENTS.md + 退役四件诱饵 + 自定义 agents/*.md 的 tmp 工作树（persona 声明文件只活在这里，不落 fixture）。 */
  function makeWs(agents: readonly { readonly file: string; readonly text: string }[]): string {
    const root = mkdtempSync(join(tmpdir(), "loom-w17e-"));
    const ws = join(root, "ws");
    mkdirSync(join(ws, "memory", "fact"), { recursive: true });
    mkdirSync(join(ws, "memory", "self"), { recursive: true });
    mkdirSync(join(ws, "memory", "profile"), { recursive: true });
    mkdirSync(join(ws, "agents"), { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "W17E-AGENTS-一级记忆\n");
    writeFileSync(join(ws, "memory", "README.md"), "W17E-README\n");
    writeFileSync(join(ws, "memory", "self", "必读.md"), "W17E-SELF\n");
    writeFileSync(join(ws, "memory", "profile", "core.md"), "W17E-CORE\n");
    writeFileSync(join(ws, "memory", "fact", "总目录.md"), "W17E-FACTIDX\n");
    for (const a of agents) writeFileSync(join(ws, "agents", a.file), a.text);
    return root;
  }

  async function bootWs(root: string, logs: LogEntry[], extraServerLines = "", extraTopLines = ""): Promise<LoomApp> {
    const ws = join(root, "ws");
    const stateRoot = join(root, "state");
    // W35：extraServerLines 为 server 段追加行（缺省空串=逐字节旧文本，既有调用零扰动）。
    // W36：extraTopLines 为顶层段追加行（sandbox 段在顶层；缺省空串同样零扰动）。
    const text = FAKE_YAML.replace("  hostname: 127.0.0.1\n", `  hostname: 127.0.0.1\n${extraServerLines}`).replace("WS_ROOT", ws) + extraTopLines;
    const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
    const applied = store.apply(text, "<test>");
    if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
    const config = parseLoomConfig(text, "<test>", { env: {} });
    return createLoomApp({
      config,
      store,
      stateRoot,
      tokens: ["tok-w17e"],
      version: "test",
      env: { LOOM_FAKE_MODEL: "1" },
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    });
  }

  const PERSONA_MD = [
    "---",
    "name: persona",
    "kind: main",
    "description: PERSONA-W17E-FM-DESC",
    "---",
    "# PERSONA-W17E-BODY",
    "身份框正文行",
  ].join("\n");
  const HELPER_MD = ["---", "name: helper", "---", "# HELPER-W17E-BODY"].join("\n");

  it("单 main 声明：段0 = 正文（去 frontmatter），占位绝迹；manifest 条带 kind；派发面 helper 正常/persona 拒绝", async () => {
    const root = makeWs([
      { file: "persona.md", text: PERSONA_MD },
      { file: "helper.md", text: HELPER_MD },
    ]);
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        // 绑定留痕：info 日志指向 persona 文件。
        const bound = logs.find((l) => l.msg === "loom main persona bound");
        expect(bound?.level).toBe("info");
        expect(String(bound?.fields["file"])).toContain("persona.md");

        // ① 装配面：段0 字节 = persona 正文，frontmatter 键值与占位文案绝迹。
        const rec = app.registry.create();
        app.registry.send(rec.sessionID, "装配触发");
        expect(await waitFor(() => app.registry.get(rec.sessionID)?.running === null)).toBe(true);
        const assemblies = app.registry.loopOf(rec.sessionID)?.assemblies() ?? [];
        expect(assemblies.length).toBeGreaterThan(0);
        const sysText = textOfSegment(assemblies[0]!.segments.find((s) => s.name === "system"));
        expect(sysText).toContain("# PERSONA-W17E-BODY");
        expect(sysText).toContain("身份框正文行");
        expect(sysText).not.toContain("你是 loom 主会话。");
        expect(sysText).not.toContain("PERSONA-W17E-FM-DESC"); // 去 frontmatter（description 不入正文）
        expect(sysText).not.toContain("kind:");
        // 请求面同源：发模型的 systemPrompt 段0 同一批字节。
        const calls = fakeModel(app).getCalls();
        expect(calls.at(-1)?.systemPrompt).toContain("# PERSONA-W17E-BODY");

        // ② manifest：persona 条 kind=main，helper/内置 kind=sub（v2 wire 形状不动，additive 字段）。
        const roles = app.contextManifest.agentRoleFiles;
        expect(roles.find((r) => r.name === "persona")?.kind).toBe("main");
        expect(roles.find((r) => r.name === "helper")?.kind).toBe("sub");
        expect(roles.find((r) => r.name === "general")?.kind).toBe("sub");

        // ③ 派发拒绝面：agent=persona → run 如实 failed + 清晰 error（无 500 通道、不起会话）。
        const rejected = await app.engine.dispatch({ workflow: "w17e-rej", prompt: "派人格", trigger: "manual", agent: "persona" });
        expect(rejected.kind).toBe("launched"); // 异步开火形状（与未知 agent 同族既有语义）
        const rejRec = rejected.kind === "launched" ? await rejected.completion : null;
        expect(rejRec?.state).toBe("failed");
        expect(String(rejRec?.error)).toContain("is kind:main, not dispatchable");

        // ③' 对照：helper（缺省 sub）绑定面逐字不动。
        const ok = await app.engine.dispatch({ workflow: "w17e-ok", prompt: "派帮手", trigger: "manual", agent: "helper" });
        if (ok.kind === "launched") await ok.completion;
        const side = fakeModel(app).getCalls().at(-1);
        expect(side?.systemPrompt).toContain("# HELPER-W17E-BODY");
        expect(side?.systemPrompt).not.toContain("PERSONA-W17E-BODY");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("双 main 声明：按清单序取首个正文 + warn 留痕（第二件绝不进段0）", async () => {
    const root = makeWs([
      { file: "fm1.md", text: ["---", "name: fm_one", "kind: main", "---", "# FM1-W17E-FIRST"].join("\n") },
      { file: "fm2.md", text: ["---", "name: fm_two", "kind: MAIN", "---", "# FM2-W17E-SECOND"].join("\n") },
    ]);
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        const warn = logs.find((l) => l.msg === "loom multiple main persona declarations (first wins)");
        expect(warn?.level).toBe("warn");
        expect(warn?.fields["files"]).toEqual([
          expect.stringContaining("fm1.md"),
          expect.stringContaining("fm2.md"),
        ]);
        const rec = app.registry.create();
        app.registry.send(rec.sessionID, "装配触发");
        expect(await waitFor(() => app.registry.get(rec.sessionID)?.running === null)).toBe(true);
        const sysText = textOfSegment(
          app.registry.loopOf(rec.sessionID)?.assemblies()[0]?.segments.find((s) => s.name === "system"),
        );
        expect(sysText).toContain("# FM1-W17E-FIRST");
        expect(sysText).not.toContain("FM2-W17E-SECOND");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // W34：kind:main frontmatter memory 声明是主会话注入清单的真源；MAIN_SESSION_GLOBS 退役为
  // 声明缺席时的兜底。两案分别钉"声明优先"与"兜底保真"，并验 boot 留痕日志形状。
  it("kind:main 声明 memory [AGENTS.md, memory/self/必读.md]：主 roster = 声明序 2 件（声明路，非兜底）", async () => {
    const root = makeWs([
      {
        file: "main.md",
        text: [
          "---",
          "name: main",
          "kind: main",
          "memory: [AGENTS.md, memory/self/必读.md]",
          "---",
          "# W34-PERSONA-BODY",
        ].join("\n"),
      },
    ]);
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        // boot 留痕：roster info 行 = declared 源 + 2 件 + 实载字节。
        const roster = logs.find((l) => l.msg === "loom main memory roster");
        expect(roster?.level).toBe("info");
        expect(roster?.fields["source"]).toBe("declared");
        expect(roster?.fields["count"]).toBe(2);
        expect(roster?.fields["bytes"]).toBe(
          Buffer.byteLength("W17E-AGENTS-一级记忆\n", "utf8") + Buffer.byteLength("W17E-SELF\n", "utf8"),
        );
        // manifest 投影 = 清单同形（下游 contextSeedFiles/manifest 皆由 plan.memorySources 派生）。
        expect(app.contextManifest.memoryFiles.map((f) => f.relPath)).toEqual([
          "AGENTS.md",
          "memory/self/必读.md",
        ]);
        // 装配面实弹：memory 段按声明序渲染两件；未声明诱饵件（README/CORE/FACTIDX）绝迹。
        const rec = app.registry.create();
        app.registry.send(rec.sessionID, "装配触发");
        expect(await waitFor(() => app.registry.get(rec.sessionID)?.running === null)).toBe(true);
        const first = app.registry.loopOf(rec.sessionID)?.assemblies()[0];
        const memoryText = textOfSegment(first?.segments.find((s) => s.name === "memory"));
        expect(memoryText).toContain("### memory[0] AGENTS.md");
        expect(memoryText).toContain("### memory[1] memory/self/必读.md");
        expect(memoryText).toContain("W17E-SELF");
        expect(memoryText).not.toContain("W17E-README");
        expect(memoryText).not.toContain("W17E-CORE");
        expect(memoryText).not.toContain("W17E-FACTIDX");
        expect(first?.memorySourceCount).toBe(2);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("kind:main 无 memory 声明：主 roster = 兜底常量恰 AGENTS.md 单件（source=fallback，W33 形态保真）", async () => {
    const root = makeWs([{ file: "main.md", text: PERSONA_MD }]);
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        const roster = logs.find((l) => l.msg === "loom main memory roster");
        expect(roster?.level).toBe("info");
        expect(roster?.fields["source"]).toBe("fallback");
        expect(roster?.fields["count"]).toBe(1);
        expect(roster?.fields["bytes"]).toBe(Buffer.byteLength("W17E-AGENTS-一级记忆\n", "utf8"));
        expect(app.contextManifest.memoryFiles.map((f) => f.relPath)).toEqual(["AGENTS.md"]);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * W35 字节契约开关 boot 面 —— info 日志留痕 + off 全链生效端到端实测。
   * Given: makeWs 树 + persona 声明 [AGENTS.md, memory/self/时戳.md]（时戳件含
   *        "2026-10-14 08:00"，strict 面必降级、off 面应全文）。
   * When:  bootWs 双路：server 段声明 sourceContract: off / 键缺席（缺省 strict）。
   *  Then:  off 路 = "loom memory source contract" {mode:"off"} + roster bytes 计入时戳件全文；
   *         缺省路 = {mode:"strict"}（boot 日志面=唯一缺省材料化点）+ 时戳件降级占位、
   *         roster bytes 不含之——与现网今日行为逐字节同形（W14 纪律保真）。
   */
  const W35_PERSONA_MD = [
    "---",
    "name: main",
    "kind: main",
    "memory: [AGENTS.md, memory/self/时戳.md]",
    "---",
    "# W35-PERSONA-BODY",
  ].join("\n");
  const W35_TS_TEXT = "W35 时戳行 2026-10-14 08:00 实况形状\n";

  it("W35 sourceContract: off 声明：contract info {mode:off} 留痕 + 时戳件全文进 roster 字节", async () => {
    const root = makeWs([{ file: "main.md", text: W35_PERSONA_MD }]);
    writeFileSync(join(root, "ws", "memory", "self", "时戳.md"), W35_TS_TEXT);
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs, "  sourceContract: off\n");
      try {
        const contract = logs.find((l) => l.msg === "loom memory source contract");
        expect(contract?.level).toBe("info");
        expect(contract?.fields["mode"]).toBe("off");
        const roster = logs.find((l) => l.msg === "loom main memory roster");
        expect(roster?.fields["count"]).toBe(2);
        // off 面时戳件全文实载 → roster bytes 计入其字节（degrade 件不计的既有口径反证全文在位）。
        expect(roster?.fields["bytes"]).toBe(
          Buffer.byteLength("W17E-AGENTS-一级记忆\n", "utf8") + Buffer.byteLength(W35_TS_TEXT, "utf8"),
        );
        expect(app.contextManifest.memoryFiles[1]?.degrade).toBeNull();
        expect(app.contextManifest.memoryFiles[1]?.bytes).toBe(Buffer.byteLength(W35_TS_TEXT, "utf8"));
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W35 键缺省：contract info {mode:strict}（日志面唯一缺省材料化点）+ 时戳件仍降级（今日行为逐字节）", async () => {
    const root = makeWs([{ file: "main.md", text: W35_PERSONA_MD }]);
    writeFileSync(join(root, "ws", "memory", "self", "时戳.md"), W35_TS_TEXT);
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        const contract = logs.find((l) => l.msg === "loom memory source contract");
        expect(contract?.level).toBe("info");
        expect(contract?.fields["mode"]).toBe("strict");
        const roster = logs.find((l) => l.msg === "loom main memory roster");
        expect(roster?.fields["count"]).toBe(2);
        // strict 面时戳件 invalid → 占位不计字节：bytes 恰等于 AGENTS.md 单件实载。
        expect(roster?.fields["bytes"]).toBe(Buffer.byteLength("W17E-AGENTS-一级记忆\n", "utf8"));
        expect(app.contextManifest.memoryFiles[1]?.degrade).toBe("invalid");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * W36 沙箱策略 boot 面 —— info 日志留痕（缺省材料化唯一面）。
 * Given: makeWs 树（无 sandbox 段 / 显式 sandbox 段）。
 * When:  bootWs 两路。
 * Then:  缺省路 = "loom sandbox policy" {containment:"strict", net:"allow", denies:0}
 *         （日志面=唯一缺省材料化点）；显式路 = 逐值透传 {containment:"off", net:"deny", denies:2}。
 */
describe("createLoomApp：W36 沙箱策略日志面（sandbox 段）", () => {
  interface LogEntry {
    readonly level: string;
    readonly msg: string;
    readonly fields: Record<string, unknown>;
  }

  function makeWs(): string {
    const root = mkdtempSync(join(tmpdir(), "loom-w36-"));
    const ws = join(root, "ws");
    mkdirSync(join(ws, "agents"), { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "W36-AGENTS\n");
    return root;
  }

  async function bootWs(root: string, logs: LogEntry[], extraTopLines = ""): Promise<LoomApp> {
    const ws = join(root, "ws");
    const stateRoot = join(root, "state");
    const text = FAKE_YAML.replace("WS_ROOT", ws) + extraTopLines;
    const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
    const applied = store.apply(text, "<test>");
    if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
    const config = parseLoomConfig(text, "<test>", { env: {} });
    return createLoomApp({
      config,
      store,
      stateRoot,
      tokens: ["tok-w36"],
      version: "test",
      env: { LOOM_FAKE_MODEL: "1" },
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    });
  }

  it("W36 sandbox 键缺省：policy info {containment:strict, net:allow, denies:0}（日志面唯一缺省材料化点）", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        const policy = logs.find((l) => l.msg === "loom sandbox policy");
        expect(policy?.level).toBe("info");
        expect(policy?.fields["containment"]).toBe("strict");
        expect(policy?.fields["net"]).toBe("allow");
        expect(policy?.fields["denies"]).toBe(0);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W36 sandbox 显式段：policy info 逐值透传 {containment:off, net:deny, denies:2}", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = '\nsandbox:\n  containment: off\n  net: deny\n  deny: [sudo, "git push"]\n';
    try {
      const app = await bootWs(root, logs, top);
      try {
        const policy = logs.find((l) => l.msg === "loom sandbox policy");
        expect(policy?.level).toBe("info");
        expect(policy?.fields["containment"]).toBe("off");
        expect(policy?.fields["net"]).toBe("deny");
        expect(policy?.fields["denies"]).toBe(2);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * W42c 三新配置段的 boot 日志面 + 运行对象抵达 ——
 * Given: makeWs/bootWs 树（三段全缺席 / 各段显式声明）。
 *  When: bootWs 起树抓 info 日志；convergence 声明路另 registry.ensure 一把真 loop 对象。
 * Then:  缺席路 = "loom subagent limits"{8,2,16,turns:50,default} + "loom convergence"{5,3,60,2,default}
 *         + "loom llm error retries"{2,default}——`?? 常数` 只是本日志面的缺省重述
 *         （= core 冻结值逐字节等价），全链 undefined-honest（limits 键不进 registry/sidePort、
 *         llmErrorRetries 键不进 MainSessionLoop、subagentLimits 不覆写不写字段）；
 *         声明路 = 各线值=声明值 + source:"declared"，且 registry.ensure 出的真 loop 的
 *         limits.turnHardCap=150（config→boot 物化→registry.limits 既有缝→loop/gate 同引用
 *         ——MUST DO"闸对象真正吃到"的 server 面直证；gate 持同一对象见 loop.ts wireParts
 *         `new ConvergenceGate({ kind: "main", limits })`，core 侧既有钉）。
 * W40 用例风格照抄（自带临时树，两态双抓，互不依赖）。
 */
describe("createLoomApp：W42c 三新段日志面与闸抵达", () => {
  interface LogEntry {
    readonly level: string;
    readonly msg: string;
    readonly fields: Record<string, unknown>;
  }

  function makeWs(): string {
    const root = mkdtempSync(join(tmpdir(), "loom-w42c-"));
    const ws = join(root, "ws");
    mkdirSync(join(ws, "agents"), { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "W42C-AGENTS\n");
    return root;
  }

  async function bootWs(root: string, logs: LogEntry[], extraTopLines = ""): Promise<LoomApp> {
    const ws = join(root, "ws");
    const stateRoot = join(root, "state");
    const text = FAKE_YAML.replace("WS_ROOT", ws) + extraTopLines;
    const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
    const applied = store.apply(text, "<test>");
    if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
    const config = parseLoomConfig(text, "<test>", { env: {} });
    return createLoomApp({
      config,
      store,
      stateRoot,
      tokens: ["tok-w42c"],
      version: "test",
      env: { LOOM_FAKE_MODEL: "1" },
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    });
  }

  it("W42c 三段全缺席：limits{8,2,16,default}+convergence{5,3,60,2,default}+llm{2,default}，loop.limits 保冻结值", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        const limits = logs.find((l) => l.msg === "loom subagent limits");
        expect(limits?.level).toBe("info");
        expect(limits?.fields["fanout"]).toBe(8);
        expect(limits?.fields["depth"]).toBe(2);
        expect(limits?.fields["inflight"]).toBe(16);
        expect(limits?.fields["turns"]).toBe(50);
        expect(limits?.fields["turnsSource"]).toBe("default");
        expect(limits?.fields["source"]).toBe("default");
        const conv = logs.find((l) => l.msg === "loom convergence");
        expect(conv?.level).toBe("info");
        expect(conv?.fields["nudgeLimit"]).toBe(5);
        expect(conv?.fields["escalateSameError"]).toBe(3);
        expect(conv?.fields["turnHardCap"]).toBe(60);
        expect(conv?.fields["autoContinuations"]).toBe(2);
        expect(conv?.fields["source"]).toBe("default");
        const llm = logs.find((l) => l.msg === "loom llm error retries");
        expect(llm?.level).toBe("info");
        expect(llm?.fields["count"]).toBe(2);
        expect(llm?.fields["source"]).toBe("default");
        expect(llm?.fields["backoffMs"]).toBe(1000);
        expect(llm?.fields["backoffSource"]).toBe("default");
        // undefined-honest 抵达钉：不注入 limits 键 → loop 走 `opts.limits ?? {...DEFAULT_LIMITS}`，
        // 值 = 冻结面（行为逐字节 = 现网旧面）。
        const rec = app.registry.ensure("w42c-absent");
        expect(rec.loop.limits.turnHardCap).toBe(60);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W42c 段只含 deadline（W40 路）：limits 行仍 source:default（deadline 键不参与本行判源）", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = "\nsubagent:\n  backgroundDeadlineSeconds: 3600\n";
    try {
      const app = await bootWs(root, logs, top);
      try {
        const limits = logs.find((l) => l.msg === "loom subagent limits");
        expect(limits?.fields["fanout"]).toBe(8);
        expect(limits?.fields["turns"]).toBe(50);
        expect(limits?.fields["turnsSource"]).toBe("default");
        expect(limits?.fields["source"]).toBe("default");
        const deadline = logs.find((l) => l.msg === "loom subagent deadline");
        expect(deadline?.fields["source"]).toBe("declared");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W42c subagent 三键声明：limits 线 {fanout:4,depth:3,inflight:20,source:declared}", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = "\nsubagent:\n  maxFanout: 4\n  maxDepth: 3\n  maxInflightTotal: 20\n";
    try {
      const app = await bootWs(root, logs, top);
      try {
        const limits = logs.find((l) => l.msg === "loom subagent limits");
        expect(limits?.level).toBe("info");
        expect(limits?.fields["fanout"]).toBe(4);
        expect(limits?.fields["depth"]).toBe(3);
        expect(limits?.fields["inflight"]).toBe(20);
        expect(limits?.fields["turns"]).toBe(50);
        expect(limits?.fields["turnsSource"]).toBe("default");
        expect(limits?.fields["source"]).toBe("declared");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W59 subagent maxTurns 声明：limits 线 {turns:150,turnsSource:declared}，fanout 三键仍 default", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = "\nsubagent:\n  maxTurns: 150\n";
    try {
      const app = await bootWs(root, logs, top);
      try {
        const limits = logs.find((l) => l.msg === "loom subagent limits");
        expect(limits?.level).toBe("info");
        expect(limits?.fields["turns"]).toBe(150);
        expect(limits?.fields["turnsSource"]).toBe("declared");
        expect(limits?.fields["fanout"]).toBe(8);
        expect(limits?.fields["depth"]).toBe(2);
        expect(limits?.fields["inflight"]).toBe(16);
        expect(limits?.fields["source"]).toBe("default");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "W59 subagent maxTurns=3 全链：boot 装配的 task 工具真子会话 3 轮封顶 → reason=max_turns / turns:3",
    async () => {
      const root = makeWs();
      const logs: LogEntry[] = [];
      const top = "\nsubagent:\n  maxTurns: 3\n";
      try {
        const app = await bootWs(root, logs, top);
        try {
          const limits = logs.find((l) => l.msg === "loom subagent limits");
          expect(limits?.fields["turns"]).toBe(3);
          expect(limits?.fields["turnsSource"]).toBe("declared");

          const fake = app.model.model as unknown as { push(...r: FakeAssistantResponse[]): void };
          fake.push(
            { content: [{ type: "toolCall", id: "w59-boot-t1", name: "ls", arguments: { path: "." } }] },
            { content: [{ type: "toolCall", id: "w59-boot-t2", name: "ls", arguments: { path: "." } }] },
            { content: [{ type: "toolCall", id: "w59-boot-t3", name: "ls", arguments: { path: "." } }] },
          );
          const task = app.tools.find((t) => t.name === "task");
          expect(task).toBeDefined();
          const { ctx } = createTestContext();
          const r = await task!.execute(
            { agent_type: "general", task: "连续三轮 ls 空转，不要收束" },
            ctx,
            new AbortController().signal,
          );
          const text = JSON.stringify(r.content);
          expect(text).toContain("<task_metadata>");
          expect(text).toContain("reason: max_turns");
          expect(text).toContain("turns: 3");
        } finally {
          app.model.teardown();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("W42c convergence 声明 turnHardCap:150：日志线四值混合 + 主会话闸对象真吃到（loop.limits 引用）", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = "\nconvergence:\n  turnHardCap: 150\n";
    try {
      const app = await bootWs(root, logs, top);
      try {
        const conv = logs.find((l) => l.msg === "loom convergence");
        expect(conv?.level).toBe("info");
        expect(conv?.fields["turnHardCap"]).toBe(150);
        expect(conv?.fields["nudgeLimit"]).toBe(5);
        expect(conv?.fields["escalateSameError"]).toBe(3);
        expect(conv?.fields["autoContinuations"]).toBe(2);
        expect(conv?.fields["source"]).toBe("declared");
        // 抵达钉：boot 物化的 Limits 引用经 registry.limits 既有缝进 MainSessionLoop，
        // 同对象即 gate.limits（wireParts 单构造面共享）——配置值活在闸上。
        const rec = app.registry.ensure("w42c-conv");
        expect(rec.loop.limits.turnHardCap).toBe(150);
        expect(rec.loop.limits.nudgeLimit).toBe(5);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W42c convergence 四键全声明：日志线逐值透传 declared", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top =
      "\nconvergence:\n  nudgeLimit: 8\n  escalateSameError: 4\n  turnHardCap: 120\n  autoContinuations: 0\n";
    try {
      const app = await bootWs(root, logs, top);
      try {
        const conv = logs.find((l) => l.msg === "loom convergence");
        expect(conv?.fields["nudgeLimit"]).toBe(8);
        expect(conv?.fields["escalateSameError"]).toBe(4);
        expect(conv?.fields["turnHardCap"]).toBe(120);
        expect(conv?.fields["autoContinuations"]).toBe(0);
        expect(conv?.fields["source"]).toBe("declared");
        const rec = app.registry.ensure("w42c-full");
        expect(rec.loop.limits.autoContinuations).toBe(0);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W42c llm 声明 errorRetries:0：线 {count:0,source:declared}（0=显式禁用，非缺席）", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = "\nllm:\n  errorRetries: 0\n";
    try {
      const app = await bootWs(root, logs, top);
      try {
        const llm = logs.find((l) => l.msg === "loom llm error retries");
        expect(llm?.level).toBe("info");
        expect(llm?.fields["count"]).toBe(0);
        expect(llm?.fields["source"]).toBe("declared");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T4 llm 声明 errorRetryBackoffMs:250：线 {backoffMs:250,backoffSource:declared}，count/source 各自判源", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = "\nllm:\n  errorRetryBackoffMs: 250\n";
    try {
      const app = await bootWs(root, logs, top);
      try {
        const llm = logs.find((l) => l.msg === "loom llm error retries");
        expect(llm?.level).toBe("info");
        expect(llm?.fields["backoffMs"]).toBe(250);
        expect(llm?.fields["backoffSource"]).toBe("declared");
        expect(llm?.fields["count"]).toBe(2);
        expect(llm?.fields["source"]).toBe("default");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * W40 后台子智能体 deadline boot 日志面 —— info 留痕（缺省材料化唯一面，W35/W36 同款放置）。
 * Given: makeWs 树（无 subagent 段 / 显式 subagent 段声明 3600）。
 *  When:  bootWs 两路起树，抓 info 日志。
 * Then:  缺省路 = "loom subagent deadline" {seconds:900, source:"default"}——900 只是
 *         core DEFAULT_BACKGROUND_DEADLINE_MS（15min）在本日志面的重述，代码路径仍
 *         undefined-honest（不写 limits 字段，task-tool 派发时刻 ?? 兜常量）；
 *         声明路 = {seconds:3600, source:"declared"}（config→wiring 可变 limits 对象的
 *         字段值接线钉在 boot-tools.test.ts W40 用例，两面无重复覆盖）。
 */
describe("createLoomApp：W40 后台 deadline 日志面（subagent 段）", () => {
  interface LogEntry {
    readonly level: string;
    readonly msg: string;
    readonly fields: Record<string, unknown>;
  }

  function makeWs(): string {
    const root = mkdtempSync(join(tmpdir(), "loom-w40-"));
    const ws = join(root, "ws");
    mkdirSync(join(ws, "agents"), { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "W40-AGENTS\n");
    return root;
  }

  async function bootWs(root: string, logs: LogEntry[], extraTopLines = ""): Promise<LoomApp> {
    const ws = join(root, "ws");
    const stateRoot = join(root, "state");
    const text = FAKE_YAML.replace("WS_ROOT", ws) + extraTopLines;
    const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
    const applied = store.apply(text, "<test>");
    if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
    const config = parseLoomConfig(text, "<test>", { env: {} });
    return createLoomApp({
      config,
      store,
      stateRoot,
      tokens: ["tok-w40"],
      version: "test",
      env: { LOOM_FAKE_MODEL: "1" },
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    });
  }

  it("W40 subagent 键缺席：deadline info {seconds:900, source:default}（日志面=唯一缺省材料化点）", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        const deadline = logs.find((l) => l.msg === "loom subagent deadline");
        expect(deadline?.level).toBe("info");
        expect(deadline?.fields["seconds"]).toBe(900);
        expect(deadline?.fields["source"]).toBe("default");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W40 subagent 显式 3600：deadline info {seconds:3600, source:declared}", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = "\nsubagent:\n  backgroundDeadlineSeconds: 3600\n";
    try {
      const app = await bootWs(root, logs, top);
      try {
        const deadline = logs.find((l) => l.msg === "loom subagent deadline");
        expect(deadline?.level).toBe("info");
        expect(deadline?.fields["seconds"]).toBe(3600);
        expect(deadline?.fields["source"]).toBe("declared");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * W49-C compaction 段 boot 日志面（commit 1：留痕与 WARN，接线钉见下一 describe）——
 * Given: bootWs 树（段缺席 / enabled:true 最小 / 生产全量声明 / 在场禁用）。
 *  When: bootWs 起树抓日志行。
 * Then:  缺席路 = "loom compaction" info {enabled:false, ..., source:"default"}（`?? 兜值`
 *         只是本日志面缺省重述，链上零注册）；声明路 = 逐值透传 + source:"declared"；
 *         enabled:true 且 maxContextTokens 缺席且模型窗 ≥200K（T2：窗口路径阈值
 *         ≈contextWindow−4096 实操不可达）= warn 行"trigger likely unreachable"在场；
 *         显式给了 maxContextTokens 或整段缺席 = warn 绝不相干。
 */
describe("createLoomApp：W49-C compaction 日志面与 1M 窗 WARN", () => {
  interface LogEntry {
    readonly level: string;
    readonly msg: string;
    readonly fields: Record<string, unknown>;
  }

  function makeWs(): string {
    const root = mkdtempSync(join(tmpdir(), "loom-w49c-log-"));
    const ws = join(root, "ws");
    mkdirSync(join(ws, "agents"), { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "W49C-AGENTS\n");
    return root;
  }

  async function bootWs(root: string, logs: LogEntry[], extraTopLines = ""): Promise<LoomApp> {
    const ws = join(root, "ws");
    const stateRoot = join(root, "state");
    const text = FAKE_YAML.replace("WS_ROOT", ws) + extraTopLines;
    const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
    const applied = store.apply(text, "<test>");
    if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
    const config = parseLoomConfig(text, "<test>", { env: {} });
    return createLoomApp({
      config,
      store,
      stateRoot,
      tokens: ["tok-w49c"],
      version: "test",
      env: { LOOM_FAKE_MODEL: "1" },
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    });
  }

  it("W49-C compaction 段缺席：info {enabled:false,triggerRatio:0.8,keepRecent:6,boundary:false,microcompact:false,source:default} 且无 WARN", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        const line = logs.find((l) => l.msg === "loom compaction");
        expect(line?.level).toBe("info");
        expect(line?.fields["enabled"]).toBe(false);
        expect(line?.fields["maxContextTokens"]).toBeNull();
        expect(line?.fields["triggerRatio"]).toBe(0.8);
        expect(line?.fields["keepRecent"]).toBe(6);
        expect(line?.fields["boundary"]).toBe(false);
        expect(line?.fields["microcompact"]).toBe(false);
        expect(line?.fields["summaryMode"]).toBeNull();
        expect(line?.fields["summaryReasoningEffort"]).toBeNull();
        expect(line?.fields["summaryBudget"]).toBeNull();
        expect(line?.fields["summaryTemplate"]).toBe("legacy-9");
        expect(line?.fields["summaryProjection"]).toBe(false);
        expect(line?.fields["source"]).toBe("default");
        expect(logs.some((l) => l.level === "warn" && l.msg.includes("trigger likely unreachable"))).toBe(false);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C enabled:true 最小声明（无 maxContextTokens，fake 窗 200000）：source:declared + T2 WARN 在场", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs, "\ncompaction:\n  enabled: true\n");
      try {
        const line = logs.find((l) => l.msg === "loom compaction");
        expect(line?.fields["enabled"]).toBe(true);
        expect(line?.fields["source"]).toBe("declared");
        expect(line?.fields["resummarizeEvery"]).toBe(6); // 兜 keepRecent 缺省链重述
        const warn = logs.find((l) => l.level === "warn" && l.msg.includes("trigger likely unreachable"));
        expect(warn).toBeDefined();
        expect(warn?.fields["contextWindow"]).toBe(200000);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C 生产全量声明：逐值透传 declared、microcompact:true、显式预算下 WARN 绝不相干", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = [
      "",
      "compaction:",
      "  enabled: true",
      "  maxContextTokens: 250000",
      "  triggerRatio: 0.8",
      "  keepRecent: 8",
      "  resummarizeEvery: 16",
      "  summaryTimeoutMs: 60000",
      "  microcompact:",
      "    enabled: true",
      "    triggerTokens: 150000",
      "    compactableTools: [read]",
      "",
    ].join("\n");
    try {
      const app = await bootWs(root, logs, top);
      try {
        const line = logs.find((l) => l.msg === "loom compaction");
        expect(line?.fields["enabled"]).toBe(true);
        expect(line?.fields["maxContextTokens"]).toBe(250000);
        expect(line?.fields["triggerRatio"]).toBe(0.8);
        expect(line?.fields["keepRecent"]).toBe(8);
        expect(line?.fields["resummarizeEvery"]).toBe(16);
        expect(line?.fields["boundary"]).toBe(false);
        expect(line?.fields["microcompact"]).toBe(true);
        expect(line?.fields["source"]).toBe("declared");
        expect(logs.some((l) => l.level === "warn" && l.msg.includes("trigger likely unreachable"))).toBe(false);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C 单次调用摘要声明：日志面 summaryMode/summaryReasoningEffort/summaryBudget/summaryTemplate/summaryProjection 逐值留痕", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = [
      "",
      "compaction:",
      "  enabled: true",
      "  fallbackTokens: 750000",
      "  summaryMode: single",
      "  summaryReasoningEffort: high",
      "  singleCallBudgetTokens: 500000",
      "  microcompact:",
      "    enabled: true",
      "    triggerTokens: 150000",
      "    compactableTools: [read]",
      "",
    ].join("\n");
    try {
      const app = await bootWs(root, logs, top);
      try {
        const line = logs.find((l) => l.msg === "loom compaction");
        expect(line?.fields["summaryMode"]).toBe("single");
        expect(line?.fields["summaryReasoningEffort"]).toBe("high");
        expect(line?.fields["summaryBudget"]).toBe(500000);
        expect(line?.fields["summaryTemplate"]).toBe("compact-6");
        expect(line?.fields["summaryProjection"]).toBe(true);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C 摘要视角缺省：worker 日志 summaryPerspectives=ops+chat，summaryTemplate 仍 compact-6", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = [
      "",
      "compaction:",
      "  enabled: true",
      "  fallbackTokens: 750000",
      "  summaryMode: chunked",
      "",
    ].join("\n");
    try {
      const app = await bootWs(root, logs, top);
      try {
        const line = logs.find((l) => l.msg === "loom compaction");
        expect(line?.fields["summaryPerspectives"]).toBe("ops+chat");
        expect(line?.fields["summaryTemplate"]).toBe("compact-6");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C 摘要视角显式 [ops]：日志 summaryPerspectives=ops，summaryTemplate 仍 compact-6", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = [
      "",
      "compaction:",
      "  enabled: true",
      "  fallbackTokens: 750000",
      "  summaryMode: chunked",
      "  summaryPerspectives: [ops]",
      "",
    ].join("\n");
    try {
      const app = await bootWs(root, logs, top);
      try {
        const line = logs.find((l) => l.msg === "loom compaction");
        expect(line?.fields["summaryPerspectives"]).toBe("ops");
        expect(line?.fields["summaryTemplate"]).toBe("compact-6");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C legacy（无 fallbackTokens）：summaryPerspectives=null，summaryTemplate 仍 legacy-9", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs, "\ncompaction:\n  enabled: true\n");
      try {
        const line = logs.find((l) => l.msg === "loom compaction");
        expect(line?.fields["summaryPerspectives"]).toBeNull();
        expect(line?.fields["summaryTemplate"]).toBe("legacy-9");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C 在场禁用 enabled:false：source:declared + enabled:false，WARN 不相干（链关=谈不上触发）", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs, "\ncompaction:\n  enabled: false\n  fallbackTokens: 750000\n");
      try {
        const line = logs.find((l) => l.msg === "loom compaction");
        expect(line?.fields["enabled"]).toBe(false);
        expect(line?.fields["summaryPerspectives"]).toBeNull();
        expect(line?.fields["source"]).toBe("declared");
        expect(logs.some((l) => l.level === "warn" && l.msg.includes("trigger likely unreachable"))).toBe(false);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * W49-C 主会话压缩接线端到端（hooksFor per-session 工厂，W49.7 LOCK）——
 * Given: bootWs 树（段缺席 / 生产全量声明 / boundary:true 声明 / enabled:true 最小）。
 *  When: registry.ensure 建真 MainSessionLoop（构造期零 LLM 调用，summarize 闭包不触发）。
 * Then:  (a) 缺席 = loop._hooks 名单与旧面逐字节全等（microcompact/autoCompaction/
 *         compactionBoundary 绝迹，G6 对照面）+ 日志 source:default；
 *       (b) 声明 = 名单**尾部**恰 [microcompact, autoCompaction]（gate 先序 W47 保序：
 *         convergence-gate/turn-end-guard/main-loop.boundary/recorded/tool-stream 全部
 *         在前——hooksFor 拼在 extraHooks 尾，构造性证明逐条点名）；autoCompaction
 *         .timeout=60000（T1）；两会话末两钩对象引用两两 !==（T4 per-session 工厂身份钉）；
 *       (c) boundary:true → 第三尾钩 compactionBoundary timeout 5000；默认面 absent；
 *       (d) enabled:true 最小 = 仅追加 autoCompaction 一钩（microcompact 子段缺席不挂）。
 * side/子会话零接线为构造性证明：createSideSessionPort 与 tool-wiring childSessionFactory
 * 的 hooks 数组本波 git diff 零行（报告留痕）。
 */
describe("createLoomApp：W49-C 主会话压缩接线（hooksFor 尾部追加）", () => {
  interface LogEntry {
    readonly level: string;
    readonly msg: string;
    readonly fields: Record<string, unknown>;
  }

  function makeWs(): string {
    const root = mkdtempSync(join(tmpdir(), "loom-w49c-wire-"));
    const ws = join(root, "ws");
    mkdirSync(join(ws, "agents"), { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "W49C-WIRE\n");
    return root;
  }

  async function bootWs(root: string, logs: LogEntry[], extraTopLines = ""): Promise<LoomApp> {
    const ws = join(root, "ws");
    const stateRoot = join(root, "state");
    const text = FAKE_YAML.replace("WS_ROOT", ws) + extraTopLines;
    const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
    const applied = store.apply(text, "<test>");
    if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
    const config = parseLoomConfig(text, "<test>", { env: {} });
    return createLoomApp({
      config,
      store,
      stateRoot,
      tokens: ["tok-w49cw"],
      version: "test",
      env: { LOOM_FAKE_MODEL: "1" },
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    });
  }

  /** loop 真实 hook 名单（_hooks 私有面直读=core 测试先例 phase3-capabilities 同款）。 */
  function hookNames(app: LoomApp, sid: string): string[] {
    const rec = app.registry.ensure(sid);
    const session = rec.loop.session as unknown as { _hooks: { name: string; timeout?: number }[] };
    return session._hooks.map((h) => h.name);
  }

  function hookObjs(app: LoomApp, sid: string): { name: string; timeout?: number }[] {
    const rec = app.registry.ensure(sid);
    const session = rec.loop.session as unknown as { _hooks: { name: string; timeout?: number }[] };
    return [...session._hooks];
  }

  it("W49-C 段缺席：loop._hooks 名单逐字节=旧面（G6）+ source:default", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs);
      try {
        expect(hookNames(app, "w49c-g6")).toEqual([
          "convergence-gate",
          "turn-end-guard",
          "main-loop.boundary",
          "session-api.recorded-forward",
          "loom-w11.tool-stream",
        ]);
        expect(logs.find((l) => l.msg === "loom compaction")?.fields["source"]).toBe("default");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C 生产全量声明：尾钩恰 [microcompact, autoCompaction]（gate/boundary/recorded/tool-stream 全在前=W47 先序）+ timeout 60000（T1）+ 两会话异引用（T4）", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = [
      "",
      "compaction:",
      "  enabled: true",
      "  maxContextTokens: 250000",
      "  triggerRatio: 0.8",
      "  keepRecent: 8",
      "  resummarizeEvery: 16",
      "  summaryTimeoutMs: 60000",
      "  microcompact:",
      "    enabled: true",
      "    triggerTokens: 150000",
      "    compactableTools: [read]",
      "",
    ].join("\n");
    try {
      const app = await bootWs(root, logs, top);
      try {
        const names = hookNames(app, "w49c-tail");
        expect(names.slice(-2)).toEqual(["microcompact", "autoCompaction"]);
        expect(names[0]).toBe("convergence-gate");
        expect(names.indexOf("main-loop.boundary")).toBeLessThan(names.indexOf("microcompact"));
        expect(names.indexOf("session-api.recorded-forward")).toBeLessThan(names.indexOf("microcompact"));
        expect(names.indexOf("loom-w11.tool-stream")).toBeLessThan(names.indexOf("microcompact"));
        expect(names).not.toContain("compactionBoundary");
        const objs = hookObjs(app, "w49c-tail");
        const auto = objs.find((h) => h.name === "autoCompaction");
        expect(auto?.timeout).toBe(60000);
        // T4 身份钉：第二会话的末两钩与第一会话对象引用两两不同（闭包缓存不跨会话）。
        const objs2 = hookObjs(app, "w49c-tail-2");
        expect(objs2[objs2.length - 1]).not.toBe(objs[objs.length - 1]);
        expect(objs2[objs2.length - 2]).not.toBe(objs[objs.length - 2]);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C boundary:true 声明：尾三钩 [microcompact, autoCompaction, compactionBoundary] 且 adapter timeout 5000（C.2 flag ON）", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    const top = "\ncompaction:\n  enabled: true\n  boundary: true\n";
    try {
      const app = await bootWs(root, logs, top);
      try {
        const names = hookNames(app, "w49c-bound");
        expect(names.slice(-2)).toEqual(["autoCompaction", "compactionBoundary"]);
        const objs = hookObjs(app, "w49c-bound");
        expect(objs[objs.length - 1]?.timeout).toBe(5000);
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W49-C enabled:true 最小声明：仅追加 autoCompaction 一钩（microcompact 子段缺席=不挂），链上无 compactSummarize（T3 构造性）", async () => {
    const root = makeWs();
    const logs: LogEntry[] = [];
    try {
      const app = await bootWs(root, logs, "\ncompaction:\n  enabled: true\n");
      try {
        const names = hookNames(app, "w49c-min");
        expect(names[names.length - 1]).toBe("autoCompaction");
        expect(names).not.toContain("microcompact");
        expect(names).not.toContain("compactSummarize");
        expect(names).not.toContain("compactionBoundary");
      } finally {
        app.model.teardown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
