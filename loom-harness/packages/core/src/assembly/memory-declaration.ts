/**
 * 记忆注入声明层（B 面设计：角色文件自声明注入，无集中配置文件）。
 *
 * 缺省语义（硬编码规则，测试钉死，不许另造第二个口径；W8' 裁决收紧语义 1）：
 *   1. `agents/*.md` 角色文件：frontmatter `memory:` **未声明 = 只注入 AGENTS.md**
 *      （与 `SIDE_SESSION_BASE_GLOBS` 同集，绝不全量读 memory/**）；已声明 = 声明集。
 *      目录内角色文件逐个显式声明（不吃默认），缺省口径只对未声明文件生效；
 *   2. 主会话 = kind:main 声明极 frontmatter `memory:` glob（W34 声明转正，接线见
 *      serve/side-binding.mainSessionMemorySources）；未声明/空声明 = `MAIN_SESSION_GLOBS`
 *      兜底（W33 用户决策 2026-10-12：前缀精简为**仅 AGENTS.md** 单件；原四件记忆文件
 *      留在工作区、按需读取，不再自动注入——W14 终态口径见下方常量注释的历史交代）；
 *   3. 副会话（任务未引用角色文件）= `SIDE_SESSION_BASE_GLOBS`（只 AGENTS.md 基础集）。
 *
 * glob 口径：相对 workspace 根的 POSIX 风格路径模式，只支持 `*`（单段）、`**`
 * （跨段零或多）、`?`（单字符）；`\` 视同 `/` 分隔。目录前缀（如 `memory/`）自动
 * 递归（等价追加 `/**`）。
 *
 * 安全闸（seam 现件思路）：命中文件经 realpath 解析后必须**仍位于 workspace 根内**
 * （workspace 根自身也 realpath，消解符号链接与 Windows 8.3 短名差异）；越界路径
 * 拒绝并 fail-soft——该 glob 记入 `rejected`（调用方落 degrade 审计），绝不 throw
 * 拖垮装配。
 *
 * 前缀纪律（排序口径唯一真源=本文件）：`expandMemoryGlobs` 产物按**声明序分组**
 * 拼接——跨声明去重**首次保留**（同一路径归首条声明的组位），组内**去重+字典序**
 * （单声明展开内 walk 序不流入清单）。声明序=代码常量序/frontmatter 声明序
 * ⇒ 同输入双跑字节全等仍由构造保证。消费链下游禁再排序（`resolveMemorySources`
 * 仅在 IO 边界去重保序），前缀慢→快由声明层唯一决定，禁第二口径。
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * 缺省语义 2 的**兜底集**：主会话钉死前缀仅 AGENTS.md 单件（W34 起本常量退役为兜底——
 * kind:main 声明极 frontmatter `memory:` 非空时声明清单为真源，未声明/空声明才走本集；
 * W33 用户决策 2026-10-12：
 * 「加 md 文件顶替默认值……memory/README.md(记忆导航)、memory/self/必读.md(自我快照)、
 * memory/profile/core.md(画像核心)、memory/fact/总目录.md 都删掉」——五件清单退役）。
 * 退役 ≠ 删除：四件文件仍在 workspace，模型可经 AGENTS.md 指针或文件工具**按需读取**，
 * 但不再自动进前缀注入。历史脉络保留（W14 终态改造）：月度 fact（fact/YYYY-MM.md）
 * 自 W14 起就不进前缀，由总目录.md 指针按需读取，boot 一次展开的月滚雷随之消；
 * W33 把总目录.md 本体也请出前缀——指针入口职责移交 AGENTS.md（用户正把人格内容
 * 收拢进 AGENTS.md）。日后要恢复兜底注入，在此加行即可；主会话实况清单以
 * kind:main 声明为准（W34，见 serve/side-binding.ts）。
 */
export const MAIN_SESSION_GLOBS: readonly string[] = Object.freeze(["AGENTS.md"]);

/** 缺省语义 3：副会话无角色引用时的基础集（只有 AGENTS.md）。同时是缺省语义 1
 *  未声明角色的缺省集——两处共用同一常量，杜绝第二口径。 */
export const SIDE_SESSION_BASE_GLOBS: readonly string[] = Object.freeze(["AGENTS.md"]);

