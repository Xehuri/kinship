/**
 * W17-B 引用清单（manifest）—— boot 一次装配的只读组装面 + 出口形状。
 *
 * 定位：GET /sessions/:id/context/full v2 的 `manifest` 块。数据全部来自**装配期已在手**
 * 的事实（boot 单点装配、进程生命周期内不变，故 capturedAt 语义 = boot 时刻）：
 *   - memoryFiles ← mainPlan.memorySources（relPath + bytes=Buffer.byteLength(content)
 *     + bootHash ← W16 种子 contextSeedFiles 同序对齐、degrade ← AssemblyDegrade.reason）；
 *   - skillFiles ← skillsWiring.entries（健康件 degraded:false）∪ loader 文件级 degrade
 *     （坏件如实入列 degraded:true —— 面板"降级"徽标的数据源；目录级 degrade 无文件路径
 *     不伪造 skill 行，warn 已留痕）；
 *   - mcpServers ← LoomConfig.mcp.servers ∪ mcpWiring.statuses（按 name 左连接：config
 *     声明恒全列，statuses 缺席 = 未启动如实 ok:false）；
 *   - agentRoleFiles ← toolWiring.agentRoleFiles（task 派发角色一次扫描：内置 + agents/*.md）；
 *   - model ← ServeModelHandle 四件，**key 只出脱敏形**（maskApiKey：短键/空一律 "***"，
 *     长键首3+***+末4；明文永不入任何出口字段）；
 *   - configPath ← cli 传入（ctor 可选字段，库层不可知时诚实 ""）；workspaceRoot =
 *     toolWiring.workspaceReal。
 */

import type { AgentKind } from "@axeuh/loom-core/subagent/agents";
import type { ContextFileSeed, MemorySource } from "@axeuh/loom-core/assembly";

/** memoryFiles 一条（boot 实载清单件之一；W33 起主会话清单 = AGENTS.md 单件）。 */
export interface ManifestMemoryFile {
  readonly relPath: string;
  /** boot 载体的 UTF-8 字节数（= Buffer.byteLength(content)，非现盘 stat）。 */
  readonly bytes: number;
  /** boot 内容 sha256 声明（degrade/stat 缺席件 = ""）。 */
  readonly bootHash: string;
  /** 降级理由（AssemblyDegrade.reason；健康件 null）。 */
  readonly degrade: string | null;
}

/** skillFiles 一条（健康载入件或文件级坏件）。 */
export interface ManifestSkillFile {
  readonly name: string;
  readonly file: string;
  readonly degraded: boolean;
}

/** mcpServers 一条（config 声明 ∪ 装配结局）。 */
export interface ManifestMcpServer {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly ok: boolean;
  readonly toolNames: readonly string[];
}

/** agentRoleFiles 一条（task 派发角色）。 */
export interface ManifestAgentRoleFile {
  readonly name: string;
  /** 定义文件绝对路径（内置类型无文件 = ""）。 */
  readonly file: string;
  readonly builtin: boolean;
  /**
   * W17-E 主次声明极（frontmatter kind 的呈现投影；值域与 core AgentKind 同源）：
   * main = 主会话人格声明（不可派发），sub = 可派发子智能体（缺省/内置恒 sub）。
   * 面板 kind 徽标渲染归 F 线；本层只供数据。
   */
  readonly kind: AgentKind;
}

/** model 脱敏面（key 字段绝不在场；apiKeyMasked 只承载脱敏显示形）。 */
export interface ManifestModel {
  readonly id: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly apiKeyMasked: string;
}

/** GET /context/full v2 的 manifest 块（Lane C 冻结契约）。 */
export interface ContextManifest {
  readonly memoryFiles: readonly ManifestMemoryFile[];
  readonly skillFiles: readonly ManifestSkillFile[];
  readonly mcpServers: readonly ManifestMcpServer[];
  readonly agentRoleFiles: readonly ManifestAgentRoleFile[];
  readonly model: ManifestModel;
  readonly configPath: string;
  readonly workspaceRoot: string;
}

