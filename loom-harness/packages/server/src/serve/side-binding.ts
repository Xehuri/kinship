// T31 serve 装配 —— 角色自声明注入的 workspace 侧解析器（B 面设计，无集中配置文件）。
//
// 缺省语义（规则真源 = core/assembly/memory-declaration.ts，此处只做接线）：
//   - 主会话：kind:main 声明极 frontmatter `memory:` glob（W34：声明=清单真源，boot 接线
//     传入 mainSessionMemorySources）；未声明/空声明 = MAIN_SESSION_GLOBS 兜底
//     （W33 用户决策 2026-10-12 的仅 AGENTS.md 单件形态，退役为兜底而非删除；
//     W14 月度 fact 出走前缀口径见 memory-declaration 注释）；
//   - 副会话且 task 引用了角色（DispatchInput.agent）：角色 md 正文 = systemPrompt
//     基底 + 其 frontmatter.memory 声明 glob 的注入集；未声明 = 只注入 AGENTS.md
//     （SIDE_SESSION_BASE_GLOBS 同集，W8' 收紧，绝不全量 memory/**）；
//   - 副会话无角色引用：身份框（SIDE_SESSION_IDENTITY_PREAMBLE）+ AGENTS.md 基础集
//     （SIDE_SESSION_BASE_GLOBS；S05 事故后加框，注入文件范围不变）。
//
// 角色加载复用 core/subagent/agents.ts 的 loadAgentTypes（不复制解析逻辑）；
// glob 展开含 realpath 包含断言，越界/非法声明 fail-soft 记日志并落占位源。
// 凭据纪律：本模块零密钥面。

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadAgentTypes } from "@axeuh/loom-core/subagent/agents";
import {
  MAIN_SESSION_GLOBS,
  SIDE_SESSION_BASE_GLOBS,
  createFsAssemblyReader,
  expandMemoryGlobs,
  memorySourceContractRelaxed,
  renderMemorySegment,
  resolveMemorySources,
  type MemorySource,
} from "@axeuh/loom-core/assembly";
import type { RunLaunchContext, SideBindingResolution } from "@axeuh/loom-core/run-engine";

/** 观测日志（与 ServeLog 同形；缺省静默）。 */
type BindLog = (level: "debug" | "info" | "warn" | "error", msg: string, fields: Record<string, unknown>) => void;

export interface SideBindingResolverOptions {
  /** 工作区根（loom.yaml workspace；构造时 realpath 归一，非法即抛——装配期响亮）。 */
  readonly workspaceRoot: string;
  readonly log?: BindLog;
  /**
   * W35 memory 源字节契约口径（loom.yaml `server.sourceContract` 直通）：
   * 键缺席 = undefined（undefined-honest，不在此造假值）——resolveMemorySources
   * 走 core 缺省谓词 memorySourceContract（strict 面，今日行为逐字节）。
   * 显式 "off" = 只豁免易变时间戳条款（memorySourceContractRelaxed），NUL/二进制闸恒在。
   * 实例级单开关（用户 2026-10-14 决策 A：全实例单口径，不分会话种——见 gatherSourcesAt）。
   */
  readonly sourceContract?: "strict" | "off";
}

export interface SideBindingResolver {
  /** run-engine 执行端口注入点（ctx.agent → 角色绑定；无 agent → 基础集）。 */
  resolve(ctx: RunLaunchContext): Promise<SideBindingResolution>;
  /** 主会话注入清单（缺省语义 2；boot 装配期取一次，进 AssemblyPlan.memorySources）。
   *  W34：kind:main 声明 glob 非空 = 清单真源；未声明/空声明 = MAIN_SESSION_GLOBS 兜底。 */
  mainSessionMemorySources(declaredGlobs?: readonly string[]): readonly MemorySource[];
}

/** `agent:` 引用归一：去 .md 后缀、取末段（允许写 agents/02-daily-review.md 或 02-daily-review）。 */
function normalizeAgentRef(ref: string): string {
  const base = ref.replace(/\\/g, "/").split("/").pop() ?? ref;
  return base.endsWith(".md") ? base.slice(0, -".md".length) : base;
}

/**
 * 无角色副会话的身份框（缺省语义 3 注入前的固定前言；常量单点防口径漂移）。
 * AGENTS.md 是工作区主智能体的一级记忆自述，直接当 systemPrompt 会让模型代入
 * 主智能体人格、把派发任务当"用户闲聊"——本框把它降回背景参考。
 */
