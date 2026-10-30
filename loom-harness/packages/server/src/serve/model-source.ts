// T31 serve 装配 —— 模型来源判别（fake/real 分区 + LOOM_FAKE_MODEL 离线覆盖）。
// W53 T1：解析面从"单 main 句柄"扩到 ServeModelSet（models[] 逐条解析成句柄 +
//   main 兼容旧语义 + teardownAll 统一停机），供后续 per-agent 模型路由消费。
// 逐条口径：
//   - env LOOM_FAKE_MODEL=1：无视配置声明，models[] **每一条**都以 fake provider 解析
//     （离线冒烟/开发通道，脚本为空 = 内核收到即"[fake: no more scripted responses]"自然收场）。
//   - config 含 provider: fake 条目：该条走 fake，其余 real 条目各走自己的真接线。
//   - real 条目：OpenAI 兼容真接线——baseUrl 取
//     models[].baseUrl（model 级）> providers[provider].baseUrl（provider 级）；皆缺则响亮拒绝。
//     apiKey 优先取 providers[provider].apiKey（内联），缺席才回退 config.credentials
//     （env 解析产物）按该条自己的 provider 逻辑名取，经 llmOptions 透传给内核；
//     **本模块任何错误消息/日志绝不回显密钥值**。
// main 选择（与旧 resolveServeModel 逐字节等价）：env 强制 → models[0]；
//   否则首个 provider: fake → 该条；否则 models[0]。
// 凭据铁律：密钥只写入 llmOptions，绝不打印/错误回显；fake 路径零凭据依赖。

import {
  makeOpenAICompatibleModel,
  type Api,
  type LlmOptions,
  type Model,
} from "@axeuh/loom-core";
import type { ModelConfig } from "../config/section-checks.js";
import type { Credentials, LoomConfig } from "../config/loom-config.js";
import {
  createFakeModelFromConfig,
  FAKE_PROVIDER,
  isFakeModelConfig,
  partitionModelConfigs,
} from "../fake-model/index.js";
import type { FakeModel } from "@axeuh/loom-core/testing";

/** 强制 fake 的环境开关值（docs/01 §15 前缀 LOOM_*）。 */
export const LOOM_FAKE_MODEL_ENV = "LOOM_FAKE_MODEL" as const;

/** 真 provider 未接线（serve 阶段的可读失败，退出前由 cli 打印）。 */
export class RealProviderNotWiredError extends Error {
  constructor(provider: string) {
    super(
      `serve 无法为真 provider "${provider}" 接线：` +
        "models[].baseUrl 与 providers[].baseUrl 均未给出该模型的 OpenAI 兼容端点。" +
        "离线开发/冒烟：models[].provider 用 fake，或设 LOOM_FAKE_MODEL=1 强制假模型。",
    );
    this.name = "RealProviderNotWiredError";
  }
}

/** 装配持有的模型句柄：注入用 model + llmOptions + 停机时的 provider 注销。 */
export interface ServeModelHandle {
  readonly model: Model<Api>;
  /**
   * 真 provider 的透传项（apiKey=providers[].apiKey 内联值优先，缺席回退 credentials
   * 解析值；timeoutMs=models[].timeout）。fake 通道为空对象——主会话/副会话统一经此
   * 拿到密钥，不另开读取路径。
   */
  readonly llmOptions: LlmOptions;
  /** 注销 fake api provider（真实 provider 无此需求，no-op）。 */
  teardown(): void;
}

/**
 * 多模型装配句柄集（W53 T1）：models[] 每条一个句柄，供后续 per-agent 路由按 id 取用。
 * main 与旧 resolveServeModel 返回的句柄语义逐字节等价；byId 按 config id 键控
 * （schema 保证唯一）；teardownAll 统一注销全部 fake provider，二次调用 no-op。
 */
export interface ServeModelSet {
  readonly main: ServeModelHandle;
  readonly byId: ReadonlyMap<string, ServeModelHandle>;
  teardownAll(): void;
}

