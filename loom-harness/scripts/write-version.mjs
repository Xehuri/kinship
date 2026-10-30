/**
 * 构建期版本文件生成：把当前 git commit 写入仓库根 VERSION。
 * 该文件被 .gitignore 忽略，属于构建产物；Loom 启动时由
 * packages/server/src/version.ts 读取（LOOM_VERSION 环境变量优先）。
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();

if (!/^[0-9a-f]{7,40}$/.test(sha)) {
  throw new Error(`invalid git sha for VERSION: ${JSON.stringify(sha)}`);
}

writeFileSync(new URL("../VERSION", import.meta.url), `${sha}\n`);
