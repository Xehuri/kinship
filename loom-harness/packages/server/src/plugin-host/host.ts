/**
 * Feature Plugin Host —— 注册、依赖排序、能力上下文、生命周期与状态。
 *
 * 这里不创建任何调度器、定时器、WakeQueue 或第二套工具/Hook 分发器：
 *   - start() 按拓扑顺序调用 plugin.setup()，把贡献收进内存；
 *   - stop() 逆序调用 contribution.stop()，随后清空贡献；
 *   - contributions() 只是当前 running 插件贡献的合并视图，由 boot 决定如何消费。
 *
 * 失败策略：
 *   - manifest 非法 / setup 抛错 / 贡献冲突 / start() 抛错：该插件 failed；
 *     critical=true 时 Host 立即抛错，否则记录后继续；
 *   - 缺失依赖 / 依赖环：依赖图本身不成立，Host 直接抛错。
 */

import type { Hook, HarnessTool } from "@axeuh/loom-core";
import type {
  LoomFeaturePlugin,
  LoomPluginManifest,
  PluginContext,
  PluginContribution,
  PluginRoute,
  PluginRuntimeStatus,
  PluginSource,
  PluginState,
  PluginTrust,
} from "@axeuh/loom-plugin-sdk";

import {
  createPluginContext,
  type PluginContributionSink,
  type PluginLogFn,
} from "./context.js";
import {
  PluginRegistry,
  resolveStartOrder,
  type PluginRegisterOptions,
  type PluginRegistration,
} from "./registry.js";
import { toPluginRuntimeStatus } from "./status.js";
import {
  PluginHostError,
  contributionFailure,
  describeError,
  manifestFailure,
  resolvePluginSource,
  resolvePluginTrust,
  validateContribution,
  validateManifest,
  type ResolvedManifest,
} from "./validate.js";

export interface PluginHostOptions {
  readonly dataRoot: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly log?: PluginLogFn;
  readonly now?: () => number;
}

export interface PluginContributions {
  readonly tools: HarnessTool[];
  readonly hooks: Hook[];
  readonly routes: PluginRoute[];
}

interface ActiveContribution {
  readonly tools: HarnessTool[];
  readonly hooks: Hook[];
  readonly routes: PluginRoute[];
  readonly stop?: () => Promise<void> | void;
}

interface RuntimeRecord {
  readonly registration: PluginRegistration;
  readonly manifest: LoomPluginManifest;
  source: PluginSource;
  trust: PluginTrust;
  state: PluginState;
  error?: string;
  startedAt?: string;
  stoppedAt?: string;
  active?: ActiveContribution;
}

interface StagedContribution extends PluginContributionSink {
  readonly tools: HarnessTool[];
  readonly hooks: Hook[];
  readonly routes: PluginRoute[];
}

function createStagedContribution(): StagedContribution {
  const tools: HarnessTool[] = [];
  const hooks: Hook[] = [];
  const routes: PluginRoute[] = [];
  return {
    tools,
    hooks,
    routes,
    registerTool(tool): void {
      tools.push(tool);
    },
    registerHook(hook): void {
      hooks.push(hook);
    },
    registerRoute(route): void {
      routes.push(route);
    },
  };
}

/**
 * 合并 setup() 的返回值（而非 ctx 注册）到暂存贡献。
 *
 * Hook 的「函数形态」需要 session 才能展开，P0 Host 没有 session 绑定，
 * 因此不拒绝也不展开；P1 需要时再由 Host 提供逐 session 解析入口。
 */
function mergeReturnedContribution(
  returned: PluginContribution | undefined,
  sink: StagedContribution,
): readonly string[] {
  if (returned === undefined || returned === null) return [];
  if (typeof returned !== "object") {
    return ["setup() must return a PluginContribution object"];
  }

  const errors: string[] = [];
  if (returned.tools !== undefined) {
    if (!Array.isArray(returned.tools)) {
      errors.push("contribution.tools must be an array");
    } else {
      for (const tool of returned.tools) sink.registerTool(tool);
    }
  }
  if (returned.hooks !== undefined) {
    if (Array.isArray(returned.hooks)) {
      for (const hook of returned.hooks) sink.registerHook(hook);
    } else if (typeof returned.hooks !== "function") {
      errors.push("contribution.hooks must be an array or a function");
    }
  }
  if (returned.routes !== undefined) {
    if (!Array.isArray(returned.routes)) {
      errors.push("contribution.routes must be an array");
    } else {
      for (const route of returned.routes) sink.registerRoute(route);
    }
  }
  return errors;
}

