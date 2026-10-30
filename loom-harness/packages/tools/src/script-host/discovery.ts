// 脚本发现与挂载准备：目录扫描（扩展名过滤）、frontmatter 校验、解释器
// 校验，产出 Mounted 态。纯 IO 顺序操作，不做任何生命周期决策。

import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";

import { parseFrontmatter } from "./frontmatter.js";
import { resolveInterpreter } from "./runtime.js";
import type { Mounted, ScriptHostOptions } from "./types.js";

const SCRIPT_EXTENSIONS: readonly string[] = [".py", ".ts", ".js", ".mjs", ".sh"];

export function fileNameOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

/** 列出 scriptsDir 下所有候选脚本（按名排序）。目录不可读时记录并返回空集。 */
export function scanScripts(
  opts: ScriptHostOptions,
  log: (msg: string, fields: Record<string, unknown>) => void,
): string[] {
  try {
    return readdirSync(opts.scriptsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && SCRIPT_EXTENSIONS.some((ext) => fileNameOf(e.name).toLowerCase().endsWith(ext)))
      .map((e) => `${opts.scriptsDir}/${e.name}`)
      .sort();
  } catch (err) {
    // 目录不存在/不可读是真实边界（脚本目录可选）：记录并返回空集。
    log("脚本目录不可读", { scriptsDir: opts.scriptsDir, err: String(err) });
    return [];
  }
}

/** 当前 mtime+size 水位线是否已变（文件删除也算变）。 */
export function watermarkChanged(m: Mounted): boolean {
  try {
    const st = statSync(m.filePath);
    return st.mtimeMs !== m.mtimeMs || st.size !== m.size;
  } catch {
    return true;
  }
}

/** 挂载拒绝原因（供宿主按级别记录）。 */
export type RejectReason =
  | { readonly kind: "read-failed"; readonly err: string }
  | { readonly kind: "bad-frontmatter"; readonly reason: string }
  | { readonly kind: "disabled"; readonly name: string }
  | { readonly kind: "no-interpreter"; readonly lang: string };

export type PrepareResult =
  | { readonly ok: true; readonly mounted: Mounted }
  | { readonly ok: false; readonly reject: RejectReason };

/** 读文件 -> frontmatter -> enabled/解释器校验 -> Mounted 态（水位线已记录）。 */
export function prepareMount(filePath: string, opts: ScriptHostOptions): PrepareResult {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, reject: { kind: "read-failed", err: String(err) } };
  }

  const fm = parseFrontmatter(text, fileNameOf(filePath));
  if (!fm.ok) {
    return { ok: false, reject: { kind: "bad-frontmatter", reason: fm.reason } };
  }
  if (!fm.meta.enabled) {
    return { ok: false, reject: { kind: "disabled", name: fm.meta.name } };
  }

  const interpreter = resolveInterpreter(fm.meta.lang, opts.interpreters?.[fm.meta.lang]);
  if (interpreter === undefined) {
    return { ok: false, reject: { kind: "no-interpreter", lang: fm.meta.lang } };
  }

  let st: Stats;
  try {
    st = statSync(filePath);
  } catch (err) {
    // 读写间隙文件消失：视作读取失败，交由上层记录跳过。
    return { ok: false, reject: { kind: "read-failed", err: String(err) } };
  }
  const mounted: Mounted = {
    meta: fm.meta,
    filePath,
    command: interpreter.command,
    prefixArgs: interpreter.prefixArgs,
    generation: 0,
    attempt: 0,
    stopping: false,
    child: undefined,
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
  return { ok: true, mounted };
}
