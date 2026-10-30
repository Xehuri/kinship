// T31 serve 装配 —— 配置装载入口（loom.yaml → HotConfigStore 基线）。
// 凭据铁律（D28）：本模块只 load/apply 配置文本，绝不接触/打印 resolved 密钥值。
// 端口覆盖（--port）只影响监听参数，不改配置文本——配置口径的生效版本仍以
// apply 文本哈希为准（/config 视图），监听口以 serve 实际 listen 为准。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LoomConfigError, loadLoomConfig, type LoomConfig } from "../config/loom-config.js";
import {
  createFileAuditSink,
  HotConfigStore,
  type ConfigAppliedEvent,
} from "../hotreload/index.js";

/** cli.ts（src 层）所在目录锚点：src/ 与 dist/ 同深度，用它锚定仓库根免 cwd 依赖。 */
const HERE_URL = new URL(".", import.meta.url);

/** 仓库根 = packages/server/src/serve 向上 4 级（与 adapters defaultStateRoot 同技法）。 */
export const REPO_ROOT: string = fileURLToPath(new URL("../../../../", HERE_URL));

/** 环境变量名（docs/01 §15 命名表：LOOM_CONFIG / LOOM_STATE / LOOM_TOKEN）。 */
export const LOOM_CONFIG_ENV = "LOOM_CONFIG" as const;
export const LOOM_STATE_ENV = "LOOM_STATE" as const;
export const LOOM_TOKEN_ENV = "LOOM_TOKEN" as const;
/** 冒烟/CI 假令牌环境变量（任务冻结项：绝不含真实凭据）。 */
export const LOOM_TEST_TOKEN_ENV = "LOOM_TEST_TOKEN" as const;
/**
 * W27 实例化环境变量：workspace 实例根（绝对路径，一个目录=一个 loom 实例）。
 * 仓库本体退化为纯客户端/引擎——运行数据与配置全部住进 `<instance>/.loom/`，
 * 指到不同实例根即得起多个互不串台的 loom 实例。
 */
export const LOOM_INSTANCE_ENV = "LOOM_INSTANCE" as const;
/** 计划/长期任务真源根覆盖（显式绝对路径；优先于 config `plan.root`）。 */
export const LOOM_PLAN_ROOT_ENV = "LOOM_PLAN_ROOT" as const;

/** W27 实例内运行目录名（state 根 + config.yaml 的共同宿主）。 */
export const INSTANCE_DIR_NAME = ".loom" as const;

/** 缺省配置路径（仓库 config/loom.yaml；gitignore 内，模板=loom.example.yaml）。 */
export const DEFAULT_CONFIG_PATH: string = join(REPO_ROOT, "config", "loom.yaml");

/** 缺省 state 根（仓库 state/；L0 唯一落盘根，ledger/trace/config/session 日分片同住）。 */
export const DEFAULT_STATE_ROOT: string = join(REPO_ROOT, "state");

/** 实例根下的 state 根：`<instance>/.loom`（session/ledger/trace/dead-letter/inbox/config 六子目录同住其中）。 */
export function instanceStateRoot(instance: string): string {
  return join(instance, INSTANCE_DIR_NAME);
}

/** 实例根下的配置路径：`<instance>/.loom/config.yaml`。 */
export function instanceConfigPath(instance: string): string {
  return join(instanceStateRoot(instance), "config.yaml");
}

/** 配置文件缺失：指向 example 模板口径报错（任务冻结项），绝不回退到猜测一份默认配置。 */
export class ConfigFileMissingError extends Error {
  readonly path: string;
  readonly templatePath: string;

  constructor(path: string) {
    const templatePath = path.replace(/loom\.yaml$/, "loom.example.yaml");
    super(
      `找不到 loom 配置文件：${path}\n` +
        `请先复制模板并按口径填写：cp ${templatePath} ${path}\n` +
        "（凭据只写 ${ENV_VAR} 引用，密钥经 systemd Environment= 注入；" +
        "见 docs/credential-migration-checklist.md）",
    );
    this.name = "ConfigFileMissingError";
    this.path = path;
    this.templatePath = templatePath;
  }
}

/**
 * W27 实例配置缺失（部署错误，口径镜像 TokenMissingError 纪律）：设了 LOOM_INSTANCE
 * 却没在 `<instance>/.loom/config.yaml` 落配置 = 迁移没做完就指向了实例根。
 * 绝不静默回退仓库 legacy 缺省——回退会让实例 A 悄悄读写仓库 state/（或另一实例的
 * 旧配置），隔离承诺当场破产；响亮炸，让运维把 runbook 补完。
 */