export class PluginHost {
  private readonly options: PluginHostOptions;
  private readonly log: PluginLogFn;
  private readonly now: () => number;
  private readonly registry = new PluginRegistry();
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private startOrder: string[] = [];
  private started = false;

  constructor(options: PluginHostOptions) {
    this.options = options;
    this.log = options.log ?? (() => {
      // 未配置 logger 时保持静默。
    });
    this.now = options.now ?? Date.now;
  }

  /** 记录插件（按注册顺序）；重复 id 立即抛错。 */
  register(plugin: LoomFeaturePlugin, options: PluginRegisterOptions = {}): void {
    const registration = this.registry.register(plugin, options);
    const source = resolvePluginSource(plugin.manifest);
    this.runtimes.set(registration.id, {
      registration,
      manifest: plugin.manifest,
      source,
      trust: resolvePluginTrust(plugin.manifest, source),
      state: registration.enabled ? "registered" : "disabled",
    });
  }

  async start(): Promise<void> {
    if (this.started) return;

    const registrations = this.registry.list();
    const validated = new Map<string, ResolvedManifest>();
    let criticalManifestError: PluginHostError | undefined;

    // 1. 校验每个 manifest（包括 disabled，便于状态里暴露问题）。
    for (const registration of registrations) {
      const runtime = this.runtimeOf(registration);
      const result = validateManifest(registration.plugin.manifest);
      if (result.manifest === undefined) {
        const failure = manifestFailure(registration.id, result.errors);
        runtime.error = failure.message;
        if (registration.enabled) {
          runtime.state = "failed";
          this.log("error", `plugin "${registration.id}" manifest invalid`, {
            pluginId: registration.id,
            code: failure.code,
            error: failure.message,
          });
          if (
            registration.plugin.manifest.critical === true &&
            criticalManifestError === undefined
          ) {
            criticalManifestError = failure;
          }
        } else {
          runtime.state = "disabled";
        }
        continue;
      }

      validated.set(registration.id, result.manifest);
      runtime.source = result.manifest.source;
      runtime.trust = result.manifest.trust;
      delete runtime.error;
      runtime.state = registration.enabled ? "registered" : "disabled";
    }

    if (criticalManifestError !== undefined) throw criticalManifestError;

    // 2. 仅对启用且 manifest 合法的插件排序；缺失依赖 / 环由 resolveStartOrder 抛错。
    const enabled = registrations.filter(
      (registration) => registration.enabled && validated.has(registration.id),
    );
    const ordered = resolveStartOrder(enabled);
    this.startOrder = ordered.map((registration) => registration.id);

    // 3. 按依赖顺序启动。
    for (const registration of ordered) {
      await this.startOne(this.runtimeOf(registration));
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    const ids =
      this.startOrder.length > 0
        ? [...this.startOrder].reverse()
        : this.registry
            .list()
            .reverse()
            .map((registration) => registration.id);

    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      if (runtime === undefined || runtime.state !== "running") continue;

      runtime.state = "stopping";
      const stop = runtime.active?.stop;
      if (stop !== undefined) {
        try {
          await stop();
        } catch (error) {
          this.log("warn", `plugin "${id}" stop failed`, {
            pluginId: id,
            error: describeError(error),
          });
        }
      }
      delete runtime.active;
      runtime.state = "stopped";
      runtime.stoppedAt = new Date(this.now()).toISOString();
    }

    this.startOrder = [];
    this.started = false;
  }

  /** 注册顺序返回全部插件状态（未启动插件也有 registered/disabled 状态）。 */
  status(): PluginRuntimeStatus[] {
    return [...this.runtimes.values()].map((runtime) => this.statusOf(runtime));
  }

