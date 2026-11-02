/**
 * Feature Plugin 运行状态。
 */

import type { PluginSource, PluginTrust } from "./manifest.js";

export type PluginState =
  | "registered"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "disabled";

export interface PluginRuntimeStatus {
  id: string;
  version: string;
  source: PluginSource;
  trust: PluginTrust;
  enabled: boolean;
  state: PluginState;
  error?: string;
  startedAt?: string;
  stoppedAt?: string;
}
