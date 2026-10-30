// 挂载脚本宿主（T16，D17/D18）：语言中立子进程协议编排层。
//
// 安全红线：
//   - 绝不在进程内 import/eval 脚本，一律 child_process.spawn 子进程（见 child.ts）。
//   - `exec` 是保留事件类型：识别到只拒绝+记录日志，任何路径不执行。
//   - 停止/卸载时杀整进程组（负 PID + SIGTERM->SIGKILL），杜绝孤儿。
// 生命周期：mount -> spawn -> stdout 逐行 JSON 事件 -> 意外退出按指数退避
// respawn（base*2^attempt 封顶 cap，收到任一合法事件即重置 attempt）。
// 热加载：rescan() 按 mtime+size 水位线 diff（D16：轮询制，不用 fs.watch）。

import { launchChild } from "./child.js";
import { prepareMount, scanScripts, watermarkChanged, type RejectReason } from "./discovery.js";
import { assertNever, parseEventLine } from "./protocol.js";
import {
  computeBackoff,
  type EventListener,
  type HostLogEntry,
  type HostLogger,
  type LogLevel,
  type Mounted,
  type ScriptHostOptions,
} from "./types.js";

export { computeBackoff } from "./types.js";
export type {
  BackoffConfig,
  EventListener,
  HostEvent,
  HostLogEntry,
  HostLogger,
  LogLevel,
  ScriptHostOptions,
} from "./types.js";
export type { ScriptMeta } from "./frontmatter.js";

