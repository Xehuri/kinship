// 子进程运行时辅助：解释器选择、环境变量白名单、进程组 kill。
// 思路参考 vendor defaultExec（detached + 负 PID 杀组 + SIGTERM→SIGKILL 升级），
// 代码为 T16 独立实现（T04 worker 正在移植 tools 根文件，避免耦合）。

import type { ChildProcess } from "node:child_process";

import type { Lang } from "./frontmatter.js";

/** 解析后的解释器调用：command + 脚本路径前的固定参数。 */
export interface ResolvedInterpreter {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/** 挂载方可显式覆盖解释器（lang=ts 必须有覆盖，node20 无内置 TS runner）。 */
export interface InterpreterOverride {
  readonly command: string;
  readonly prefixArgs?: readonly string[];
}

/**
 * 语言 -> 解释器映射。TS 返回 undefined：默认运行时没有 TS 执行器
 * （monorepo 明确排除 bun），挂载方需通过 InterpreterOverride 注入（如 tsx）。
 */
export function resolveInterpreter(
  lang: Lang,
  override: InterpreterOverride | undefined,
): ResolvedInterpreter | undefined {
  if (override !== undefined) {
    return { command: override.command, prefixArgs: override.prefixArgs ?? [] };
  }
  switch (lang) {
    case "python":
      return { command: "python3", prefixArgs: [] };
    case "node":
      return { command: "node", prefixArgs: [] };
    case "shell":
      return { command: "sh", prefixArgs: [] };
    case "ts":
      return undefined;
    default: {
      // Lang 联合已穷尽；守卫防未来加语言漏分支。
      return undefined;
    }
  }
}

/**
 * 传给脚本的最小环境变量（正向白名单，而不是密钥黑名单）：
 * 挂载脚本是半信任的旁路进程，只给运行所需，绝不透传任何业务密钥。
 */
export function minimalEnv(
  extra: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TZ"] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }
  return env;
}

/**
 * 杀整进程组（子进程以 detached 启动，自成进程组组长，PID===PGID）。
 * 非 win32 用负 PID 杀组；ESRCH/EPERM 等失败按尽力而为处理：
 * 回退杀单进程，仍失败则忽略（close 事件仍会驱动状态机）。
 */
export function killProcessTree(
  child: Pick<ChildProcess, "pid">,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程已退出：尽力而为。
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程已退出：尽力而为。
    }
  }
}
