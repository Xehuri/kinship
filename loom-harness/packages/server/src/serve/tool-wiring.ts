// T31 serve 装配 —— 工具面单缝接线（boot.ts 的主/副会话共用件）。
//
// 一句话职责：把 tools 包真件按「同一缝、同一 workspace 边界」装成一份工具集——
//   - 文件类六件套（read/edit/write/grep/find/ls）：cwd = loom.yaml workspace 的 realpath，
//     路径咽喉 = path-utils.resolveToolPath（realpath 包含断言；W36 起 allowOutsideCwd 由
//     sandbox.containment 单键切换，见下）；
//   - bash：D7 单缝 ToolExecutor（default-deny 权限 + chdir/realpath 包含断言 + 审计），
//     经 asBashOperations 换掉 vendor 的裸 shell 咽喉点（生产不跑裸 exec）；
//   - 全部工具再包一层 tool span trace（tool-trace.ts，观测面 fail-soft）。
// 装配范例 = e2e-datacheck/tools.ts（T34 真件接线），纪律一致：越界响亮拒绝、审计留痕。
// 边界口径（任务冻结）：工具工作目录/路径边界 = loom.yaml workspace；config/loom.yaml 不改。
//
// W36 沙箱 config 驱动（用户 2026-10-14 决策，取代 T22 内置面）：
//   - "realpath 围栏需要 config 可配置，拒绝引擎默认不拦截，而是在 config 配置好才拦截"。
//   - 档案唯一构建点 = makeServeSandboxProfile(sandbox)：fs 恒空（仅工作区包含断言兜底，
//     沙箱期 bwrap 挂载接管，签名不变）；net 缺省 allow（键缺席/非 "deny" 一律不拦网络）；
//     deny 缺省空表（引擎空转，全放行）；显式配置值逐条入档案。
//   - 旧内置 deny 前缀表（sudo/su/shutdown ... git push）**已整体移出缺省**，仅在
//     config/loom.example.yaml 作为等价配置示例与本文档注释留存——缺省实例（无 sandbox 段）
//     的缝对 sudo/systemctl/curl 等一律放行（开工单前的现网拦截面属旧内置默认，随本片退役）。
//   - containment：缺省/strict = 文件类六件套保持 realpath 围栏（今日行为逐字节）；
//     "off" = 六件套 allowOutsideCwd=true（read/edit/write/grep/find/ls 同一开关，可读写任意
//     绝对路径）。**bash 的 cwd 起点不受本开关影响**（恒为 workspace realpath）：bash 的
//     路径逃逸面由 OS 权限 + 上述 deny/net 声明治理（二者皆 config-only），非本开关职责。
//   - 权限规则表 default-deny 不动：无命中一律拒；当前只显式 allow "bash"（缝上唯一调用方）。
//
// T41 task 工具挂载（本文件为 D7 单缝唯一接线点，createServeToolWiring 因此转 async）：
//   - 「主会话派副会话收摘要」= createTaskTool（core/subagent，T11 完成品）装进同一工具数组：
//     主/副会话共用同一份 task；子会话拿同一缝的完整面（fan-out/depth 闸在 T11 层现读，
//     递归由 maxDepth 纵向闸封顶，不给子会话另开工具面）。
//   - 子会话装配走 childSessionFactory：serve 真 provider 的 llmOptions（apiKey/timeout）
//     必须进子会话，T11 默认工厂无此字段——装配层在此补上（id 仍用 newSubagentSessionId，
//     前端契约守卫在 T11 层不放松）。
//   - Start/End 直接回调 → ServeToolTrace 落 task.subagent span 行（trace/{date}.jsonl
//     取证「子 run」；stage 沿用 "tool" 词表，name 区分）。
//   - agent 类型 = 内置 general/explore + workspace agents/*.md（loadAgentTypes，正文/记忆
//     在每次 spawn 时现读）；agents 目录缺失/不可读 → warn + 只留内置（服务可用性优先，坏数据不拖垮装配）。

import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Api, HarnessTool, Hook, LlmOptions, Model, SessionStore, WireRequestSnapshot } from "@axeuh/loom-core";
import { SessionContextWatcher } from "@axeuh/loom-core/assembly";
import { buildSubSession } from "@axeuh/loom-core/kernel";
import { loadAgentTypes, builtinAgentTypes, type AgentTypeDef } from "@axeuh/loom-core/subagent/agents";
import { DEFAULT_SUBAGENT_LIMITS, type SubagentLimits } from "@axeuh/loom-core/subagent/limits";
import { newSubagentSessionId } from "@axeuh/loom-core/subagent/ids";
import { createTaskTool } from "@axeuh/loom-core/subagent/task-tool";
import { createTaskCancelTool, type TaskCancelSource } from "@axeuh/loom-core/subagent/task-cancel";
import type { ToolName } from "@axeuh/loom-tools";
import { createAllTools, toolNames } from "@axeuh/loom-tools";
import { createPtyTools } from "@axeuh/loom-tools/pty";
import {
  ToolExecutor,
  SeamDeniedError,
  type SandboxProfile,
  type SeamAuditEvent,
  type ShellProgram,
} from "@axeuh/loom-tools/seam";

