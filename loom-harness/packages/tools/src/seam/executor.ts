/**
 * ToolExecutor —— D7 单缝编排器（T22）。
 *
 * `exec(cmd, cwd, env, timeout, paths)` 是工具代码路径上**唯一**的副作用入口
 * （第 6 位 ctx 为可选接线上下文，不改 5 位置冻结签名）：
 * 权限求值（default-deny）→ 沙箱断言（chdir + realpath 包含 + 命令前缀）→
 * 进程执行（seam-process.ts 唯一 child_process 落点）→ 审计（allow/deny 双态）。
 *
 * bash 工具接线：`createBashTool(cwd, { operations: executor.asBashOperations() })`
 * ——vendor 的 rolling-output/truncation 复用，exec 咽喉点换成缝。
 * 文件类工具路径咽喉仍是 path-utils.resolveToolPath（realpath 包含断言）。
 */


import type { BashExecOptions, BashExecResult, BashOperations } from "../index.js";
import type {
  AskResolver,
  AuditSink,
  PathAccess,
  ProcessRunner,
  SandboxProfile,
  ScopeKey,
  SeamAuditEvent,
  SeamCall,
  SeamDecision,
  SeamExecResult,
  SeamPermissionRule,
  SeamRunCtx,
  ShellProgram,
} from "./types.js";
import { SeamDeniedError } from "./types.js";
import { evaluatePermission } from "./permission.js";
import {
  assertCommand,
  assertCwdInsideWorkspace,
  assertPathAccess,
  realWorkspaceRoot,
} from "./sandbox.js";
import { makeProcessRunner } from "./seam-process.js";

/** executor 构造选项（配置聚合对象，非参数走私）。 */
export interface ToolExecutorOptions {
  /** 工作区根（绝对）。所有断言以其 realpath 为界。 */
  readonly workspaceRoot: string;
  /** 声明式沙箱档案。 */
  readonly profile: SandboxProfile;
  /** 权限规则表（deny 优先 + 特异分层 + default-deny）。 */
  readonly rules: readonly SeamPermissionRule[];
  /** 调用默认作用域；每次 exec 可经 ctx.scope 覆盖。 */
  readonly scope: ScopeKey;
  /** 无命中兜底，缺省 deny。 */
  readonly fallback?: SeamDecision | undefined;
  /** ask 解析器；缺省 = 无人值守 = 拒。 */
  readonly askResolver?: AskResolver | undefined;
  /** 审计接收器（allow/deny 双态都发）。 */
  readonly audit?: AuditSink | undefined;
  /** 进程执行回调；缺省 seam-process.runProcess（测试可注入 fake）。 */
  readonly runner?: ProcessRunner | undefined;
  /**
   * W4：指定 shell 程序（loom.yaml bash.shell 直投）。仅在缺省 runner 时生效——
   * 显式 runner 优先（测试注入通路不变）。
   */
  readonly bashShell?: ShellProgram | undefined;
}

/** 权限 + 沙箱预检输入（exec 与 authorizeTool 共用，避免参数走私）。 */
interface PreflightInput {
  readonly tool: string;
  readonly scope: ScopeKey;
  readonly cmd: string;
  readonly cwd: string;
  readonly paths: readonly PathAccess[];
  readonly isDestructive: boolean;
}

export class ToolExecutor {
  private readonly rootReal: string;
  private readonly profile: SandboxProfile;
  private readonly rules: readonly SeamPermissionRule[];
  private readonly scope: ScopeKey;
  private readonly fallback: SeamDecision;
  private readonly askResolver: AskResolver | undefined;
  private readonly audit: AuditSink | undefined;
  private readonly runner: ProcessRunner;

  constructor(opts: ToolExecutorOptions) {
    this.rootReal = realWorkspaceRoot(opts.workspaceRoot);
    this.profile = opts.profile;
    this.rules = opts.rules;
    this.scope = opts.scope;
    this.fallback = opts.fallback ?? "deny";
    this.askResolver = opts.askResolver;
    this.audit = opts.audit;
    this.runner = opts.runner ?? makeProcessRunner(opts.bashShell);
  }

