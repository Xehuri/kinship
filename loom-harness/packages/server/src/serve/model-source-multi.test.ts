/**
 * resolveServeModels 多模型句柄集测试（W53 T1：per-model handle 集合 + 兼容 wrapper）。
 * Given: parseLoomConfig 边界产物（brand 类型不手写）+ env 表
 * When:  resolveServeModels / resolveServeModel
 * Then:  逐条解析（fake/real 各用自己 provider 的端点与凭据）、main 选择=旧单模型语义
 *        （env 强制→models[0]、否则首个 fake→该条、否则 models[0]）、byId 按 id 键控、
 *        teardownAll 每句柄恰一次且二次调用 no-op。
 */

import { describe, expect, it, vi } from "vitest";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import {
  RealProviderNotWiredError,
  ServeCredentialMissingError,
  resolveServeModel,
  resolveServeModels,
} from "./model-source.js";

// 每个 provider 独立密钥值：用例 c 要能分辨"取的是自己 provider 的凭据"。
const KEY_ALPHA = "key-alpha-provider";
const KEY_BETA = "key-beta-provider";
const KEY_GAMMA = "key-gamma-provider";

/** 与 model-source.test.ts 同款：走 parseLoomConfig 边界产物，不手写 brand 类型。 */
function cfgWith(
  yamlModels: string,
  providersBlock = "",
  credentialsBlock: string | null = "  alpha: ${LOOM_KEY_ALPHA}",
  env: Readonly<Record<string, string>> = { LOOM_KEY_ALPHA: KEY_ALPHA },
): LoomConfig {
  const yaml = [
    "server:",
    "  port: 5100",
    "  hostname: 127.0.0.1",
    "workspace: /srv/loom/ws",
    providersBlock,
    "models:",
    yamlModels,
    "pricing:",
    "  alpha:",
    "    input: 0",
    "    output: 0",
    "  beta:",
    "    input: 0",
    "    output: 0",
    "  fake:",
    "    input: 0",
    "    output: 0",
    ...(credentialsBlock === null ? [] : ["credentials:", credentialsBlock]),
  ].join("\n");
  return parseLoomConfig(yaml, "<test>", { env });
}

/** 单条 models[] 条目（缩进 2 空格起；extra 行用 4 空格缩进，如 baseUrl）。 */
function modelYaml(id: string, provider: string, ...extra: readonly string[]): string {
  return [
    `  - id: ${id}`,
    `    provider: ${provider}`,
    "    contextWindow: 262144",
    "    maxOutput: 32768",
    "    timeout: 120000",
    ...extra,
  ].join("\n");
}

/** providers[] 段（provider 级端点表；第三项为可选内联 apiKey）。 */
function providersYaml(...entries: readonly (readonly [string, string, string?])[]): string {
  return [
    "providers:",
    ...entries.map(([provider, baseUrl, apiKey]) =>
      [
        `  - provider: ${provider}`,
        `    baseUrl: ${baseUrl}`,
        ...(apiKey === undefined ? [] : [`    apiKey: ${apiKey}`]),
      ].join("\n"),
    ),
  ].join("\n");
}

/** credentials 段条目（逻辑名 → ${ENV_VAR} 引用；段头由 cfgWith 统一拼）。 */
function credentialsYaml(...entries: readonly (readonly [string, string])[]): string {
  return entries.map(([provider, envName]) => `  ${provider}: \${${envName}}`).join("\n");
}

const PROVIDERS = providersYaml(
  ["alpha", "https://alpha.example/v1"],
  ["beta", "https://beta.example/v1"],
);

describe("resolveServeModels: 单条 real", () => {
  it("main=deepseek-v4.1-flash，apiKey/baseUrl 来自 credentials/provider 行，byId 仅 1 条", () => {
    const cfg = cfgWith(
      modelYaml("deepseek-v4.1-flash", "alpha"),
      providersYaml(["alpha", "https://alpha.example/v1"]),
    );
    const set = resolveServeModels(cfg, {});
    expect(set.main.model.id).toBe("deepseek-v4.1-flash");
    expect(set.main.model.baseUrl).toBe("https://alpha.example/v1");
    expect(set.main.llmOptions.apiKey).toBe(KEY_ALPHA);
    expect(set.byId.size).toBe(1);
    expect(set.byId.get("deepseek-v4.1-flash")).toBe(set.main);
    set.teardownAll();
  });
});

describe("resolveServeModels: 混合 real+fake（无 env 强制）", () => {
  it("main=首个 fake 条目（旧单模型规则），real 条目仍按自己的 provider 真接线", () => {
    const cfg = cfgWith(
      [modelYaml("real-one", "alpha"), modelYaml("fake-two", "fake")].join("\n"),
      providersYaml(["alpha", "https://alpha.example/v1"]),
    );
    const set = resolveServeModels(cfg, {});
    expect(set.main.model.id).toBe("fake-two");
    expect(set.main.model.provider).toBe("fake");
    const real = set.byId.get("real-one");
    expect(real?.model.baseUrl).toBe("https://alpha.example/v1");
    expect(real?.model.provider).toBe("alpha");
    expect(real?.llmOptions.apiKey).toBe(KEY_ALPHA);
    expect(set.byId.get("fake-two")).toBe(set.main);
    set.teardownAll();
  });
});

