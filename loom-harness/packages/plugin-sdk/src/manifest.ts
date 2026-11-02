/**
 * Feature Plugin Manifest —— 插件身份、兼容性与能力声明。
 *
 * Manifest 是插件与 Host 之间的唯一静态契约：Host 在 register/start 阶段据此
 * 校验 API 版本、id、权限与依赖顺序，不读取插件内部实现。
 */

import type { PluginPermission } from "./permissions.js";

/** 当前 SDK 支持的插件 API 版本；manifest.apiVersion 必须与之相等。 */
export const LOOM_PLUGIN_API_VERSION = 1;

/** 插件来源：内置于 Loom 的插件，或通过外部 loader 装入的插件。 */
export type PluginSource = "builtin" | "external";

/** 信任级别：builtin 与宿主同源，trusted 走进程内加载，sandboxed 走隔离 runtime。 */
export type PluginTrust = "builtin" | "trusted" | "sandboxed";

export interface LoomPluginManifest {
  /** 全局唯一 id，格式 `[a-z0-9][a-z0-9._-]*`。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 插件自身语义化版本。 */
  version: string;
  /** 插件契约版本，必须等于 `LOOM_PLUGIN_API_VERSION`。 */
  apiVersion: number;
  /** 外部插件必填的入口模块；builtin 可省略。 */
  entry?: string;
  /** 要求的最低 Loom 版本。 */
  minLoomVersion?: string;
  description?: string;
  author?: string;
  license?: string;
  /** 插件声明需要的能力；P0 只校验声明，不做运行时隔离。 */
  permissions: PluginPermission[];
  /** 配置 schema：JSON Schema 字符串或已解析对象。 */
  configSchema?: string | Record<string, unknown>;
  /** 由 Host 填充 / 校验。 */
  source?: PluginSource;
  /** 由 Host 填充 / 校验。 */
  trust?: PluginTrust;
  /** 依赖的插件 id，只表达启动顺序与存在性，不传递能力。 */
  requires?: string[];
  /** 为 true 时启动失败会导致 Host（进而 boot）失败。 */
  critical?: boolean;
}
