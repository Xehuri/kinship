/**
 * T09 生产覆盖校验绑定：把脚本层 `check_coverage.py` 的退出码翻译成
 * plan 工具（T07）与检查点执行器共用的类型化结果。
 *
 * 边界：
 *   - 只负责「日期 -> 进程 -> 结果」；不读 plan、不写 flow、不派发任何后续动作；
 *   - 退出码是唯一真源：0=pass、1=gap、2=no_data，其余/信号/超时/启动失败=error；
 *   - 任何失败都折叠成 `{ ok, status, exitCode, summary }` 返回，绝不向调用方抛异常；
 *   - `verify(input)` 与 T07 `PlanCoverageVerifier` 同形，`check(date)` 是检查点
 *     执行器使用的日期直调面（同一个实现，不产生第二套判定）。
 */

import { spawn as nodeSpawn } from "node:child_process";

import type {
  PlanCoverageVerification,
  PlanCoverageVerificationInput,
  PlanCoverageVerifier,
} from "./plan-overlay-tool.js";

export type CoverageVerifyStatus = "pass" | "gap" | "no_data" | "error";

/** 结果四元组；`ok` 只在 pass 时为 true，供 T07 的 done 门直接消费。 */
export interface CoverageVerifyResult extends PlanCoverageVerification {
  readonly status: CoverageVerifyStatus;
  readonly exitCode: number | null;
  readonly summary: string;
}

/** 子进程 stdout/stderr 的最小订阅面；Node `Readable` 天然满足。 */
export interface CoverageEventStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/** 注入缝：默认实现包 `node:child_process.spawn`，测试用 EventEmitter 假进程。 */
export interface CoverageChildProcess {
  readonly stdout: CoverageEventStream | null;
  readonly stderr: CoverageEventStream | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type CoverageSpawn = (
  command: string,
  args: readonly string[],
) => CoverageChildProcess;

export interface CoverageVerifierOptions {
  readonly pythonBin: string;
  readonly scriptPath: string;
  /** 缺省 30000ms；<=0 或非有限值表示不设超时。 */
  readonly timeoutMs?: number;
  readonly spawn?: CoverageSpawn;
}

/**
 * T07 兼容面 + 执行器直调面。
 * `verify` 的参数/返回都收窄为 T07 契约的子类型，因此可直接注入
 * `PlanOverlayToolOptions.verifier`，不需要任何断言。
 */
export interface CoverageVerifier extends PlanCoverageVerifier {
  verify(input: PlanCoverageVerificationInput): Promise<CoverageVerifyResult>;
  check(date: string): Promise<CoverageVerifyResult>;
}

export const DEFAULT_COVERAGE_TIMEOUT_MS = 30_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OUTPUT_LIMIT = 4_096;

const defaultSpawn: CoverageSpawn = (command, args) =>
  nodeSpawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusForExit(code: number | null): CoverageVerifyStatus {
  switch (code) {
    case 0:
      return "pass";
    case 1:
      return "gap";
    case 2:
      return "no_data";
    default:
      return "error";
  }
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line !== undefined && line !== "") return line;
  }
  return undefined;
}

function summaryFor(
  status: CoverageVerifyStatus,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  const line = lastNonEmptyLine(stdout) ?? lastNonEmptyLine(stderr);
  if (line !== undefined) return line;
  const code = exitCode === null ? "null" : String(exitCode);
  return status === "error"
    ? `check_coverage error (exit ${code})`
    : `check_coverage exit ${code}`;
}

function verificationResult(
  status: CoverageVerifyStatus,
  exitCode: number | null,
  summary: string,
): CoverageVerifyResult {
  return { ok: status === "pass", status, exitCode, summary };
}

function runCoverageCheck(
  options: {
    readonly pythonBin: string;
    readonly scriptPath: string;
    readonly timeoutMs: number;
    readonly spawn: CoverageSpawn;
  },
  date: string,
): Promise<CoverageVerifyResult> {
  if (options.pythonBin.trim() === "" || options.scriptPath.trim() === "") {
    return Promise.resolve(
      verificationResult("error", null, "check_coverage 未配置 pythonBin/scriptPath"),
    );
  }
  if (!DATE_RE.test(date)) {
    return Promise.resolve(
      verificationResult("error", null, `check_coverage 非法日期: ${date}`),
    );
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CoverageVerifyResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let child: CoverageChildProcess;
    try {
      child = options.spawn(options.pythonBin, [options.scriptPath, date]);
    } catch (error) {
      finish(
        verificationResult(
          "error",
          null,
          `check_coverage spawn error: ${errorText(error)}`,
        ),
      );
      return;
    }

    const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (target === "stdout") stdout = (stdout + text).slice(-OUTPUT_LIMIT);
      else stderr = (stderr + text).slice(-OUTPUT_LIMIT);
    };

    try {
      child.stdout?.on("data", (chunk) => append("stdout", chunk));
      child.stderr?.on("data", (chunk) => append("stderr", chunk));
      child.on("error", (error) => {
        finish(
          verificationResult(
            "error",
            null,
            `check_coverage spawn error: ${error.message}`,
          ),
        );
      });
      child.on("close", (code, signal) => {
        const status = statusForExit(code);
        const summary =
          code === null
            ? `check_coverage terminated by ${signal ?? "signal"}`
            : summaryFor(status, code, stdout, stderr);
        finish(verificationResult(status, code, summary));
      });
      if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // 进程可能已退出；超时结论不依赖 kill 是否成功。
          }
          finish(
            verificationResult(
              "error",
              null,
              `check_coverage timeout after ${options.timeoutMs}ms`,
            ),
          );
        }, options.timeoutMs);
      }
    } catch (error) {
      finish(
        verificationResult(
          "error",
          null,
          `check_coverage spawn error: ${errorText(error)}`,
        ),
      );
    }
  });
}

export function createCoverageVerifier(
  options: CoverageVerifierOptions,
): CoverageVerifier {
  const runtime = {
    pythonBin: options.pythonBin,
    scriptPath: options.scriptPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_COVERAGE_TIMEOUT_MS,
    spawn: options.spawn ?? defaultSpawn,
  };
  return {
    verify: (input) => runCoverageCheck(runtime, input.date),
    check: (date) => runCoverageCheck(runtime, date),
  };
}