export const SIDE_SESSION_IDENTITY_PREAMBLE = [
  "你是 loom 副会话：一次性任务执行体，不是本工作区的主智能体。",
  "你的任务指令以下一条用户消息为准；其后注入的 AGENTS.md 等记忆材料只是背景参考，",
  "其中的身份声明、调度职责、消息分级与通知纪律都不适用于你。",
  "完成用户消息的任务后，必须调用 converge 工具收束。",
].join("\n");

/**
 * glob 集 → 注入清单（非法/越界声明 fail-soft：记日志 + MISSING 占位源，绝不 throw）。
 * 模块级唯一实现（W9 切片 2 上提）：副会话 resolve、主会话清单、task 子会话装配
 * （assembleRoleSystemPrompt）**共用此一口径**——expandMemoryGlobs/resolveMemorySources
 * 单真源纪律不许长第二触点。
 * W35 单闸（用户 2026-10-14 决策 A：全实例单口径，不分会话种）：本函数是 serve 面
 * **唯一** resolveMemorySources 触点，主会话清单（mainSessionMemorySources）、副会话
 * （resolve/bindForAgent）、子会话装配（assembleRoleSystemPrompt）三条路全部汇入此处，
 * sourceContract 口径只需在这一个闸上生效，禁在各路会话种里各配一份。
 * mode 语义（undefined-honest，W26 纪律镜像）：仅显式 "off" 时传 core 放宽谓词
 * memorySourceContractRelaxed（豁免易变时间戳、保留 NUL/二进制闸）；其余一律**不传**
 * validate 参、由 core 缺省 memorySourceContract 治理——strict 面逐字节零扰动。
 */
function gatherSourcesAt(
  rootReal: string,
  globs: readonly string[],
  log: BindLog,
  sourceContract?: "strict" | "off",
): readonly MemorySource[] {
  if (globs.length === 0) return [];
  const expanded = expandMemoryGlobs(rootReal, globs);
  for (const rejected of expanded.rejected) {
    log("warn", "loom memory glob rejected", { pattern: rejected.pattern, detail: rejected.detail });
  }
  const reader = createFsAssemblyReader({ workspaceRoot: rootReal, shards: null });
  const resolved = sourceContract === "off"
    ? resolveMemorySources(reader, expanded.paths, memorySourceContractRelaxed)
    : resolveMemorySources(reader, expanded.paths);
  for (const degrade of resolved.degrades) {
    log("debug", "loom memory source degraded", { source: degrade.source, reason: degrade.reason });
  }
  return resolved.sources;
}

/** 角色正文与记忆块的唯一拼接式（副/子两路共用；空块=裸正文）。 */
function joinRolePrompt(body: string, sources: readonly MemorySource[]): string {
  const memoryBlock = renderMemorySegment(sources);
  return memoryBlock.length === 0 ? body : `${body}\n${memoryBlock}`;
}

/** 角色装配上下文：完整 systemPrompt 与同帧记忆源清单（子会话 watcher 以其播种）。 */
export interface RoleContext {
  readonly systemPrompt: string;
  readonly sources: readonly MemorySource[];
}

/**
 * 角色正文 + 自声明记忆块 → 完整上下文（子会话 spawn 装配单入口）。
 * systemPrompt 与 sources 由同一次展开产生，watcher 基线因此与 prompt 字节同源。
 * 缺省语义与 assembleRoleSystemPrompt 完全一致（未声明角色 = AGENTS.md 基集）。
 */
export function assembleRoleContext(
  workspaceReal: string,
  body: string,
  memoryGlobs: readonly string[] | undefined,
  log: BindLog = () => {},
): RoleContext {
  const sources = gatherSourcesAt(workspaceReal, memoryGlobs ?? SIDE_SESSION_BASE_GLOBS, log);
  return { systemPrompt: joinRolePrompt(body, sources), sources };
}

/**
 * W9 切片 2（F4 补链，serve 装配面唯一入口）：角色正文 + 自声明记忆块 → 完整 systemPrompt。
 * 缺省语义与副会话角色完全同口径（memory-declaration 单真源复用，禁第二口径）：
 * 未声明角色 = SIDE_SESSION_BASE_GLOBS（恰 AGENTS.md 基集，W8' 裁决正片——
 * 子智能体今日实况零记忆，本函数令其与副会话对齐）；展开/读盘失败 = fail-soft
 * 占位 + degrade 日志，绝不 throw（派发不因记忆装配炸）。
 */
