/**
 * resolveServeModel 真/假通道判别测试（T39 前置接线波）。
 * Given: parseLoomConfig 边界产物（brand 类型不手写）+ env 表
 * When:  resolveServeModel / resolveRealBaseUrl
 * Then:  通道选择、端点优先级、apiKey 透传、错误形状（**密钥值绝不出现在 message**）。
 */

import { describe, expect, it } from "vitest";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import {
  RealProviderNotWiredError,
  ServeCredentialMissingError,
  pickFakeModelConfig,
  resolveRealBaseUrl,
  resolveServeModel,
  wantsFakeModel,
} from "./model-source.js";

const SECRET = "sk-CANARY-secretvalue-9f3a";

function cfgWith(yamlModels: string, providersBlock = ""): LoomConfig {
  const yaml = [
    "server:",
    "  port: 5100",
    "  hostname: 127.0.0.1",
    "workspace: /srv/loom/ws",
    providersBlock,
    "models:",
    yamlModels,
    "pricing:",
    "  eflowcode:",
    "    input: 0",
    "    output: 0",
    "  fake:",
    "    input: 0",
    "    output: 0",
    "credentials:",
    "  eflowcode: ${LOOM_KEY_EFLOWCODE}",
  ].join("\n");
  return parseLoomConfig(yaml, "<test>", { env: { LOOM_KEY_EFLOWCODE: SECRET } });
}

const REAL_MODEL = [
  "  - id: qwen3.8-flash",
  "    provider: eflowcode",
  "    contextWindow: 262144",
  "    maxOutput: 32768",
  "    vision: true",
  "    timeout: 120000",
].join("\n");

describe("resolveServeModel: fake 通道（CI 口径不破坏）", () => {
  it("provider: fake → FakeModel，llmOptions 零凭据", () => {
    const cfg = cfgWith(
      ["  - id: fake-x", "    provider: fake", "    contextWindow: 1000", "    maxOutput: 10", "    timeout: 1000"].join("\n"),
    );
    const handle = resolveServeModel(cfg, {});
    expect(handle.model.provider).toBe("fake");
    expect(handle.llmOptions).toEqual({});
    handle.teardown();
  });

  it("LOOM_FAKE_MODEL=1 覆盖真 provider 声明 → fake 数据面（原样保留窗口）", () => {
    const cfg = cfgWith(REAL_MODEL, "providers:\n  - provider: eflowcode\n    baseUrl: https://e-flowcode.cc/v1\n");
    expect(wantsFakeModel(cfg, { LOOM_FAKE_MODEL: "1" })).toBe(true);
    const picked = pickFakeModelConfig(cfg, { LOOM_FAKE_MODEL: "1" });
    expect(picked?.provider).toBe("fake");
    expect(picked?.contextWindow).toBe(262144);
    const handle = resolveServeModel(cfg, { LOOM_FAKE_MODEL: "1" });
    expect(handle.model.provider).toBe("fake");
    handle.teardown();
  });
});

