// T07: Loom 配置 schema 与加载器（loom.yaml）。
// 分段校验 ./section-checks.ts；凭据铁律 ./credentials.ts；
// 约束来源：D32（port ≥5097）、D33（exits 透传 stub）。

import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { type Credentials, checkCredentials } from "./credentials.js";
import {
  type BashConfig,
  type CompactionConfig,
  type ConvergenceConfig,
  type ExitsStub,
  type FlowConfig,
  type LlmConfig,
  type McpConfig,
  type ModelConfig,
  type PlanConfig,
  type PricingConfig,
  type ProviderEndpoints,
  type PtyConfig,
  type SandboxConfig,
  type SchedulingConfig,
  type ServerConfig,
  type SkillsConfig,
  type SubagentConfig,
  checkBash,
  checkCompaction,
  checkConvergence,
  checkExits,
  checkFlow,
  checkLlm,
  checkMcp,
  checkModels,
  checkPlan,
  checkPricing,
  checkProviders,
  checkPty,
  checkSandbox,
  checkScheduling,
  checkServer,
  checkSkills,
  checkSubagent,
  checkWorkspace,
  isRecord,
} from "./section-checks.js";

export type { CredentialEntry, Credentials } from "./credentials.js";
export type {
  BashConfig,
  CompactionConfig,
  CompactionWatermarkConfig,
  ConvergenceConfig,
  ExitsStub,
  FlowConfig,
  Hostname,
  LlmConfig,
  McpConfig,
  McpServerEntryConfig,
  MicrocompactConfig,
  ModelConfig,
  ModelId,
  PlanConfig,
  PricingConfig,
  ProviderEndpoint,
  ProviderEndpoints,
  PtyConfig,
  ReasoningEffort,
  SandboxConfig,
  SchedulingConfig,
  ServerConfig,
  ShellProgramConfig,
  SkillsConfig,
  SubagentConfig,
} from "./section-checks.js";
export { MIN_PORT } from "./section-checks.js";

