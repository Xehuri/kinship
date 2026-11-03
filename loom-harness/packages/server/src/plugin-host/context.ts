/**
 * 受控 PluginContext 实现。
 *
 * 插件只能看到 SDK 定义的最小能力面：命名空间 storage / events、只增注册表、
 * 配置视图与 logger。原始 EventHub、WakeQueue、router、session registry、模型
 * 对象一律不注入。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { HarnessTool, Hook } from "@axeuh/loom-core";
import type {
  LoomFeaturePlugin,
  PluginContext,
  PluginEventBus,
  PluginEventListener,
  PluginLogger,
  PluginPermission,
  PluginRoute,
  PluginStorage,
} from "@axeuh/loom-plugin-sdk";

import { FilePluginStorage } from "./storage.js";
import { PluginHostError, isRecord } from "./validate.js";

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export type PluginLogFn = (
  level: PluginLogLevel,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

/** Host 注入的只增贡献收集器；Context 的 tools/hooks/routes 都汇入这里。 */
export interface PluginContributionSink {
  registerTool(tool: HarnessTool): void;
  registerHook(hook: Hook): void;
  registerRoute(route: PluginRoute): void;
}

export interface PluginContextOptions {
  readonly plugin: LoomFeaturePlugin;
  readonly dataRoot: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly log?: PluginLogFn;
  readonly sink: PluginContributionSink;
}

const NOOP_LOG: PluginLogFn = () => {
  // 默认静默；Host 未注入 log 时保持与无日志环境一致。
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createLogger(pluginId: string, log: PluginLogFn): PluginLogger {
  const write = (
    level: PluginLogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): void => {
    log(level, `[plugin:${pluginId}] ${msg}`, { ...fields, pluginId });
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}

function createEventBus(pluginId: string, log: PluginLogFn): PluginEventBus {
  const listeners = new Map<string, Set<PluginEventListener>>();
  return {
    on(event: string, listener: PluginEventListener): () => void {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set<PluginEventListener>();
        listeners.set(event, set);
      }
      set.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        const current = listeners.get(event);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(event);
      };
    },
    emit(event: string, payload?: unknown): void {
      const set = listeners.get(event);
      if (set === undefined) return;
      // 快照遍历：listener 在回调中退订/新订不影响本轮。
      for (const listener of [...set]) {
        try {
          listener(payload);
        } catch (error) {
          log("error", `event listener failed for "${event}"`, {
            pluginId,
            error: errorMessage(error),
          });
        }
      }
    },
  };
}

function requirePermission(
  pluginId: string,
  permissions: ReadonlySet<PluginPermission>,
  permission: PluginPermission,
): void {
  if (permissions.has(permission)) return;
  throw new PluginHostError(
    "permission-denied",
    `permission "${permission}" is required but not declared in manifest.permissions`,
    pluginId,
  );
}

/** storage 能力闸：只做权限检查，读写语义仍由 FilePluginStorage 承担。 */
function gateStorage(
  storage: PluginStorage,
  require: (permission: PluginPermission) => void,
): PluginStorage {
  return {
    get(key: string): Promise<unknown> {
      require("storage:own");
      return storage.get(key);
    },
    set(key: string, value: unknown): Promise<void> {
      require("storage:own");
      return storage.set(key, value);
    },
    delete(key: string): Promise<void> {
      require("storage:own");
      return storage.delete(key);
    },
    list(prefix?: string): Promise<string[]> {
      require("storage:own");
      return storage.list(prefix);
    },
  };
}

/** events 能力闸：listener 抛错吞掉并记日志的行为由 createEventBus 原样保留。 */
function gateEventBus(
  bus: PluginEventBus,
  require: (permission: PluginPermission) => void,
): PluginEventBus {
  return {
    on(event: string, listener: PluginEventListener): () => void {
      require("events:own");
      return bus.on(event, listener);
    },
    emit(event: string, payload?: unknown): void {
      require("events:own");
      bus.emit(event, payload);
    },
  };
}

function resolvePluginConfig(
  pluginId: string,
  config: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const value = config?.[pluginId];
  return isRecord(value) ? Object.freeze({ ...value }) : Object.freeze({});
}

/**
 * 创建某个插件的受控上下文。
 *
 * 同步创建 `<dataRoot>/<pluginId>/`；plugin id 已在 Host 的 manifest 校验中通过
 * `/^[a-z0-9][a-z0-9._-]*$/`，因此不会引入路径穿越。独立调用时调用方需自行保证 id 合法。
 */
export function createPluginContext(options: PluginContextOptions): PluginContext {
  const { plugin, dataRoot, sink } = options;
  const id = plugin.manifest.id;
  const dataDir = join(dataRoot, id);
  mkdirSync(dataDir, { recursive: true });

  const log = options.log ?? NOOP_LOG;
  const permissions = new Set<PluginPermission>(plugin.manifest.permissions);
  const requireCapability = (permission: PluginPermission): void => {
    requirePermission(id, permissions, permission);
  };
  const storage = gateStorage(
    new FilePluginStorage(id, join(dataDir, "storage.json")),
    requireCapability,
  );
  const events = gateEventBus(createEventBus(id, log), requireCapability);

  return {
    plugin: {
      id,
      version: plugin.manifest.version,
      dataDir,
    },
    config: resolvePluginConfig(id, options.config),
    logger: createLogger(id, log),
    tools: {
      register(tool: HarnessTool): void {
        requireCapability("tools:register");
        sink.registerTool(tool);
      },
    },
    hooks: {
      register(hook: Hook): void {
        requireCapability("hooks:register");
        sink.registerHook(hook);
      },
    },
    routes: {
      register(route: PluginRoute): void {
        requireCapability("routes:register");
        sink.registerRoute(route);
      },
    },
    storage,
    events,
  };
}
