/**
 * Feature Plugin 边界校验。
 *
 * Host 在 start() 阶段用这里的函数把插件的 manifest 与 setup 贡献解析成受信任的
 * 内部形态；正常路径返回错误清单，只有 Host 决定失败策略（critical / 非 critical）
 * 后才抛 PluginHostError。依赖解析、重复 id 这类 Host 级不变量则直接抛错。
 */

import {
  LOOM_PLUGIN_API_VERSION,
  PLUGIN_PERMISSIONS,
  type LoomPluginManifest,
  type PluginPermission,
  type PluginRoute,
  type PluginSource,
  type PluginTrust,
} from "@axeuh/loom-plugin-sdk";

/** 插件 id：小写字母/数字开头，后续可含 `.`、`_`、`-`。 */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 宽松 semver：`1.2.3` 或 `1.2.3-pre+build`。 */
export const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PLUGIN_PERMISSIONS);
const ROUTE_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ROUTE_AUTH_VALUES: ReadonlySet<string> = new Set(["required", "admin", "none"]);
const CONTROL_OR_BACKSLASH_RE = /[\u0000-\u001f\u007f\\]/;

export type PluginHostErrorCode =
  | "duplicate-id"
  | "invalid-manifest"
  | "missing-dependency"
  | "dependency-cycle"
  | "invalid-contribution"
  | "setup-failed"
  | "start-failed"
  | "context-closed"
  | "invalid-storage";

/** Host 的统一错误类型；message 里始终带插件 id（若可用），便于日志定位。 */
export class PluginHostError extends Error {
  readonly code: PluginHostErrorCode;
  readonly pluginId: string | undefined;

  constructor(code: PluginHostErrorCode, message: string, pluginId?: string) {
    super(pluginId === undefined ? message : `plugin "${pluginId}": ${message}`);
    this.name = "PluginHostError";
    this.code = code;
    this.pluginId = pluginId;
  }
}

/** 把任意捕获值转成稳定、可读的一行文本。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export function isPluginSource(value: unknown): value is PluginSource {
  return value === "builtin" || value === "external";
}

export function isPluginTrust(value: unknown): value is PluginTrust {
  return value === "builtin" || value === "trusted" || value === "sandboxed";
}

/**
 * 解析 manifest.source；非法值在校验阶段已拒绝，这里只做状态展示用的兜底。
 * 缺省按 builtin 处理（P0 的内置插件都不写 source）。
 */
export function resolvePluginSource(manifest: LoomPluginManifest): PluginSource {
  return isPluginSource(manifest.source) ? manifest.source : "builtin";
}

/** 解析 manifest.trust；缺省时 builtin 来源为 builtin，其余为 trusted。 */
export function resolvePluginTrust(
  manifest: LoomPluginManifest,
  source: PluginSource,
): PluginTrust {
  if (isPluginTrust(manifest.trust)) return manifest.trust;
  return source === "builtin" ? "builtin" : "trusted";
}

/** 校验通过后的 manifest：只保留 Host 需要的字段，且补齐默认值。 */
export interface ResolvedManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: number;
  readonly permissions: readonly PluginPermission[];
  readonly requires: readonly string[];
  readonly critical: boolean;
  readonly source: PluginSource;
  readonly trust: PluginTrust;
}

export interface ManifestValidation {
  readonly errors: readonly string[];
  readonly manifest?: ResolvedManifest;
}