import { createServeToolTrace, type ServeToolTrace } from "./tool-trace.js";
import { createTaskFetchTool } from "./task-fetch.js";
import { createTodoWriteTool, type TodoUpdatedSink } from "./todo-tool.js";
import { createPlanTool } from "./plan-tool.js";
import { createLongTaskTool } from "./long-task-tool.js";
import { JsonPlanStore } from "../plan/json-plan-store.js";
import { JsonLongTaskStore } from "../plan/json-long-task-store.js";
import { assembleRoleContext } from "./side-binding.js";
import type { ManifestAgentRoleFile } from "../session-api/context-manifest.js";
import type { PtyConfig, SandboxConfig } from "../config/loom-config.js";
import type { SpawnKernel, SubFanout, TaskIndexPort } from "@axeuh/loom-core/kernel";
import { teeBashOperations, type ToolOutputSink } from "../events/tool-stream.js";

/** 缝审计环形上限（观测面；超出逐出最旧，长跑不留无界数组）。 */
const SEAM_AUDIT_CAP = 256;

/**
 * serve 沙箱档案（W36 config 驱动）：唯一构建点，消费 config.sandbox。
 * - fs 恒空 = 仅工作区 realpath 包含断言兜底（沙箱期 bwrap 挂载接管，签名不变）。
 * - net = sandbox?.net === "deny" ? "deny" : "allow"（键缺席/非 deny 一律放行网络）。
 * - deny = [...(sandbox?.deny ?? [])]（缺省空表 = 拒绝引擎空转）。
 * 旧内置面（已退役为 config 示例，见 config/loom.example.yaml sandbox 段）：
 * sudo/su/shutdown/reboot/halt/poweroff/mkfs/dd/mount/umount/kill/pkill/killall/
 * systemctl/service/crontab/nsenter/docker/podman/chown/"git push"（词首前缀匹配；
 * 链式命令绕过属 D7 已知朴素口径，沙箱期 bwrap 接管，不假想全防）。
 */
export function makeServeSandboxProfile(sandbox: SandboxConfig | undefined): SandboxProfile {
  return {
    fs: { read: [], write: [] }, // 空 = 仅工作区 realpath 包含断言兜底
    net: sandbox?.net === "deny" ? "deny" : "allow",
    cmd_allow: [],
    deny: [...(sandbox?.deny ?? [])],
  };
}

