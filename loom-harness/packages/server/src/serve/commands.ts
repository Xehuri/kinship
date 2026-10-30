// T31 serve 装配 —— CLI 参数解析（纯函数，无副作用；退出码口径由 cli.ts 落地）。
// 口径（任务冻结 + docs/02 §T31）：
//   - `loom serve [--port N] [--hostname H] [--config PATH]`
//   - `loom runs|trace|doctor` = 子命令桩（至少注册，深度实现归后续任务）
//   - 未知命令 / 参数畸形 → UsageError（退出码 2，与 grep/getopts 惯例一致）
//   - --port 必须为 ≥5097 的整数（D32：5096/8768/8769/18888 为现网禁碰端口）

import { MIN_PORT } from "../config/section-checks.js";

/** 解析产物：命令 + 该命令的已校验选项。 */
export type ParsedCommand =
  | {
      readonly kind: "serve";
      readonly port: number | null; // null = 未显式给定，回落 loom.yaml server.port
      readonly hostname: string | null; // null = 回落 loom.yaml server.hostname
      readonly config: string | null; // null = 回落 LOOM_CONFIG / 仓库缺省
    }
  | { readonly kind: "stub"; readonly name: StubCommand };

export const STUB_COMMANDS = ["runs", "trace", "doctor"] as const;
export type StubCommand = (typeof STUB_COMMANDS)[number];

/** 用法/参数错误（cli.ts 映射为退出码 2）。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = [
  "用法：loom serve [--port N] [--hostname H] [--config PATH]",
  `      （--port 必须 ≥${MIN_PORT}；5096/8768/8769/18888 为现网端口，禁止占用——D32）`,
  "      loom runs | loom trace | loom doctor   （子命令桩，接线归后续任务）",
  "环境变量：LOOM_CONFIG 配置路径 / LOOM_TOKEN 服务令牌 / LOOM_STATE state 根",
  "          LOOM_INSTANCE 实例根（运行数据与配置住 <实例根>/.loom/；W27）",
  "          LOOM_FAKE_MODEL=1 强制假模型（离线开发/冒烟）",
].join("\n");

function parsePortFlag(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--port 需要整数，实际为 "${value}"`);
  }
  const port = Number(value);
  if (port < MIN_PORT || port > 65535) {
    throw new UsageError(`--port 必须在 ${MIN_PORT}–65535（D32 下限 ${MIN_PORT}），实际为 ${value}`);
  }
  return port;
}

/** 解析 serve 的旗标序列（serve 之后的全部参数）。 */
function parseServeFlags(rest: readonly string[]): ParsedCommand {
  const queue = [...rest];
  const seen = new Set<string>();
  let port: number | null = null;
  let hostname: string | null = null;
  let config: string | null = null;

  while (queue.length > 0) {
    const flag = queue.shift() ?? "";
    if (seen.has(flag)) throw new UsageError(`${flag} 重复给定`);
    const takeValue = (): string => {
      const v = queue.shift();
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} 缺少值`);
      return v;
    };
    seen.add(flag);
    switch (flag) {
      case "--port":
        port = parsePortFlag(takeValue());
        break;
      case "--hostname":
        hostname = takeValue();
        break;
      case "--config":
        config = takeValue();
        break;
      default:
        throw new UsageError(`未知选项：${flag}`);
    }
  }
  return { kind: "serve", port, hostname, config };
}

/**
 * 解析命令行（argv.slice(2) 口径）。空命令 = 用法错误（2），绝不静默起服务。
 * 首参数即子命令判别位：serve → 旗标解析；stub 名 → 桩；其余 → UsageError。
 */
export function parseArgs(args: readonly string[]): ParsedCommand {
  const head = args[0];
  if (head === undefined) {
    throw new UsageError("缺少子命令");
  }
  switch (head) {
    case "serve":
      return parseServeFlags(args.slice(1));
    case "runs":
    case "trace":
    case "doctor":
      return { kind: "stub", name: head };
    default:
      throw new UsageError(`未知命令：${head}`);
  }
}