export interface LoomConfig {
  readonly server: ServerConfig;
  /** 工作区路径（部署配置一行路径参数，禁止硬编码，D33 修正三）。 */
  readonly workspace: string;
  readonly models: readonly ModelConfig[];
  /**
   * provider 级端点表（providers[] 段；缺省空表）。
   * 真 provider 接线取址口径：models[].baseUrl（model 级）> providers[].baseUrl（provider 级）；
   * 凭据口径：providers[].apiKey（内联）> credentials[provider]（env 解析值）。
   */
  readonly providers: ProviderEndpoints;
  readonly pricing: Readonly<Record<string, PricingConfig>>;
  readonly credentials: Credentials;
  readonly exits: ExitsStub | undefined;
  /** skills 目录白名单（W5-A，T24 loader 数据源）；整段缺省 = 不启用。 */
  readonly skills: SkillsConfig | undefined;
  /** 外部 MCP stdio server 声明表（W5-B，T23 client 数据源）；整段缺省 = 不接。 */
  readonly mcp: McpConfig | undefined;
  /** bash 工具 shell 程序指定（W4）；整段缺省 = 平台默认（POSIX /bin/bash）。 */
  readonly bash: BashConfig | undefined;
  /**
   * 工具面沙箱配置（W36）；键缺席 = 不物化（undefined）——缺省语义见 SandboxConfig doc
   * （containment strict / net allow / deny 空表），收敛在消费层与 boot 日志面。
   * exactOptionalPropertyTypes：键缺席即属性不在对象上（W35 sourceContract 同款可选键纪律）。
   */
  readonly sandbox?: SandboxConfig | undefined;
  /**
   * 子智能体派发阈值（W40）；键缺席 = 不物化（undefined）——缺省语义见 SubagentConfig doc
   * （backgroundDeadlineSeconds 缺席 = core 派发时刻现读 DEFAULT_BACKGROUND_DEADLINE_MS=15min，
   * opencode 对齐默认零改动；maxTurns 缺席 = serve 常量 SERVE_SUB_MAX_TURNS=50 的子会话回合
   * 上限，仅实例显式声明时覆盖）。抬闸接线：boot 透传 → tool-wiring 写进 task 工具持有的
   * 同一可变 limits 对象（现读机制 core 侧既有，D26 口径）；改配置 + 重启生效，
   * 无运行期热重载通道。
   * exactOptionalPropertyTypes：键缺席即属性不在对象上（W36 sandbox 同款可选键纪律）。
   */
  readonly subagent?: SubagentConfig | undefined;
  /**
   * 收束闸阈值（W42c）；键缺席 = 不物化（undefined）——缺省语义见 ConvergenceConfig doc
   * （四值缺席 = core DEFAULT_LIMITS 冻结值 5/3/60/2，两既有注入缝现读）。接线：boot 段在场时
   * 物化唯一可变 Limits 对象 → registry.limits（主会话 loop/gate）与 sidePort.limits
   * （副会话 gate，00点班 turn 闸实际咬合面）同一引用喂两缝（D26 热载形状）。
   * exactOptionalPropertyTypes：键缺席即属性不在对象上（W40 subagent 同款纪律）。
   */
  readonly convergence?: ConvergenceConfig | undefined;
  /**
   * LLM 调用面阈值（W42c）；键缺席 = 不物化（undefined）——缺省语义见 LlmConfig doc
   * （errorRetries 缺席 = AgentSession 构造时刻兜 core DEFAULT_LLM_ERROR_RETRIES=2）。
   * 接线：boot 透传 → registry.llmErrorRetries → MainSessionLoop（W42a 既有透传面）；
   * errorRetryBackoffMs 同链（T4）；failedTurnReplay* 仅配置面（运行时归 T5）。
   */
  readonly llm?: LlmConfig | undefined;
  /**
   * 主会话上下文压缩接线（W49-C）；键缺席 = 不物化（undefined）——零 compaction hook
   * 注册 = G6 逐字节旧行为面。在场四态（禁用/最小/全量）语义见 CompactionConfig doc：
   * enabled 段在场必填，其余键缺席 = core 插件构造时刻 `??` 兜缺省（undefined-honest，
   * W40/W42c 同款纪律；缺省物化只在 boot 日志面 loom compaction{...,source} 重述）。
   * 接线面：per-session hooksFor 工厂（主会话 loop 尾部 microcompact→autoCompaction，
   * W49.7 LOCK；side/子会话零触碰）。
   */
  readonly compaction?: CompactionConfig | undefined;
  /**
   * 交互式终端工具配置（pty）；键缺席 = 不物化——缺省语义见 PtyConfig doc
   * （enabled true / 每会话 16 / 全局 64 在消费层收敛）。
   * exactOptionalPropertyTypes：键缺席即属性不在对象上（sandbox/subagent 同款纪律）。
   */
  readonly pty?: PtyConfig | undefined;
  /**
   * 计划/长期任务真源根（GAP-3/GAP-4）；键缺席 = undefined = plan/long_task 工具不挂面。
   * 解析优先级：LOOM_PLAN_ROOT 环境变量 > plan.root 配置；必须绝对路径，绝不猜 ai/data。
   * 生效 = 改配置/环境 + 重启（与 sandbox/pty 同纪律，无运行期热重载通道）。
   */
  readonly plan?: PlanConfig | undefined;
  /**
   * 主会话心流台账（L6）；整段缺省 = undefined = 不建 JsonFlowStore、不挂 flow_commit、
   * 不武装 flow 唤醒（旧行为逐字节）。键物化只发生在段在场时，缺省 enabled/retireConverge
   * 均为 false。retireConverge 仅在该段 enabled=true 时被 boot 采纳。
   */
  readonly flow?: FlowConfig | undefined;
  /**
   * 调度子系统配置（wakeQueue/planScheduler 档位 + 时间参数）；整段缺省 = undefined
   * 不物化——运行期缺省收敛在 boot，schema 面不造假值（sandbox/subagent 同款纪律）。
   */
  readonly scheduling?: SchedulingConfig | undefined;
}

/** 配置校验失败：errors 汇总全部问题，避免一次只报一个。 */
export class LoomConfigError extends Error {
  readonly path: string;
  readonly errors: readonly string[];

  constructor(path: string, errors: readonly string[]) {
    super(`loom 配置校验失败（${path}）：\n- ${errors.join("\n- ")}`);
    this.name = "LoomConfigError";
    this.path = path;
    this.errors = errors;
  }
}

export interface LoadLoomConfigOptions {
  /** 注入环境变量表（默认 process.env），便于测试。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** 解析并校验 loom.yaml 文本 → LoomConfig；失败抛 LoomConfigError。 */
export function parseLoomConfig(
  text: string,
  source: string,
  options: LoadLoomConfigOptions = {},
): LoomConfig {
  const env = options.env ?? process.env;
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new LoomConfigError(source, [`YAML 解析失败: ${msg}`]);
  }
  if (!isRecord(doc)) {
    throw new LoomConfigError(source, ["顶层需要映射"]);
  }

