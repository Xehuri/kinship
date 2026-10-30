// T07 loom.yaml 各段（server/models/pricing/workspace/exits）的类型与运行时校验。
// credentials 段单独在 ./credentials.ts（凭据铁律）。

/** 品牌类型：模型 id，区别于普通 string（跨模块传错 id 编译期即拒）。 */
export type ModelId = string & { readonly __brand: "ModelId" };

/** 主机名（允许 IP/域名，不做 DNS 校验）。 */
export type Hostname = string;

/** 思考强度（models[].reasoningEffort）：none|minimal|low|medium|high|xhigh|max。 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** D32 冻结的开发端口下限。 */
export const MIN_PORT = 5097;

export interface ServerConfig {
  readonly port: number;
  readonly hostname: Hostname;
  /**
   * W26 主会话收束强制开关（loom.yaml `server.convergenceEnforced`）。
   * 键缺席 = 不物化（undefined）—— "缺省 ⇒ 强制在位(true)" 的收敛在 core 层
   * MainSessionLoopOptions.convergenceEnforced（!== false 判别），schema 面不造假值。
   * 显式 false = 主会话模型自然收尾即终局（零催办/零强制收束/零终态改标）；
   * side/子会话纪律不受本键影响（各自端口自建 gate）。
   * 生效方式（W27 实例化部署模型）：键住 <实例根>/.loom/config.yaml，
   * 切换 = 改配置 + 重启服务，**无运行期热重载通道**（HotConfigStore 的 apply
   * 只更新 /config 观测面，loop 接线在 boot 定死——与令牌纪律同构，如实声明）。
   */
  readonly convergenceEnforced?: boolean;
  /**
   * W35 memory 源字节契约开关（loom.yaml `server.sourceContract`，"strict" | "off"）。
   * 键缺席 = 不物化（undefined）—— "缺省 ⇒ strict（今日全量语义）" 的收敛在 boot 日志面
   * 单点材料化（`config.server.sourceContract ?? "strict"` 只供 info 留痕），schema 面
   * 不造假值；消费层（side-binding gatherSourcesAt）同样 undefined-honest。
   * 显式 "off" = 仅豁免"每轮易变时间戳"条款（core memorySourceContractRelaxed 放宽面）；
   * NUL/二进制闸两模式恒在，与开关语义无关。主/副/子会话装配共用同一闸（全实例单口径，
   * 用户 2026-10-14 决策 A）。
   * 生效方式（W27 实例化部署模型）：键住 <实例根>/.loom/config.yaml，
   * 切换 = 改配置 + 重启服务，**无运行期热重载通道**（与 convergenceEnforced 同纪律，如实声明）。
   */
  readonly sourceContract?: "strict" | "off";
  /**
   * W56 忙时发送抢占开关（loom.yaml `server.interruptOnSend`）。
   * 键缺席 = 不物化（undefined）= 缺省 OFF：busy 发送沿用旧 FIFO 排队 + steer 语义。
   * 显式 true = busy 会话的新消息插队首并 abort 当前轮；当前轮收尾后 #drainQueue 取其
   * 为下一轮 prompt，既有排队项保持原序作为 followers 合并进该轮（绝不丢弃/重排）。
   * 显式 false = 旧语义（与缺省逐字节等价，物化仅为观测诚实）。
   * 仅作用主会话 POST /sessions/:id/messages 发送路径；side/子会话不受本键影响。
   * 生效方式（W27 实例化部署模型）：键住 <实例根>/.loom/config.yaml，
   * 切换 = 改配置 + 重启服务，**无运行期热重载通道**（与 convergenceEnforced 同纪律）。
   */
  readonly interruptOnSend?: boolean;
  /**
   * 自动唤醒开关（loom.yaml `server.autoWakeEnabled`）。
   * 键缺席 = 不物化（undefined）—— 缺省启用（!== false 判别在 boot/registry）；
   * 显式 false = 关闭主会话自动唤醒（converge schema 省略 `wake`，带 wake 的收束拒收）；
   * 仅主会话收束路径读取。
   * 切换 = 改配置 + 重启服务，**无运行期热重载通道**。
   */
  readonly autoWakeEnabled?: boolean;
  /**
   * session 列表 API 开关（loom.yaml `server.sessionList`）。
   * 键缺席 = 不物化（undefined）—— 消费层按关闭收敛（不物化 false）；
   * 显式 true = 开启列表接口，显式 false = 关闭（与缺席等价）。
   * 仅配置面；路由接线不在本键落地范围。
   */
  readonly sessionList?: boolean;
  /**
   * 主会话 id（loom.yaml `server.mainSessionId`）。
   * 键缺席 = 不物化（undefined）；在场必须非空且匹配 `^[A-Za-z0-9_]+$`
   * （Loom 会话 id 仅字母数字/下划线，连字符不在字符集内），否则 fail-fast。
   * 仅配置面；路由接线不在本键落地范围。
   */
  readonly mainSessionId?: string;
}

export interface ModelConfig {
  readonly id: ModelId;
  readonly provider: string;
  readonly contextWindow: number;
  readonly maxOutput: number;
  /** 是否支持图像输入；未配置时默认 false。 */
  readonly vision: boolean;
  /** 单次请求超时（毫秒）。 */
  readonly timeout: number;
  /**
   * OpenAI 兼容端点 baseURL（真 provider 接线用，T39 前置）。
   * **优先级：model 级显式值 > provider 级 providers[].baseUrl**（两者皆缺且
   * provider 非 fake 时，serve 装配响亮拒绝——见 serve/model-source.ts）。
   * 只承载非密钥字段；密钥走 providers[].apiKey（内联）或 credentials `${ENV_VAR}` 引用。
   */
  readonly baseUrl?: string;
  /**
   * 思考强度（DeepSeek/OpenAI 兼容模型的 reasoning_effort）。
   * 键缺席 = 不发送任何 thinking 参数，走上游默认；显式给值 = pi-ai 视该模型为
   * reasoning-capable 并转发该档位。DeepSeek 官方档位 none/low/high/max；
   * minimal 上游按 low 处理，medium/xhigh 上游按 high 处理。
   */
  readonly reasoningEffort?: ReasoningEffort;
  /**
   * 失败回合重放时是否回传该模型的 reasoning_content（T4 配置面；运行时行为归 T6）。
   * 键缺席 = 不物化 = 不回放（消费层缺省 false）；显式 true/false 原样物化。
   */
  readonly reasoningContentReplay?: boolean;
}

/** provider 级端点声明（providers[] 条目）：一个供应商一个 OpenAI 兼容端点 + 可选内联密钥。 */
export interface ProviderEndpoint {
  readonly provider: string;
  readonly baseUrl: string;
  /**
   * 内联 API key（可选）：直接写在 providers[] 条目里，优先级高于
   * credentials[provider] 的 ${ENV_VAR} 解析值。仅 serve 装配读取；
   * /config 只投影 apiKeyConfigured 布尔，密钥值绝不序列化/日志化。
   */
  readonly apiKey?: string;
}

/** provider → 端点声明查表（serve 装配消费；provider 级优先口径的"级"定义在这）。 */
export type ProviderEndpoints = Readonly<Record<string, ProviderEndpoint>>;

/**
 * 可选值校验：缺省 = undefined（exactOptionalPropertyTypes 下"没有键"与"键=undefined"
 * 是两件事，校验器只在键存在且非空时给值）。非法值 push 错误。
 */
function optionalStr(
  v: unknown,
  field: string,
  errors: string[],
): string | undefined {
  if (v === undefined) {
    return undefined;
  }
  return str(v, field, errors);
}

/**
 * W26 可选布尔校验（optionalStr 同构）：键缺席 = undefined 不物化
 * （缺省⇒true 的收敛语义在消费层，schema 不造假值）；键在场必须布尔，
 * 报错文案与 boolDefault 逐字一致（邻居口径统一）。
 */
function optionalBool(
  v: unknown,
  field: string,
  errors: string[],
): boolean | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (typeof v === "boolean") {
    return v;
  }
  errors.push(`${field}: 需要布尔值，实际为 ${JSON.stringify(v)}`);
  return undefined;
}

const SESSION_ID_RE = /^[A-Za-z0-9_]+$/;

/**
 * 可选会话 id 校验（optionalStr 同构 + 字符集闸）：键缺席 = undefined 不物化；
 * 键在场必须非空且匹配 `^[A-Za-z0-9_]+$`（Loom 会话 id 仅字母数字/下划线，
 * 连字符/空格等一律 fail-fast 点名键名）。
 */