/** 该配置在 serve 层是否走离线 fake 通道（env 覆盖或 provider 声明判别）。 */
export function wantsFakeModel(config: LoomConfig, env: NodeJS.ProcessEnv): boolean {
  if (env[LOOM_FAKE_MODEL_ENV] === "1") return true;
  return config.models.some(isFakeModelConfig);
}

/** 供判别/测试的纯函数：给定配置+env，返回将走 fake 通道的数据面条目。 */
export function pickFakeModelConfig(config: LoomConfig, env: NodeJS.ProcessEnv): ModelConfig | null {
  if (config.models.length === 0) return null; // schema 保证非空，防御分支
  const first = config.models[0];
  if (first === undefined) return null;
  const { fake } = partitionModelConfigs(config.models);
  const chosen = env[LOOM_FAKE_MODEL_ENV] === "1" ? first : fake[0];
  if (chosen === undefined) return null;
  // env 强制时把 provider 数据面改写为 fake（createFakeModelFromConfig 的判别依据）。
  return env[LOOM_FAKE_MODEL_ENV] === "1" ? { ...chosen, provider: FAKE_PROVIDER } : chosen;
}

/** 真 provider 端点解析：model 级 baseUrl > provider 级 providers[]；皆缺 → null（调用方响亮拒绝）。 */
export function resolveRealBaseUrl(
  spec: ModelConfig,
  providers: LoomConfig["providers"],
): string | null {
  if (spec.baseUrl !== undefined) return spec.baseUrl;
  return providers[spec.provider]?.baseUrl ?? null;
}

/**
 * 凭据查找错误：点名 provider 与两个可接受位置（providers[].apiKey / credentials env 引用），
 * 绝不回显任何密钥值。
 */
export class ServeCredentialMissingError extends Error {
  constructor(provider: string) {
    super(
      `serve 真 provider "${provider}" 无凭据：providers[].apiKey 未声明，` +
        `credentials 段也没有 ${provider}: \${ENV_VAR} 声明（或引用的环境变量无值）。` +
        `请在 providers[] 的 "${provider}" 条目加 apiKey，或在 credentials 段写 ` +
        `${provider}: \${ENV_VAR}（二选一；fail-fast，口径见 docs/credential-migration-checklist.md）`,
    );
    this.name = "ServeCredentialMissingError";
  }
}

/**
 * 单条模型解析：env 强制或条目声明 fake → FakeModel；否则真 provider 走 OpenAI 兼容接线。
 * 与旧 resolveServeModel 单模型路径同一逻辑，逐条独立取自己的端点/凭据/超时。
 */
