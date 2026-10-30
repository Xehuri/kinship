// T31 serve 装配 barrel（内部模块，消费者 = cli.ts 与后续测试；不进 server 公共出口，
// 避免把 node:http 装配细节钉进 index.ts 的公开面）。

export {
  LOOM_CONFIG_ENV,
  LOOM_STATE_ENV,
  LOOM_TOKEN_ENV,
  LOOM_TEST_TOKEN_ENV,
  LOOM_INSTANCE_ENV,
  INSTANCE_DIR_NAME,
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_ROOT,
  REPO_ROOT,
  ConfigFileMissingError,
  InstanceConfigMissingError,
  TokenMissingError,
  instanceConfigPath,
  instanceStateRoot,
  loadServeConfig,
  readConfigAudit,
  resolveConfigPath,
  resolveServeTokens,
  resolveStateRootFromEnv,
} from "./config-source.js";

export {
  LOOM_FAKE_MODEL_ENV,
  RealProviderNotWiredError,
  ServeCredentialMissingError,
  pickFakeModelConfig,
  resolveRealBaseUrl,
  resolveServeModel,
  resolveServeModels,
  wantsFakeModel,
  type ServeModelHandle,
  type ServeModelSet,
} from "./model-source.js";

export {
  STUB_COMMANDS,
  USAGE,
  UsageError,
  parseArgs,
  type ParsedCommand,
  type StubCommand,
} from "./commands.js";

export {
  SHUTDOWN_TIMEOUT_MS,
  createLoomApp,
  serveLoom,
  type LoomApp,
  type LoomAppOptions,
  type ServeHandle,
  type ServeLog,
  type ServeOptions,
} from "./boot.js";

export {
  createSideBindingResolver,
  type SideBindingResolver,
  type SideBindingResolverOptions,
} from "./side-binding.js";

export {
  createServeSkillsWiring,
  type ServeSkillsWiring,
  type ServeSkillsWiringOptions,
} from "./skills-wiring.js";

export {
  createServeMcpWiring,
  mcpMappedToolName,
  mcpResultToToolResult,
  type McpServerWiringStatus,
  type ServeMcpWiring,
  type ServeMcpWiringOptions,
} from "./mcp-wiring.js";

export {
  assemblySpan,
  createAssemblyTraceWriter,
  type AssemblyTraceWriter,
} from "./assembly-trace.js";

export {
  makeServeSandboxProfile,
  createServeToolWiring,
  SeamDeniedError,
  UnknownAgentModelError,
  type ServeToolWiring,
  type ServeToolWiringOptions,
} from "./tool-wiring.js";

export {
  createServeToolTrace,
  type ServeToolTrace,
} from "./tool-trace.js";

export {
  createTaskFetchTool,
  type TaskFetchToolOptions,
} from "./task-fetch.js";

export {
  createServeRunTrace,
  type ServeRunTrace,
} from "./run-trace.js";

export {
  createDeadLetterSink,
} from "./dead-letter-sink.js";