/** 凭据遮蔽（fail-closed 单点）：undefined/空/过短一律 "***"；长键只露首3末4。 */
export function maskApiKey(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) return "";
  if (raw.length < 8) return "***";
  return `${raw.slice(0, 3)}***${raw.slice(-4)}`;
}

/** 装配输入（boot 现场事实的结构化投影；单对象收口防参数膨胀）。 */
export interface ContextManifestAssemblyInput {
  readonly memorySources: readonly MemorySource[];
  /** W16 种子（与 memorySources 同序构造，见 boot.ts contextSeedFiles）。 */
  readonly memorySeeds: readonly ContextFileSeed[];
  readonly skillEntries: readonly { readonly name: string; readonly file: string }[];
  readonly skillDegrades: readonly { readonly dir: string; readonly file?: string | undefined }[];
  readonly mcpServers: readonly {
    readonly name: string;
    readonly cmd: string;
    readonly args: readonly string[];
    readonly cwd?: string | undefined;
  }[];
  readonly mcpStatuses: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly toolNames: readonly string[];
  }[];
  readonly agentRoleFiles: readonly ManifestAgentRoleFile[];
  readonly model: {
    readonly id: string;
    readonly api: string;
    readonly baseUrl: string;
  };
  /** ServeModelHandle.llmOptions.apiKey（fake 通道 undefined → 遮蔽 ""）。 */
  readonly apiKeyRaw: string | undefined;
  readonly configPath: string;
  readonly workspaceRoot: string;
}

/** 文件级 degrade 项 → 展示名（文件名去扩展名；stem 清洗归 loader 侧，此处只呈现）。 */
function degradeSkillName(file: string): string {
  const base = file.split("/").pop() ?? file;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 只收文件级 degrade（目录级无路径不伪造 skill 行）；null = 该条不入列。 */
function fileDegrade(
  d: { readonly dir: string; readonly file?: string | undefined },
): { readonly file: string } | null {
  return d.file === undefined ? null : { file: d.file };
}

/**
 * boot 一次装配（纯函数、零 IO；调用点 = boot.ts 组装 registry 之前）。
 * 左连接纪律：config 声明恒全列（缺席结局 = 未启动），绝不静默丢项。
 */
export function assembleContextManifest(
  input: ContextManifestAssemblyInput,
): ContextManifest {
  const memoryFiles: ManifestMemoryFile[] = input.memorySources.map((source, i) => {
    const seed = input.memorySeeds[i];
    return {
      relPath: source.source,
      bytes: Buffer.byteLength(source.content, "utf8"),
      bootHash: seed?.bootHash ?? "",
      degrade: source.degrade === null ? null : source.degrade.reason,
    };
  });

  const skillFiles: ManifestSkillFile[] = [
    ...input.skillEntries.map((e) => ({ name: e.name, file: e.file, degraded: false })),
    // 文件级坏件如实入列 degraded:true（与 loader 去重语义正交：degrade 件必不在 entries）。
    ...input.skillDegrades.flatMap((d): ManifestSkillFile[] => {
      const f = fileDegrade(d);
      return f === null ? [] : [{ name: degradeSkillName(f.file), file: f.file, degraded: true }];
    }),
  ];

  const mcpServers: ManifestMcpServer[] = input.mcpServers.map((server) => {
    const status = input.mcpStatuses.find((s) => s.name === server.name) ?? null;
    return {
      name: server.name,
      cmd: server.cmd,
      args: [...server.args],
      cwd: server.cwd ?? "",
      ok: status?.ok ?? false,
      toolNames: status === null ? [] : [...status.toolNames],
    };
  });

  return {
    memoryFiles,
    skillFiles,
    mcpServers,
    agentRoleFiles: input.agentRoleFiles,
    model: {
      id: input.model.id,
      api: input.model.api,
      baseUrl: input.model.baseUrl,
      apiKeyMasked: maskApiKey(input.apiKeyRaw),
    },
    configPath: input.configPath,
    workspaceRoot: input.workspaceRoot,
  };
}
