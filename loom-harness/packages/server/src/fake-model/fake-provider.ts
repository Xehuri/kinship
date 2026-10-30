// T32：fake 模型 provider 接线——把 `@axeuh/loom-core/testing` 的 createFakeModel
// （pi-ai api-registry 层的脚本化 provider）接到 loom 的 LLM seam：
// loom.yaml `models[].provider: fake` 的条目可被解析成可直接注入
// `new AgentSession({ model })` 的 FakeModel，离线跑完整 turn（含工具调用），
// 无网络、无 API key。config/ 模块只读复用其类型（ModelConfig），不做任何修改。
//
// 消费者（T33-T38 golden-path 系列）：
//   const cfg = parseLoomConfig(yamlText, "test", { env: {} });
//   const model = createFakeModelFromConfig(cfg.models[0], script);
//   const session = new AgentSession({ model, tools: [echoTool] });
//   const summary = await session.run("go");   // 脚本按序回放，跑完即终态
//   model.teardown();                           // 注销 api provider

import {
  createFakeModel,
  type FakeAssistantResponse,
  type FakeModel,
} from "@axeuh/loom-core/testing";

import type { ModelConfig } from "../config/section-checks.js";

/** loom.yaml models[].provider 声明假模型的保留字（唯一 fake 判别来源，勿手写字符串）。 */
export const FAKE_PROVIDER = "fake" as const;

/** 该模型条目是否走 fake provider（离线脚本化）。real provider 判别留给 T31 接线层。 */
export function isFakeModelConfig(model: ModelConfig): boolean {
  return model.provider === FAKE_PROVIDER;
}

/**
 * 按 provider 把 models[] 分成 fake / real 两组（保持声明顺序）。
 * serve 组装层（T31）据此决定哪些条目不需要凭据即可离线注入。
 */
export function partitionModelConfigs(
  models: readonly ModelConfig[],
): { readonly fake: readonly ModelConfig[]; readonly real: readonly ModelConfig[] } {
  const fake: ModelConfig[] = [];
  const real: ModelConfig[] = [];
  for (const m of models) {
    (isFakeModelConfig(m) ? fake : real).push(m);
  }
  return { fake, real };
}

/**
 * 把一个 `provider: fake` 的 ModelConfig + 响应脚本变成可注入 AgentSession 的 FakeModel。
 *
 * 复用 core 的 createFakeModel：每个实例绑定独立 api id / 独立队列，互不污染（并行测试安全）。
 * config 字段就地覆写 fake Model 的数据面（id / name / contextWindow / maxTokens / input），
 * 让上层按 loom.yaml 声明消费（成本归类、assembly 窗口计算等）时无需区分真假；
 * provider 保持 `fake`，与 loom.yaml 声明一致。push/getCalls/reset/teardown 原样可用。
 *
 * @param model loom.yaml models[] 条目（provider 必须是 "fake"，否则 fail-loud）
 * @param script 按序回放的 assistant 响应（toolCall 会被 kernel 真执行工具后回灌 toolResult）
 * @throws 非 fake provider 条目传入时抛错——调用方应先 isFakeModelConfig 判别
 */
export function createFakeModelFromConfig(
  model: ModelConfig,
  script: readonly FakeAssistantResponse[] = [],
): FakeModel {
  if (!isFakeModelConfig(model)) {
    throw new Error(
      `createFakeModelFromConfig: "${model.id}" 的 provider 是 "${model.provider}"，不是 "${FAKE_PROVIDER}"`,
    );
  }
  const fake = createFakeModel([...script]);
  // 数据面对齐 loom.yaml 声明（api 是 fake 注册的路由字段，不动；provider 归一为 "fake"）。
  fake.id = model.id;
  fake.name = `fake:${model.id}`;
  fake.provider = FAKE_PROVIDER;
  fake.contextWindow = model.contextWindow;
  fake.maxTokens = model.maxOutput;
  fake.input = model.vision ? ["text", "image"] : ["text"];
  return fake;
}
