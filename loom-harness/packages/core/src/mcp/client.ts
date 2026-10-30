/**
 * T23 —— MCP stdio 客户端。
 *
 * 生命周期：start(spec) spawn 子进程并完成 initialize 握手
 * （initialize → initialized 通知），随后 listTools/callTool 走请求 id 关联的
 * JSON-RPC；close() 幂等、保证无孤儿进程。stderr 按行透传给 onStderr。
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  McpClosedError,
  McpError,
  McpProcessExitedError,
  McpProtocolError,
  McpRpcError,
  McpSpawnError,
  McpTimeoutError,
} from "./errors.js";
import {
  decodeServerInfo,
  decodeToolCallResult,
  decodeTools,
  encodeNotification,
  encodeRequest,
  splitLines,
  tryParseResponse,
  type RequestId,
} from "./protocol.js";
import type {
  McpClientOptions,
  McpServerInfo,
  McpServerSpec,
  McpToolCallResult,
  McpToolInfo,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: McpError) => void;
  timer: NodeJS.Timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** MCP stdio 客户端：一个实例 = 一个子进程会话。 */
export class McpClient {
  readonly #requestTimeoutMs: number;
  readonly #onStderr: ((line: string) => void) | undefined;
  #child: Child;
  #serverInfo: McpServerInfo = { name: "unknown" };
  #stdinBuf = "";
  #nextId = 1;
  #pending = new Map<RequestId, Pending>();
  #exitError: McpProcessExitedError | undefined;
  #closed = false;
  #exitObserved = false;

  static async start(spec: McpServerSpec, options?: McpClientOptions): Promise<McpClient> {
    const client = new McpClient(spec, options);
    try {
      await client.#handshake();
    } catch (e: unknown) {
      // 握手失败也要收尸，不留孤儿。
      await client.close();
      throw e;
    }
    return client;
  }

  private constructor(spec: McpServerSpec, options?: McpClientOptions) {
    this.#requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#onStderr = options?.onStderr;
    const args = spec.args === undefined ? [] : [...spec.args];
    const env =
      spec.env === undefined
        ? { ...process.env }
        : { ...process.env, ...spec.env };
    this.#child = spawn(spec.cmd, args, {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    // 子进程死后对 stdin 的在途 write 会异步抛 EPIPE；退出/关闭路径已由
    // exit 事件 failAll 覆盖，这里吞掉流级错误避免 uncaughtException。
    this.#child.stdin.on("error", () => {});
    this.#child.stdout.on("data", (chunk: string) => {
      this.#onStdoutChunk(chunk);
    });
    this.#child.stderr.on("data", (chunk: string) => {
      this.#onStderrChunk(chunk);
    });
    this.#child.on("error", (err: Error) => {
      // spawn 失败（ENOENT 等）时 exit 事件可能不来，直接标记进程已终结，
      // 避免 close() 对不存在的 pid 空等宽限。
      this.#exitObserved = true;
      this.#failAll(new McpSpawnError(spec.cmd, err));
    });
    this.#child.on("exit", (code, signal) => {
      this.#exitObserved = true;
      if (this.#exitError === undefined) {
        this.#exitError = new McpProcessExitedError(code, signal);
      }
      if (!this.#closed) {
        this.#failAll(this.#exitError);
      }
    });
  }

  /** initialize 握手后拿到的对端信息。 */
  get serverInfo(): McpServerInfo {
    return this.#serverInfo;
  }

  /** 子进程 PID（close/死亡后仍可读，供测试与运维确认无孤儿）。 */
  get pid(): number | undefined {
    return this.#child.pid;
  }

  /** tools/list：返回全部工具描述。 */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.#request("tools/list", {});
    return decodeTools(result);
  }

  /** tools/call：协议层成功即返回；工具内失败由 result.isError 表达（合约同 HarnessTool）。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.#request("tools/call", { name, arguments: args });
    return decodeToolCallResult(result);
  }

  /** 幂等关闭：拒新请求 → 关 stdin → SIGTERM → 宽限后 SIGKILL。 */
  async close(): Promise<void> {
    if (this.#closed) {
      if (this.#child.exitCode === null && !this.#exitObserved) {
        await sleep(KILL_GRACE_MS);
      }
      return;
    }
    this.#closed = true;
    const closeErr = new McpClosedError("close() called");
    this.#failAll(closeErr);
    const child = this.#child;
    if (child.exitCode === null && !this.#exitObserved) {
      child.stdin.destroy();
      child.kill("SIGTERM");
      const deadline = Date.now() + KILL_GRACE_MS;
      while (child.exitCode === null && !this.#exitObserved && Date.now() < deadline) {
        await sleep(20);
      }
      if (child.exitCode === null && !this.#exitObserved) {
        child.kill("SIGKILL");
        const hard = Date.now() + KILL_GRACE_MS;
        while (child.exitCode === null && !this.#exitObserved && Date.now() < hard) {
          await sleep(20);
        }
      }
    }
  }

  async #handshake(): Promise<void> {
    const result = await this.#request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "axeuh-loom-mcp-client", version: "0.0.0" },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    this.#serverInfo = decodeServerInfo(result);
    this.#writeLine(encodeNotification("notifications/initialized"));
  }

  #request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new McpClosedError(method));
    }
    if (this.#exitError !== undefined) {
      return Promise.reject(this.#exitError);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const limit = timeoutMs ?? this.#requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpTimeoutError(method, id, limit));
      }, limit);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#writeLine(encodeRequest(id, method, params));
      } catch (e: unknown) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof McpError ? e : new McpProtocolError(String(e)));
      }
    });
  }

  #writeLine(frame: string): void {
    if (this.#child.stdin.destroyed || this.#child.stdin.writableEnded) {
      throw new McpClosedError("stdin closed");
    }
    this.#child.stdin.write(frame);
  }

  #onStdoutChunk(chunk: string): void {
    this.#stdinBuf += chunk;
    if (this.#stdinBuf.length > 16 * 1024 * 1024) {
      this.#failAll(new McpProtocolError("stdout buffer exceeded 16MiB (framing broken?)"));
      this.#stdinBuf = "";
      return;
    }
    const { lines, rest } = splitLines(this.#stdinBuf);
    this.#stdinBuf = rest;
    for (const line of lines) {
      let frame: ReturnType<typeof tryParseResponse>;
      try {
        frame = tryParseResponse(line);
      } catch (e: unknown) {
        // 任何解析失败都视为协议违规，让全部在途请求带错终止。
        this.#failAll(
          e instanceof McpProtocolError ? e : new McpProtocolError(String(e)),
        );
        return;
      }
      if (frame === undefined) continue; // 通知/无关帧：v1 忽略
      const p = this.#pending.get(frame.id);
      if (p === undefined) continue; // 已超时的迟到响应：丢弃
      this.#pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error !== undefined) {
        p.reject(
          new McpRpcError(p.method, frame.id, frame.error.code, frame.error.message, frame.error.data),
        );
      } else {
        p.resolve(frame.result);
      }
    }
  }

  #onStderrChunk(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.#onStderr?.(line);
    }
  }

  #failAll(err: McpError): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }
}