/** 非法声明的拒绝原因（fail-soft 记录，不是异常）。 */
export interface GlobRejection {
  /** 原始声明值（进审计，不含内容）。 */
  readonly pattern: string;
  /** 拒绝原因（非相对路径 / 段越界 / 非法段字符）。 */
  readonly detail: string;
}

/** `expandMemoryGlobs` 产物：可用路径清单 + 被拒声明。 */
export interface ExpandedGlobs {
  /** workspace 相对路径（`/` 分隔），声明序分组 + 组内字典序 + 跨声明去重首次保留。 */
  readonly paths: readonly string[];
  readonly rejected: readonly GlobRejection[];
}

/**
 * 段字符白名单：常用可打印安全集（字母数字 . _ - 空格 + glob 元字符 + CJK 基本区
 * 汉字）。W14 微调：曾有含中文段的显式声明（必读/总目录），旧白名单只覆盖 ASCII——
 * 中文段被整条拒绝致声明缺位；防注入面（| " 控制字符 盘符 ~ ..）不变。W33 主会话
 * 清单转纯 ASCII（仅 AGENTS.md），白名单的 CJK 支撑仍留给角色 frontmatter 按需声明
 * 的中文文件名，机制不动。
 */
const SEGMENT_ALLOWED = /^[A-Za-z0-9._\- ?*\u4e00-\u9fff]+$/;

function isGlobMeta(seg: string): boolean {
  return seg.includes("*") || seg.includes("?");
}

/** 声明形态（决定 0 命中时的语义，见 expandMemoryGlob 注释）。 */
export type GlobPatternKind =
  /** 无元字符 + 末段带扩展名：精确文件（缺失 = 声明占位，对齐 assembler 纪律）。 */
  | "explicit-file"
  /** 无元字符 + 末段无扩展名：目录前缀（等价递归 `/**`，空目录 = 零贡献）。 */
  | "dir-prefix"
  /** 含 `*`/`**`/`?`：glob（0 命中 = 不注入、不占位）。 */
  | "glob";

/**
 * 声明合法性判定 + 归一化：返回 `/` 分隔的段序列；非法返回原因字符串。
 * 拒绝面：绝对路径、盘符、`\` 前缀的网络路径、空段以外的 `.`/`..`/`~` 段、
 * 段内含白名单外字符（防注入 `|`、引号、控制字符等形状）。
 */
function normalizePattern(
  pattern: string,
):
  | { readonly ok: true; readonly segments: readonly string[]; readonly kind: GlobPatternKind }
  | { readonly ok: false; readonly detail: string } {
  const unified = pattern.trim().replace(/\\/g, "/");
  if (unified.length === 0) return { ok: false, detail: "空声明" };
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    return { ok: false, detail: "必须是 workspace 相对路径（拒绝绝对路径/盘符）" };
  }
  const parts = unified.split("/").filter((x) => x.length > 0);
  if (parts.length === 0) return { ok: false, detail: "归一化后为空" };
  for (const seg of parts) {
    if (seg === ".." || seg === ".") return { ok: false, detail: `拒绝段 "${seg}"（不允许穿越/自指）` };
    if (seg.startsWith("~")) return { ok: false, detail: `拒绝家目录展开段 "${seg}"` };
    if (!SEGMENT_ALLOWED.test(seg)) return { ok: false, detail: `段 "${seg}" 含非法字符` };
  }
  const hasMeta = parts.some(isGlobMeta);
  const last = parts[parts.length - 1] ?? "";
  if (!hasMeta) {
    // 精确文件声明（含扩展名）：缺失走占位；目录前缀口径：等价递归。
    if (last.includes(".")) return { ok: true, segments: parts, kind: "explicit-file" };
    return { ok: true, segments: [...parts, "**"], kind: "dir-prefix" };
  }
  return { ok: true, segments: parts, kind: "glob" };
}

/** 段序列 → 锚定正则（`**`=跨段零或多，`*`=单段非分隔符，`?`=单字符）。 */
function segmentsToRegex(segments: readonly string[]): RegExp {
  return new RegExp(`^${compileWithSeparators(segments)}$`);
}