export interface ServeToolWiringOptions {
  /** loom.yaml workspace（构造即 realpath 归一；不可解析 = 装配期响亮抛错）。 */
  readonly workspaceRoot: string;
  /** L0 state 根（tool span 落 trace/{date}.jsonl）。 */
  readonly stateRoot: string;
  /** 子会话模型（serve 主模型同一句柄；task 派发经 childSessionFactory 注入）。 */
  readonly model: Model<Api>;
  /** provider 透传项（真 provider 的 apiKey/timeout 必须进子会话——fake 通道传空对象）。 */
  readonly llmOptions: LlmOptions;
  readonly log?: (level: "debug" | "info" | "warn" | "error", msg: string, fields: Record<string, unknown>) => void;
  readonly now?: () => number;
  /**
   * W5 附加工具面（skill 工具 + mcp 映射工具）：与七件套/task 同一 D7 单缝数组、
   * 同一 trace.wrapAll 包痕、同一 childFace（子会话同面）。重名 = 跳过 + warn（响亮留痕）。
   */
  readonly extraTools?: readonly HarnessTool[];
  /** W5 附加会话 hooks（skills catalog hook）：主/副/子会话共用同一实例。 */
  readonly extraHooks?: readonly Hook[];
  /**
   * W4 bash.shell（loom.yaml 直投）：bash 工具的 shell 程序指定（含完整路径）。
   * 缺省 = seam 平台默认（POSIX /bin/bash）。deny/net/cwd 断言口径与此正交（只看 command）。
   */
  readonly bashShell?: ShellProgram | undefined;
  /**
   * W9 切片0 决策：子会话转录落盘面（boot 注入 state/session/loom-sessions.jsonl 的
   * JsonlSessionStore 实例）。task 派发工厂恒挂（同步/后台一视同仁）——内核每 turn
   * flush 语义现成，子会话跑完 GET /sessions/<子sid>/history 即得真实转录。
   * 缺省 = 不挂（直调测试旧面不变）；主会话 store 不归此处（boot 直注 registry，冻结不动）。
   */
  readonly childSessionStore?: SessionStore;
  /**
   * W11a3 task_fetch 挂面（读侧速行版）：boot 注入 loom-sessions.jsonl 的 store 实例
   * （= childSessionStore 同一实例，写侧落盘/读侧取件成对）。工具进共用数组——主/副/子
   * 会话全可 fetch（子会话 fetch 兄弟会话合法），trace.wrapAll 既有包痕自动覆盖。
   * 缺省 = 不挂（直调测试旧面不变）。语义钉死：W9 内核切片落地后 task 后台化
   * （派发即返 sid）+ 本工具即成完整闭环，工具接口不变。
   */
  readonly taskFetchStore?: SessionStore;
  /**
    * W11a P0：bash 输出 chunk 上抛缝（= ToolOutputStream.onOutput）。给了就把
    * executor.asBashOperations() 包一层 tee——vendor 滚动缓冲口径一字不动，
    * 只是旁路多喂一份给事件面。缺省 = 不包（测试/离线旧面逐字节不变）。
    */
  readonly onToolOutput?: ToolOutputSink;
  /**
   * W11b todowrite 挂面：boot 注入 todo.updated 上抛缝（双惰性箭头指 registry，
   * 与 onToolOutput 同构——wiring 早于 registry 构造）。给了才挂面；工具进共用数组
   * = 主/副/子会话同一份（per-session 存储在 ctx.state，天然隔离；trace.wrapAll
   * 既有包痕自动覆盖）。缺省 = 不挂（直调测试旧面不变）。
   */
  readonly onTodoUpdated?: TodoUpdatedSink;
  /**
   * W9 切片 2：task 横向闸的在飞账池（= SpawnKernel.asFanout() 视图，boot 注入）。
   * 缺省 = 不挂（task-tool 走旧局部计数面，直调测试逐字节不变）；给了 = 主/副/子
   * 跨门面共享内核一池（计数窗等价性论证见 core/subagent/task-tool options.fanout）。
   */
  readonly fanout?: SubFanout;
  /**
   * W9 切片 3：内核本体注入（boot 传进程单例）——后台派发口（subBackground）与
   * task_fetch 的 task_id→sid 索引都从它切窄接口。缺省不挂 = background:true 响亮拒绝、
   * task_fetch 仅 ses_ 寻址（直调测试旧面逐字节不变）。
   */
  readonly kernel?: SpawnKernel;
  /**
   * W37 task_cancel 挂面（模型面后台任务中止）：boot 注入与 HTTP
   * `POST /tasks/:taskID/cancel` 路由**同一适配器实例**（kernel sub 册 get/cancel 投影，
   * 单缝——取消语义唯一真源=kernel.cancelSub，工具只委托不重写，见 core task-cancel.ts）。
   * 缺省不接 = 不挂面（直调测试旧面逐字节不变，taskFetchStore 同款条件挂面纪律）。
   */
  readonly taskCancel?: TaskCancelSource;
  /**
   * W23-A 发线面持久回调（子会话同步/后台两路同一工厂恒挂）：boot 注入 = wire-cache
   * 落盘。缺省 = 不挂（直调测试旧面逐字节不变）。
   */
  readonly onWireSnapshot?: (
    sessionId: string,
    snapshot: WireRequestSnapshot,
    providerPayload: string | null,
  ) => void;
  /**
   * W36 沙箱配置（boot 透传 config.sandbox；键缺席 = undefined 不物化）。
   * 唯一消费点 = makeServeSandboxProfile（档案 net/deny）+ 文件工具 allowOutsideCwd
   * （containment === "off" 才放行工作区外路径）。缺省 undefined = 新缺省面
   * （containment strict / net allow / deny 空表，见模块头 W36 段）。
   */
  readonly sandbox?: SandboxConfig | undefined;
  /** 交互式终端（pty）配置直投；键缺席 = 默认启用（enabled !== false）。 */
  readonly pty?: PtyConfig | undefined;
  /**
   * 计划/长期任务显式根（boot 从 LOOM_PLAN_ROOT > config `plan.root` 解析）。
   * 键缺席 = plan/long_task 两工具都不挂面；本层绝不猜 ai/data。
   */
  readonly planRoot?: string | undefined;
  /**
   * T11a：planScheduler=live 时顶替 legacy plan 工具的 T07 覆盖层工具。
   * 键缺席 = 旧 plan 工具；long_task 恒用 planRoot 装配，不受本键影响。
   */
  readonly planTool?: HarnessTool | undefined;
  /** PTY 退出通知出口（boot 以双惰性箭头指 registry.deliverReminder）。 */
  readonly onPtyExit?: ((ownerSessionId: string, line: string) => void) | undefined;
  /**
   * W40 后台子智能体硬 deadline（loom.yaml `subagent.backgroundDeadlineSeconds` 直投，秒）。
   * 给值 = 装配时写进 task 工具持有的**同一可变 limits 对象**（backgroundDeadlineMs =
   * 秒×1000）；键缺席 = undefined 不物化 = 字段不写 = core 派发时刻兜
   * DEFAULT_BACKGROUND_DEADLINE_MS（15min，opencode 对齐默认，逐字节不动）。
   */
  readonly subagentBackgroundDeadlineSeconds?: number | undefined;
  /**
   * W42c 横向闸：同一 task 工具实例在飞子智能体上限（`subagent.maxFanout` 直投，整数 ≥1）。
   * 给值 = 装配时覆写 task 工具持有的**同一可变 limits 对象**的 maxFanout 字段；
   * 键缺席 = 不覆写 = 对象保 DEFAULT_SUBAGENT_LIMITS 冻结值 8（逐字节不动，派发时刻现读）。
   */
  readonly subagentMaxFanout?: number | undefined;
  /** W42c 纵向闸（`subagent.maxDepth` 直投）：给值覆写，缺席保冻结值 2。语义同 subagentMaxFanout。 */
  readonly subagentMaxDepth?: number | undefined;
  /**
   * W42c 总量闸（`subagent.maxInflightTotal` 直投）：可选字段——给值才写（缺席 = 字段不物化，
   * task-tool 派发时刻 `??` 兜 DEFAULT_MAX_INFLIGHT_TOTAL=16，同 backgroundDeadlineMs 纪律）。
   */
  readonly subagentMaxInflightTotal?: number | undefined;
  /**
   * task 子会话轮数成本闸（未来 `subagent.maxTurns` 直投）。
   * 键缺席 = 回落 `SERVE_SUB_MAX_TURNS=50`（现网缺省面逐字节不动）。
   * 装配期一次定值：同时进 task 工具默认子路径与 serve 注入的 childSessionFactory，
   * 非热载面——改配置需重启生效。
   */
  readonly subagentMaxTurns?: number | undefined;
  /**
   * W53 T3 per-agent 模型路由（D5）：**仅当**该 agent 定义 frontmatter 声明了 `model:` 时才咨询
   * （def.model !== undefined）——未声明 = 旧行为（子会话继承下方 opts.model / opts.llmOptions）。
   * 返回 undefined = 调用方回落 opts.model（仅防御面；boot 实现对已声明 id 恒返回句柄或抛错）。
   * 已声明但 config.models 无此 id 必须由本回调响亮抛错，绝不静默回落主模型。
   */
  readonly modelByAgent?: (
    def: AgentTypeDef,
  ) => { readonly model: Model<Api>; readonly llmOptions: LlmOptions } | undefined;
  /**
   * W53 T3 已知模型 id 表（= ServeModelSet.byId keys）：装配期对 agents/*.md 的 `model:`
   * 逐条比对，未命中仅 warn 留痕、不阻断装配（生产韧性：单个 agent 笔误不许拖垮 5100；
   * 真正派发时再由 modelByAgent 响亮拒绝）。键缺席 = 不巡检（直调测试旧面逐字节不变）。
   */
  readonly knownModelIds?: readonly string[];
}