describe("resolveServeModels: 同一 provider 多模型共享内联 apiKey", () => {
  it("两条同 provider 模型均取该 provider 条目的 apiKey（无 credentials 段）", () => {
    const inline = "sk-inline-shared-provider-2a9c";
    const cfg = cfgWith(
      [modelYaml("alpha-one", "alpha"), modelYaml("alpha-two", "alpha")].join("\n"),
      providersYaml(["alpha", "https://alpha.example/v1", inline]),
      null,
    );
    expect(cfg.credentials).toEqual({});
    const set = resolveServeModels(cfg, {});
    expect(set.byId.get("alpha-one")?.llmOptions.apiKey).toBe(inline);
    expect(set.byId.get("alpha-two")?.llmOptions.apiKey).toBe(inline);
    expect(set.byId.get("alpha-one")?.model.baseUrl).toBe("https://alpha.example/v1");
    expect(set.byId.get("alpha-two")?.model.baseUrl).toBe("https://alpha.example/v1");
    set.teardownAll();
  });
});

describe("resolveServeModels: 两个 real provider", () => {
  it("每个句柄的 baseUrl/apiKey 取自己 provider 行，互不串用", () => {
    const cfg = cfgWith(
      [modelYaml("alpha-model", "alpha"), modelYaml("beta-model", "beta")].join("\n"),
      PROVIDERS,
      credentialsYaml(["alpha", "LOOM_KEY_ALPHA"], ["beta", "LOOM_KEY_BETA"]),
      { LOOM_KEY_ALPHA: KEY_ALPHA, LOOM_KEY_BETA: KEY_BETA },
    );
    const set = resolveServeModels(cfg, {});
    const alpha = set.byId.get("alpha-model");
    const beta = set.byId.get("beta-model");
    expect(alpha?.model.baseUrl).toBe("https://alpha.example/v1");
    expect(alpha?.llmOptions.apiKey).toBe(KEY_ALPHA);
    expect(beta?.model.baseUrl).toBe("https://beta.example/v1");
    expect(beta?.llmOptions.apiKey).toBe(KEY_BETA);
    expect(set.main.model.id).toBe("alpha-model");
    expect(set.byId.size).toBe(2);
    set.teardownAll();
  });
});

describe("resolveServeModels: LOOM_FAKE_MODEL=1", () => {
  it("两条 real 条目全解析为 fake（id 保留），main=models[0].id", () => {
    const cfg = cfgWith(
      [modelYaml("alpha-model", "alpha"), modelYaml("beta-model", "beta")].join("\n"),
      PROVIDERS,
      credentialsYaml(["alpha", "LOOM_KEY_ALPHA"], ["beta", "LOOM_KEY_BETA"]),
      { LOOM_KEY_ALPHA: KEY_ALPHA, LOOM_KEY_BETA: KEY_BETA },
    );
    const set = resolveServeModels(cfg, { LOOM_FAKE_MODEL: "1" });
    expect(set.main.model.id).toBe("alpha-model");
    const alpha = set.byId.get("alpha-model");
    const beta = set.byId.get("beta-model");
    expect(alpha?.model.provider).toBe("fake");
    expect(alpha?.model.id).toBe("alpha-model");
    expect(alpha?.llmOptions).toEqual({});
    expect(beta?.model.provider).toBe("fake");
    expect(beta?.model.id).toBe("beta-model");
    expect(beta?.llmOptions).toEqual({});
    expect(set.byId.size).toBe(2);
    set.teardownAll();
  });
});

describe("resolveServeModels: 非 main real 条目的解析失败同样响亮", () => {
  it("credentials 缺非 main provider → ServeCredentialMissingError（解析期即抛）", () => {
    const cfg = cfgWith(
      [modelYaml("alpha-model", "alpha"), modelYaml("beta-model", "beta")].join("\n"),
      PROVIDERS,
      credentialsYaml(["alpha", "LOOM_KEY_ALPHA"]),
      { LOOM_KEY_ALPHA: KEY_ALPHA },
    );
    expect(() => resolveServeModels(cfg, {})).toThrow(ServeCredentialMissingError);
  });

  it("非 main provider 无任何 baseUrl → RealProviderNotWiredError", () => {
    const cfg = cfgWith(
      [modelYaml("alpha-model", "alpha"), modelYaml("gamma-model", "gamma")].join("\n"),
      providersYaml(["alpha", "https://alpha.example/v1"]),
      credentialsYaml(["alpha", "LOOM_KEY_ALPHA"], ["gamma", "LOOM_KEY_GAMMA"]),
      { LOOM_KEY_ALPHA: KEY_ALPHA, LOOM_KEY_GAMMA: KEY_GAMMA },
    );
    expect(() => resolveServeModels(cfg, {})).toThrow(RealProviderNotWiredError);
  });
});

describe("resolveServeModels: teardownAll", () => {
  it("所有 fake 句柄各 teardown 恰一次；第二次调用 no-op", () => {
    const cfg = cfgWith(
      [modelYaml("fake-a", "fake"), modelYaml("fake-b", "fake")].join("\n"),
    );
    const set = resolveServeModels(cfg, {});
    const handles = [...set.byId.values()];
    const spies = handles.map((handle) => vi.spyOn(handle, "teardown"));
    set.teardownAll();
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([1, 1]);
    set.teardownAll();
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([1, 1]);
  });
});

describe("resolveServeModel: 向后兼容 wrapper", () => {
  it("返回 resolveServeModels(config).main 的同一语义（混合配置 main=首个 fake）", () => {
    const cfg = cfgWith(
      [modelYaml("real-one", "alpha"), modelYaml("fake-two", "fake")].join("\n"),
      providersYaml(["alpha", "https://alpha.example/v1"]),
    );
    const set = resolveServeModels(cfg, {});
    const legacy = resolveServeModel(cfg, {});
    expect(legacy.model.id).toBe(set.main.model.id);
    expect(legacy.model.provider).toBe(set.main.model.provider);
    legacy.teardown();
    set.teardownAll();
  });
});
