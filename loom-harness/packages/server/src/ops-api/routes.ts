// T30 配置/目录/健康只读 API（ops domain）。
// 全部只读（仅 GET，无任何写端点）；鉴权继承 http 骨架（Router 在匹配前统一鉴权，
// 见 ../http/router.ts 与 docs/05：health 同样要求 token，不存在未鉴权可达路径）。
// 脱敏铁律（credentials.ts raw/resolved 分离口径）：对外只回 `${ENV_VAR}` 引用名，
// 绝不回显 resolved 密钥值；审计面只暴露版本哈希 + 时间，不外泄配置原文。
import type { ReasoningEffort } from "../config/section-checks.js";
import type { LoomConfig } from "../config/loom-config.js";
import type { ConfigAppliedEvent } from "../hotreload/types.js";
import type { HotConfigStore } from "../hotreload/store.js";
import type { Router } from "../http/router.js";
import { sendJson } from "../http/respond.js";

/**
 * 只读 API 的注入依赖（T31 serve CLI 组装时接真实实例；测试注入 fake）。
 * - getConfig()：当前生效配置（来自 hotStore.get() 或静态加载，二选一由宿主决定）。
 * - hotStore：热加载存储；用于取当前生效配置的文本哈希（版本指纹）。null = 无热加载面。
 * - startedAt：进程启动时间（epoch ms），health 用于算 uptime。
 * - version：构建版本字符串。
 * - audit：审计事件源（缺省 = 无审计面，/config/audit 回空表）。
 */
export interface OpsDeps {
  readonly getConfig: () => LoomConfig;
  readonly hotStore: HotConfigStore | null;
  readonly startedAt: number;
  readonly version: string;
  readonly audit?: (() => readonly ConfigAppliedEvent[]) | undefined;
}

/** GET /health 响应体。 */
export interface HealthBody {
  readonly status: "ok";
  readonly version: string;
  readonly uptimeMs: number;
  readonly startedAt: string;
}

/** 单条凭据的对外视图：仅 `${ENV_VAR}` 引用形式，无值。 */
export interface CredentialView {
  readonly name: string;
  readonly envRef: string;
}

/** 单条 provider 的对外视图：端点非密钥可直投，内联密钥只回是否配置。 */
export interface ProviderView {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKeyConfigured: boolean;
}

/** GET /config 响应体（脱敏后的生效配置）。 */
export interface ConfigView {
  readonly server: { readonly port: number; readonly hostname: string };
  readonly workspace: string;
  readonly modelIds: readonly string[];
  readonly pricingProviders: readonly string[];
  readonly credentials: readonly CredentialView[];
  readonly providers: readonly ProviderView[];
  /** W5 skills 段视图（allowlist 是部署路径、非密钥，原样透出）；未配置 = null。 */
  readonly skills: { readonly allowlist: readonly string[] } | null;
  /** W5 mcp 段视图（env 只回键名，值与 credentials 同纪律不出库）；未配置 = null。 */
  readonly mcp: readonly McpServerView[] | null;
  /** W4 bash.shell 视图（program/args 是部署命令面、非密钥，直投）；未配置 = null（= 平台默认）。 */
  readonly bashShell: { readonly program: string; readonly args: readonly string[] } | null;
  /** 生效配置的文本 sha256（版本指纹）；无热加载库为 null。 */
  readonly effectiveVersionSha256: string | null;
}

/** GET /config 的单个 MCP server 视图（脱敏：env 值一律只留键名）。 */
export interface McpServerView {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly envKeys: readonly string[];
  readonly requestTimeoutMs?: number;
}

/** GET /catalog/models 单条模型视图（ModelConfig 无密钥，原样透出）。 */
export interface ModelView {
  readonly id: string;
  readonly provider: string;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly vision: boolean;
  readonly timeout: number;
  readonly reasoningEffort?: ReasoningEffort;
}

