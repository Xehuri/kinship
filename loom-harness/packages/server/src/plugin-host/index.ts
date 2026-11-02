/**
 * Loom Feature Plugin Host（P0）。
 *
 * 只导出 Host、注册表、校验器、受控上下文与状态辅助；内置插件清单
 * （builtins.ts）由 W2 单独提供，这里刻意不 re-export。
 */

export {
  PluginHost,
  type PluginContributions,
  type PluginHostOptions,
} from "./host.js";

export {
  PluginRegistry,
  resolveStartOrder,
  type PluginRegisterOptions,
  type PluginRegistration,
} from "./registry.js";

export {
  PLUGIN_ID_RE,
  PLUGIN_VERSION_RE,
  PluginHostError,
  contributionFailure,
  describeError,
  isRecord,
  isPluginSource,
  isPluginTrust,
  isRouteWithinPlugin,
  manifestFailure,
  resolvePluginSource,
  resolvePluginTrust,
  validateContribution,
  validateManifest,
  type ContributionValidationInput,
  type ManifestValidation,
  type PluginContributionView,
  type PluginHostErrorCode,
  type ResolvedManifest,
} from "./validate.js";

export {
  createPluginContext,
  type PluginContextOptions,
  type PluginContributionSink,
  type PluginLogFn,
  type PluginLogLevel,
} from "./context.js";

export {
  toPluginRuntimeStatus,
  toPluginStatusReport,
  type PluginStatusFields,
  type PluginStatusReport,
} from "./status.js";
