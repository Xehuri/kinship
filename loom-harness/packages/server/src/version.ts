/**
 * 版本解析：systemd 注入的 LOOM_VERSION 优先；缺失时读构建期生成的
 * 仓库根 VERSION（scripts/write-version.mjs 在 npm run build 末尾写入）。
 *
 * 为什么需要 fallback：生产 Loom 由 systemd 托管，但版本注入需要 root
 * drop-in；构建期 VERSION 让同一份可复现构建在无 root 的环境也能报告
 * 发布 SHA。systemd 环境变量仍优先，后续写入 drop-in 不会冲突。
 */

import { readFileSync } from "node:fs";

const DEFAULT_VERSION = "0.0.0-dev";

export function resolveLoomVersion(
  env: NodeJS.ProcessEnv = process.env,
  versionUrl: URL = new URL("../../../VERSION", import.meta.url),
): string {
  const fromEnv = env["LOOM_VERSION"]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const fromFile = readFileSync(versionUrl, "utf8").trim();
    return fromFile || DEFAULT_VERSION;
  } catch {
    return DEFAULT_VERSION;
  }
}
