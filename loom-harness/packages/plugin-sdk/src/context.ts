/**
 * 受控 PluginContext —— 插件在 setup() 中拿到的最小能力面。
 *
 * 明确不暴露：原始 EventHub、WakeQueue、InboxJournalStore / 其他 store、
 * HTTP router 实例、SessionRegistry 内部、模型 / provider 对象、进程环境变量。
 * 这些能力只能通过 register-only 注册表、命名空间 storage/events 获得。
 */

import type { HarnessTool, Hook } from "@axeuh/loom-core";
import type { PluginRoute } from "./plugin.js";

export interface PluginLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** 按插件命名空间隔离的键值存储；key 不需要带插件前缀。 */
export interface PluginStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export type PluginEventListener = (payload: unknown) => void;

/** 按插件命名空间隔离的事件总线；事件名不需要带插件前缀。 */
export interface PluginEventBus {
  /** 返回取消订阅函数。 */
  on(event: string, listener: PluginEventListener): () => void;
  emit(event: string, payload?: unknown): void;
}

export interface PluginToolRegistry {
  register(tool: HarnessTool): void;
}

export interface PluginHookRegistry {
  register(hook: Hook): void;
}

export interface PluginRouteRegistry {
  register(route: PluginRoute): void;
}

/** 会话生命周期回调看到的最小会话视图，避免把 server 内部类型带进 SDK。 */
export interface PluginSessionContext {
  readonly sessionID: string;
  readonly cwd: string;
}

export interface PluginSessionLifecycle {
  onSessionStart?(session: PluginSessionContext): void | Promise<void>;
  onPrompt?(session: PluginSessionContext, prompt: string): void | Promise<void>;
  onRunFinished?(session: PluginSessionContext): void | Promise<void>;
  onSessionEnd?(session: PluginSessionContext): void | Promise<void>;
}

export interface PluginContext {
  readonly plugin: {
    id: string;
    version: string;
    dataDir: string;
  };
  readonly config: Readonly<Record<string, unknown>>;
  readonly logger: PluginLogger;
  readonly tools: PluginToolRegistry;
  readonly hooks: PluginHookRegistry;
  readonly routes: PluginRouteRegistry;
  readonly storage: PluginStorage;
  readonly events: PluginEventBus;
}
