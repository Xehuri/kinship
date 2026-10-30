// T20 热加载四件套 —— HotConfigStore：加载即校验 → 原子交换 → 审计留痕 → 回滚=git。
//
// 四件套对应关系（D10）：
//  1. 加载即校验：parseLoomConfig（T07 schema 校验，复用不重写）+ checkReferences（引用存在性）。
//  2. 原子交换：全函数 apply —— 校验/审计任一失败都返回类型化 ApplyResult{ok:false}，
//     旧配置继续服务；Node 单线程事件循环内字段赋值不可分割，交换本身即原子，绝不抛穿调用方。
//  3. 审计：每次 apply（含拒载）写 config.applied 事件；留痕是硬性要求，
//     成功交换前必须先落审计，sink 写失败 → 拒载（stage="audit"），旧配置继续服务。
//  4. 回滚：由部署侧 git 完成（ai/ 与工作区配置都在版本控制内）——改坏配置提交即回退，
//     watch 会把回退后的文件重新 apply。本模块不执行任何 git 操作。
//
// 运行时=声明式 + 提示模板（D10/D28），本模块无 eval、无任意代码执行面。

import { readFileSync, watch as fsWatch } from "node:fs";
import { createHash } from "node:crypto";

import {
  LoomConfigError,
  type LoomConfig,
  parseLoomConfig,
} from "../config/loom-config.js";
import type { AuditSink, ApplyResult, ConfigAppliedEvent, FailureStage } from "./types.js";