function optionalSessionId(
  v: unknown,
  field: string,
  errors: string[],
): string | undefined {
  if (v === undefined) {
    return undefined;
  }
  const id = str(v, field, errors);
  if (id === undefined) {
    return undefined;
  }
  if (!SESSION_ID_RE.test(id)) {
    errors.push(
      `${field}: 需要匹配 ^[A-Za-z0-9_]+$（字母数字/下划线，禁止连字符），实际为 ${JSON.stringify(id)}`,
    );
    return undefined;
  }
  return id;
}

/** 计价表：USD / 百万 token。 */
export interface PricingConfig {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** D33 stub：出口声明，v1 原样透传，不做语义校验。 */
export interface ExitsStub {
  readonly stub: true;
  readonly declaration: Record<string, unknown>;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, field: string, errors: string[]): string | undefined {
  if (typeof v === "string" && v.length > 0) {
    return v;
  }
  errors.push(`${field}: 需要非空字符串，实际为 ${JSON.stringify(v) ?? "undefined"}`);
  return undefined;
}

function intRange(
  v: unknown,
  field: string,
  min: number,
  errors: string[],
): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v >= min) {
    return v;
  }
  errors.push(`${field}: 需要 ≥${min} 的整数，实际为 ${JSON.stringify(v) ?? "undefined"}`);
  return undefined;
}

function boolDefault(v: unknown, field: string, fallback: boolean, errors: string[]): boolean {
  if (v === undefined) {
    return fallback;
  }
  if (typeof v === "boolean") {
    return v;
  }
  errors.push(`${field}: 需要布尔值，实际为 ${JSON.stringify(v)}`);
  return fallback;
}

/** server 段：port ≥5097（D32），hostname 必填；W26 convergenceEnforced 可选布尔（缺省=强制在位）；W35 sourceContract 可选枚举串（缺省=strict，见 ServerConfig 注释）。 */
export function checkServer(raw: unknown, errors: string[]): ServerConfig | undefined {
  if (!isRecord(raw)) {
    errors.push("server: 缺失或不是映射");
    return undefined;
  }
  const port = intRange(raw["port"], "server.port", MIN_PORT, errors);
  const hostname = str(raw["hostname"], "server.hostname", errors);
  const convergenceEnforced = optionalBool(
    raw["convergenceEnforced"],
    "server.convergenceEnforced",
    errors,
  );
  const sourceContract = optionalSourceContract(
    raw["sourceContract"],
    "server.sourceContract",
    errors,
  );
  const interruptOnSend = optionalBool(
    raw["interruptOnSend"],
    "server.interruptOnSend",
    errors,
  );
  const autoWakeEnabled = optionalBool(
    raw["autoWakeEnabled"],
    "server.autoWakeEnabled",
    errors,
  );
  const sessionList = optionalBool(raw["sessionList"], "server.sessionList", errors);
  const mainSessionId = optionalSessionId(
    raw["mainSessionId"],
    "server.mainSessionId",
    errors,
  );
  if (port === undefined || hostname === undefined) {
    return undefined;
  }
  return {
    port,
    hostname,
    ...(convergenceEnforced === undefined ? {} : { convergenceEnforced }),
    ...(sourceContract === undefined ? {} : { sourceContract }),
    ...(interruptOnSend === undefined ? {} : { interruptOnSend }),
    ...(autoWakeEnabled === undefined ? {} : { autoWakeEnabled }),
    ...(sessionList === undefined ? {} : { sessionList }),
    ...(mainSessionId === undefined ? {} : { mainSessionId }),
  };
}

/**
 * W35 可选枚举串校验（optionalBool 同构）：键缺席 = undefined 不物化
 * （"缺省 ⇒ strict" 的收敛在 boot 日志面单点，schema 不造假值——W26 纪律镜像）；
 * 键在场必为 "strict" / "off" 枚举串，其余一律 push 错误 fail-fast（同邻居形状）。
 */
function optionalSourceContract(
  v: unknown,
  field: string,
  errors: string[],
): "strict" | "off" | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (v === "strict" || v === "off") {
    return v;
  }
  errors.push(`${field}: 需要 "strict" 或 "off" 字符串，实际为 ${JSON.stringify(v) ?? "undefined"}`);
  return undefined;
}

/**
 * 可选思考强度校验（optionalSourceContract 同构）：键缺席 = undefined 不物化；
 * 键在场必须是七档枚举之一，否则 push 错误 fail-fast。
 */
function optionalReasoningEffort(
  v: unknown,
  field: string,
  errors: string[],
): ReasoningEffort | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (
    v === "none" || v === "minimal" || v === "low" || v === "medium" ||
    v === "high" || v === "xhigh" || v === "max"
  ) {
    return v;
  }
  errors.push(
    `${field}: 需要 none|minimal|low|medium|high|xhigh|max 之一，实际为 ${JSON.stringify(v) ?? "undefined"}`,
  );
  return undefined;
}

