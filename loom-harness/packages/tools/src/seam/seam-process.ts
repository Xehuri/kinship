/**
 * 唯一 child_process 落点（T22，D7；W4 起支持配置指定 shell 程序）。
 *
 * 契约：packages/tools/src 下除本文件外，任何工具/包装代码都不得 import
 * `node:child_process`。executor.ts 是这里 runner 的唯一消费方；
 * 工具经 ToolExecutor.exec 间接起进程，无法绕过缝上的权限/沙箱/审计。
 *
 * 实现镜像 tools 根 index.ts 的 `defaultExec`（vendor 移植，T04）：
 * detached 进程组 + SIGTERM→1.5s→SIGKILL 升级 + timeout/abort 双通道。
 * 不复用 defaultExec 本体原因：它是 BashOperations.exec（onData 流式契约），
 * 且是 index.ts 私有函数不可 import；本文件是缝的语义等价实现。
 *
 * W4 变更（有意升级，须随版本报告）：spawn 从 `shell:true`（POSIX 隐式
 * /bin/sh -c、win32 隐式 ComSpec /d /s /c）改为显式 `spawn(program, [...args, command])`，
 * 缺省 program：**POSIX 由 sh 升 /bin/bash**（args 缺省补 ["-c"]）；win32 保持
 * ComSpec ?? "cmd.exe" + ["/d","/s","/c"] 语义不变。loom.yaml bash.shell 可全量指定
 * （如 win32 git bash：program="C:\\Program Files\\Git\\bin\\bash.exe", args=["--login","-c"]）。
 * 进程组 kill/detached/超时/截断口径一律不动。
 */

import { spawn } from "node:child_process";
import type { ProcessRunner, SeamExecResult, ShellProgram } from "./types.js";

export interface RunProcessOptions {
  readonly env: NodeJS.ProcessEnv;
  /** 秒；undefined/<=0 = 不限时。 */
  readonly timeoutSeconds: number | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onData: (data: Buffer) => void;
}

/** bashSpawnPlan 的产出：argv 头部（command 由 runner 追加在末尾）。 */
export interface ShellSpawnPlan {
  readonly program: string;
  readonly argvHead: readonly string[];
}

/**
 * 纯函数 argv 组装（平台/ComSpec 参数化 → win32 分支可穷尽单测，不必真起进程）。
 * 显式 spec 全量接管 args 前缀（不自动补 -c：git bash ["--login","-c"] 这类
 * 组合由声明者自己负责，缝不做二次猜测）。
 */
export function bashSpawnPlan(
  spec: ShellProgram | undefined,
  platform: NodeJS.Platform,
  comSpec: string | undefined,
): ShellSpawnPlan {
  if (spec !== undefined) {
    return { program: spec.program, argvHead: [...(spec.args ?? [])] };
  }
  if (platform === "win32") {
    // 与 node shell:true 的 win32 内置口径逐字节一致（ComSpec 优先，缺省 cmd.exe）。
    return { program: comSpec ?? "cmd.exe", argvHead: ["/d", "/s", "/c"] };
  }
  return { program: "/bin/bash", argvHead: ["-c"] };
}

/** 造一个进程 runner：shell 程序编入闭包（executor 构造期接线；缺省 = 平台默认）。 */
export function makeProcessRunner(shell?: ShellProgram): ProcessRunner {
  return (command, cwd, options) => runProcessWithShell(command, cwd, options, shell);
}

export function runProcess(
  command: string,
  cwd: string,
  options: RunProcessOptions,
): Promise<SeamExecResult> {
  return runProcessWithShell(command, cwd, options, undefined);
}

function runProcessWithShell(
  command: string,
  cwd: string,
  options: RunProcessOptions,
  shell: ShellProgram | undefined,
): Promise<SeamExecResult> {
  const plan = bashSpawnPlan(shell, process.platform, process.env.ComSpec);
  return new Promise((resolve, reject) => {
    let settled = false;
    let termination: "abort" | "timeout" | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const child = spawn(plan.program, [...plan.argvHead, command], {
      cwd,
      // 进程组 kill 口径不动：POSIX detached 组领导、win32 单 PID（killProcessGroup 分支）。
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (rejectTimer) clearTimeout(rejectTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const terminate = (reason: "abort" | "timeout"): void => {
      if (settled) return;
      termination ??= reason;
      killProcessGroup(child.pid, "SIGTERM");
      killTimer ??= setTimeout(() => {
        killProcessGroup(child.pid, "SIGKILL");
      }, 1_500);
      rejectTimer ??= setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              termination === "timeout" ? `timeout:${options.timeoutSeconds}` : "aborted",
            ),
          ),
        );
      }, 5_000);
    };
    timeoutTimer =
      options.timeoutSeconds === undefined || options.timeoutSeconds <= 0
        ? undefined
        : setTimeout(() => {
            terminate("timeout");
          }, options.timeoutSeconds * 1_000);
    const onAbort = (): void => {
      terminate("abort");
    };
    if (options.signal?.aborted) {
      terminate("abort");
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    const push = (data: Buffer): void => {
      chunks.push(data);
      options.onData(data);
    };
    child.stdout?.on("data", (chunk: Buffer) => push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => push(chunk));
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      finish(() => {
        if (termination === "abort") reject(new Error("aborted"));
        else if (termination === "timeout") reject(new Error(`timeout:${options.timeoutSeconds}`));
        else resolve({ exitCode: code, output: Buffer.concat(chunks).toString("utf8") });
      });
    });
  });
}

/** 进程组 kill（win32 退回单 PID；best effort，与 vendor defaultExec 一致）。 */
function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // best effort
    }
  }
}