  /** 单缝（签名冻结自 docs/01 D7）。拒绝一律经 SeamDeniedError 抛出，
   * 且先审计后抛出——out-of-workspace write rejected + audited（T22 验收）。 */
  async exec(
    cmd: string,
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
    timeout: number | undefined,
    paths: readonly PathAccess[] = [],
    ctx: SeamRunCtx = {},
  ): Promise<SeamExecResult> {
    const cwdReal = await this.preflight({
      tool: ctx.tool ?? "bash",
      scope: ctx.scope ?? this.scope,
      cmd,
      cwd,
      paths,
      // exec 起进程，天然按破坏性对待（docs/01 D7 收严对象）。
      isDestructive: ctx.isDestructive ?? true,
    });
    return await this.runner(cmd, cwdReal, {
      env: env ?? safeShellEnv(),
      timeoutSeconds: timeout,
      signal: ctx.signal,
      onData: ctx.onData ?? (() => {}),
    });
  }

  /**
   * 仅供特殊执行面（如 PTY）使用的“只授权不执行”入口：与 exec 共用权限求值、
   * 命令前缀/网络/cwd 断言与审计，但不启动进程。返回 cwd 的 realpath。
   */
  async authorizeTool(
    tool: string,
    cmd: string,
    cwd: string,
    paths: readonly PathAccess[] = [],
  ): Promise<string> {
    return this.preflight({
      tool,
      scope: this.scope,
      cmd,
      cwd,
      paths,
      isDestructive: true,
    });
  }

  /**
   * 适配 tools 根 `BashOperations.exec`，把 bash 工具咽喉点接到本缝。
   * shell 字符串的 paths 无法静态提取，v1 传空数组——兜底靠 chdir(cwd) 断言 +
   * cmd_allow/deny + net 声明（D7：朴素但真拒绝；沙箱期 profile fs 挂载接管）。
   */
  asBashOperations(): BashOperations {
    return {
      exec: async (command: string, cwd: string, options: BashExecOptions): Promise<BashExecResult> => {
        const result = await this.exec(command, cwd, options.env, options.timeout, [], {
          tool: "bash",
          isDestructive: true,
          signal: options.signal,
          onData: options.onData,
        });
        return { exitCode: result.exitCode };
      },
    };
  }

  /** exec 与 authorizeTool 的唯一预检路径：权限求值 → 沙箱断言 → 审计；返回 cwdReal。 */
  private async preflight(input: PreflightInput): Promise<string> {
    const { tool, scope, cmd, cwd, paths } = input;
    const call: SeamCall = {
      tool,
      scope,
      args: { cmd, cwd, paths: paths.map((p) => p.path) },
      isDestructive: input.isDestructive,
    };

    const verdict = await evaluatePermission(call, {
      rules: this.rules,
      fallback: this.fallback,
      ...(this.askResolver !== undefined ? { askResolver: this.askResolver } : {}),
    });
    if (verdict.decision !== "allow") {
      this.emitAudit({ scope, tool: call.tool, cmd, cwd, paths, verdict: "deny", reason: verdict.reason });
      throw new SeamDeniedError(`permission denied: ${verdict.reason}`, "permission", verdict.reason);
    }

    try {
      assertCommand(cmd, this.profile);
      const cwdReal = assertCwdInsideWorkspace(this.rootReal, cwd);
      // v1 强制：断言通过即放行（沙箱期由 bwrap 的 fs 挂载接管）。
      for (const p of paths) assertPathAccess(this.rootReal, cwdReal, p, this.profile);
      this.emitAudit({ scope, tool: call.tool, cmd, cwd: cwdReal, paths, verdict: "allow", reason: verdict.reason });
      return cwdReal;
    } catch (err) {
      if (err instanceof SeamDeniedError && err.kind === "sandbox") {
        this.emitAudit({ scope, tool: call.tool, cmd, cwd, paths, verdict: "deny", reason: err.reason });
      }
      throw err;
    }
  }

  private emitAudit(e: Omit<SeamAuditEvent, "ts">): void {
    if (!this.audit) return;
    this.audit({ ts: Date.now(), ...e });
  }
}

/** env 净化：剔除密钥类变量（与 vendor safeShellEnv 同款策略）。 */
export function safeShellEnv(): NodeJS.ProcessEnv {
  const blocked = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !blocked.test(key)),
  ) as NodeJS.ProcessEnv;
}