export function assembleRoleSystemPrompt(
  workspaceReal: string,
  body: string,
  memoryGlobs: readonly string[] | undefined,
  log: BindLog = () => {},
): string {
  return assembleRoleContext(workspaceReal, body, memoryGlobs, log).systemPrompt;
}

export function createSideBindingResolver(opts: SideBindingResolverOptions): SideBindingResolver {
  const log = opts.log ?? (() => {});
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(opts.workspaceRoot));
  } catch (err) {
    throw new Error(
      `serve 装配失败：workspace 根不可解析 "${opts.workspaceRoot}"：` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const agentsDir = join(rootReal, "agents");

  /** 闭包版：行为=旧 gatherSources 逐字节（同参数转发模块级唯一实现）；W35 起透传实例级 sourceContract。 */
  function gatherSources(globs: readonly string[]): readonly MemorySource[] {
    return gatherSourcesAt(rootReal, globs, log, opts.sourceContract);
  }

  async function bindForAgent(ref: string): Promise<SideBindingResolution> {
    let scan;
    try {
      scan = await loadAgentTypes({ dirs: [agentsDir], includeBuiltins: false });
    } catch (err) {
      // 目录不可读 = 该 run 引用无法兑现（端口抛错走引擎崩溃形状，账本留缺口）。
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `agents 目录不可读（${agentsDir}）: ${msg}` };
    }
    const want = normalizeAgentRef(ref);
    const def = scan.entries.find((e) => e.type === want || normalizeAgentRef(e.type) === want);
    if (def === undefined) {
      const degradedNote = scan.degraded.length > 0 ? `；另有 ${String(scan.degraded.length)} 个定义文件被跳过` : "";
      return { error: `agent "${ref}" 未在 workspace agents/ 中定义${degradedNote}` };
    }
    // W17-E 主次声明：kind:main 文件是主会话人格声明极，不是可派发角色。拒绝只落在
    // 可派发面的唯一落点（agent 引用解析）；{error} 走既有通道（run 如实 failed + 留痕），
    // 绝不 500、绝不静默起会话。resolve() 的无 agent 缺省面与角色语义逐字不动。
    if (def.kind === "main") {
      return { error: `agent "${ref}" is kind:main, not dispatchable` };
    }
    const body = await def.loadSystemPrompt();
    // 缺省语义 1（W8' 收紧）：未声明角色 = SIDE_SESSION_BASE_GLOBS（只 AGENTS.md），绝不 [] 或全量。
    // 拼接式与 task 子会话装配（assembleRoleSystemPrompt）同函数——单真源零口径漂移。
    const sources = gatherSources(def.memoryGlobs ?? SIDE_SESSION_BASE_GLOBS);
    return { systemPrompt: joinRolePrompt(body, sources), memorySources: sources, workspaceRoot: rootReal };
  }

  return {
    async resolve(ctx: RunLaunchContext): Promise<SideBindingResolution> {
      if (ctx.agent !== undefined) return bindForAgent(ctx.agent);
      const sources = gatherSources(SIDE_SESSION_BASE_GLOBS);
      const memoryBlock = renderMemorySegment(sources);
      // S05 断链根因修复：副会话此前整段只吃工作区「一级记忆」——那份文档通篇是
      // 主智能体自述（身份/调度/消息分级/通知纪律），模型把它当任务本体，派发
      // prompt 被记忆压过（digest 复述记忆里的行程告知、工具只调 converge）。
      // 决策：不改记忆文件、不裁注入面，只加一行「角色边界」前言——AGENTS.md 降级
      // 为背景参考，用户消息才是任务指令。注入范围与 W8' 裁决逐字不变。
      return {
        systemPrompt: `${SIDE_SESSION_IDENTITY_PREAMBLE}\n${memoryBlock}`,
        memorySources: sources,
        workspaceRoot: rootReal,
      };
    },
    mainSessionMemorySources(declaredGlobs?: readonly string[]): readonly MemorySource[] {
      // W34 声明转正（对偶 bindForAgent 的 `def.memoryGlobs ?? SIDE_SESSION_BASE_GLOBS`，
      // 两路同口径）：kind:main 声明非空 = 主会话清单真源（声明序走 gatherSources 单链，
      // 禁第二展开口径）；未声明/空声明 = MAIN_SESSION_GLOBS 兜底，W33 形态字节保真。
      const globs = declaredGlobs !== undefined && declaredGlobs.length > 0 ? declaredGlobs : MAIN_SESSION_GLOBS;
      return gatherSources(globs);
    },
  };
}