export class InstanceConfigMissingError extends Error {
  readonly instanceRoot: string;
  readonly expectedPath: string;

  constructor(instanceRoot: string, expectedPath: string) {
    super(
      `serve 启动失败：设置了 ${LOOM_INSTANCE_ENV}="${instanceRoot}"，` +
        `但实例配置不存在：${expectedPath}\n` +
        "（LOOM_INSTANCE 指向的是 workspace 实例根；运行数据与配置住在其下 .loom/。" +
        "请先完成实例迁移：mkdir -p .loom 并把配置落为 .loom/config.yaml——" +
        "口径见 state/fleet/out/w27.md 部署清单；" +
        "非实例模式请撤掉 LOOM_INSTANCE 回落仓库 legacy 缺省）",
    );
    this.name = "InstanceConfigMissingError";
    this.instanceRoot = instanceRoot;
    this.expectedPath = expectedPath;
  }
}

/**
 * 解析配置文件路径，优先级（W27 冻结口径）：
 * --config 显式参数 > LOOM_CONFIG 环境变量 > `$LOOM_INSTANCE/.loom/config.yaml` > 仓库缺省。
 * 实例分支做存在性硬校验：LOOM_INSTANCE 已设而实例配置不存在 → InstanceConfigMissingError
 * （部署错误绝不静默起在错误配置上）；显式/LOOM_CONFIG 命中时不回看实例（迁移过渡期
 * 显式指路是运维的合法手段）。回落仓库缺省时打一行 legacy warn（观测面说实话）。
 * 其余存在性校验在 loadServeConfig 里做（此处只裁决路径来源）。
 */