function resolveServeModelEntry(
  spec: ModelConfig,
  config: LoomConfig,
  env: NodeJS.ProcessEnv,
  credentials: Credentials,
): ServeModelHandle {
  const forceFake = env[LOOM_FAKE_MODEL_ENV] === "1";
  if (forceFake || isFakeModelConfig(spec)) {
    // env 强制时把 provider 数据面改写为 fake（createFakeModelFromConfig 的判别依据）；
    // 未强制时条目本身就是 fake，原样传入。id 恒由 config 声明保留。
    const fakeSpec: ModelConfig = forceFake ? { ...spec, provider: FAKE_PROVIDER } : spec;
    const fake: FakeModel = createFakeModelFromConfig(fakeSpec, []);
    return { model: fake, llmOptions: {}, teardown: () => fake.teardown() };
  }
  const baseUrl = resolveRealBaseUrl(spec, config.providers);
  if (baseUrl === null) {
    throw new RealProviderNotWiredError(spec.provider);
  }
  // 内联 apiKey 优先；缺席才回退 credentials 的 env 解析值。空值视同缺失（schema 已拒，
  // 这里兜注入式配置对象）：两处皆无 → 响亮拒绝且只报 provider 与位置，不报值。
  const inlineApiKey = config.providers[spec.provider]?.apiKey;
  const apiKey = inlineApiKey ?? credentials[spec.provider]?.value;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ServeCredentialMissingError(spec.provider);
  }
  // apiKey 只在构造 llmOptions 时触碰一次；不进 model 对象、不进任何错误消息。
  const isDeepSeek = /deepseek/i.test(`${spec.id} ${spec.provider} ${baseUrl}`);
  // T6：显式 reasoningContentReplay 是生产兜底开关——即使未配 reasoningEffort，
  // 也强制 reasoning-capable 并启用 DeepSeek thinking 回传口径，避免 thinking 模式
  // 下上游 400（reasoning_content 必须回传）。
  const replayReasoningContent = spec.reasoningContentReplay === true;
  const reasoningEnabled = spec.reasoningEffort !== undefined || replayReasoningContent;
  const deepSeekCompat = isDeepSeek || replayReasoningContent;
  const model = makeOpenAICompatibleModel({
    id: spec.id,
    baseUrl,
    provider: spec.provider,
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxOutput,
    input: spec.vision ? ["text", "image"] : ["text"],
    // pi-ai 仅在 model.reasoning=true 时转发 reasoning_effort；而 reasoning=true 会把
    // system 消息角色切到 developer（DeepSeek 不接受），故显式关掉。
    // DeepSeek 还要求 thinking 模式回传真实 reasoning_content，并识别 deepseek 的
    // thinking 参数格式；否则上游 400（W1-T1）。T6 的显式开关同样进入这一口径。
    ...(reasoningEnabled
      ? {
          reasoning: true,
          compat: {
            supportsDeveloperRole: false,
            ...(deepSeekCompat
              ? {
                  thinkingFormat: "deepseek" as const,
                  requiresReasoningContentOnAssistantMessages: true,
                }
              : {}),
          },
        }
      : {}),
  });
  const llmOptions: LlmOptions = {
    apiKey,
    timeoutMs: spec.timeout,
    ...(spec.reasoningEffort === undefined
      ? {}
      : { providerExtras: { reasoningEffort: spec.reasoningEffort } }),
  };
  return { model, llmOptions, teardown: () => {} };
}

/**
 * 装配 serve 用模型集：models[] 逐条解析成句柄（见模块头逐条口径），main 按旧单模型
 * 规则选取，byId 按 config id 键控；teardownAll 对每个句柄恰调一次（二次调用 no-op）。
 */
export function resolveServeModels(
  config: LoomConfig,
  env: NodeJS.ProcessEnv,
  credentials: Credentials = config.credentials,
): ServeModelSet {
  const first = config.models[0];
  if (first === undefined) {
    throw new RealProviderNotWiredError("<empty models>");
  }
  // main 选择与旧 resolveServeModel 逐字节等价：env 强制 → models[0]；否则首个
  // provider: fake → 该条；否则 models[0]（pickFakeModelConfig 已封装前两档）。
  const mainId = (pickFakeModelConfig(config, env) ?? first).id;
  const handles: ServeModelHandle[] = [];
  const byId = new Map<string, ServeModelHandle>();
  let main: ServeModelHandle | undefined;
  for (const spec of config.models) {
    const handle = resolveServeModelEntry(spec, config, env, credentials);
    handles.push(handle);
    byId.set(spec.id, handle);
    if (spec.id === mainId) {
      main = handle;
    }
  }
  if (main === undefined) {
    // 防御：schema 保证 models 非空且 id 唯一，正常不可达；响亮拒绝而非断言。
    throw new RealProviderNotWiredError("<empty models>");
  }
  let tornDown = false;
  return {
    main,
    byId,
    teardownAll(): void {
      if (tornDown) return;
      tornDown = true;
      for (const handle of handles) {
        handle.teardown();
      }
    },
  };
}

/** 兼容 wrapper：旧单模型调用面返回 main 句柄（语义见 resolveServeModels）。 */
export function resolveServeModel(
  config: LoomConfig,
  env: NodeJS.ProcessEnv,
  credentials: Credentials = config.credentials,
): ServeModelHandle {
  return resolveServeModels(config, env, credentials).main;
}
