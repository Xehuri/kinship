/**
 * Feature Plugin 能力声明。
 *
 * P0 只校验 manifest 里声明的权限，不做运行时隔离；外部插件的能力限制在 P2
 * 由独立进程 runtime / capability RPC 落实。
 */

export type PluginPermission =
  | "tools:register"
  | "hooks:register"
  | "routes:register"
  | "storage:own"
  | "config:own"
  | "events:own"
  | "fs:read"
  | "fs:write"
  | "net:outbound"
  | "exec"
  | "sessions:read"
  | "wake:schedule";

const PERMISSION_VALUES = [
  "tools:register",
  "hooks:register",
  "routes:register",
  "storage:own",
  "config:own",
  "events:own",
  "fs:read",
  "fs:write",
  "net:outbound",
  "exec",
  "sessions:read",
  "wake:schedule",
] as const satisfies readonly PluginPermission[];

/** 全部合法权限的运行时清单，供 Host 做 manifest 校验。 */
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = PERMISSION_VALUES;