function readStringArray(
  raw: Record<string, unknown>,
  field: string,
  errors: string[],
): string[] {
  const value = raw[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      errors.push(`${field}[${index}] must be a string`);
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * 解析并校验 manifest。
 *
 * 错误顺序固定（id -> version -> apiVersion -> permissions -> requires ->
 * critical -> source -> trust），不含随机/时间信息，便于测试断言。
 */
export function validateManifest(raw: unknown): ManifestValidation {
  if (!isRecord(raw)) {
    return { errors: ["manifest must be an object"] };
  }

  const errors: string[] = [];
  const rawId = raw["id"];
  if (typeof rawId !== "string" || !PLUGIN_ID_RE.test(rawId)) {
    errors.push(`id must match ${PLUGIN_ID_RE.source}`);
  }

  const version = raw["version"];
  if (typeof version !== "string" || !PLUGIN_VERSION_RE.test(version)) {
    errors.push(`version must be semver-like (got ${JSON.stringify(version)})`);
  }

  const apiVersion = raw["apiVersion"];
  if (apiVersion !== LOOM_PLUGIN_API_VERSION) {
    errors.push(
      `apiVersion must be ${String(LOOM_PLUGIN_API_VERSION)} (got ${JSON.stringify(apiVersion)})`,
    );
  }

  const permissions: PluginPermission[] = [];
  const rawPermissions = raw["permissions"];
  if (!Array.isArray(rawPermissions)) {
    errors.push("permissions must be an array of known PluginPermission values");
  } else {
    const unknownPermissions: string[] = [];
    for (const item of rawPermissions) {
      if (isPluginPermission(item)) {
        permissions.push(item);
      } else {
        unknownPermissions.push(String(item));
      }
    }
    if (unknownPermissions.length > 0) {
      errors.push(
        `permissions contains unknown values: ${unknownPermissions.join(", ")}`,
      );
    }
  }

  const requires = readStringArray(raw, "requires", errors);
  if (typeof rawId === "string" && requires.includes(rawId)) {
    errors.push("requires must not include the plugin itself");
  }

  const critical = raw["critical"];
  if (critical !== undefined && typeof critical !== "boolean") {
    errors.push("critical must be a boolean");
  }

  const source = raw["source"];
  if (source !== undefined && !isPluginSource(source)) {
    errors.push("source must be \"builtin\" or \"external\"");
  }

  const trust = raw["trust"];
  if (trust !== undefined && !isPluginTrust(trust)) {
    errors.push("trust must be \"builtin\", \"trusted\", or \"sandboxed\"");
  }

  if (errors.length > 0) {
    return { errors };
  }

  const id = typeof rawId === "string" ? rawId : "";
  const resolvedSource = isPluginSource(source) ? source : "builtin";
  return {
    errors: [],
    manifest: {
      id,
      name: typeof raw["name"] === "string" ? raw["name"] : id,
      version: typeof version === "string" ? version : "",
      apiVersion: LOOM_PLUGIN_API_VERSION,
      permissions,
      requires,
      critical: critical === true,
      source: resolvedSource,
      trust: isPluginTrust(trust)
        ? trust
        : resolvedSource === "builtin"
          ? "builtin"
          : "trusted",
    },
  };
}

/** 贡献面校验只需要工具的 name 和路由的 method/path，因此用宽松的视图类型。 */
export interface PluginContributionView {
  readonly tools: readonly unknown[];
  readonly routes: readonly unknown[];
}

export interface ContributionValidationInput {
  readonly pluginId: string;
  readonly contribution: PluginContributionView;
  readonly existing: PluginContributionView;
}

function toolNameOf(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  const name = tool["name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function routeKeyOf(route: unknown): string | undefined {
  if (!isRecord(route)) return undefined;
  const method = route["method"];
  const path = route["path"];
  if (typeof method !== "string" || typeof path !== "string") return undefined;
  return `${method} ${path}`;
}

function isValidAbsolutePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("?") || path.includes("#") || path.includes("//")) return false;
  if (CONTROL_OR_BACKSLASH_RE.test(path)) return false;
  return !path.split("/").some((segment) => segment === "..");
}

/**
 * 校验 setup 产生的贡献：
 *   - 工具名在「已运行插件 + 本插件」范围内唯一；
 *   - 路由 method/path 唯一，且 path 必须位于 `/plugins/<plugin-id>/` 下；
 *   - 不校验 Hook 名冲突（Hook 总线允许重名）。
 *
 * 返回确定性错误清单；空数组表示通过。
 */
export function validateContribution(
  input: ContributionValidationInput,
): readonly string[] {
  const errors: string[] = [];
  const toolNames = new Set<string>();
  for (const tool of input.existing.tools) {
    const name = toolNameOf(tool);
    if (name !== undefined) toolNames.add(name);
  }

  for (const [index, tool] of input.contribution.tools.entries()) {
    const name = toolNameOf(tool);
    if (name === undefined) {
      errors.push(`tools[${index}] must be a HarnessTool with a non-empty name`);
      continue;
    }
    if (toolNames.has(name)) {
      errors.push(`tool name "${name}" is already registered`);
      continue;
    }
    toolNames.add(name);
  }

  const routeKeys = new Set<string>();
  for (const route of input.existing.routes) {
    const key = routeKeyOf(route);
    if (key !== undefined) routeKeys.add(key);
  }

  const routePrefix = `/plugins/${input.pluginId}/`;
  for (const [index, route] of input.contribution.routes.entries()) {
    if (!isRecord(route)) {
      errors.push(`routes[${index}] must be a PluginRoute object`);
      continue;
    }

    const method = route["method"];
    if (typeof method !== "string" || !ROUTE_METHODS.has(method)) {
      errors.push(`routes[${index}].method is not supported (got ${JSON.stringify(method)})`);
    }

    const path = route["path"];
    if (typeof path !== "string" || !path.startsWith(routePrefix)) {
      errors.push(
        `route path ${JSON.stringify(path)} must start with ${JSON.stringify(routePrefix)}`,
      );
    } else if (!isValidAbsolutePath(path)) {
      errors.push(`route path ${JSON.stringify(path)} must be a valid absolute path`);
    }

    const auth = route["auth"];
    if (auth !== undefined && (typeof auth !== "string" || !ROUTE_AUTH_VALUES.has(auth))) {
      errors.push(`routes[${index}].auth must be "required", "admin", or "none"`);
    }

    if (typeof route["handler"] !== "function") {
      errors.push(`routes[${index}].handler must be a function`);
    }

    if (typeof method === "string" && typeof path === "string") {
      const key = `${method} ${path}`;
      if (routeKeys.has(key)) {
        errors.push(`route ${key} is already registered`);
      } else {
        routeKeys.add(key);
      }
    }
  }

  return errors;
}

/** 供 Host 组合失败信息：确定性、单行。 */
export function manifestFailure(
  pluginId: string,
  errors: readonly string[],
): PluginHostError {
  return new PluginHostError("invalid-manifest", errors.join("; "), pluginId);
}

/** 供 Host 组合贡献校验失败信息。 */
export function contributionFailure(
  pluginId: string,
  errors: readonly string[],
): PluginHostError {
  return new PluginHostError("invalid-contribution", errors.join("; "), pluginId);
}

/** 判断 route 是否满足 Host 的前缀约束（测试与 Host 共用同一实现）。 */
export function isRouteWithinPlugin(pluginId: string, route: PluginRoute): boolean {
  return typeof route.path === "string" && route.path.startsWith(`/plugins/${pluginId}/`);
}