/**
 * W53 T3：agent 声明了 config.models 中不存在的 model id。
 * 派发期响亮拒绝（task 工具错误合约：内核包成 isError toolResult 回灌），绝不静默回落主模型。
 */
export class UnknownAgentModelError extends Error {
  constructor(agentType: string, modelId: string, available: readonly string[]) {
    super(
      `task 派发失败：agent "${agentType}" 声明 model "${modelId}"，但 config.models 无此 id` +
        `（可用：${available.join("、")}）。请修正 agents/*.md 的 model: 或 ` +
        ".loom/config.yaml 的 models[]；绝不静默回落主模型。",
    );
    this.name = "UnknownAgentModelError";
  }
}

export interface ServeToolWiring {
  /** 主会话与副会话共用的工具集（同一数组、同一缝、同一边界；converge 不在此列）。 */
  readonly tools: readonly HarnessTool[];
  /** D7 单缝本体（bash 咽喉点已接此；测试/运维可直接驱动断言口径）。 */
  readonly executor: ToolExecutor;
  /** 缝审计快照（allow/deny 双态，FIFO 有界）。 */
  readonly seamAudit: () => readonly SeamAuditEvent[];
  /** tool span trace 端口（boot 用它把 sessionId→账本 runId 登记进 resolveBinding 组合）。 */
  readonly trace: ServeToolTrace;
  /** 归一后的 workspace 真实根（边界取证面）。 */
  readonly workspaceReal: string;
  /** task 派发横/纵闸的**可变**阈值对象（D26 热载口径：改字段即对下一次派发生效）。 */
  readonly subagentLimits: SubagentLimits;
  /** 子会话（task 派发）附加 hooks = extraHooks 原样（W5 skills catalog 同面进子会话）。 */
  readonly childHooks: readonly Hook[];
  /**
   * W17-B manifest 角色扫描面（agentTypes 一次装配的呈现投影）：内置 general/explore
   * （file=""，builtin:true）+ workspace agents/*.md（file=绝对路径，builtin:false）。
   * 数据与 task 派发闸同源（装配期扫描，进程内不变；degrade 件不入列——warn 已留痕）。
   */
  readonly agentRoleFiles: readonly ManifestAgentRoleFile[];
  /**
   * W17-E agent 定义全表（内置 + agents/*.md 原样，含 kind:main 人格声明件）。
   * task 派发面在 createTaskTool 内部过滤 main；本面供 boot 人格装配按清单序取首个
   * main 正文（身份框），与 agentRoleFiles 同一份扫描结果、零第二口径。
   */
  readonly agentTypeDefs: readonly AgentTypeDef[];
}

