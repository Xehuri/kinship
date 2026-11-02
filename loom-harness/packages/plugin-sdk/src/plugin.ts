/**
 * Feature Plugin 契约 —— 插件对象、贡献面与定义辅助函数。
 */

import type { HarnessTool, Hook } from "@axeuh/loom-core";
import type {
  PluginContext,
  PluginSessionContext,
  PluginSessionLifecycle,
} from "./context.js";
import type { LoomPluginManifest } from "./manifest.js";
import type { PluginRuntimeStatus } from "./status.js";

export type PluginRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 路由鉴权级别；缺省视为 `required`。 */
export type PluginRouteAuth = "required" | "admin" | "none";

export type PluginRouteHandler = (
  request: unknown,
  response: unknown,
) => void | Promise<void>;

export interface PluginRoute {
  method: PluginRouteMethod;
  /** 必须位于 `/plugins/<id>/` 下，由 Host 校验。 */
  path: string;
  /** 缺省为 `required`。 */
  auth?: PluginRouteAuth;
  handler: PluginRouteHandler;
}

/** setup() 返回的贡献面；Host 负责合并进现有工具 / Hook / 路由集合。 */
export interface PluginContribution {
  tools?: HarnessTool[];
  hooks?: Hook[] | ((session: PluginSessionContext) => Hook[]);
  routes?: PluginRoute[];
  sessionLifecycle?: PluginSessionLifecycle;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  status?(): PluginRuntimeStatus;
}

export interface LoomFeaturePlugin {
  manifest: LoomPluginManifest;
  setup(ctx: PluginContext): PluginContribution | Promise<PluginContribution>;
}

/** 身份辅助：让插件定义获得编辑器补全，同时不引入额外运行时行为。 */
export function definePlugin(plugin: LoomFeaturePlugin): LoomFeaturePlugin {
  return plugin;
}