const DEFAULTS = {
  baseBackoffMs: 1000,
  capBackoffMs: 60000,
  killGraceMs: 1500,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const consoleLogger: HostLogger = (entry: HostLogEntry) => {
  const line = `[script-host] ${entry.level} ${entry.message} ${JSON.stringify(entry.fields)}`;
  switch (entry.level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
};

export class ScriptHost {
  private readonly opts: ScriptHostOptions;
  private readonly logger: HostLogger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mounts = new Map<string, Mounted>();
  private readonly listeners = new Set<EventListener>();
  private stopped = false;
  private watchTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ScriptHostOptions) {
    this.opts = options;
    this.logger = options.logger ?? consoleLogger;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** 扫描 scriptsDir 并挂载全部合法且 enabled 的脚本。 */
  start(): void {
    this.stopped = false;
    this.discoverAndMount();
    const interval = this.opts.watchIntervalMs ?? 0;
    if (interval > 0) {
      this.watchTimer ??= setInterval(() => this.rescan(), interval);
    }
  }

  /** 热加载：mtime+size 水位线 diff -> 变化/删除的先卸载，再补挂新的。 */
  rescan(): void {
    if (this.stopped) return;
    const found = new Set(scanScripts(this.opts, (msg, fields) => this.log("warn", msg, fields)));
    for (const [filePath, m] of [...this.mounts]) {
      if (!found.has(filePath) || watermarkChanged(m)) {
        this.unmount(m);
        this.mounts.delete(filePath);
      }
    }
    this.discoverAndMount();
  }

  /** 停止全部：杀进程组、取消在途 respawn/watch。幂等。 */
  stop(): void {
    this.stopped = true;
    if (this.watchTimer !== undefined) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
    for (const m of this.mounts.values()) this.unmount(m);
    this.mounts.clear();
  }

  /** 订阅事件；返回取消订阅函数。 */
  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 当前活跃子进程 pid（测试用于无孤儿断言）。 */
  activePids(): number[] {
    const pids: number[] = [];
    for (const m of this.mounts.values()) {
      if (m.child?.pid !== undefined) pids.push(m.child.pid);
    }
    return pids;
  }

  // ---------- 内部 ----------

  private discoverAndMount(): void {
    for (const filePath of scanScripts(this.opts, (msg, fields) => this.log("warn", msg, fields))) {
      if (this.stopped || this.mounts.has(filePath)) continue;
      const prepared = prepareMount(filePath, this.opts);
      if (!prepared.ok) {
        this.logReject(filePath, prepared.reject);
        continue;
      }
      this.mounts.set(filePath, prepared.mounted);
      this.log("info", "挂载脚本", {
        name: prepared.mounted.meta.name,
        filePath,
        respawn: prepared.mounted.meta.respawn,
      });
      this.spawn(prepared.mounted);
    }
  }

  private logReject(filePath: string, reject: RejectReason): void {
    switch (reject.kind) {
      case "read-failed":
        this.log("warn", "脚本读取失败，跳过", { filePath, err: reject.err });
        return;
      case "bad-frontmatter":
        this.log("error", "frontmatter 非法，拒绝挂载", { filePath, reason: reject.reason });
        return;
      case "disabled":
        this.log("info", "脚本已禁用，跳过", { filePath, name: reject.name });
        return;
      case "no-interpreter":
        this.log("error", "无可用解释器，拒绝挂载", {
          filePath,
          lang: reject.lang,
          hint: "lang=ts 需挂载方注入 interpreters.ts（node20 无内置 TS runner）",
        });
        return;
      default:
        return assertNever(reject);
    }
  }

  private spawn(m: Mounted): void {
    m.generation += 1;
    const gen = m.generation;
    m.child = launchChild(
      {
        command: m.command,
        scriptPath: m.filePath,
        prefixArgs: m.prefixArgs,
        extraEnv: this.opts.env,
      },
      {
        onLaunch: (pid) => this.opts.onChildLaunch?.(pid),
        onStdoutLine: (line) => this.handleStdoutLine(m, line),
        onStderrLine: (line) => this.log("debug", "stderr", { name: m.meta.name, line }),
        onError: (err) => this.log("error", "子进程错误", { name: m.meta.name, err: String(err) }),
        onExit: (why) => this.onChildClosed(m, gen, why),
      },
    );
  }

  private onChildClosed(
    m: Mounted,
    gen: number,
    why: { code: number | null; signal: NodeJS.Signals | null },
  ): void {
    if (m.generation !== gen || m.stopping || this.stopped) return;
    m.child = undefined;
    const exitInfo = { name: m.meta.name, code: why.code, signal: why.signal };

    if (why.code === 0 && why.signal === null) {
      // 干净退出（code 0、无信号）= 脚本正常收尾，不重拉（即便 respawn:true）。
      this.log("info", "脚本干净退出（不重拉）", exitInfo);
      return;
    }
    if (!m.meta.respawn) {
      this.log("info", "脚本退出（respawn 关闭，不重拉）", exitInfo);
      return;
    }
    const cfg = {
      baseMs: this.opts.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      capMs: this.opts.capBackoffMs ?? DEFAULTS.capBackoffMs,
    };
    const delay = computeBackoff(m.attempt, cfg);
    m.attempt += 1;
    this.log("warn", "脚本退出，计划退避重拉", { ...exitInfo, delayMs: delay, attempt: m.attempt });
    void this.sleep(delay).then(() => {
      if (m.stopping || this.stopped || m.generation !== gen) return;
      this.spawn(m);
    });
  }

  private handleStdoutLine(m: Mounted, line: string): void {
    const parsed = parseEventLine(line);
    if (parsed.kind === "blank") return;
    if (parsed.kind === "invalid") {
      this.log("warn", "无法解析的事件行", {
        name: m.meta.name,
        line: parsed.line,
        reason: parsed.reason,
      });
      return;
    }
    if (parsed.kind === "reserved") {
      // 保留事件 exec：拒绝并记录。绝不执行——宿主没有任何按 payload 行动的代码路径。
      this.log("error", "拒绝保留事件（不执行）", {
        name: m.meta.name,
        reservedType: parsed.reservedType,
        line: parsed.line,
        reason: parsed.reason,
      });
      return;
    }
    if (parsed.kind === "event") {
      m.attempt = 0; // 收到合法事件即视为健康：重置退避计数。
      const evt = { script: m.meta.name, filePath: m.filePath, event: parsed.event };
      for (const listener of this.listeners) {
        try {
          listener(evt);
        } catch (err) {
          this.log("warn", "事件监听器抛错", { name: m.meta.name, err: String(err) });
        }
      }
      return;
    }
    return assertNever(parsed);
  }

  private unmount(m: Mounted): void {
    m.stopping = true;
    m.generation += 1; // 令在途 sleep/exit 回调失效
    const child = m.child;
    m.child = undefined;
    child?.terminate(this.opts.killGraceMs ?? DEFAULTS.killGraceMs);
  }

  private log(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    this.logger({ level, message, fields });
  }
}