describe("resolveServeModel: 真 provider 接线", () => {
  const PROVIDERS = "providers:\n  - provider: eflowcode\n    baseUrl: https://e-flowcode.cc/v1\n";
  const INLINE_KEY = "sk-inline-provider-canary-8b2c";

  it("内联 providers[].apiKey 优先于 credentials env 解析值", () => {
    const cfg = cfgWith(
      REAL_MODEL,
      "providers:\n  - provider: eflowcode\n    baseUrl: https://e-flowcode.cc/v1\n" +
        `    apiKey: ${INLINE_KEY}\n`,
    );
    const handle = resolveServeModel(cfg, {});
    expect(cfg.credentials["eflowcode"]?.value).toBe(SECRET);
    expect(handle.llmOptions.apiKey).toBe(INLINE_KEY);
    expect(handle.llmOptions.apiKey).not.toBe(SECRET);
    expect(JSON.stringify(handle.model)).not.toContain(INLINE_KEY);
  });

  it("provider 级 baseUrl + credentials env fallback → openai-completions 真模型 + llmOptions.apiKey/timeoutMs", () => {
    const cfg = cfgWith(REAL_MODEL, PROVIDERS);
    const handle = resolveServeModel(cfg, {});
    expect(handle.model.provider).toBe("eflowcode");
    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.baseUrl).toBe("https://e-flowcode.cc/v1");
    expect(handle.model.contextWindow).toBe(262144);
    expect(handle.model.maxTokens).toBe(32768);
    expect(handle.model.input).toEqual(["text", "image"]);
    expect(handle.llmOptions.apiKey).toBe(SECRET);
    expect(handle.llmOptions.timeoutMs).toBe(120000);
  });

  it("model 级 baseUrl 覆盖 provider 级（优先级钉死）", () => {
    const cfg = cfgWith(`${REAL_MODEL}\n    baseUrl: https://model-specific.example/v1`, PROVIDERS);
    expect(resolveRealBaseUrl(cfg.models[0]!, cfg.providers)).toBe("https://model-specific.example/v1");
    const handle = resolveServeModel(cfg, {});
    expect(handle.model.baseUrl).toBe("https://model-specific.example/v1");
  });

  it("reasoningEffort 缺席 → reasoning=false 且无 providerExtras（旧载荷不变）", () => {
    const cfg = cfgWith(REAL_MODEL, PROVIDERS);
    const handle = resolveServeModel(cfg, {});
    expect(handle.model.reasoning).toBe(false);
    expect(handle.llmOptions.providerExtras).toBeUndefined();
  });

  it("reasoningEffort: max → reasoning-capable + 关 developer 角色 + providerExtras 透传", () => {
    const cfg = cfgWith(`${REAL_MODEL}\n    reasoningEffort: max`, PROVIDERS);
    const handle = resolveServeModel(cfg, {});
    expect(handle.model.reasoning).toBe(true);
    expect(handle.model.compat).toMatchObject({ supportsDeveloperRole: false });
    expect(handle.llmOptions.providerExtras).toEqual({ reasoningEffort: "max" });
  });

  it("deepseek 模型 reasoningEffort: max → deepseek thinking compat + reasoning_content 回传要求", () => {
    const deepseekModel = [
      "  - id: deepseek-flash",
      "    provider: eflowcode",
      "    contextWindow: 262144",
      "    maxOutput: 32768",
      "    vision: true",
      "    timeout: 120000",
    ].join("\n");
    const cfg = cfgWith(`${deepseekModel}\n    reasoningEffort: max`, PROVIDERS);
    const handle = resolveServeModel(cfg, {});
    expect(handle.model.reasoning).toBe(true);
    expect(handle.model.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(handle.llmOptions.providerExtras).toEqual({ reasoningEffort: "max" });
  });

  it("reasoningContentReplay: true 且 reasoningEffort 缺席 → 强制 reasoning + deepseek 回传 compat", () => {
    const cfg = cfgWith(`${REAL_MODEL}\n    reasoningContentReplay: true`, PROVIDERS);
    const handle = resolveServeModel(cfg, {});
    expect(handle.model.reasoning).toBe(true);
    expect(handle.model.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(handle.llmOptions.providerExtras).toBeUndefined();
  });

  it("reasoningContentReplay 缺席或 false → 无 reasoningEffort 时维持旧行为", () => {
    const absent = resolveServeModel(cfgWith(REAL_MODEL, PROVIDERS), {});
    expect(absent.model.reasoning).toBe(false);
    expect(absent.model.compat).toBeUndefined();

    const disabled = resolveServeModel(
      cfgWith(`${REAL_MODEL}\n    reasoningContentReplay: false`, PROVIDERS),
      {},
    );
    expect(disabled.model.reasoning).toBe(false);
    expect(disabled.model.compat).toBeUndefined();
  });

  it("无任何 baseUrl → RealProviderNotWiredError（消息不含密钥）", () => {
    const cfg = cfgWith(REAL_MODEL);
    let message = "";
    try {
      resolveServeModel(cfg, {});
    } catch (err) {
      expect(err).toBeInstanceOf(RealProviderNotWiredError);
      message = (err as Error).message;
    }
    expect(message).toContain("eflowcode");
    expect(message).not.toContain(SECRET);
  });

  it("内联 apiKey 与 credentials 均缺 → 错误点名 provider 与两处可接受位置，不回显密钥", () => {
    const cfg = cfgWith(
      REAL_MODEL,
      "providers:\n  - provider: eflowcode\n    baseUrl: https://e-flowcode.cc/v1\n" +
        "  - provider: other\n    baseUrl: https://other.example/v1\n" +
        `    apiKey: ${INLINE_KEY}\n`,
    );
    const stripped: LoomConfig = { ...cfg, credentials: {} };
    let message = "";
    try {
      resolveServeModel(stripped, {});
    } catch (err) {
      expect(err).toBeInstanceOf(ServeCredentialMissingError);
      message = (err as Error).message;
    }
    expect(message).toContain('"eflowcode"');
    expect(message).toContain("providers[].apiKey");
    expect(message).toContain("credentials");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(INLINE_KEY);
  });
});