  const errors: string[] = [];
  const server = checkServer(doc["server"], errors);
  const workspace = checkWorkspace(doc["workspace"], errors);
  const models = checkModels(doc["models"], errors);
  const providers = checkProviders(doc["providers"], errors);
  const pricing = checkPricing(doc["pricing"], errors);
  const credentials = checkCredentials(doc["credentials"], env, errors);
  const exits = checkExits(doc["exits"], errors);
  const skills = checkSkills(doc["skills"], errors);
  const mcp = checkMcp(doc["mcp"], errors);
  const bash = checkBash(doc["bash"], errors);
  const sandbox = checkSandbox(doc["sandbox"], errors);
  const subagent = checkSubagent(doc["subagent"], errors);
  const convergence = checkConvergence(doc["convergence"], errors);
  const llm = checkLlm(doc["llm"], errors);
  const compaction = checkCompaction(doc["compaction"], errors);
  const pty = checkPty(doc["pty"], errors);
  const plan = checkPlan(doc["plan"], errors);
  const flow = checkFlow(doc["flow"], errors);
  const scheduling = checkScheduling(doc["scheduling"], errors);

  if (errors.length > 0) {
    throw new LoomConfigError(source, errors);
  }
  // 校验器返回 undefined 时必已同步 push 错误；守卫用于类型收窄，替代断言。
  if (server === undefined || workspace === undefined || models === undefined ||
      providers === undefined || pricing === undefined || credentials === undefined) {
    throw new LoomConfigError(source, ["校验器内部不一致：缺失值未随错误上报"]);
  }
  return {
    server, workspace, models, providers, pricing, credentials, exits, skills, mcp, bash,
    // W36 顶层 sandbox 段：缺席 = 键不物化（exactOptionalPropertyTypes 条件展开），
    // "缺省 ⇒ {containment strict, net allow, deny []}" 的收敛在消费层（W35 同款纪律）。
    ...(sandbox === undefined ? {} : { sandbox }),
    // W40 顶层 subagent 段：缺席 = 键不物化（同款条件展开），"缺省 ⇒ 后台 deadline
    // core DEFAULT_BACKGROUND_DEADLINE_MS（15min）" 的收敛在 task-tool 派发时刻现读
    // （schema 不造假值；日志面重述见 boot "loom subagent deadline" info 行）。
    ...(subagent === undefined ? {} : { subagent }),
    // W42c 顶层 convergence 段：缺席 = 键不物化，"缺省 ⇒ core DEFAULT_LIMITS 冻结值"
    // 的收敛在 loop.ts/gate.ts 构造时刻 `??` 兜常量（同 W40 纪律；日志面重述见
    // boot "loom convergence" info 行；语义铁律：只改数值不改 W26 强制/自然停分支）。
    ...(convergence === undefined ? {} : { convergence }),
    // W42c 顶层 llm 段：缺席 = 键不物化，"缺省 ⇒ DEFAULT_LLM_ERROR_RETRIES=2" 的收敛在
    // AgentSession 构造时刻 `??`（schema 不造假值；日志面重述见 "loom llm error retries"）。
    ...(llm === undefined ? {} : { llm }),
    // W49-C 顶层 compaction 段：缺席 = 键不物化 = **一个压缩 hook 都不挂**（G6 逐字节
    // 对照面；条件展开纪律同 W40/W42c——键 absent=字段 absent=core 缺省，日志面重述
    // 见 boot "loom compaction" info 行）。
    ...(compaction === undefined ? {} : { compaction }),
    // pty 段：缺席 = 键不物化（条件展开纪律同 sandbox/subagent），"缺省 ⇒ 启用 /
    // 16 / 64" 的收敛在消费层（工具装配与 spawn 闸），schema 面不造假值。
    ...(pty === undefined ? {} : { pty }),
    // plan 段：缺席 = 键不物化 = plan/long_task 工具不挂面（绝不猜根）。
    ...(plan === undefined ? {} : { plan }),
    // L6 flow 段：缺席 = 键不物化（旧行为逐字节）；在场 = 两键物化（缺省 false）。
    ...(flow === undefined ? {} : { flow }),
    // scheduling 段：缺席 = 键不物化（运行期缺省归 boot；schema 不造假值）。
    ...(scheduling === undefined ? {} : { scheduling }),
  };
}

/** 从文件加载并校验 loom.yaml（env 可注入便于测试）。 */
export function loadLoomConfig(
  path: string,
  env?: Readonly<Record<string, string | undefined>>,
): LoomConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new LoomConfigError(path, [`无法读取配置文件: ${msg}`]);
  }
  return parseLoomConfig(text, path, env === undefined ? {} : { env });
}
