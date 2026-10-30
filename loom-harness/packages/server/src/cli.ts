/**
 * loom CLI 入口（T31 接管：占位 main → 真实现）。
 *
 * 子命令（docs/01 §15 命名表 / docs/02 §T31）：
 *   loom serve [--port N] [--hostname H] [--config PATH]  —— 起全栈服务（假模型离线可跑）
 *   loom runs | trace | doctor                             —— 桩：注册且明示状态，接线归后续任务
 *
 * 退出码（任务冻结）：
 *   0  = serve 正常停机（SIGTERM/SIGINT 排水完毕）或桩命令
 *   1  = 运行期失败（配置缺失/校验不过/端口占用/真 provider 未接线/无令牌）
 *   2  = 用法错误（未知命令、--port < 5097、旗标畸形）
 *
 * 凭据纪律：本文件绝不打印/落盘任何 resolved 密钥值（日志只出端口/host 等部署事实）。
 */

import { pathToFileURL } from "node:url";

import { LoomConfigError } from "./config/loom-config.js";
import { resolveLoomVersion } from "./version.js";
import { runPlanCli } from "./serve/plan-cli.js";
import {
  ConfigFileMissingError,
  InstanceConfigMissingError,
  RealProviderNotWiredError,
  ServeCredentialMissingError,
  TokenMissingError,
  UsageError,
  loadServeConfig,
  parseArgs,
  resolveConfigPath,
  resolveServeTokens,
  resolveStateRootFromEnv,
  serveLoom,
  USAGE,
  type ParsedCommand,
  type ServeLog,
} from "./serve/index.js";

const log: ServeLog = (level, msg, fields) => {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

function assertNever(x: never): never {
  throw new Error(`unhandled command: ${JSON.stringify(x)}`);
}

/** serve 主流程：装配 → 监听 → 停机排水完成返回 0。运行期失败原样抛给 main 映射退出码。 */
async function runServe(command: Extract<ParsedCommand, { kind: "serve" }>): Promise<number> {
  // W27 实例化：LOOM_INSTANCE 设了但 .loom/config.yaml 不在 → InstanceConfigMissingError
  // 响亮炸（部署错误绝不静默起在 legacy 路径上）；回落 legacy 缺省打一行 warn 说实话。
  const configPath = resolveConfigPath(command.config ?? undefined, process.env, (msg) => {
    log("warn", msg, {});
  });
  const stateRoot = resolveStateRootFromEnv(process.env);
  const tokens = resolveServeTokens(process.env);
  const { config, store } = loadServeConfig({ configPath, stateRoot });

  // 监听参数：CLI 显式 > loom.yaml（schema 已保证 ≥5097，D32）。
  const port = command.port ?? config.server.port;
  const hostname = command.hostname ?? config.server.hostname;
  const version = resolveLoomVersion(process.env);

  const handle = await serveLoom({
    config,
    store,
    stateRoot,
    tokens,
    version,
    port,
    hostname,
    log,
    // W17-B：configPath 解析真源在 cli（库层不猜配置文件取址，供 manifest.configPath）。
    configPath,
  });
  log("info", "loom serve ready", { url: `http://${handle.hostname}:${handle.port}` });
  await handle.closed; // SIGTERM/SIGINT 排水完成后 resolve
  return 0;
}

/** 端口占用等 node 网络错误（code 判别，不猜 message）。 */
function isAddrInUse(err: unknown): err is Error {
  return err instanceof Error && (err as { code?: unknown }).code === "EADDRINUSE";
}

/** 运行期错误 → 人话 + 退出码 1；未识别错误返回 null（照常上抛暴露为 bug 而非吞掉）。 */
function toExitOne(err: unknown): number | null {
  if (
    err instanceof ConfigFileMissingError ||
    // W27：实例配置缺失同为部署错误（硬失败纪律），退出码 1 走人话通道。
    err instanceof InstanceConfigMissingError ||
    err instanceof LoomConfigError ||
    err instanceof RealProviderNotWiredError ||
    err instanceof ServeCredentialMissingError ||
    err instanceof TokenMissingError
  ) {
    console.error(err.message);
    return 1;
  }
  if (isAddrInUse(err)) {
    console.error(`端口占用：${err.message}（换端口；D32 禁碰 5096/8768/8769/18888）`);
    return 1;
  }
  return null;
}

export async function main(args: readonly string[]): Promise<number> {
  // plan 子命令独立解析（不进 serve 的 ParsedCommand 联合），其余命令保持原样。
  if (args[0] === "plan") {
    return runPlanCli(args.slice(1));
  }
  let command: ParsedCommand;
  try {
    command = parseArgs(args);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  switch (command.kind) {
    case "serve": {
      try {
        return await runServe(command);
      } catch (err) {
        const mapped = toExitOne(err);
        if (mapped !== null) return mapped;
        log("error", "loom serve failed", { error: err instanceof Error ? err.message : String(err) });
        return 1;
      }
    }
    case "stub":
      console.log(`loom ${command.name}: 桩命令（接线归后续任务，见 docs/02；serve 已就绪）`);
      return 0;
    default:
      return assertNever(command);
  }
}

// 直接运行时执行（被 import 时不自动跑——测试/复用方走 main()）。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exitCode = 1;
    });
}