/**
 * GET /config/audit 单条审计视图。
 * 铁律「审计只回哈希+时间」：只投影 ts/status/stage/前后哈希；
 * errors 文本与 source 路径不出库（拒载详情留在本地 jsonl 审计文件）。
 */
export interface AuditEventView {
  readonly ts: string;
  readonly status: "applied" | "rejected";
  readonly stage?: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
}

function toAuditView(events: readonly ConfigAppliedEvent[]): readonly AuditEventView[] {
  return events.map((e) => {
    const stage = e.status === "rejected" ? { stage: e.stage } : {};
    return {
      ts: e.ts,
      status: e.status,
      ...stage,
      beforeSha256: e.beforeSha256,
      afterSha256: e.afterSha256,
    };
  });
}

function envRefLiteral(envRef: string): string {
  // 存储口径 envRef 是变量名（如 LOOM_KEY_X）；对外还原为 `${LOOM_KEY_X}` 引用字面量。
  return "${" + envRef + "}";
}

/** 把生效配置投影为脱敏视图：credentials 只留引用名，resolved 值一律丢弃。 */
export function toConfigView(cfg: LoomConfig, effectiveSha: string | null): ConfigView {
  const credentials: CredentialView[] = Object.entries(cfg.credentials).map(
    ([name, entry]) => ({ name, envRef: envRefLiteral(entry.envRef) }),
  );
  const providers: ProviderView[] = Object.entries(cfg.providers).map(([name, entry]) => ({
    name,
    baseUrl: entry.baseUrl,
    apiKeyConfigured: entry.apiKey !== undefined,
  }));
  const mcp: McpServerView[] | null =
    cfg.mcp === undefined
      ? null
      : cfg.mcp.servers.map((s) => {
          const view: McpServerView = {
            name: s.name,
            cmd: s.cmd,
            args: s.args,
            envKeys: s.env === undefined ? [] : Object.keys(s.env),
            ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
            ...(s.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: s.requestTimeoutMs }),
          };
          return view;
        });
  return {
    server: { port: cfg.server.port, hostname: cfg.server.hostname },
    workspace: cfg.workspace,
    modelIds: cfg.models.map((m) => m.id),
    pricingProviders: Object.keys(cfg.pricing),
    credentials,
    providers,
    skills: cfg.skills === undefined ? null : { allowlist: cfg.skills.allowlist },
    mcp,
    bashShell:
      cfg.bash?.shell === undefined
        ? null
        : { program: cfg.bash.shell.program, args: cfg.bash.shell.args ?? [] },
    effectiveVersionSha256: effectiveSha,
  };
}

function toModelViews(cfg: LoomConfig): readonly ModelView[] {
  return cfg.models.map((m) => ({
    id: m.id,
    provider: m.provider,
    contextWindow: m.contextWindow,
    maxOutput: m.maxOutput,
    vision: m.vision,
    timeout: m.timeout,
    ...(m.reasoningEffort === undefined ? {} : { reasoningEffort: m.reasoningEffort }),
  }));
}

/** 把四只读端点注册到 Router。方法固定 GET；无任何写端点。 */
export function registerOpsRoutes(router: Router, deps: OpsDeps): void {
  const effectiveSha = (): string | null => deps.hotStore?.currentSha256() ?? null;

  router.add("GET", "/health", (_req, res) => {
    const body: HealthBody = {
      status: "ok",
      version: deps.version,
      uptimeMs: Math.max(0, Date.now() - deps.startedAt),
      startedAt: new Date(deps.startedAt).toISOString(),
    };
    sendJson(res, 200, body);
  });

  router.add("GET", "/config", (_req, res) => {
    sendJson(res, 200, toConfigView(deps.getConfig(), effectiveSha()));
  });

  router.add("GET", "/catalog/models", (_req, res) => {
    const models = toModelViews(deps.getConfig());
    sendJson(res, 200, { models, count: models.length });
  });

  router.add("GET", "/config/audit", (_req, res) => {
    const events = deps.audit === undefined ? [] : deps.audit();
    sendJson(res, 200, { events: toAuditView(events) });
  });
}