/** 子会话轮数成本闸（serve 装配决定：主模型 runaway 兜底；T11 内核缺省 200 对真 provider 过宽）。 */
export const SERVE_SUB_MAX_TURNS = 50;

/** workspace 内子智能体定义目录（约定 agents/，与 side-binding 角色引用同一族布局）。 */
function agentsDirOf(workspaceReal: string): string {
  return join(workspaceReal, "agents");
}

export async function createServeToolWiring(
  opts: ServeToolWiringOptions,
): Promise<ServeToolWiring> {
  const log = opts.log ?? (() => {});
  let workspaceReal: string;
  try {
    workspaceReal = realpathSync(resolve(opts.workspaceRoot));
  } catch (err) {
    throw new Error(
      `serve 装配失败：workspace 根不可解析 "${opts.workspaceRoot}"：` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const audit: SeamAuditEvent[] = [];
  const executor = new ToolExecutor({
    workspaceRoot: workspaceReal,
    profile: makeServeSandboxProfile(opts.sandbox),
    scope: { agent: "serve", workflow: "serve" },
    ...(opts.bashShell === undefined ? {} : { bashShell: opts.bashShell }),
    rules: [
      {
        name: "serve-bash",
        match: "bash",
        decision: "allow",
        reason: "serve 工具面接线：bash 经 D7 单缝执行（default-deny 表上唯一显式 allow）",
      },
      {
        name: "serve-pty",
        match: "pty_spawn",
        decision: "allow",
        reason: "serve 工具面接线：pty_spawn 经 authorizeTool 只授权不执行（权限 + sandbox + 审计）",
      },
    ],
    // fallback 缺省 deny（default-deny，无规则命中即拒）。
    audit: (event) => {
      if (audit.length >= SEAM_AUDIT_CAP) audit.shift();
      audit.push(event);
      if (event.verdict === "deny") {
        log("warn", "loom seam deny", { tool: event.tool, reason: event.reason ?? "", cwd: event.cwd });
      }
    },
  });

  // 七件套真件：文件类走 resolveToolPath 咽喉（工作区外抛错），bash 走缝。
  // W11a P0：接了 onToolOutput 就在缝的 BashOperations 外再包一层 tee（旁路复制
  // chunk 上抛事件面；vendor 滚动缓冲与截断口径不动）。
  // W36 containment：单键派生文件类六件套的 allowOutsideCwd（strict 缺省 = 不给，
  // 今日围栏逐字节；off = 六件套同开，可读写任意绝对路径）。bash 的 cwd 起点不在此列
  // （恒为 workspace realpath；bash 逃逸面由 OS 权限 + deny/net 声明治理）。
  const allowOutsideCwd = opts.sandbox?.containment === "off";
  const rawBashOps = executor.asBashOperations();
  const all = createAllTools(workspaceReal, {
    bash: {
      operations: opts.onToolOutput === undefined ? rawBashOps : teeBashOperations(rawBashOps, opts.onToolOutput),
      defaultTimeout: 120,
    },
    ...(allowOutsideCwd
      ? {
          read: { allowOutsideCwd: true },
          edit: { allowOutsideCwd: true },
          write: { allowOutsideCwd: true },
          grep: { allowOutsideCwd: true },
          find: { allowOutsideCwd: true },
          ls: { allowOutsideCwd: true },
        }
      : {}),
  });
  const base: HarnessTool[] = toolNames.map((name: ToolName) => all[name]);

  // pty 五件套：spawn 前经 executor.authorizeTool 走同一 D7 缝（权限 + sandbox + 审计，
  // 不启动进程——真进程由 PtyManager 起）。缺省启用；enabled:false 才整体缺席。
  const ptyTools: HarnessTool[] =
    opts.pty?.enabled === false
      ? []
      : createPtyTools({
          defaultWorkdir: workspaceReal,
          workspaceRoot: workspaceReal,
          ...(opts.pty?.maxSessionsPerLoomSession === undefined && opts.pty?.maxSessionsTotal === undefined
            ? {}
            : {
                caps: {
                  ...(opts.pty?.maxSessionsPerLoomSession === undefined
                    ? {}
                    : { maxSessionsPerLoomSession: opts.pty.maxSessionsPerLoomSession }),
                  ...(opts.pty?.maxSessionsTotal === undefined
                    ? {}
                    : { maxSessionsTotal: opts.pty.maxSessionsTotal }),
                },
              }),
          ...(opts.onPtyExit === undefined ? {} : { onExit: opts.onPtyExit }),
          validateSpawn: async (command, args, workdir) => {
            await executor.authorizeTool("pty_spawn", [command, ...args].join(" "), workdir);
          },
          log,
        });

  const trace = createServeToolTrace({
    stateRoot: opts.stateRoot,
    log,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });

  // ── task 工具（T11 装配层）：主/副会话共用派发入口，子会话拿同一缝完整面。
  const agentsDir = agentsDirOf(workspaceReal);
  const agentTypes: AgentTypeDef[] = [...builtinAgentTypes()];
  if (existsSync(agentsDir)) {
    try {
      const scan = await loadAgentTypes({ dirs: [agentsDir], includeBuiltins: false });
      agentTypes.push(...scan.entries);
      for (const d of scan.degraded) {
        log("warn", "loom agents degrade", { dir: d.dir, ...(d.file === undefined ? {} : { file: d.file }), reason: d.reason });
      }
      // W17-E fail-soft 留痕：kind 非法值按 sub 兜底入清单，此处只把瑕疵响亮进 boot 日志。
      for (const w of scan.warnings) {
        log("warn", "loom agents kind warn", { dir: w.dir, file: w.file, reason: w.reason });
      }
    } catch (err) {
      // 目录存在但读坏 = 数据面故障：不拖垮装配，回退内置类型 + 响亮 warn。
      log("warn", "loom agents scan failed (fallback to builtins)", {
        dir: agentsDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log("info", "loom agents dir absent (builtin types only)", { dir: agentsDir });
  }

  // W53 T3 模型 id 巡检（boot 韧性）：agent 声明了 model: 但 config.models 无此 id → 仅 warn
  // 留痕，服务照常起（单个 agent 笔误不得拖垮 5100）；真正派发时由 modelByAgent 响亮抛
  // UnknownAgentModelError，绝不静默回落主模型。键缺席 = 不巡检（直调测试旧面不变）。
  if (opts.knownModelIds !== undefined) {
    const known = new Set(opts.knownModelIds);
    for (const def of agentTypes) {
      if (def.model !== undefined && !known.has(def.model)) {
        log("warn", "loom agent model unresolved", {
          agentType: def.type,
          model: def.model,
          available: [...known].join(","),
        });
      }
    }
  }

  // W9 切片 2（F4 补链，决策）：记忆段拼装在**本装配面**（workspaceReal 与 agents 扫描结果
  // 皆在此；内核 buildSubSession 保持 domain-free 只收 systemPrompt 成品）——角色
  // frontmatter.memory 声明经 memory-declaration 单真源展开，禁第二口径；未声明角色 =
  // AGENTS.md 基集（W8' 语义 1 正片）。正文与记忆都在 spawn 时现读（assembleRoleContext），
  // 文件改动由下一次派发生效；记忆源同时播种子会话 watcher，turn 间变更以 durable diff 回灌。

  const subagentLimits: SubagentLimits = { ...DEFAULT_SUBAGENT_LIMITS };
  // W40 后台 deadline 接线（config→可变 limits 单点写入）：现读机制 core 侧既有——
  // task-tool 每次派发时刻现读 `limits.backgroundDeadlineMs ?? DEFAULT_BACKGROUND_DEADLINE_MS`
  // （不快照，D26 热载口径），故 boot/装配期对本对象写一次 = 其后**每次**派发都吃到新值。
  // 本处写的必须也是 task 工具持有的同一实例（下方 createTaskTool limits 位 + 返回面
  // subagentLimits 共用一个对象，热载测试 boot-tools 已钉）。键缺席 = 不写字段
  // （undefined-honest；15min 兜底收敛在 core 的 ??，缺省材料化只在 boot 日志面重述）。
  if (opts.subagentBackgroundDeadlineSeconds !== undefined) {
    subagentLimits.backgroundDeadlineMs = opts.subagentBackgroundDeadlineSeconds * 1000;
  }
  // W42c 派发闸三键接线（与上方 deadline 同一模式、同一可变对象、同一现读语义）：
  // maxFanout/maxDepth 是 DEFAULT_SUBAGENT_LIMITS 必给字段（8/2）——键缺席 = 不覆写
  // = 对象保冻结值（逐字节 = 现网缺省面）；maxInflightTotal 可选字段——键缺席 = 不写
  // （字段不在对象上，task-tool 派发时刻 ?? 兜 DEFAULT_MAX_INFLIGHT_TOTAL=16）。
  // 数值零改动承诺：8/2/16 无事故证据咬过，开键只修可调性（core 常量不许触，MUST NOT）。
  if (opts.subagentMaxFanout !== undefined) {
    subagentLimits.maxFanout = opts.subagentMaxFanout;
  }
  if (opts.subagentMaxDepth !== undefined) {
    subagentLimits.maxDepth = opts.subagentMaxDepth;
  }
  if (opts.subagentMaxInflightTotal !== undefined) {
    subagentLimits.maxInflightTotal = opts.subagentMaxInflightTotal;
  }
  // 子会话轮数成本闸（装配期一次定值，非热载）：键缺席回落 SERVE_SUB_MAX_TURNS=50。
  // 同步派发走 childSessionFactory、默认子路径走 task-tool 的 subMaxTurns——两处都传同一
  // 有效值（下方两处 pass-through 均为有意接线，不许只改一处导致同装配两种轮数预算）。
  const subMaxTurns = opts.subagentMaxTurns ?? SERVE_SUB_MAX_TURNS;
  /** 子会话工具面 = 最终整面（含 task 自身，递归由纵向深度闸封顶）；装配完成前为空（首派必在装配后）。 */
  const childFace: HarnessTool[] = [];

  const taskHandle = await createTaskTool({
    agentTypes,
    limits: subagentLimits,
    model: opts.model, // T11 默认工厂兜底路径；serve 走 childSessionFactory（带 llmOptions）
    subMaxTurns,
    childTools: () => [...childFace],
    // W9 切片 2：横闸计数改内核在飞册（给了才委托；未给=旧局部面）。
    ...(opts.fanout === undefined ? {} : { fanout: opts.fanout }),
    // W9 切片 3：后台派发内核口（给了才支持 background:true；未给=响亮拒绝）。
    ...(opts.kernel === undefined ? {} : { subBackground: opts.kernel }),
    childSessionFactory: (def, _task, parentCtx) => {
      // W9 切片 1：serve 注入的 childSessionFactory 语义保留（llmOptions 必带/转录恒挂/
      // childFace 同面），构造产物改由内核唯一工厂 buildSubSession 造（raw-summary 档案，
      // 键展开逐字节同旧：hooks 空/缺省=键缺席，store 缺省=键缺席）。
      // W53 T3：声明了 model: 的 agent 先路由到对应句柄；未声明 = 旧行为（整体继承主模型）。
      // 未知 id 由 modelByAgent 抛 UnknownAgentModelError（响亮拒绝，绝不回落）；返回
      // undefined 仅为防御面（boot 实现对已声明 id 要么给句柄要么抛错）。
      const routed = def.model === undefined ? undefined : opts.modelByAgent?.(def);
      const childSessionId = newSubagentSessionId();
      const wireSink = opts.onWireSnapshot;
      const role = assembleRoleContext(
        workspaceReal,
        def.loadSystemPromptSync(),
        def.memoryGlobs,
        log,
      );
      const childWatcher = role.sources.length === 0
        ? undefined
        : new SessionContextWatcher({
            workspaceRoot: workspaceReal,
            sources: role.sources.map((s) => ({
              relPath: s.source,
              content: s.degrade === null ? s.content : null,
            })),
          });
      const sub = buildSubSession({
        model: routed?.model ?? opts.model,
        sessionId: childSessionId,
        systemPrompt: role.systemPrompt,
        tools: [...childFace],
        hooks: opts.extraHooks,
        llmOptions: routed?.llmOptions ?? opts.llmOptions,
        // W9 切片0：转录恒挂（同步/后台同一工厂、同一实例；子 sid 由 newSubagentSessionId
        // 逐派发全新 ⇒ 同 sid 单写者由派发序天然保证）。
        store: opts.childSessionStore,
        maxTurns: subMaxTurns,
        ...(childWatcher === undefined ? {} : { contextWatcher: childWatcher }),
        // W23-A 发线面持久（同步/后台同一工厂同挂；sid 绑派发时的全新子会话号）。
        ...(wireSink === undefined
          ? {}
          : {
              onWireSnapshot: (snap: WireRequestSnapshot, payload: string | null): void =>
                wireSink(childSessionId, snap, payload),
            }),
      });
      // 父现场登记（同步先于 Start 回调）：subagent span 的 runId join 键。
      trace.beginSubagent(sub.id, parentCtx.sessionId);
      return sub;
    },
    onSubagentStart: (e) => trace.subagentStart(e),
    onSubagentEnd: (e) => trace.subagentEnd(e),
  });

  // W11a3：task_fetch 取件工具（读侧速行版，见 task-fetch.ts）——给了 store 才挂面；
  // 进同一 wrapAll 包痕数组 = 主/副/子会话共用同一份只读取件口。
  // W9 切片 3：给了内核就带 task_id→sid 双索引（run_ 前缀寻址；未给=旧 ses_ 单索引面）。
  const taskFetchTools: HarnessTool[] =
    opts.taskFetchStore === undefined
      ? []
      : [
          createTaskFetchTool({
            store: opts.taskFetchStore,
            ...(opts.kernel === undefined
              ? {}
              : {
                  taskIndex: {
                    resolve: (taskId: string) => {
                      const rec = opts.kernel!.getSub(taskId);
                      return rec === undefined ? undefined : { sessionId: rec.row.session_id, status: rec.state };
                    },
                  } satisfies TaskIndexPort,
                }),
          }),
        ];

  // W11b：todowrite 计划工具（见 todo-tool.ts）——给了上抛缝才挂面；同一 wrapAll 数组
  // = 主/副/子会话共用同一份工具实例（存储在各会话自己的 ctx.state，互不串写）。
  const todoTools: HarnessTool[] =
    opts.onTodoUpdated === undefined ? [] : [createTodoWriteTool({ onUpdated: opts.onTodoUpdated })];

  // W37：task_cancel 中止工具（见 core/subagent/task-cancel.ts）——给了账本适配器才挂面；
  // 进同一 wrapAll 包痕数组 = 主/副/子共用同一取消口（task/task_fetch 同款双门面纪律）。
  const taskCancelTools: HarnessTool[] =
    opts.taskCancel === undefined ? [] : [createTaskCancelTool({ source: opts.taskCancel })];

  // GAP-3/GAP-4：plan/long_task 工具只在 boot 解析出显式 planRoot 时挂面；两 store 共用
  // 同一根（plan 真源 {root}/daily/...，长期任务 {root}/plan/long-tasks）。根不由本层猜。
  const planTools: HarnessTool[] =
    opts.planRoot === undefined
      ? []
      : [
          opts.planTool ?? createPlanTool({ store: new JsonPlanStore({ planRoot: opts.planRoot }) }),
          createLongTaskTool({ store: new JsonLongTaskStore({ planRoot: opts.planRoot }) }),
        ];

  const wrapped = trace.wrapAll([...base, taskHandle.tool, ...taskFetchTools, ...taskCancelTools, ...todoTools, ...ptyTools, ...planTools, ...filterExtraTools(base, opts.extraTools ?? [], log)]);
  childFace.push(...wrapped);

  return {
    tools: wrapped,
    executor,
    seamAudit: () => audit.slice(),
    trace,
    workspaceReal,
    subagentLimits,
    childHooks: [...(opts.extraHooks ?? [])],
    // W17-B：角色呈现投影（type→name；内置无文件=""；source 判别 builtin 旗标）。
    // W17-E：每条带 kind（main=人格声明极，sub=可派发；缺省/内置恒 sub，fail-soft 口径在 core）。
    agentRoleFiles: agentTypes.map((def): ManifestAgentRoleFile => ({
      name: def.type,
      file: def.file ?? "",
      builtin: def.source === "builtin",
      kind: def.kind,
    })),
    agentTypeDefs: [...agentTypes],
  };
}

/**
 * W5 附加面重名守卫：与七件套/task 同名者跳过 + warn（不静默顶掉原生工具，也不让
 * skills 插件构造期重名抛炸整个装配——装配层职责是把坏配置挡在工具面外并留痕）。
 */
function filterExtraTools(
  base: readonly HarnessTool[],
  extra: readonly HarnessTool[],
  log: (level: "warn", msg: string, fields: Record<string, unknown>) => void,
): HarnessTool[] {
  const names = new Set(base.map((t) => t.name));
  const out: HarnessTool[] = [];
  for (const t of extra) {
    if (names.has(t.name)) {
      log("warn", "loom extra tool skipped (name collision with base face)", { name: t.name });
      continue;
    }
    names.add(t.name);
    out.push(t);
  }
  return out;
}

/** 重导出给测试断言拒绝类型用（不强制消费者拉 loom-tools/seam）。 */
export { SeamDeniedError };
