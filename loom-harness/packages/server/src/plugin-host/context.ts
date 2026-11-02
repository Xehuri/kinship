/**
 * 受控 PluginContext 实现。
 *
 * 插件只能看到 SDK 定义的最小能力面：命名空间 storage / events、只增注册表、
 * 配置视图与 logger。原始 EventHub、WakeQueue、router、session registry、模型
 * 对象一律不注入。
 *
 * storage 是「每插件一个 JSON 对象文件」：`<dataRoot>/<pluginId>/storage.json`。
 * 值必须可 JSON 序列化（undefined、BigInt、循环引用会被拒绝）。写盘在进程内串行，
 * 用 tmp 文件 + rename 保证原子替换。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessTool, Hook } from "@axeuh/loom-core";
import type {
  LoomFeaturePlugin,
  PluginContext,
  PluginEventBus,
  PluginEventListener,
  PluginLogger,
  PluginRoute,
  PluginStorage,
} from "@axeuh/loom-plugin-sdk";

import {
  PluginHostError,
  describeError,
  isRecord,
} from "./validate.js";

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

let tmpCounter = 0;

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

function loadStorage(pluginId: string, storagePath: string): Record<string, unknown> {
  if (!existsSync(storagePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(storagePath, "utf8"));
  } catch (error) {
    throw new PluginHostError(
      "invalid-storage",
      `storage.json is not valid JSON: ${describeError(error)}`,
      pluginId,
    );
  }
  if (!isRecord(parsed)) {
    throw new PluginHostError(
      "invalid-storage",
      "storage.json must contain a JSON object",
      pluginId,
    );
  }
  return parsed;
}

function assertStorageKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw new PluginHostError("invalid-storage", "storage key must be a non-empty string");
  }
}

function assertJsonSerializable(value: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new PluginHostError(
      "invalid-storage",
      `storage value is not JSON-serializable: ${describeError(error)}`,
    );
  }
  if (encoded === undefined) {
    throw new PluginHostError(
      "invalid-storage",
      "storage value is not JSON-serializable (undefined or unsupported type)",
    );
  }
}

class FilePluginStorage implements PluginStorage {
  private readonly data: Record<string, unknown>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly pluginId: string,
    private readonly storagePath: string,
  ) {
    this.data = loadStorage(pluginId, storagePath);
  }

  async get(key: string): Promise<unknown> {
    assertStorageKey(key);
    return this.data[key];
  }

  async set(key: string, value: unknown): Promise<void> {
    assertStorageKey(key);
    assertJsonSerializable(value);
    this.data[key] = value;
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    if (!(key in this.data)) return;
    delete this.data[key];
    await this.persist();
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = Object.keys(this.data);
    const filtered =
      prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
    return filtered.sort();
  }

  private persist(): Promise<void> {
    // 每次 set/delete 都拍快照；队列保证磁盘写入顺序，读路径直接看内存最新值。
    const snapshot = JSON.stringify(this.data);
    const write = this.writeChain.then(() => this.writeSnapshot(snapshot));
    this.writeChain = write.catch(() => {
      // 失败不阻塞后续写入；错误已经通过返回的 promise 交给本次调用者。
    });
    return write;
  }

  private async writeSnapshot(content: string): Promise<void> {
    tmpCounter += 1;
    const tempPath = `${this.storagePath}.${process.pid}.${tmpCounter}.tmp`;
    try {
      await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.storagePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {
        // 清理失败不掩盖原始错误。
      });
      throw error;
    }
  }
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
  const storage = new FilePluginStorage(id, join(dataDir, "storage.json"));

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
        sink.registerTool(tool);
      },
    },
    hooks: {
      register(hook: Hook): void {
        sink.registerHook(hook);
      },
    },
    routes: {
      register(route: PluginRoute): void {
        sink.registerRoute(route);
      },
    },
    storage,
    events: createEventBus(id, log),
  };
}
