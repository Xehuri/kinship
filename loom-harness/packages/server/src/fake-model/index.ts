// T32：fake 模型 provider 接线（barrel）。
// 消费者一律从这里拿：`import { createFakeModelFromConfig, installNoNetworkGuard } from "./fake-model/index.js"`。

export {
  FAKE_PROVIDER,
  createFakeModelFromConfig,
  isFakeModelConfig,
  partitionModelConfigs,
} from "./fake-provider.js";
export { installNoNetworkGuard, type NoNetworkGuard } from "./no-network.js";
