/**
 * PTY 子进程环境净化。
 *
 * pty-manager 起 shell 时不能把本机服务/凭据变量（LOOM_/AXEUH_/OPENCODE_/MI_/MOP_
 * 前缀与密钥类键名）带进终端会话；这里复用 seam 的 safeShellEnv 密钥策略，再叠一层
 * 前缀剥离。extra 是调用方显式追加的环境（如 TERM/COLORTERM），同样受约束。
 */

import { safeShellEnv } from "../seam/index.js";

const BLOCKED_KEY = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const BLOCKED_PREFIXES = ["LOOM_", "AXEUH_", "OPENCODE_", "MI_", "MOP_"] as const;

function isBlocked(key: string): boolean {
  return BLOCKED_KEY.test(key) || BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** PTY 子进程环境：先套用 seam safeShellEnv，再剥离本机服务/凭据前缀；extra 中的键同样受约束。 */
export function scrubPtyEnv(
  extra?: Readonly<Record<string, string>>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // safeShellEnv 只读 process.env；显式 base 时按同一正则就地过滤，绝不改调用方对象。
  const source = base === process.env ? safeShellEnv() : base;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (isBlocked(key)) continue;
    env[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (isBlocked(key)) continue;
      env[key] = value;
    }
  }
  return env;
}