/** 空库未加载时 get() 抛出；属启动时序问题，与坏配置拒载（类型化返回）是两类事。 */
export class ConfigNotLoadedError extends Error {
  constructor() {
    super("loom 配置尚未成功加载（空库；先 apply 或 applyFile 一份有效配置）");
    this.name = "ConfigNotLoadedError";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 引用存在性校验（schema 之外的跨段一致性）：
 *  - models[].provider 必须有对应 pricing.<name> 计价条目（缺 = 计费不可算，拒载）；
 *  - credentials 的每个 key 必须是某模型的 provider（凭据按供应商注入，悬空 key 拒载）。
 */
export function checkReferences(cfg: LoomConfig): readonly string[] {
  const errors: string[] = [];
  const providers = new Set(cfg.models.map((m) => m.provider));
  for (const m of cfg.models) {
    if (!(m.provider in cfg.pricing)) {
      errors.push(`引用缺失: 模型 ${m.id} 的 provider "${m.provider}" 在 pricing 段无计价条目`);
    }
  }
  for (const name of Object.keys(cfg.credentials)) {
    if (!providers.has(name)) {
      errors.push(`引用缺失: credentials key "${name}" 不对应任何模型的 provider`);
    }
  }
  return errors;
}

export interface HotConfigStoreOptions {
  readonly sink: AuditSink;
  /** 注入环境变量表（默认 process.env，透传给 T07 validator）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 时间源（注入便于测试；须产出 ISO 字符串）。 */
  readonly now?: () => string;
}

export interface WatchOptions {
  /** 被监视的配置文件路径。 */
  readonly file: string;
  /** 每次触发（含拒载）回调结果，仅观测用。 */
  readonly onResult?: (result: ApplyResult) => void;
  /** fs.watch 自身错误（NTFS/编辑器噪声常见）；缺省忽略。 */
  readonly onError?: (err: Error) => void;
  /** 事件聚合窗口毫秒（默认 150，编辑器多次写入合并为一次 apply）。 */
  readonly debounceMs?: number;
}

export class HotConfigStore {
  readonly #sink: AuditSink;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #now: () => string;
  // 生效配置与其文本哈希；null = 空库尚未加载。二者只在 apply 成功路径末尾一起赋值。
  #current: LoomConfig | null = null;
  #currentSha: string | null = null;

  constructor(options: HotConfigStoreOptions) {
    this.#sink = options.sink;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** 当前生效配置；空库抛 ConfigNotLoadedError（调用方契约：先成功 apply 再读）。 */
  get(): LoomConfig {
    if (this.#current === null) {
      throw new ConfigNotLoadedError();
    }
    return this.#current;
  }

  /** 当前生效配置的文本哈希；空库为 null。 */
  currentSha256(): string | null {
    return this.#currentSha;
  }

  /**
   * 全函数入口：校验配置文本并原子交换。任何失败都返回 ok:false + 审计事件，
   * 旧配置继续服务；本方法在任何输入下都不抛。
   */
  apply(text: string, source = "<memory>"): ApplyResult {
    const afterSha = sha256(text);
    const ts = this.#now();

    let cfg: LoomConfig;
    try {
      cfg = parseLoomConfig(text, source, { env: this.#env });
    } catch (e: unknown) {
      return this.#reject("schema", errorsOf(e), ts, source, afterSha);
    }

    const refErrors = checkReferences(cfg);
    if (refErrors.length > 0) {
      return this.#reject("reference", refErrors, ts, source, afterSha);
    }

    // 交换前必须先把 applied 事件落审计（留痕硬性）；写不进就不交换。
    const event: ConfigAppliedEvent = {
      type: "config.applied",
      ts,
      source,
      status: "applied",
      beforeSha256: this.#currentSha,
      afterSha256: afterSha,
    };
    if (!this.#writeAudit(event)) {
      return this.#reject("audit", ["审计 sink 写入失败，未交换配置"], ts, source, afterSha);
    }

    // 原子交换点：审计已落，赋值即生效（单线程事件循环内不可分割）。
    this.#current = cfg;
    this.#currentSha = afterSha;
    return { ok: true, config: cfg, event };
  }

  /** 读文件再 apply；读失败返回 stage="read" 的类型化失败（afterSha256=null）。 */
  applyFile(path: string): ApplyResult {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e: unknown) {
      return this.#reject("read", errorsOf(e, "无法读取配置文件"), this.#now(), path, null);
    }
    return this.apply(text, path);
  }

  /**
   * 可选的 fs.watch 接入：事件聚合后重新 applyFile（applyFile 全函数，回调绝不抛）。
   * 返回停止函数。测试不依赖触发时序（防 flaky），配置面语义一律通过 apply 直测。
   */
  watch(opts: WatchOptions): () => void {
    const { file } = opts;
    let timer: NodeJS.Timeout | undefined;
    // fs.watch 单次改动会发多个事件：聚合窗口内只保留最后一个触发。
    const watcher = fsWatch(file, { persistent: false }, () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        // applyFile 契约上不抛；外层兜底为「watch 回调绝不崩」再加一层保险。
        let result: ApplyResult;
        try {
          result = this.applyFile(file);
        } catch (e: unknown) {
          result = this.#fallbackCrashGuard(e, file);
        }
        opts.onResult?.(result);
      }, opts.debounceMs ?? 150);
      timer.unref(); // 监视器不钉住事件循环，进程退出由宿主（T31）决定。
    });
    watcher.on("error", (err: Error) => {
      opts.onError?.(err);
    });
    return () => {
      watcher.close();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }

  #fallbackCrashGuard(e: unknown, file: string): ApplyResult {
    return this.#buildRejectWithoutSwap("read", errorsOf(e), this.#now(), file, null);
  }

  /** 拒载统一路径：写 rejected 事件（写不进也要返回结果——旧值未动，安全侧），绝不交换。 */
  #reject(
    stage: FailureStage,
    errors: readonly string[],
    ts: string,
    source: string,
    afterSha: string | null,
  ): ApplyResult {
    return this.#buildRejectWithoutSwap(stage, errors, ts, source, afterSha);
  }

  #buildRejectWithoutSwap(
    stage: FailureStage,
    errors: readonly string[],
    ts: string,
    source: string,
    afterSha: string | null,
  ): ApplyResult {
    const event: ConfigAppliedEvent = {
      type: "config.applied",
      ts,
      source,
      status: "rejected",
      stage,
      beforeSha256: this.#currentSha,
      afterSha256: afterSha,
      errors,
    };
    this.#writeAudit(event);
    return { ok: false, stage, errors, event };
  }

  /** 审计写入：成功 true；失败 false（不外抛——坏 sink 也必须演变成拒载而非崩溃）。 */
  #writeAudit(event: ConfigAppliedEvent): boolean {
    try {
      this.#sink.write(event);
      return true;
    } catch {
      return false;
    }
  }
}

function errorsOf(e: unknown, prefix?: string): readonly string[] {
  if (e instanceof LoomConfigError) {
    return e.errors;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return [prefix === undefined ? msg : `${prefix}: ${msg}`];
}