/** 正则拼接（含段间 `/`）：`**` 自带尾 `/` 语义，普通段间补 `/`。 */
function compileWithSeparators(segments: readonly string[]): string {
  let out = "";
  for (const [i, seg] of segments.entries()) {
    if (i > 0 && segments[i - 1] !== "**") out += "/";
    if (seg === "**") {
      out += "(?:[^/]+/)*[^/]*";
      continue;
    }
    for (const ch of seg) {
      if (ch === "*") out += "[^/]*";
      else if (ch === "?") out += "[^/]";
      else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

/** 确定性目录遍历：目录名/文件名各层字典序，跳过隐藏项与符号链接目录（防越界+防环）。 */
function walkFiles(rootReal: string): readonly string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop() ?? "";
    let entries: string[];
    try {
      entries = readdirSync(join(rootReal, relDir));
    } catch {
      continue; // 目录读不动 = 视为无命中（fail-soft）
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const rel = relDir.length === 0 ? name : `${relDir}/${name}`;
      let st;
      try {
        st = lstatSync(join(rootReal, rel)); // lstat：符号链接在此现形（stat 会跟随）
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(rel);
      } else if (st.isFile()) {
        out.push(rel);
      }
    }
  }
  return out;
}

/**
 * 单条 glob → workspace 相对路径清单（realpath 包含断言在此，非普通文件/越界一律不进清单）。
 * 声明非法 = rejected 记录（不 throw）。注意 `**` 匹配的候选来自确定性 walkFiles，
 * 匹配后再逐条断言。
 */
export function expandMemoryGlob(workspaceRoot: string, pattern: string): ExpandedGlobs {
  const normalized = normalizePattern(pattern);
  if (!normalized.ok) {
    return { paths: [], rejected: [{ pattern, detail: normalized.detail }] };
  }
  const re = segmentsToRegex(normalized.segments);
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(workspaceRoot));
  } catch (err) {
    return { paths: [], rejected: [{ pattern, detail: `workspace 根不可解析: ${String(err)}` }] };
  }
  const paths: string[] = [];
  const exactRel = normalized.segments.join("/");
  for (const rel of walkFiles(rootReal)) {
    if (!re.test(rel)) continue;
    // 包含断言：realpath(命中文件) 必须仍在 realpath(workspace 根) 之下。
    // walkFiles 已跳过符号链接，本断言是纵深防御（NTFS 重解析点/junction 兜底）。
    let fileReal: string;
    try {
      fileReal = realpathSync(join(rootReal, rel));
    } catch {
      continue;
    }
    const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    if (fileReal !== join(rootReal, rel) && !fileReal.startsWith(prefix)) {
      continue; // 越界（理论上到不了）：静默丢弃，装配占位由 resolveMemorySources 兜底
    }
    paths.push(rel);
  }
  // 0 命中语义按声明形态分档（测试钉死）：
  //   explicit-file → 保留声明路径（resolveMemorySources 落 MISSING 占位 + degrade，对齐装配纪律）；
  //   glob / dir-prefix → 空清单（模式无保证命中，不注入占位噪声）。
  if (paths.length === 0 && normalized.kind === "explicit-file") {
    paths.push(exactRel);
  }
  return { paths: dedupeSort(paths), rejected: [] };
}

/**
 * 单声明组内纪律：去重 + 字典序（组内唯一排序点）。
 * 跨声明合并走 `expandMemoryGlobs` 的声明序分组——本函数绝不吃多声明合并清单，
 * 否则全局重排会把快变文件埋进前缀中段（W14 病灶，禁回退）。
 */
export function dedupeSort(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

/** 多条声明（角色 frontmatter.memory / 缺省集共用）→ 单一注入清单 + 各条拒绝记录。 */
export function expandMemoryGlobs(
  workspaceRoot: string,
  patterns: readonly string[],
): ExpandedGlobs {
  const out: string[] = [];
  const seen = new Set<string>();
  const rejected: GlobRejection[] = [];
  for (const p of patterns) {
    const one = expandMemoryGlob(workspaceRoot, p); // 组内已去重+字典序
    rejected.push(...one.rejected);
    for (const path of one.paths) {
      if (seen.has(path)) continue; // 跨声明去重：首次保留，后续声明同路径不迁位
      seen.add(path);
      out.push(path);
    }
  }
  return { paths: out, rejected };
}
