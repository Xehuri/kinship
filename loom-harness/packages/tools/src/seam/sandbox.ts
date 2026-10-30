/**
 * SandboxProfile v1 强制（T22，D7「v1 实现=chdir+路径断言」）。
 *
 * 朴素但**真拒绝**：
 *   1. chdir —— 子进程 cwd 必须是工作区内 realpath（工作区外 cwd 直接拒）。
 *   2. 路径包含断言 —— 每个声明路径先 normalize 解析（拒 `../` 逃逸与绝对路径
 *      逃逸），再取最近存在祖先的 realpath（拒 symlink 逃逸），断言落在工作区
 *      realpath 内；若 profile 给了 fs.read/fs.write 白名单，还须匹配前缀/glob。
 *   3. 命令断言 —— deny 前缀优先；cmd_allow 非空时白名单外一律拒（default-deny）。
 *   4. net 断言 —— profile.net==="deny" 时拒明显外联命令（curl/wget/nc…）。
 *
 * rlimit 仅声明不强制；沙箱期换 bubblewrap/容器时本模块整体替换、上层签名零改动。
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { globToRegExp, hasGlobMagic, normalizeDisplayPath } from "../path-utils.js";
import { SeamDeniedError } from "./types.js";
import type { PathAccess, PathMode, SandboxProfile } from "./types.js";

/** 工作区根（绝对路径，建议传 realpath 结果）。 */
export type WorkspaceRoot = string;

/** 断言通过的路径：绝对 + 已解析 symlink 的真实路径。 */
export interface CheckedPath {
  readonly input: string;
  readonly absolute: string;
  readonly real: string;
  readonly mode: PathMode;
}

function deny(reason: string): never {
  throw new SeamDeniedError(`sandbox: ${reason}`, "sandbox", reason);
}

/** real 是否落在 rootReal 内（相等或为其后代）。 */
function isInside(rootReal: string, real: string): boolean {
  const rel = path.relative(rootReal, real);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 工作区根的 realpath（symlink 化的工作区本身也先落地）。 */
export function realWorkspaceRoot(root: WorkspaceRoot): string {
  return realpathSync.native(root);
}

/**
 * cwd 断言：必须解析到工作区内，返回其 realpath（spawn 的 chdir 目标）。
 * `../`、绝对路径、symlink 逃逸全部拒绝。
 */
export function assertCwdInsideWorkspace(rootReal: string, cwd: string): string {
  const absolute = path.resolve(rootReal, cwd);
  const real = realOfPath(absolute);
  if (!isInside(rootReal, real)) {
    deny(`cwd escapes workspace: ${cwd}`);
  }
  return real;
}

/**
 * 路径断言：解析 + 包含检查 + profile 白名单检查。返回 CheckedPath。
 *
 * - 先 path.resolve 拒掉字面 `../` 逃逸与工作区外绝对路径；
 * - 再取最近存在祖先 realpath 拒 symlink 逃逸（祖先本身在工作区内、
 *   其后代经 symlink 指向外部同样拒）；
 * - fs.write 白名单为空数组时视为「工作区内可写」；非空时须匹配某条
 *   前缀或 glob（相对工作区根、POSIX 分隔符）。
 */
export function assertPathAccess(
  rootReal: string,
  cwdReal: string,
  access: PathAccess,
  profile: SandboxProfile,
): CheckedPath {
  const absolute = path.resolve(cwdReal, access.path);
  const real = realOfPath(absolute);
  if (!isInside(rootReal, real)) {
    deny(`path escapes workspace: ${access.path}`);
  }

  if (!matchesFsAllowlist(rootReal, real, access.mode, profile)) {
    deny(
      `path not in profile fs.${access.mode} allowlist: ${normalizeDisplayPath(path.relative(rootReal, real))}`,
    );
  }
  return { input: access.path, absolute, real, mode: access.mode };
}

/**
 * 目标的真实路径：最近存在祖先 realpath + 相对祖先的 remainder 组合
 * （与 path-utils.isPathInsideReal 同法；symlink 逃逸——祖先在工作区内、
 * 祖先本身是 symlink 指向外部——同样在此暴露）。
 */
function realOfPath(target: string): string {
  let current = target;
  for (;;) {
    let currentReal: string;
    try {
      currentReal = realpathSync.native(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        deny(`cannot resolve real path for ${target}`);
      }
      current = parent;
      continue;
    }
    const remainder = path.relative(current, target);
    return remainder ? path.resolve(currentReal, remainder) : currentReal;
  }
}

function matchesFsAllowlist(
  rootReal: string,
  real: string,
  mode: PathMode,
  profile: SandboxProfile,
): boolean {
  const patterns = mode === "read" ? profile.fs.read : profile.fs.write;
  if (patterns.length === 0) return true; // 空 = 不额外限缩（仍受工作区约束）
  const rel = normalizeDisplayPath(path.relative(rootReal, real));
  return patterns.some((pattern) => matchPattern(pattern, rel));
}

function matchPattern(pattern: string, rel: string): boolean {
  const norm = normalizeDisplayPath(pattern);
  if (hasGlobMagic(norm)) {
    const regex = globToRegExp(norm.endsWith("/") ? `${norm}**` : norm);
    if (regex.test(rel)) return true;
    // 目录语义：src/** 应覆盖 src 下所有后代（globToRegExp 的 `**/` 已处理），
    // 再试「祖先逐层」匹配 pattern 以目录前缀命中。
    return relAncestors(rel).some((anc) => regex.test(anc));
  }
  const prefix = norm.replace(/\/+$/, "");
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

function relAncestors(rel: string): string[] {
  const parts = rel.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

const NET_DENY_CMDS: readonly string[] = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "http",
  "https",
];

/** 命令断言：deny 前缀优先 → cmd_allow 白名单（非空即 default-deny）→ net 声明。 */
export function assertCommand(command: string, profile: SandboxProfile): void {
  const trimmed = command.trim();
  const firstWord = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();

  for (const deniedPrefix of profile.deny) {
    if (startsWithPrefix(trimmed, deniedPrefix)) {
      deny(`command denied by profile: ${command.slice(0, 120)}`);
    }
  }
  if (profile.cmd_allow.length > 0) {
    const allowed = profile.cmd_allow.some((prefix) =>
      startsWithPrefix(trimmed, prefix),
    );
    if (!allowed) {
      deny(`command not in profile cmd_allow: ${command.slice(0, 120)}`);
    }
  }
  if (profile.net === "deny" && NET_DENY_CMDS.includes(firstWord)) {
    deny(`network egress denied by profile (net:"deny"): ${firstWord}`);
  }
}

function startsWithPrefix(haystack: string, prefix: string): boolean {
  const p = prefix.trim();
  if (p.length === 0) return false;
  if (!haystack.toLowerCase().startsWith(p.toLowerCase())) return false;
  const rest = haystack.slice(p.length);
  return rest.length === 0 || /^\s/.test(rest);
}