  /** 只合并当前 running 插件的贡献。 */
  contributions(): PluginContributions {
    const tools: HarnessTool[] = [];
    const hooks: Hook[] = [];
    const routes: PluginRoute[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.state !== "running" || runtime.active === undefined) continue;
      tools.push(...runtime.active.tools);
      hooks.push(...runtime.active.hooks);
      routes.push(...runtime.active.routes);
    }
    return { tools, hooks, routes };
  }

  private async startOne(runtime: RuntimeRecord): Promise<void> {
    const id = runtime.registration.id;
    runtime.state = "starting";
    delete runtime.error;
    delete runtime.startedAt;
    delete runtime.stoppedAt;

    const staged = createStagedContribution();
    let context: PluginContext;
    try {
      context = createPluginContext({
        plugin: runtime.registration.plugin,
        dataRoot: this.options.dataRoot,
        ...(this.options.config === undefined ? {} : { config: this.options.config }),
        log: this.log,
        sink: staged,
      });
    } catch (error) {
      const failure =
        error instanceof PluginHostError
          ? error
          : new PluginHostError("setup-failed", describeError(error), id);
      this.fail(runtime, failure);
      if (runtime.manifest.critical === true) throw failure;
      return;
    }

    let contribution: PluginContribution | undefined;
    try {
      contribution = await runtime.registration.plugin.setup(context);
    } catch (error) {
      const failure = new PluginHostError("setup-failed", describeError(error), id);
      this.fail(runtime, failure);
      if (runtime.manifest.critical === true) throw failure;
      return;
    }

    const mergeErrors = mergeReturnedContribution(contribution, staged);
    if (mergeErrors.length > 0) {
      const failure = contributionFailure(id, mergeErrors);
      this.fail(runtime, failure);
      if (runtime.manifest.critical === true) throw failure;
      return;
    }

    const validationErrors = validateContribution({
      pluginId: id,
      contribution: staged,
      existing: this.activeContributionView(),
    });
    if (validationErrors.length > 0) {
      const failure = contributionFailure(id, validationErrors);
      this.fail(runtime, failure);
      if (runtime.manifest.critical === true) throw failure;
      return;
    }

    // 校验后拍快照：start() 里再注册的内容不会绕过冲突检查。
    const validatedTools = [...staged.tools];
    const validatedHooks = [...staged.hooks];
    const validatedRoutes = [...staged.routes];

    if (contribution?.start !== undefined) {
      try {
        await contribution.start();
      } catch (error) {
        const failure = new PluginHostError("start-failed", describeError(error), id);
        this.fail(runtime, failure);
        if (runtime.manifest.critical === true) throw failure;
        return;
      }
    }

    runtime.active = {
      tools: validatedTools,
      hooks: validatedHooks,
      routes: validatedRoutes,
      ...(contribution?.stop === undefined
        ? {}
        : { stop: contribution.stop.bind(contribution) }),
    };
    runtime.state = "running";
    runtime.startedAt = new Date(this.now()).toISOString();
  }

  private fail(runtime: RuntimeRecord, failure: PluginHostError): void {
    runtime.state = "failed";
    runtime.error = failure.message;
    delete runtime.active;
    this.log("error", `plugin "${runtime.registration.id}" failed`, {
      pluginId: runtime.registration.id,
      code: failure.code,
      error: failure.message,
    });
  }

  private activeContributionView(): {
    readonly tools: readonly unknown[];
    readonly routes: readonly unknown[];
  } {
    const tools: HarnessTool[] = [];
    const routes: PluginRoute[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.state !== "running" || runtime.active === undefined) continue;
      tools.push(...runtime.active.tools);
      routes.push(...runtime.active.routes);
    }
    return { tools, routes };
  }

  private statusOf(runtime: RuntimeRecord): PluginRuntimeStatus {
    return toPluginRuntimeStatus({
      id: runtime.registration.id,
      version: runtime.manifest.version,
      source: runtime.source,
      trust: runtime.trust,
      enabled: runtime.registration.enabled,
      state: runtime.state,
      ...(runtime.error === undefined ? {} : { error: runtime.error }),
      ...(runtime.startedAt === undefined ? {} : { startedAt: runtime.startedAt }),
      ...(runtime.stoppedAt === undefined ? {} : { stoppedAt: runtime.stoppedAt }),
    });
  }

  private runtimeOf(registration: PluginRegistration): RuntimeRecord {
    const runtime = this.runtimes.get(registration.id);
    if (runtime === undefined) {
      throw new PluginHostError(
        "invalid-manifest",
        "plugin registration is missing its runtime record",
        registration.id,
      );
    }
    return runtime;
  }
}
