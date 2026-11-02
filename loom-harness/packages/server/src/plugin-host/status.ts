/**
 * PluginHost 状态视图。
 *
 * 生成 PluginRuntimeStatus 时对 optional 字段做条件展开，满足
 * exactOptionalPropertyTypes；同时提供 `/plugins/status` 可直接序列化的响应壳。
 */

import {
  LOOM_PLUGIN_API_VERSION,
  type PluginRuntimeStatus,
  type PluginSource,
  type PluginState,
  type PluginTrust,
} from "@axeuh/loom-plugin-sdk";

export interface PluginStatusFields {
  readonly id: string;
  readonly version: string;
  readonly source: PluginSource;
  readonly trust: PluginTrust;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly error?: string;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
}

export interface PluginStatusReport {
  readonly apiVersion: number;
  readonly plugins: PluginRuntimeStatus[];
}

/** 构造对外状态；可选字段只在有值时出现。 */
export function toPluginRuntimeStatus(fields: PluginStatusFields): PluginRuntimeStatus {
  return {
    id: fields.id,
    version: fields.version,
    source: fields.source,
    trust: fields.trust,
    enabled: fields.enabled,
    state: fields.state,
    ...(fields.error === undefined ? {} : { error: fields.error }),
    ...(fields.startedAt === undefined ? {} : { startedAt: fields.startedAt }),
    ...(fields.stoppedAt === undefined ? {} : { stoppedAt: fields.stoppedAt }),
  };
}

/** `GET /plugins/status` 的响应壳；不返回插件内部配置或数据。 */
export function toPluginStatusReport(
  plugins: readonly PluginRuntimeStatus[],
): PluginStatusReport {
  return {
    apiVersion: LOOM_PLUGIN_API_VERSION,
    plugins: [...plugins],
  };
}