/** models[]：id/provider/contextWindow/maxOutput/timeout 必填，vision 可选。 */
export function checkModels(raw: unknown, errors: string[]): readonly ModelConfig[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("models: 缺失或为空数组");
    return undefined;
  }
  const seen = new Set<string>();
  const out: ModelConfig[] = [];
  for (const [i, item] of raw.entries()) {
    const where = `models[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${where}: 需要映射`);
      continue;
    }
    const id = str(item["id"], `${where}.id`, errors);
    const provider = str(item["provider"], `${where}.provider`, errors);
    const contextWindow = intRange(item["contextWindow"], `${where}.contextWindow`, 1, errors);
    const maxOutput = intRange(item["maxOutput"], `${where}.maxOutput`, 1, errors);
    const timeout = intRange(item["timeout"], `${where}.timeout`, 1, errors);
    const vision = boolDefault(item["vision"], `${where}.vision`, false, errors);
    // baseUrl 可选：显式给值时覆盖 provider 级端点（优先级注释见 ModelConfig.baseUrl）。
    const baseUrl = optionalStr(item["baseUrl"], `${where}.baseUrl`, errors);
    const reasoningEffort = optionalReasoningEffort(
      item["reasoningEffort"],
      `${where}.reasoningEffort`,
      errors,
    );
    // T4 配置面：失败回合重放的 reasoning_content 回传开关（运行时归 T6）。
    const reasoningContentReplay = optionalBool(
      item["reasoningContentReplay"],
      `${where}.reasoningContentReplay`,
      errors,
    );
    if (id === undefined || provider === undefined || contextWindow === undefined ||
        maxOutput === undefined || timeout === undefined) {
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${where}.id: 重复的模型 id "${id}"`);
      continue;
    }
    seen.add(id);
    if (maxOutput > contextWindow) {
      errors.push(`${where}: maxOutput(${maxOutput}) 不应大于 contextWindow(${contextWindow})`);
    }
    out.push({
      id: id as ModelId,
      provider,
      contextWindow,
      maxOutput,
      vision,
      timeout,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(reasoningContentReplay === undefined ? {} : { reasoningContentReplay }),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 可选内联密钥校验：键缺席 = undefined（回退 credentials 的 env 引用）；
 * 键在场必须是非空字符串。非法值错误只报字段/类型，**绝不回显密钥值**。
 */
function optionalApiKey(
  v: unknown,
  field: string,
  errors: string[],
): string | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== "string") {
    const kind = v === null ? "null" : typeof v;
    errors.push(`${field}: 内联密钥必须是字符串（实际类型 ${kind}；为防泄露不回显值）`);
    return undefined;
  }
  if (v.trim().length === 0) {
    errors.push(`${field}: 内联密钥不能为空（省略该键则回退 credentials 的 \${ENV_VAR} 引用）`);
    return undefined;
  }
  return v;
}

/**
 * providers[]：provider 级端点声明（provider 唯一 + baseUrl 非空 + apiKey 可选）。
 * 整段可缺省（缺省 = 空表：全部端点靠 model 级 baseUrl 或 fake 通道）。
 * apiKey 在场时优先于 credentials[provider] 的 env 解析值（解析归 serve 装配）。
 */
export function checkProviders(
  raw: unknown,
  errors: string[],
): ProviderEndpoints | undefined {
  if (raw === undefined) {
    return {};
  }
  if (!Array.isArray(raw)) {
    errors.push("providers: 需要数组");
    return undefined;
  }
  const out: Record<string, ProviderEndpoint> = {};
  for (const [i, item] of raw.entries()) {
    const where = `providers[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${where}: 需要映射`);
      continue;
    }
    const provider = str(item["provider"], `${where}.provider`, errors);
    const baseUrl = str(item["baseUrl"], `${where}.baseUrl`, errors);
    const apiKey = optionalApiKey(item["apiKey"], `${where}.apiKey`, errors);
    if (provider === undefined || baseUrl === undefined) {
      continue;
    }
    if (provider in out) {
      errors.push(`${where}.provider: 重复的供应商 "${provider}"`);
      continue;
    }
    out[provider] = {
      provider,
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
    };
  }
  return out;
}

/** pricing：逻辑名 → 四项单价（≥0，缺省 0）。 */
export function checkPricing(
  raw: unknown,
  errors: string[],
): Readonly<Record<string, PricingConfig>> | undefined {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    errors.push("pricing: 需要映射");
    return undefined;
  }
  const out: Record<string, PricingConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      errors.push(`pricing.${name}: 需要映射`);
      continue;
    }
    const fields: Record<keyof PricingConfig, number> = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    let ok = true;
    for (const key of Object.keys(fields) as (keyof PricingConfig)[]) {
      const v = entry[key];
      if (v === undefined) {
        continue;
      }
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        fields[key] = v;
      } else {
        errors.push(`pricing.${name}.${key}: 需要 ≥0 的数字，实际为 ${JSON.stringify(v)}`);
        ok = false;
      }
    }
    if (ok) {
      out[name] = fields;
    }
  }
  return out;
}

/** workspace：非空字符串路径（不校验存在性，留给运行期/fixture 任务）。 */
export function checkWorkspace(raw: unknown, errors: string[]): string | undefined {
  return str(raw, "workspace", errors);
}

/**
 * bash.shell 节（W4）：指定 shell 程序（含完整路径，如 win32 git bash）。
 * 缺省 = 平台默认（POSIX /bin/bash -c、win32 ComSpec /d /s /c）。
 * args 是 command 之前的固定前缀，声明者自负其完整性（缝不自动补 -c）。
 */
export interface ShellProgramConfig {
  readonly program: string;
  readonly args?: readonly string[];
}

export interface BashConfig {
  readonly shell?: ShellProgramConfig;
}

export function checkBash(raw: unknown, errors: string[]): BashConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("bash: 需要映射");
    return undefined;
  }
  const shellRaw = raw["shell"];
  if (shellRaw === undefined) {
    return {};
  }
  if (!isRecord(shellRaw)) {
    errors.push("bash.shell: 需要映射 {program, args?}");
    return undefined;
  }
  const program = str(shellRaw["program"], "bash.shell.program", errors);
  if (program === undefined) {
    return undefined;
  }
  let args: readonly string[] | undefined;
  if (shellRaw["args"] !== undefined) {
    if (!Array.isArray(shellRaw["args"])) {
      errors.push("bash.shell.args: 需要字符串数组");
      return undefined;
    }
    const out: string[] = [];
    for (const [i, item] of (shellRaw["args"] as unknown[]).entries()) {
      // 空串是合法 argv（如某些 shell 的占位参），只拒非字符串——校验从宽、拼装如实。
      if (typeof item !== "string") {
        errors.push(`bash.shell.args[${i}]: 需要字符串，实际为 ${JSON.stringify(item)}`);
        return undefined;
      }
      out.push(item);
    }
    args = out;
  }
  return { shell: args === undefined ? { program } : { program, args } };
}

/**
 * skills 段（W5-A 接线）：T24 loader 的目录白名单。
 * 整段缺省 = 不启用 skills（vendored 插件 opt-in 纪律的装配层镜像）。
 * 存在时：allowlist 必为非空字符串数组（路径参数化，拒绝隐式全局扫描）。
 */
export interface SkillsConfig {
  readonly allowlist: readonly string[];
}

export function checkSkills(raw: unknown, errors: string[]): SkillsConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("skills: 需要映射");
    return undefined;
  }
  const list = raw["allowlist"];
  if (!Array.isArray(list) || list.length === 0) {
    errors.push("skills.allowlist: 需要非空字符串数组（目录白名单，禁止隐式全局扫描）");
    return undefined;
  }
  const out: string[] = [];
  for (const [i, item] of list.entries()) {
    const v = str(item, `skills.allowlist[${i}]`, errors);
    if (v !== undefined) out.push(v);
  }
  return out.length > 0 ? { allowlist: out } : undefined;
}

/**
 * mcp 段（W5-B 接线）：外部 MCP stdio server 声明表。
 * name 口径 `[a-z][a-z0-9_-]{0,31}`：工具映射名 mcp_<name>_<tool> 需落在各家
 * provider 的工具名字符集与长度预算内，装配层不再二次宽容。
 */
export interface McpServerEntryConfig {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
}

export interface McpConfig {
  readonly servers: readonly McpServerEntryConfig[];
}

const MCP_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function checkMcpServerEntry(raw: unknown, where: string, errors: string[]): McpServerEntryConfig | undefined {
  if (!isRecord(raw)) {
    errors.push(`${where}: 需要映射`);
    return undefined;
  }
  const name = str(raw["name"], `${where}.name`, errors);
  const cmd = str(raw["cmd"], `${where}.cmd`, errors);
  if (name !== undefined && !MCP_NAME_RE.test(name)) {
    errors.push(`${where}.name: 需要匹配 [a-z][a-z0-9_-]{0,31}（映射工具名 mcp_<name>_<tool> 的字符集预算）`);
    return undefined;
  }
  if (name === undefined || cmd === undefined) {
    return undefined;
  }
  let args: readonly string[] = [];
  if (raw["args"] !== undefined) {
    if (!Array.isArray(raw["args"])) {
      errors.push(`${where}.args: 需要字符串数组`);
      return undefined;
    }
    const out: string[] = [];
    for (const [i, item] of (raw["args"] as unknown[]).entries()) {
      const v = str(item, `${where}.args[${i}]`, errors);
      if (v !== undefined) out.push(v);
    }
    args = out;
  }
  let env: Record<string, string> | undefined;
  if (raw["env"] !== undefined) {
    if (!isRecord(raw["env"])) {
      errors.push(`${where}.env: 需要「键=字符串值」映射`);
      return undefined;
    }
    env = {};
    for (const [k, v] of Object.entries(raw["env"] as Record<string, unknown>)) {
      if (typeof v !== "string") {
        errors.push(`${where}.env.${k}: 值需要字符串`);
        return undefined;
      }
      env[k] = v;
    }
  }
  let requestTimeoutMs: number | undefined;
  if (raw["requestTimeoutMs"] !== undefined) {
    const v = intRange(raw["requestTimeoutMs"], `${where}.requestTimeoutMs`, 1000, errors);
    if (v === undefined) return undefined;
    requestTimeoutMs = v;
  }
  const cwd = optionalStr(raw["cwd"], `${where}.cwd`, errors);
  return {
    name,
    cmd,
    args,
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };
}

/**
 * mcp 段校验：整段缺省 = 不接外部 server。存在时 servers 必为非空数组，
 * name 段内唯一；单条坏条目 push 错误后丢弃（错误聚合口径同 models）。
 */
export function checkMcp(raw: unknown, errors: string[]): McpConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("mcp: 需要映射");
    return undefined;
  }
  const list = raw["servers"];
  if (!Array.isArray(list) || list.length === 0) {
    errors.push("mcp.servers: 需要非空数组（每个条目 {name, cmd, args?, cwd?, env?}）");
    return undefined;
  }
  const seen = new Set<string>();
  const out: McpServerEntryConfig[] = [];
  for (const [i, item] of list.entries()) {
    const entry = checkMcpServerEntry(item, `mcp.servers[${i}]`, errors);
    if (entry === undefined) continue;
    if (seen.has(entry.name)) {
      errors.push(`mcp.servers[${i}].name: 重复的 server 名 "${entry.name}"`);
      continue;
    }
    seen.add(entry.name);
    out.push(entry);
  }
  return out.length > 0 ? { servers: out } : undefined;
}

/** exits：D33 stub，允许缺省；存在时只要求是映射，内容原样透传。 */
export function checkExits(raw: unknown, errors: string[]): ExitsStub | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("exits: D33 stub 段需要映射");
    return undefined;
  }
  return { stub: true, declaration: raw };
}

/**
 * sandbox 段（W36 工具面沙箱配置化）：三键全可选、键缺席 = undefined 不物化
 * （"缺省 ⇒ containment strict / net allow / deny 空表" 的收敛在消费层——
 * tool-wiring 的档案构建与 boot 日志面，schema 面不造假值；W26 convergenceEnforced /
 * W35 sourceContract 同款纪律）。
 * 用户 2026-10-14 决策：realpath 围栏需要 config 可配置，拒绝引擎默认不拦截，
 * 而是在 config 配置好才拦截——旧内置 deny 前缀表不再作为缺省（见 loom.example.yaml
 * 示例段与 tool-wiring.ts doc 注释）。
 * 生效方式（W27 实例化部署模型）：键住 <实例根>/.loom/config.yaml，改配置 + 重启生效，
 * 无运行期热重载通道（与 convergenceEnforced 同纪律，如实声明）。
 */
export interface SandboxConfig {
  /** 文件工具 realpath 围栏开关；缺席 = undefined（下游按 strict 收敛）。 */
  readonly containment?: "strict" | "off";
  /** 缝 net 声明；缺席 = undefined（下游按 allow 收敛）。 */
  readonly net?: "deny" | "allow";
  /** 命令前缀黑名单（词首匹配）；缺席 = undefined（下游按空表收敛）。 */
  readonly deny?: readonly string[];
}

/**
 * sandbox 段校验：整段缺省 = undefined；存在必为映射。三键各自独立校验、
 * 缺席不物化、非法值 fail-fast（错误聚合口径同 models/skills）。
 * deny 要求字符串数组且逐项非空（空表合法 = 引擎空转等价）。
 */
export function checkSandbox(raw: unknown, errors: string[]): SandboxConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("sandbox: 需要映射");
    return undefined;
  }
  const containment = optionalEnum(
    raw["containment"],
    "sandbox.containment",
    ["strict", "off"],
    errors,
  );
  const net = optionalEnum(raw["net"], "sandbox.net", ["deny", "allow"], errors);
  const deny = optionalStrArray(raw["deny"], "sandbox.deny", errors);
  return {
    ...(containment === undefined ? {} : { containment }),
    ...(net === undefined ? {} : { net }),
    ...(deny === undefined ? {} : { deny }),
  };
}

/**
 * pty 段（交互式终端工具配置化）：三键全可选、键缺席 = undefined 不物化
 * （"缺省 ⇒ enabled true / 每会话 16 / 全局 64" 的收敛在消费层——工具装配与 spawn 闸，
 * schema 面不造假值；W36 sandbox / W40 subagent 同款纪律）。
 * 两个上限为缺席=默认的运维闸：超限 spawn 响亮拒绝，不在 schema 里落默认数。
 */
export interface PtyConfig {
  /** pty_* 五件套是否进工具面开关；缺席 = undefined（下游按 true 收敛）。 */
  readonly enabled?: boolean;
  /** 单个 loom 会话在飞 pty 会话上限（整数 ≥1）；缺席 = undefined（下游按 16 收敛）。 */
  readonly maxSessionsPerLoomSession?: number;
  /** 进程内全部 loom 会话合计 pty 会话上限（整数 ≥1）；缺席 = undefined（下游按 64 收敛）。 */
  readonly maxSessionsTotal?: number;
}

/**
 * pty 段校验：整段缺省 = undefined；存在必为映射。三键各自独立校验、
 * 缺席不物化、非法值 fail-fast（错误聚合口径同 sandbox/subagent）。
 */
export function checkPty(raw: unknown, errors: string[]): PtyConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("pty: 需要映射");
    return undefined;
  }
  const enabled = optionalBool(raw["enabled"], "pty.enabled", errors);
  const maxSessionsPerLoomSession = optionalIntRange(
    raw["maxSessionsPerLoomSession"],
    "pty.maxSessionsPerLoomSession",
    1,
    errors,
  );
  const maxSessionsTotal = optionalIntRange(
    raw["maxSessionsTotal"],
    "pty.maxSessionsTotal",
    1,
    errors,
  );
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(maxSessionsPerLoomSession === undefined ? {} : { maxSessionsPerLoomSession }),
    ...(maxSessionsTotal === undefined ? {} : { maxSessionsTotal }),
  };
}

/**
 * plan 段：计划/长期任务真源根（GAP-3/GAP-4）。
 * 整段缺省 = undefined = plan/long_task 工具不挂面（绝不猜 ai/data）。
 * root 必须是显式绝对路径；绝对性由装配层 resolvePlanRoot 统一校验（env 覆盖同口）。
 */
export interface PlanConfig {
  /** 计划与长期任务的显式绝对根（`{root}/daily/...` + `{root}/plan/long-tasks`）。 */
  readonly root?: string;
}

/** plan 段校验：整段缺省 = undefined；存在必为映射；root 缺席 = 键不物化。 */
export function checkPlan(raw: unknown, errors: string[]): PlanConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("plan: 需要映射");
    return undefined;
  }
  const root = optionalStr(raw["root"], "plan.root", errors);
  return root === undefined ? {} : { root };
}

/** flow.limits 容量/notes 覆盖值（四键均可选；缺省由 core FLOW_LIMITS 兜底）。 */
export interface FlowLimitsConfig {
  /** state === "active" 的主体数上限（正整数）。 */
  readonly maxActive?: number;
  /** waiting_user / waiting_event 主体数合计上限（正整数）。 */
  readonly maxWaiting?: number;
  /** session 内全部主体（含 closed）行数上限（正整数）。 */
  readonly maxSubjects?: number;
  /** notes 累计 UTF-8 字节数上限（正整数）。 */
  readonly maxNotesBytes?: number;
}

/**
 * flow 段（L6 主会话心流台账接线）：整段缺省 = undefined（旧行为逐字节）；
 * 存在必为映射，两键缺省 = false（物化缺省，boot 直读 enabled/retireConverge）。
 * retireConverge 仅在 enabled=true 时被 boot 采纳（关闭 flow 时绝不摘 converge）。
 */
export interface FlowConfig {
  /** 主会话 flow 接线总开关（flow_commit 工具 + FlowGate + JsonFlowStore + 唤醒）。 */
  readonly enabled: boolean;
  /** true = 主会话不挂 converge 工具/钩子，由 flow 接管终止（需 enabled=true）。 */
  readonly retireConverge: boolean;
  /** 容量/notes 覆盖值；缺席 = core FLOW_LIMITS 缺省（键不物化）。 */
  readonly limits?: FlowLimitsConfig;
}

/** flow.limits 校验：存在必为映射；四键各自正整数、缺席不物化、非法值 fail-fast。 */
function checkFlowLimits(raw: unknown, errors: string[]): FlowLimitsConfig | undefined {
  if (!isRecord(raw)) {
    errors.push("flow.limits: 需要映射");
    return undefined;
  }
  const maxActive = optionalIntRange(raw["maxActive"], "flow.limits.maxActive", 1, errors);
  const maxWaiting = optionalIntRange(raw["maxWaiting"], "flow.limits.maxWaiting", 1, errors);
  const maxSubjects = optionalIntRange(raw["maxSubjects"], "flow.limits.maxSubjects", 1, errors);
  const maxNotesBytes = optionalIntRange(
    raw["maxNotesBytes"],
    "flow.limits.maxNotesBytes",
    1,
    errors,
  );
  return {
    ...(maxActive === undefined ? {} : { maxActive }),
    ...(maxWaiting === undefined ? {} : { maxWaiting }),
    ...(maxSubjects === undefined ? {} : { maxSubjects }),
    ...(maxNotesBytes === undefined ? {} : { maxNotesBytes }),
  };
}

/** flow 段校验：整段缺省 = undefined；存在必为映射；非法值 fail-fast。 */
export function checkFlow(raw: unknown, errors: string[]): FlowConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("flow: 需要映射");
    return undefined;
  }
  const enabled = optionalBool(raw["enabled"], "flow.enabled", errors) ?? false;
  const retireConverge =
    optionalBool(raw["retireConverge"], "flow.retireConverge", errors) ?? false;
  const limits =
    raw["limits"] === undefined ? undefined : checkFlowLimits(raw["limits"], errors);
  return {
    enabled,
    retireConverge,
    ...(limits === undefined ? {} : { limits }),
  };
}

/** W35 枚举串校验的泛化：键缺席 = undefined 不物化；键在场必须落在枚举内，否则 push 错误。 */
function optionalEnum<T extends string>(
  v: unknown,
  field: string,
  allowed: readonly T[],
  errors: string[],
): T | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
    return v as T;
  }
  errors.push(
    `${field}: 需要 ${allowed.map((a) => `"${a}"`).join(" 或 ")} 字符串，实际为 ${JSON.stringify(v) ?? "undefined"}`,
  );
  return undefined;
}

/** 可选非空字符串数组校验：键缺席 = undefined；非数组/含非空串外元素 push 错误。 */
function optionalStrArray(
  v: unknown,
  field: string,
  errors: string[],
): readonly string[] | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (!Array.isArray(v)) {
    errors.push(`${field}: 需要非空字符串数组，实际为 ${JSON.stringify(v) ?? "undefined"}`);
    return undefined;
  }
  const out: string[] = [];
  for (const [i, item] of v.entries()) {
    const s = str(item, `${field}[${i}]`, errors);
    if (s !== undefined) out.push(s);
  }
  return out;
}

/**
 * subagent 段（W40 后台 deadline + W42c 派发闸三键）：键全可选、键缺席 = undefined 不物化
 * （"缺省 ⇒ core 现读常量"的收敛在 task-tool **派发时刻现读**（limits.maxFanout/maxDepth
 * 字段值 = DEFAULT_SUBAGENT_LIMITS 8/2；limits.maxInflightTotal ?? DEFAULT_MAX_INFLIGHT_TOTAL=16；
 * limits.backgroundDeadlineMs ?? DEFAULT_BACKGROUND_DEADLINE_MS=15min），schema 面不造假值——
 * W26 convergenceEnforced / W35 sourceContract / W36 sandbox 同款纪律）。
 * 用户 2026-10-14 现网实况：数据核验批次后台任务被 900s 硬 deadline 杀掉，实例需抬闸
 * （lead 将在 ai/.loom/config.yaml 设 3600）；core 默认值零改动，仅打通 config→
 * tool-wiring 可变 limits 对象这条接线（boot 写一次 = 其后每次派发生效）。
 * W42c（用户 2026-10-15 明令"回合数/工具调用上限/时长都要可改"）：横闸 maxFanout、
 * 纵闸 maxDepth、总量闸 maxInflightTotal 开成实例配置键——数值不动（8/2/16 无事故证据
 * 它们咬过），开键即修复可调性；接线与 backgroundDeadlineMs 同款（同一可变 limits 对象）。
 * 生效方式（W27 实例化部署模型）：键住 <实例根>/.loom/config.yaml，改配置 + 重启生效，
 * 无运行期热重载通道（与 sourceContract/sandbox/convergenceEnforced 同纪律，如实声明）。
 */
export interface SubagentConfig {
  /** 后台子智能体硬 deadline（秒，整数 ≥1）；缺席 = undefined（下游走 core 15min 现读缺省）。 */
  readonly backgroundDeadlineSeconds?: number;
  /** 横向闸：同一 task 工具实例在飞子智能体上限（整数 ≥1）；缺席 = core 缺省 8（对齐 vendored maxSubAgents）。 */
  readonly maxFanout?: number;
  /** 纵向闸：主会话(0)起最多在第几层会话上再 spawn（整数 ≥1）；缺席 = core 缺省 2。 */
  readonly maxDepth?: number;
  /** 总量闸：后台 sub 账本在册非终态总数上限（整数 ≥1）；缺席 = task-tool 派发时刻现读 DEFAULT_MAX_INFLIGHT_TOTAL=16。 */
  readonly maxInflightTotal?: number;
  /** 子会话回合上限（整数 ≥1）；缺席 = serve 缺省 SERVE_SUB_MAX_TURNS=50（task 派发装配时刻现读）。 */
  readonly maxTurns?: number;
}

/**
 * subagent 段校验：整段缺省 = undefined；存在必为映射。单键缺席不物化、
 * 非法值 fail-fast（报错文案复用 intRange 邻居口径，错误聚合口径同 models/sandbox）。
 */
export function checkSubagent(raw: unknown, errors: string[]): SubagentConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("subagent: 需要映射");
    return undefined;
  }
  const backgroundDeadlineSeconds = optionalIntRange(
    raw["backgroundDeadlineSeconds"],
    "subagent.backgroundDeadlineSeconds",
    1,
    errors,
  );
  // W42c 派发闸三键（同 optionalIntRange 先例：键缺席不物化，非法值点名键名中文报错）。
  const maxFanout = optionalIntRange(raw["maxFanout"], "subagent.maxFanout", 1, errors);
  const maxDepth = optionalIntRange(raw["maxDepth"], "subagent.maxDepth", 1, errors);
  const maxInflightTotal = optionalIntRange(
    raw["maxInflightTotal"],
    "subagent.maxInflightTotal",
    1,
    errors,
  );
  // 子会话回合上限（键缺席不物化 = 下游 serve 装配时刻现读 SERVE_SUB_MAX_TURNS=50）。
  const maxTurns = optionalIntRange(raw["maxTurns"], "subagent.maxTurns", 1, errors);
  return {
    ...(backgroundDeadlineSeconds === undefined ? {} : { backgroundDeadlineSeconds }),
    ...(maxFanout === undefined ? {} : { maxFanout }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxInflightTotal === undefined ? {} : { maxInflightTotal }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
  };
}

/**
 * convergence 段（W42c 收束闸四值配置化）：键全可选、键缺席 = undefined 不物化。
 * 缺省语义 = core convergence DEFAULT_LIMITS 冻结值（nudgeLimit 5 / escalateSameError 3 /
 * turnHardCap 60 / autoContinuations 2，docs/01 D26）——schema 面不造假值，"缺省 ⇒ 冻结值"
 * 的收敛在两处既有注入缝：主会话 registry.limits→MainSessionLoop（loop.ts `opts.limits ??
 * {...DEFAULT_LIMITS}`）与副会话 sidePort.limits→buildConvergeSession→gate（事件时刻现读）。
 * boot 是段在场时四值的唯一物化点（一个可变 Limits 对象同时喂两缝，D26 热载形状）。
 * 语义铁律（W26 用户决策不动）：autoContinuations/convergenceEnforced 的"主会话自然停、
 * sub/side 强制"分支逻辑与配置无关——本段只改数值，绝不改语义。
 * 生效方式（W27 部署模型）：改 <实例根>/.loom/config.yaml + 重启；无运行期热重载通道。
 */
export interface ConvergenceConfig {
  /** 空转/字段不齐催办上限（整数 ≥1）；缺席 = core 冻结值 5。 */
  readonly nudgeLimit?: number;
  /** 同工具同错误升级提示阈值（整数 ≥1）；缺席 = core 冻结值 3。 */
  readonly escalateSameError?: number;
  /** 单请求轮数硬顶（整数 ≥1）；缺席 = core 冻结值 60。 */
  readonly turnHardCap?: number;
  /** 跨请求自动续跑上限（整数 ≥0，0=不自动续跑）；缺席 = core 冻结值 2。 */
  readonly autoContinuations?: number;
}

/** convergence 段校验：整段缺省 = undefined；存在必为映射；单键缺席不物化、非法值 fail-fast。 */
export function checkConvergence(
  raw: unknown,
  errors: string[],
): ConvergenceConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("convergence: 需要映射");
    return undefined;
  }
  const nudgeLimit = optionalIntRange(raw["nudgeLimit"], "convergence.nudgeLimit", 1, errors);
  const escalateSameError = optionalIntRange(
    raw["escalateSameError"],
    "convergence.escalateSameError",
    1,
    errors,
  );
  const turnHardCap = optionalIntRange(raw["turnHardCap"], "convergence.turnHardCap", 1, errors);
  // autoContinuations ≥0（0=合法：不自动续跑；core assertValidLimits 同界）。
  const autoContinuations = optionalIntRange(
    raw["autoContinuations"],
    "convergence.autoContinuations",
    0,
    errors,
  );
  return {
    ...(nudgeLimit === undefined ? {} : { nudgeLimit }),
    ...(escalateSameError === undefined ? {} : { escalateSameError }),
    ...(turnHardCap === undefined ? {} : { turnHardCap }),
    ...(autoContinuations === undefined ? {} : { autoContinuations }),
  };
}

/**
 * llm 段（W42a/T4 瞬时 provider 错误重试的实例配置化）：键全可选、键缺席 = undefined 不物化
 * （"缺省 ⇒ core DEFAULT_LLM_ERROR_RETRIES=2 / DEFAULT_LLM_ERROR_RETRY_BACKOFF_MS=1000"
 * 的收敛在 AgentSession 构造时刻 `??` 兜常量，schema 面不造假值）。0 = 禁用重试/立即重发。
 * errorRetries/errorRetryBackoffMs 经 boot→registry→MainSessionLoop 进**主会话**内核；
 * side/sub 会话恒用 core 缺省（按工单不扩）。failedTurnReplayRetries/BackoffMs 仅配置面，
 * 运行时重放语义归 T5（当前不生效）。
 * 生效方式（W27 部署模型）：改配置 + 重启；无运行期热重载通道。
 */
export interface LlmConfig {
  /** 一次 LLM call 瞬时失败的带退避重发上限（整数 ≥0，0=禁用）；缺席 = core 缺省 2。 */
  readonly errorRetries?: number;
  /** 重试退避基数毫秒（整数 ≥0）；退避 = base×2ⁿ。缺席 = core 缺省 1000。 */
  readonly errorRetryBackoffMs?: number;
  /** 失败回合重放上限（整数 ≥0）；键缺席 = 不物化（运行时语义归 T5）。 */
  readonly failedTurnReplayRetries?: number;
  /** 失败回合重放退避基数毫秒（整数 ≥0）；键缺席 = 不物化（运行时语义归 T5）。 */
  readonly failedTurnReplayBackoffMs?: number;
}

/** llm 段校验：整段缺省 = undefined；存在必为映射；单键缺席不物化、非法值 fail-fast。 */
export function checkLlm(raw: unknown, errors: string[]): LlmConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("llm: 需要映射");
    return undefined;
  }
  const errorRetries = optionalIntRange(raw["errorRetries"], "llm.errorRetries", 0, errors);
  const errorRetryBackoffMs = optionalIntRange(
    raw["errorRetryBackoffMs"],
    "llm.errorRetryBackoffMs",
    0,
    errors,
  );
  const failedTurnReplayRetries = optionalIntRange(
    raw["failedTurnReplayRetries"],
    "llm.failedTurnReplayRetries",
    0,
    errors,
  );
  const failedTurnReplayBackoffMs = optionalIntRange(
    raw["failedTurnReplayBackoffMs"],
    "llm.failedTurnReplayBackoffMs",
    0,
    errors,
  );
  return {
    ...(errorRetries === undefined ? {} : { errorRetries }),
    ...(errorRetryBackoffMs === undefined ? {} : { errorRetryBackoffMs }),
    ...(failedTurnReplayRetries === undefined ? {} : { failedTurnReplayRetries }),
    ...(failedTurnReplayBackoffMs === undefined ? {} : { failedTurnReplayBackoffMs }),
  };
}

/**
 * microcompact 子段（W49-C）：廉价工具输出清理的参数面。**在场且未显式禁用时
 * triggerTokens 必填**（≥1 整数）——插件侧无诚实缺省可兜（microcompact.ts:85 triggerTokens
 * 是本段唯一无缺省的必需要件），缺席且未禁用时报错点名键，绝不造 0/假值。
 * targetTokens/keepRecent/compactableTools 可选：缺席 = 不物化 = 插件构造时刻
 * `??`（target=triggerTokens 早停线 / keepRecent=5 / 空白名单=钩子在场但无可清）。
 * 交叉校验 targetTokens ≤ triggerTokens（microcompact.ts:89-91 同界，前移到 schema
 * fail-fast——工厂逐会话构造时再炸会拖到首会话 ensure，装配期报错更可诊断）。
 */
export interface MicrocompactConfig {
  /** 子段开关；缺席/true = 启用（在场即意图），false = 显式禁用（零注册）。 */
  readonly enabled?: boolean;
  /** 估算 tokens 超此值触发清理（整数 ≥1）；子段在场且未禁用时必填。 */
  readonly triggerTokens?: number;
  /** 清理目标体积（整数 ≥1，须 ≤ triggerTokens）；缺席 = 插件兜 triggerTokens。 */
  readonly targetTokens?: number;
  /** 恒保留原文的最近 N 条 toolResult（整数 ≥0）；缺席 = 插件缺省 5。 */
  readonly keepRecent?: number;
  /** 可清理工具白名单（domain-free，由部署者声明）；缺席 = 空表。 */
  readonly compactableTools?: readonly string[];
}

/**
 * compaction.watermark 子段（W57 P3）：上下文水位提醒档位。整段在场时必须同时声明
 * `compaction.fallbackTokens`（各档须严格小于兜底阈值）。
 */
export interface CompactionWatermarkConfig {
  /** 各档绝对 token 数（整数 ≥1000、严格递增）；缺席 = 不产生提醒。 */
  readonly levels?: readonly number[];
}

/**
 * compaction 段（W49-C 主会话上下文压缩接线）：undefined-honest 四态——
 * 缺席（零 hook 注册 = G6 逐字节旧行为面）/ 在场禁用 / 在场最小 / 在场全量。
 * **enabled 段在场时必填布尔**（与 convergence/llm 各段"键全可选"不同族：本段的
 * 在场语义就是"要不要挂压缩链"，缺 enabled 是半句话，fail-fast 拒）。其余键全可选、
 * 缺席不物化——缺省收敛在 core 插件构造时刻 `??`（triggerRatio 0.8 / keepRecent 6 /
 * resummarizeEvery=keepRecent，auto-compaction.ts:265-273；summaryTimeoutMs 60000 与
 * boundary false 只在 boot 日志面/wiring 物化，schema 不造假值）——W42c 同款纪律。
 * maxContextTokens ≥1000 下界（W49.7 memo T2：生产 1M 申报窗走窗口路径阈值 995,904
 * 实际不可达，显式预算走百分比路径是接线生效的唯一现实触发；下界防 framing 地板 60K
 * 以下的荒谬小窗，T6 复核口径见 memo）。summaryTimeoutMs ≥1000（T1：pipe 缺省 500ms
 * 会静默杀 summarize，落成 autoCompaction hook timeout 覆盖值）。
 * 生效方式（W27 实例化部署模型）：键住 <实例根>/.loom/config.yaml，改配置+重启，
 * 无运行期热重载通道（与 convergenceEnforced/sandbox/subagent 同纪律，如实声明）。
 * 范围申明：**只作用主会话**（W49.7 LOCK per-session 工厂挂主会话 loop 尾部）；
 * side/子会话零压缩纪律不动（core/compaction/routine.ts 头注"副会话 run 默认不压缩"）。
 */
export interface CompactionStreamConfig {
  /** SSE delta 合并窗口（ms，正整数）；缺席 = 发布器缺省 50。 */
  readonly flushIntervalMs?: number;
  /** SSE delta 合并字节上限（正整数）；缺席 = 发布器缺省 4096。 */
  readonly flushMaxBytes?: number;
}

export interface CompactionConfig {
  /** 压缩链总开关（段在场必填布尔）；false = 零注册（日志面 source=declared 如实留痕）。 */
  readonly enabled: boolean;
  /** 百分比触发路径预算（整数 ≥1000）；缺席 = 窗口路径（1M 窗下不可达，T2 boot WARN 留痕）。 */
  readonly maxContextTokens?: number;
  /** 触发比例 ∈ (0, 1]（缺席 = 插件缺省 0.8）。 */
  readonly triggerRatio?: number;
  /** W57 绝对 fallback 阈值（整数 ≥1000）；声明后由 session worker 接管自动压缩，旧 auto hook 停用。 */
  readonly fallbackTokens?: number;
  /** W57 P3 上下文水位提醒档位；在场时要求 `fallbackTokens` 同时在场。 */
  readonly watermark?: CompactionWatermarkConfig;
  /** W57 worker 单次 summarize 请求超时（整数 ≥1000；缺席 = 300000）。 */
  readonly requestTimeoutMs?: number;
  /** W57 worker 单次 attempt 重试次数（整数 ≥0；缺席 = 10）。 */
  readonly retryCount?: number;
  /** 压缩后恒保留的 recent tail 条数（整数 ≥1；缺席 = 插件缺省 6）。 */
  readonly keepRecent?: number;
  /** recent tail token 预算（整数 ≥0；缺席 = wiring 物化 15000，与 keepRecent 条数下限并用取更长 tail）。 */
  readonly keepRecentTokens?: number;
  /** 前缀增长多少条才重总结（整数 ≥1；缺席 = 插件兜 =keepRecent，T5 成本旋钮）。 */
  readonly resummarizeEvery?: number;
  /** summarize（含 LLM 调用）的 hook 超时毫秒（整数 ≥1000；缺席 = wiring 物化 60000，T1）。 */
  readonly summaryTimeoutMs?: number;
  /** 单次 summarize 调用的输入 token 上限（整数 ≥1000；缺席 = 插件缺省 200000，W52 分块摘要）。 */
  readonly summaryChunkTokens?: number;
  /**
   * 摘要调用模式（"auto" | "single" | "chunked"）；键缺席 = 不物化。
   * 缺省收敛在 wiring 层（`cfg.summaryMode ?? "auto"`），schema 不造假值。
   */
  readonly summaryMode?: "auto" | "single" | "chunked";
  /** 摘要 LLM 调用的思考强度覆盖；键缺席 = 沿用模型 llmOptions（不物化）。 */
  readonly summaryReasoningEffort?: ReasoningEffort;
  /**
   * 单次调用 token 预算（整数 ≥1000）；键缺席 = wiring 按模型窗口推导
   * （`deriveSingleCallBudgetTokens`），推导失败时降级 chunked。
   */
  readonly singleCallBudgetTokens?: number;
  /**
   * worker 摘要视角集（`ops`/`chat` 的非空无重复数组，必须含 `ops`）；键缺席 = 不物化。
   * 在场时必须同时声明 `fallbackTokens`：legacy 单摘要路径不读此键。
   */
  readonly summaryPerspectives?: readonly ("ops" | "chat")[];
  /** C.2 durable compaction_boundary adapter flag（可选布尔，**缺省 OFF**；缺席/false = 不挂）。 */
  readonly boundary?: boolean;
  /** W57 P5 压缩 SSE 流节流参数；缺席 = 发布器缺省 50ms / 4096B。 */
  readonly stream?: CompactionStreamConfig;
  /** microcompact 廉价清理子段；缺席 = 不挂 microcompact hook。 */
  readonly microcompact?: MicrocompactConfig;
}

/** compaction 段在场时 enabled 必填布尔（缺席报错点名键，非布尔文案与 optionalBool 邻居逐字一致）。 */
function requireBool(raw: Record<string, unknown>, key: string, field: string, errors: string[]): boolean | undefined {
  const v = raw[key];
  if (v === undefined) {
    errors.push(`${field}: 段在场时必填布尔值（键缺席视为半句话，fail-fast）`);
    return undefined;
  }
  return optionalBool(v, field, errors);
}

/** W49-C 可选开闭区间小数校验：键缺席 = undefined 不物化；键在场必为 (0, 1] 数字。 */
function optionalRatioUpperOne(
  v: unknown,
  field: string,
  errors: string[],
): number | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1) {
    return v;
  }
  errors.push(`${field}: 需要 (0, 1] 区间的数字，实际为 ${JSON.stringify(v) ?? "undefined"}`);
  return undefined;
}

/** microcompact 子段校验：缺席 = undefined；在场必映射；triggerTokens 在场未禁用必填；target≤trigger 交叉界。 */
/** W57 P5：compaction.stream 子段；缺席 = undefined，键缺席不物化。 */
function checkCompactionStream(
  raw: unknown,
  errors: string[],
): CompactionStreamConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push("compaction.stream: 需要映射");
    return undefined;
  }
  const flushIntervalMs = optionalIntRange(
    raw["flushIntervalMs"],
    "compaction.stream.flushIntervalMs",
    1,
    errors,
  );
  const flushMaxBytes = optionalIntRange(
    raw["flushMaxBytes"],
    "compaction.stream.flushMaxBytes",
    1,
    errors,
  );
  if (flushIntervalMs === undefined && flushMaxBytes === undefined) return undefined;
  return {
    ...(flushIntervalMs === undefined ? {} : { flushIntervalMs }),
    ...(flushMaxBytes === undefined ? {} : { flushMaxBytes }),
  };
}

function checkMicrocompact(
  raw: unknown,
  errors: string[],
): MicrocompactConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("compaction.microcompact: 需要映射");
    return undefined;
  }
  const enabled = optionalBool(raw["enabled"], "compaction.microcompact.enabled", errors);
  const triggerTokens = optionalIntRange(
    raw["triggerTokens"],
    "compaction.microcompact.triggerTokens",
    1,
    errors,
  );
  const targetTokens = optionalIntRange(
    raw["targetTokens"],
    "compaction.microcompact.targetTokens",
    1,
    errors,
  );
  // keepRecent ≥0：microcompact.ts:92 把负数归 0，schema 面直接以 0 为下界（诚实边界）。
  const keepRecent = optionalIntRange(
    raw["keepRecent"],
    "compaction.microcompact.keepRecent",
    0,
    errors,
  );
  const compactableTools = optionalStrArray(
    raw["compactableTools"],
    "compaction.microcompact.compactableTools",
    errors,
  );
  // 在场且未显式禁用 = 启用意图：triggerTokens 必为有效值（缺席/非法已被上面 push，
  // 此处只补"合法形状但没给"的必填判别；非法值路径已报错，不重复 push 噪音）。
  if (enabled !== false && raw["triggerTokens"] === undefined) {
    errors.push(
      "compaction.microcompact.triggerTokens: microcompact 在场且未显式禁用时需要 ≥1 的整数（插件无诚实缺省可兜）",
    );
  }
  // 交叉界（仅两值都在场且各自合法时判，避免叠报）
  if (
    targetTokens !== undefined &&
    triggerTokens !== undefined &&
    targetTokens > triggerTokens
  ) {
    errors.push(
      `compaction.microcompact.targetTokens: 不应大于 triggerTokens(${triggerTokens})，实际为 ${targetTokens}`,
    );
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(triggerTokens === undefined ? {} : { triggerTokens }),
    ...(targetTokens === undefined ? {} : { targetTokens }),
    ...(keepRecent === undefined ? {} : { keepRecent }),
    ...(compactableTools === undefined ? {} : { compactableTools }),
  };
}

/** 可选整数数组校验：键缺席 = undefined；逐项 ≥min 整数，任一项非法即整组 undefined。 */
function optionalIntArrayMin(
  v: unknown,
  field: string,
  min: number,
  errors: string[],
): readonly number[] | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (!Array.isArray(v)) {
    errors.push(`${field}: 需要 ≥${min} 的整数数组，实际为 ${JSON.stringify(v) ?? "undefined"}`);
    return undefined;
  }
  const out: number[] = [];
  let valid = true;
  for (const [i, item] of v.entries()) {
    if (typeof item === "number" && Number.isInteger(item) && item >= min) {
      out.push(item);
    } else {
      errors.push(`${field}[${i}]: 需要 ≥${min} 的整数，实际为 ${JSON.stringify(item) ?? "undefined"}`);
      valid = false;
    }
  }
  return valid ? out : undefined;
}

/**
 * watermark 子段校验：缺省 = undefined；在场必须是映射，且必须同时声明 fallbackTokens；
 * levels 逐项 ≥1000、严格递增、每个 < fallbackTokens（交叉界只在两值合法时判，避免叠报）。
 */
function checkCompactionWatermark(
  raw: unknown,
  fallbackTokens: number | undefined,
  errors: string[],
): CompactionWatermarkConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("compaction.watermark: 需要映射");
    return undefined;
  }
  if (fallbackTokens === undefined) {
    errors.push(
      "compaction.watermark: 需要同时声明 compaction.fallbackTokens（水位档位必须小于兜底阈值）",
    );
    return undefined;
  }
  const levels = optionalIntArrayMin(
    raw["levels"],
    "compaction.watermark.levels",
    1000,
    errors,
  );
  if (levels !== undefined && levels.length === 0) {
    errors.push("compaction.watermark.levels: 需要非空整数数组（至少一个水位档位）");
  }
  if (levels !== undefined) {
    for (let i = 1; i < levels.length; i++) {
      if (levels[i]! <= levels[i - 1]!) {
        errors.push(
          `compaction.watermark.levels: 必须严格递增，实际为 ${JSON.stringify(levels)}`,
        );
        break;
      }
    }
    for (const [i, level] of levels.entries()) {
      if (level >= fallbackTokens) {
        errors.push(
          `compaction.watermark.levels[${i}]: 必须小于 compaction.fallbackTokens(${fallbackTokens})，实际为 ${level}`,
        );
      }
    }
  }
  return { ...(levels === undefined ? {} : { levels }) };
}

function checkSummaryPerspectives(
  v: unknown,
  fallbackTokens: number | undefined,
  errors: string[],
): readonly ("ops" | "chat")[] | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (!Array.isArray(v)) {
    errors.push(
      `compaction.summaryPerspectives: 需要 "ops"/"chat" 数组，实际为 ${JSON.stringify(v) ?? "undefined"}`,
    );
    return undefined;
  }
  if (fallbackTokens === undefined) {
    errors.push(
      "compaction.summaryPerspectives: 需要同时声明 compaction.fallbackTokens（双视角摘要由 worker 摘要链接管，legacy 单摘要路径不读此键）",
    );
    return undefined;
  }
  if (v.length === 0) {
    errors.push("compaction.summaryPerspectives: 需要非空数组（至少声明一个视角）");
    return undefined;
  }
  const out: ("ops" | "chat")[] = [];
  for (const [i, item] of v.entries()) {
    if (item === "ops" || item === "chat") {
      out.push(item);
    } else {
      errors.push(
        `compaction.summaryPerspectives[${i}]: 需要 "ops" 或 "chat"，实际为 ${JSON.stringify(item) ?? "undefined"}`,
      );
    }
  }
  if (out.length !== v.length) {
    return undefined;
  }
  if (new Set(out).size !== out.length) {
    errors.push(
      `compaction.summaryPerspectives: 不允许重复视角，实际为 ${JSON.stringify(v)}`,
    );
    return undefined;
  }
  if (!out.includes("ops")) {
    errors.push(
      `compaction.summaryPerspectives: 必须包含 "ops"，实际为 ${JSON.stringify(v)}`,
    );
    return undefined;
  }
  return out;
}

/** compaction 段校验：整段缺省 = undefined；存在必为映射；enabled 必填；其余键缺席不物化、非法值中文 fail-fast 点名键名。 */
export function checkCompaction(
  raw: unknown,
  errors: string[],
): CompactionConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("compaction: 需要映射");
    return undefined;
  }
  const enabled = requireBool(raw, "enabled", "compaction.enabled", errors);
  const maxContextTokens = optionalIntRange(
    raw["maxContextTokens"],
    "compaction.maxContextTokens",
    1000,
    errors,
  );
  const triggerRatio = optionalRatioUpperOne(
    raw["triggerRatio"],
    "compaction.triggerRatio",
    errors,
  );
  const fallbackTokens = optionalIntRange(
    raw["fallbackTokens"],
    "compaction.fallbackTokens",
    1000,
    errors,
  );
  const watermark = checkCompactionWatermark(raw["watermark"], fallbackTokens, errors);
  const requestTimeoutMs = optionalIntRange(
    raw["requestTimeoutMs"],
    "compaction.requestTimeoutMs",
    1000,
    errors,
  );
  const retryCount = optionalIntRange(
    raw["retryCount"],
    "compaction.retryCount",
    0,
    errors,
  );
  const keepRecent = optionalIntRange(raw["keepRecent"], "compaction.keepRecent", 1, errors);
  const keepRecentTokens = optionalIntRange(
    raw["keepRecentTokens"],
    "compaction.keepRecentTokens",
    0,
    errors,
  );
  const resummarizeEvery = optionalIntRange(
    raw["resummarizeEvery"],
    "compaction.resummarizeEvery",
    1,
    errors,
  );
  const summaryTimeoutMs = optionalIntRange(
    raw["summaryTimeoutMs"],
    "compaction.summaryTimeoutMs",
    1000,
    errors,
  );
  const summaryChunkTokens = optionalIntRange(
    raw["summaryChunkTokens"],
    "compaction.summaryChunkTokens",
    1000,
    errors,
  );
  const summaryMode = optionalEnum(
    raw["summaryMode"],
    "compaction.summaryMode",
    ["auto", "single", "chunked"],
    errors,
  );
  const summaryReasoningEffort = optionalReasoningEffort(
    raw["summaryReasoningEffort"],
    "compaction.summaryReasoningEffort",
    errors,
  );
  const singleCallBudgetTokens = optionalIntRange(
    raw["singleCallBudgetTokens"],
    "compaction.singleCallBudgetTokens",
    1000,
    errors,
  );
  const summaryPerspectives = checkSummaryPerspectives(
    raw["summaryPerspectives"],
    fallbackTokens,
    errors,
  );
  const boundary = optionalBool(raw["boundary"], "compaction.boundary", errors);
  const stream = checkCompactionStream(raw["stream"], errors);
  const microcompact = checkMicrocompact(raw["microcompact"], errors);
  if (enabled === undefined) {
    return undefined;
  }
  return {
    enabled,
    ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
    ...(triggerRatio === undefined ? {} : { triggerRatio }),
    ...(fallbackTokens === undefined ? {} : { fallbackTokens }),
    ...(watermark === undefined ? {} : { watermark }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(retryCount === undefined ? {} : { retryCount }),
    ...(keepRecent === undefined ? {} : { keepRecent }),
    ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
    ...(resummarizeEvery === undefined ? {} : { resummarizeEvery }),
    ...(summaryTimeoutMs === undefined ? {} : { summaryTimeoutMs }),
    ...(summaryChunkTokens === undefined ? {} : { summaryChunkTokens }),
    ...(summaryMode === undefined ? {} : { summaryMode }),
    ...(summaryReasoningEffort === undefined ? {} : { summaryReasoningEffort }),
    ...(singleCallBudgetTokens === undefined ? {} : { singleCallBudgetTokens }),
    ...(summaryPerspectives === undefined ? {} : { summaryPerspectives }),
    ...(boundary === undefined ? {} : { boundary }),
    ...(stream === undefined ? {} : { stream }),
    ...(microcompact === undefined ? {} : { microcompact }),
  };
}

/**
 * W40 可选整数校验（optionalBool 同构）：键缺席 = undefined 不物化（"缺省 ⇒ core 常量"
 * 的收敛在派发时刻现读，schema 不造假值）；键在场必为 ≥min 整数，报错文案与 intRange
 * 逐字一致（邻居口径统一）。
 */
function optionalIntRange(
  v: unknown,
  field: string,
  min: number,
  errors: string[],
): number | undefined {
  if (v === undefined) {
    return undefined;
  }
  return intRange(v, field, min, errors);
}

/**
 * 调度子系统上线档位：live = 真跑、shadow = 只观测不生效、off = 不启。
 * 档位组合语义归 boot/消费层，schema 只做形状校验（不在本段判互斥）。
 */
export type SchedulingMode = "live" | "shadow" | "off";

/**
 * scheduling 段（调度子系统配置面）：键全可选、键缺席 = undefined 不物化
 * （"缺省 ⇒ 运行期缺省"的收敛在 boot，schema 面不造假值；W40/W42c 同款纪律）。
 * 四个时长/阈值键均为正整数（≥1）；timezone 为非空字符串（IANA 名合法性归运行期）。
 * 未知键与邻居各段同口径：不读不报，静默容忍。
 */
export interface SchedulingConfig {
  /** 唤醒队列档位；缺席 = 不物化（boot 收敛）。 */
  readonly wakeQueue?: SchedulingMode;
  /** 计划调度器档位；缺席 = 不物化（boot 收敛）。 */
  readonly planScheduler?: SchedulingMode;
  /** 看门狗超时（毫秒，正整数）；缺席 = 不物化。 */
  readonly watchdogMs?: number;
  /** 计划视野（小时，正整数）；缺席 = 不物化。 */
  readonly horizonHours?: number;
  /** 追赶窗口（小时，正整数）；缺席 = 不物化。 */
  readonly catchupMaxAgeHours?: number;
  /** 欠账判定阈值（小时，正整数）；缺席 = 不物化。 */
  readonly debtAfterHours?: number;
  /** 时区名（非空字符串）；缺席 = 不物化。 */
  readonly timezone?: string;
  /** 调度目标会话；缺席 = boot 按默认主会话选择。 */
  readonly sessionId?: string;
}

/** scheduling 段校验：整段缺省 = undefined；存在必为映射；单键缺席不物化、非法值 fail-fast。 */
export function checkScheduling(
  raw: unknown,
  errors: string[],
): SchedulingConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push("scheduling: 需要映射");
    return undefined;
  }
  const wakeQueue = optionalEnum(
    raw["wakeQueue"],
    "scheduling.wakeQueue",
    ["live", "shadow", "off"],
    errors,
  );
  const planScheduler = optionalEnum(
    raw["planScheduler"],
    "scheduling.planScheduler",
    ["live", "shadow", "off"],
    errors,
  );
  const watchdogMs = optionalIntRange(
    raw["watchdogMs"],
    "scheduling.watchdogMs",
    1,
    errors,
  );
  const horizonHours = optionalIntRange(
    raw["horizonHours"],
    "scheduling.horizonHours",
    1,
    errors,
  );
  const catchupMaxAgeHours = optionalIntRange(
    raw["catchupMaxAgeHours"],
    "scheduling.catchupMaxAgeHours",
    1,
    errors,
  );
  const debtAfterHours = optionalIntRange(
    raw["debtAfterHours"],
    "scheduling.debtAfterHours",
    1,
    errors,
  );
  const timezone = optionalStr(raw["timezone"], "scheduling.timezone", errors);
  const sessionId = optionalStr(raw["sessionId"], "scheduling.sessionId", errors);
  return {
    ...(wakeQueue === undefined ? {} : { wakeQueue }),
    ...(planScheduler === undefined ? {} : { planScheduler }),
    ...(watchdogMs === undefined ? {} : { watchdogMs }),
    ...(horizonHours === undefined ? {} : { horizonHours }),
    ...(catchupMaxAgeHours === undefined ? {} : { catchupMaxAgeHours }),
    ...(debtAfterHours === undefined ? {} : { debtAfterHours }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}
