/**
 * D7/D25 seam 契约类型（T22）。
 *
 * 本目录是 loom-tools 内**唯一**允许触碰 `node:child_process` 的地方
 * （落在 seam-process.ts，仅 executor.ts 消费）。工具代码路径上任何副作用
 * ——起进程、写文件、碰网络——都必须走 ToolExecutor.exec 单缝；文件类工具
 * 的路径咽喉复用 path-utils.resolveToolPath（realpath 包含断言）。
 *
 * 契约声明：
 *   - exec 的五个位置参数 (cmd, cwd, env, timeout, paths) 是 docs/01 D7
 *     冻结签名，>3 参数是合约要求而非设计失误。
 *   - SandboxProfile 是**声明式**的；v1 强制 = chdir + realpath 包含断言 +
 *     命令前缀 allow/deny（朴素但真拒绝）。net / rlimit 仅声明，留给沙箱期
 *     （bubblewrap/容器），上层零改动。
 */

/** 权限三级决策（与 core permission-gate 的语义一致）。 */
export type SeamDecision = "allow" | "ask" | "deny";

/** 作用域键：权限规则按 {agent, workflow} 作用域求值。 */
export interface ScopeKey {
  readonly agent: string;
  readonly workflow: string;
}

/** 文件访问模式。 */
export type PathMode = "read" | "write";

/** exec 的 paths 声明：本次调用意图触及的路径（相对 cwd 或绝对）。 */
export interface PathAccess {
  readonly path: string;
  readonly mode: PathMode;
}

/** rlimit 声明位（v1 不强制，沙箱期接 setrlimit/bwrap）。 */
export interface RLimitSpec {
  readonly cpuSeconds?: number | undefined;
  readonly memBytes?: number | undefined;
  readonly nofile?: number | undefined;
}

/**
 * 声明式沙箱档案（D7）。fs.read/fs.write 是工作区内的 glob 前缀白名单；
 * 空数组 = 不额外限缩（仍受工作区包含断言约束）。deny 前缀永远优先于
 * cmd_allow。
 */
export interface SandboxProfile {
  readonly fs: {
    readonly read: readonly string[];
    readonly write: readonly string[];
  };
  /** v1 仅声明；"deny" 时缝拒绝明显外联命令（curl/wget/nc 等）。 */
  readonly net: "allow" | "deny";
  readonly cmd_allow: readonly string[];
  readonly deny: readonly string[];
  readonly rlimit?: RLimitSpec | undefined;
}

/** 一次缝上求值的调用意图。 */
export interface SeamCall {
  readonly tool: string;
  readonly scope: ScopeKey;
  readonly args: Readonly<Record<string, unknown>>;
  readonly isDestructive: boolean;
}

/** 权限规则：match 谓词或 tool 名精确匹配；首命中胜出，deny 优先。 */
export interface SeamPermissionRule {
  readonly name?: string | undefined;
  readonly match: string | ((call: SeamCall) => boolean);
  readonly decision: SeamDecision;
  /** 限定作用域；缺省 = 全作用域生效。 */
  readonly scope?: ScopeKey | undefined;
  readonly reason?: string | undefined;
}

/** 审批解析器：把 "ask" 落成 allow/deny。无人值守 = 不提供 = 拒。 */
export type AskResolver = (call: SeamCall) => boolean | Promise<boolean>;

/** 缝上审计事件（D21 trace 的 tool 级前身）。 */
export interface SeamAuditEvent {
  readonly ts: number;
  readonly scope: ScopeKey;
  readonly tool: string;
  readonly cmd: string;
  readonly cwd: string;
  readonly paths: readonly PathAccess[];
  readonly verdict: "allow" | "deny";
  readonly reason?: string | undefined;
}


/** 审计接收器。executor 只调用，不关心落地方式。 */
export type AuditSink = (event: SeamAuditEvent) => void;

/** 缝拒绝异常：调用方据此区分「被拒」与「执行失败」。 */
export class SeamDeniedError extends Error {
  readonly reason: string;
  readonly kind: "permission" | "sandbox";

  constructor(message: string, kind: "permission" | "sandbox", reason: string) {
    super(message);
    this.name = "SeamDeniedError";
    this.kind = kind;
    this.reason = reason;
  }
}

/** exec 结果（与 BashExecResult 对齐：exitCode=null 表示被信号杀）。 */
export interface SeamExecResult {
  readonly exitCode: number | null;
  readonly output: string;
}

/**
 * exec 的可选第 6 位上下文：不破坏 D7 冻结的 5 位置签名 (cmd,cwd,env,timeout,paths)，
 * 仅补接线细节（tool 身份 / 作用域覆盖 / abort / 流式回调）。
 */
export interface SeamRunCtx {
  readonly tool?: string | undefined;
  readonly isDestructive?: boolean | undefined;
  readonly scope?: ScopeKey | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onData?: ((data: Buffer) => void) | undefined;
}

/** 注入式进程执行回调（seam-process.ts 提供默认实现；测试可注入 fake）。 */
export type ProcessRunner = (
  command: string,
  cwd: string,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutSeconds: number | undefined;
    readonly signal: AbortSignal | undefined;
    readonly onData: (data: Buffer) => void;
  },
) => Promise<SeamExecResult>;

/**
 * 指定 shell 程序（W4，loom.yaml bash.shell 的运行时形状）：
 * program=可执行文件（含完整路径，如 win32 git bash 的 "C:\\Program Files\\Git\\bin\\bash.exe"）；
 * args=command 之前的固定前缀（如 ["--login","-c"]；缺省 = 平台默认注入 ["-c"] / ["/d","/s","/c"]）。
 * 执行 argv = [program, ...args, command]；deny/net 断言仍只看 command。
 */
export interface ShellProgram {
  readonly program: string;
  readonly args?: readonly string[] | undefined;
}

