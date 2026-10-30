/**
 * T34 只读红线守护（docs/02 §T34；决策 docs/01 D32「不触碰现状」）。
 *
 * 证明形态（可机检、不靠约定）：
 *   1. 全树 (path → mtime) 快照：场景开跑前 / 全部用例跑完后各取一次；
 *   2. `axeuh-health-monitor/**`：漂移集必须全部落在「活体服务既有写入面」白名单内
 *      （ai/data/ 采集与任务日志、backend/ 服务日志与 kernel_state 作业、.git/ ——
 *      这些由运行中的 axeuh-health.service 自行写入，与本 harness 场景无关，实测见 DoneClaim）；
 *      白名单之外任何 mtime 漂移 = 红线违背 → 失败并列明路径；
 *   3. 仓库 `fixture-workspace/` 与本目录 `fixtures/` 模板：无任何白名单，全树必须全等；
 *   4. 产物名探测：本场景工件文件名（事实/理解/commit-body/check-report）若出现在
 *      axeuh-health-monitor/** 之内 = 违背（find -name 探测，零漂移也不能漏）。
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** 活体服务写入面白名单（相对 axeuh-health-monitor 根；POSIX 分隔）。 */
export const LIVE_SERVICE_WRITE_PREFIXES: readonly string[] = [
  "ai/data/",
  "backend/",
  ".git/",
  // moss 影子观察旁车（systemd axeuh-moss-watch.service，2026-10-12 起常驻）自写
  // 深潜游标 tools/moss-shadow/state/cursor.json——与本 harness 场景零因果的第三
  // 方活体漂移（lead 复验 14:33 实证：watcher PID 在跑、mtime 恰落扫描窗）。
  // 白名单口径=「运行中的现网服务自行写入」，非「仅 axeuh-health 单元」。
  "tools/moss-shadow/state/",
];

export function isLiveServiceDrift(relPathPosix: string): boolean {
  const rel = relPathPosix.startsWith("./") ? relPathPosix.slice(2) : relPathPosix;
  return LIVE_SERVICE_WRITE_PREFIXES.some((p) => rel.startsWith(p));
}

/** 组装 find 起点参数：excludeDirs 非空时用 -prune 剪掉这些相对子树。 */
function findBaseArgs(root: string, excludeDirs: readonly string[]): string[] {
  const args = [root];
  if (excludeDirs.length > 0) {
    args.push("(");
    excludeDirs.forEach((d, i) => {
      if (i > 0) args.push("-o");
      args.push("-path", join(root, d));
    });
    args.push(")", "-prune", "-o");
  }
  return args;
}

/** 全树 mtime 快照（GNU find 一次遍历，NTFS 上秒级；输出 path|mtime 逐行）。 */
export function snapshotMtrees(
  root: string,
  timeoutMs: number,
  excludeDirs: readonly string[] = [],
): Map<string, string> {
  const out = execFileSync("find", [...findBaseArgs(root, excludeDirs), "-type", "f", "-printf", "%p|%T@\n"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const map = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const cut = line.lastIndexOf("|");
    map.set(line.slice(0, cut), line.slice(cut + 1));
  }
  return map;
}

/** 两份快照的漂移（新增/删除/mtime 变更），返回相对 root 的 POSIX 路径。 */
export function snapshotDrift(
  before: Map<string, string>,
  after: Map<string, string>,
  root: string,
): string[] {
  const drift: string[] = [];
  for (const [path, mtime] of after) {
    const old = before.get(path);
    if (old === undefined || old !== mtime) drift.push(toRel(root, path));
  }
  for (const path of before.keys()) {
    if (!after.has(path)) drift.push(toRel(root, path));
  }
  return [...new Set(drift)].sort();
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

/** 产物名探测：root 下是否存在任一指定文件名（返回命中相对路径列表）。 */
export function findFileNames(
  root: string,
  names: readonly string[],
  timeoutMs: number,
  excludeDirs: readonly string[] = [],
): string[] {
  const args = [...findBaseArgs(root, excludeDirs), "-type", "f"];
  names.forEach((n, i) => {
    if (i > 0) args.push("-o");
    args.push("-name", n);
  });
  args.push("-print");
  const out = execFileSync("find", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((p) => toRel(root, p));
}

/** 递归列出目录树全部文件（相对路径），供沙箱包含性断言。 */
export function listFilesRecursive(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...listFilesRecursive(join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/** 文件是否存在（同步、廉价）。 */
export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
