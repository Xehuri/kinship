// 子进程传输层：spawn 一条脚本进程并把 stdout/stderr 按行回传。
// 不含任何协议/退避决策（那是 host.ts 的职责），可独立测试。
//
// 进程组：非 win32 用 detached 让子进程自成组长（PID===PGID），terminate()
// 负 PID 杀整组——python 脚本内部再 fork 的孙子进程一并收掉，杜绝孤儿。
// SIGTERM 宽限后升级 SIGKILL，思路参考 vendor defaultExec，实现独立。

import { spawn } from "node:child_process";
import { dirname } from "node:path";

import { killProcessTree, minimalEnv } from "./runtime.js";
import type { ChildHandle, ChildHandlers } from "./types.js";

/** 行分割器：push 喂 chunk，flush 在流关闭时冲刷无换行的残段。 */
interface LineSplitter {
  push(chunk: string): void;
  flush(): void;
}

function makeLineSplitter(onLine: (line: string) => void): LineSplitter {
  let buffer = "";
  return {
    push(chunk: string): void {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
        idx = buffer.indexOf("\n");
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        const rest = buffer;
        buffer = "";
        onLine(rest);
      }
    },
  };
}

export interface LaunchSpec {
  readonly command: string;
  readonly scriptPath: string;
  readonly prefixArgs: readonly string[];
  readonly extraEnv: NodeJS.ProcessEnv | undefined;
}

/** 拉起一条脚本子进程，返回句柄；事件经 handlers 回传（纯传输，不决策）。 */
export function launchChild(spec: LaunchSpec, handlers: ChildHandlers): ChildHandle {
  const child = spawn(spec.command, [...spec.prefixArgs, spec.scriptPath], {
    cwd: dirname(spec.scriptPath),
    env: minimalEnv(spec.extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  if (child.pid !== undefined) {
    handlers.onLaunch(child.pid);
  }

  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    const splitter = makeLineSplitter(handlers.onStdoutLine);
    child.stdout.on("data", (chunk: string) => splitter.push(chunk));
    child.stdout.on("end", () => splitter.flush());
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    const splitter = makeLineSplitter(handlers.onStderrLine);
    child.stderr.on("data", (chunk: string) => splitter.push(chunk));
  }

  let exitReported = false;
  const reportExit = (why: { code: number | null; signal: NodeJS.Signals | null }): void => {
    if (exitReported) return;
    exitReported = true;
    handlers.onExit(why);
  };

  child.on("error", (err) => {
    handlers.onError(err);
    reportExit({ code: null, signal: null });
  });
  child.on("exit", (code, signal) => {
    reportExit({ code: code ?? null, signal });
  });

  return {
    pid: child.pid,
    terminate(graceMs: number): void {
      killProcessTree(child, "SIGTERM");
      const killer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, graceMs);
      killer.unref();
      child.on("exit", () => clearTimeout(killer));
    },
  };
}