export function resolveConfigPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  warn?: (msg: string) => void,
): string {
  if (explicit !== undefined) return explicit;
  const fromEnv = env[LOOM_CONFIG_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const instance = env[LOOM_INSTANCE_ENV];
  if (instance !== undefined && instance.length > 0) {
    const candidate = instanceConfigPath(instance);
    if (!existsSync(candidate)) {
      throw new InstanceConfigMissingError(instance, candidate);
    }
    return candidate;
  }
  warn?.(
    `loom 配置回落仓库 legacy 缺省路径（非实例模式）：${DEFAULT_CONFIG_PATH}；` +
      `实例化口径见 ${LOOM_INSTANCE_ENV}`,
  );
  return DEFAULT_CONFIG_PATH;
}

/**
 * state 根解析（W27 冻结口径）：LOOM_STATE 显式 > `$LOOM_INSTANCE/.loom` > 仓库缺省。
 * 装配处显式传（boot 的 StateLayout / EventHub / Tracer 全从这一口拿根），
 * 免得各消费方各猜各的。实例模式下不做目录存在性硬校验：layout.ensureDirs 幂等建齐，
 * 空实例首启合法；配置的硬校验已守住"指向错根"的主要部署事故面。
 */
export function resolveStateRootFromEnv(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[LOOM_STATE_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const instance = env[LOOM_INSTANCE_ENV];
  if (instance !== undefined && instance.length > 0) return instanceStateRoot(instance);
  return DEFAULT_STATE_ROOT;
}

/** planRoot 解析结果：显式根 + 来源；缺省携带可观测的禁用原因。 */
export type PlanRootResolution =
  | { readonly planRoot: string; readonly source: "env" | "config" }
  | { readonly planRoot: undefined; readonly reason: string };

/**
 * planRoot 解析（GAP-3/GAP-4）：LOOM_PLAN_ROOT 压过 config `plan.root`；两者皆缺 =
 * plan/long_task 工具不挂面，并返回禁用原因（显式根缺失，绝不猜 ai/data）。
 * 显式值必须是绝对路径，否则装配期响亮拒绝（不静默禁用、不回落猜测根）。
 */
export function resolvePlanRoot(
  configRoot: string | undefined,
  env: NodeJS.ProcessEnv,
): PlanRootResolution {
  const envRoot = env[LOOM_PLAN_ROOT_ENV]?.trim() ?? "";
  const configuredRoot = configRoot?.trim() ?? "";
  const raw = envRoot.length > 0 ? envRoot : configuredRoot;
  if (raw.length === 0) {
    return {
      planRoot: undefined,
      reason:
        `plan.root 未配置且 ${LOOM_PLAN_ROOT_ENV} 未设置：` +
        "plan/long_task 工具不挂面（显式根缺失，绝不猜 ai/data）",
    };
  }
  const source = envRoot.length > 0 ? "env" : "config";
  if (!isAbsolute(raw)) {
    throw new Error(
      `planRoot 必须是显式绝对路径（来源 ${source}: ${raw}）；绝不猜测 ai/data`,
    );
  }
  return { planRoot: resolve(raw), source };
}

/** 服务令牌缺失（Router 空 tokens = 拒绝一切请求，属部署错误，绝不静默起不可用服务）。 */
export class TokenMissingError extends Error {
  constructor() {
    super(
      `serve 启动失败：未配置服务令牌。请设置 ${LOOM_TOKEN_ENV}（或冒烟用 ${LOOM_TEST_TOKEN_ENV}）；` +
        "值绝不含真实凭据——口径见 docs/credential-migration-checklist.md",
    );
    this.name = "TokenMissingError";
  }
}

/**
 * 服务令牌解析（Router 鉴权唯一来源；loom.yaml schema 无 token 段——D28 密钥走 env）。
 * 接受 LOOM_TOKEN（docs/01 §15 命名表）与 LOOM_TEST_TOKEN（冒烟/CI 假令牌，任务冻结项），
 * 逗号分隔多值（轮换期双令牌），去重后原样进 Router。两者皆空 → TokenMissingError。
 */
export function resolveServeTokens(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = [env[LOOM_TOKEN_ENV] ?? "", env[LOOM_TEST_TOKEN_ENV] ?? ""]
    .flatMap((chunk) => chunk.split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unique = [...new Set(raw)];
  if (unique.length === 0) throw new TokenMissingError();
  return unique;
}

/**
 * 载入 serve 配置基线：loadLoomConfig（schema+凭据 fail-fast）→ 校验通过才
 * new HotConfigStore + applyFile 建立生效版本（config.applied 审计同步落
 * state/config/{date}.jsonl，ops-api /config/audit 由此可查）。
 * 缺失配置文件 → ConfigFileMissingError（提示模板）；校验失败 → LoomConfigError 原样上抛。
 */
export function loadServeConfig(options: {
  readonly configPath: string;
  readonly stateRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}): { readonly config: LoomConfig; readonly store: HotConfigStore } {
  const env = options.env ?? process.env;
  if (!existsSync(options.configPath)) {
    throw new ConfigFileMissingError(options.configPath);
  }
  const config = loadLoomConfig(options.configPath, env);
  const store = new HotConfigStore({
    sink: createFileAuditSink(join(options.stateRoot, "config")),
    env,
  });
  // loadLoomConfig 已用同一 env 校验通过，applyFile 走同一路径理论上必成功；
  // 类型化拒载只剩理论分支——不静默吞：响亮抛，让装配失败可见。
  const result = store.applyFile(options.configPath);
  if (!result.ok) {
    throw new LoomConfigError(
      options.configPath,
      [`热加载基线交换失败（stage=${result.stage}）`, ...result.errors],
    );
  }
  return { config, store };
}

/**
 * 审计事件读取（ops-api /config/audit 数据源）：扫 state/config/*.jsonl 全部分片，
 * 撕裂/坏行容忍（读侧口径同 T08），按 ts 升序返回。目录不存在 = 空表。
 */
export function readConfigAudit(stateRoot: string): readonly ConfigAppliedEvent[] {
  const dir = join(stateRoot, "config");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return []; // 目录还没建（从未 apply 过）= 空审计面
  }
  const out: ConfigAppliedEvent[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue; // 单文件读失败不影响其余（NTFS 噪声容忍）
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed: unknown = safeJsonParse(trimmed);
      if (isConfigAppliedEvent(parsed)) out.push(parsed);
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null; // 撕裂尾行容忍
  }
}

/** 判别审计事件形状：只认 type=config.applied + status 二值；坏行丢弃不炸。 */
function isConfigAppliedEvent(x: unknown): x is ConfigAppliedEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  if (e["type"] !== "config.applied") return false;
  if (typeof e["ts"] !== "string") return false;
  if (typeof e["source"] !== "string") return false;
  if (typeof e["beforeSha256"] !== "string" && e["beforeSha256"] !== null) return false;
  if (typeof e["afterSha256"] !== "string" && e["afterSha256"] !== null) return false;
  return e["status"] === "applied" || e["status"] === "rejected";
}
