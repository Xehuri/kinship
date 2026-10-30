/**
 * Markdown frontmatter 解析（T24 配套，零依赖）。
 *
 * 格式：文件开头一段 `---` 围栏块，块内为 `key: value` 行（YAML 标量子集）：
 *
 *   ---
 *   name: review-pr
 *   description: Use when asked to review a pull request.
 *   tools: WebFetch, Grep
 *   ---
 *   # 正文...
 *
 * 规则（与 vendored script-host frontmatter 的注释围栏不同族——那是 .py 脚本专用，
 * 这里是 .md 文档标准格式；两者互不复用）：
 *   - 首行（容忍 BOM 与行首尾空白）必须是 `---`；否则视为"无 frontmatter"，报错。
 *   - 块以第二个 `---` 行结束；未闭合报错。
 *   - 块内：空行与 `#` 注释行跳过；其余必须匹配 `key: value`，键名 `[A-Za-z0-9_-]+`。
 *   - 缩进的续行折叠进上一个键的值（支持多行 description）。
 *   - 值两侧成对的引号剥掉；重复键后者覆盖前者。
 *   - `body` = 闭合围栏之后的全部剩余文本（去掉紧跟围栏的一个换行）。
 *
 * 纯函数、失败返回 reason（调用方决定跳过 + 记 degrade，绝不抛）。
 * T11 子智能体从 ai/agents/*.md 加载时复用本解析器（同族机制，见 docs/02 T11/T24）。
 */

/** 解析成功：data 为键值表（值都是 string），body 为围栏后的正文。 */
export interface MdFrontmatterOk {
  readonly ok: true;
  readonly data: Readonly<Record<string, string>>;
  readonly body: string;
}

/** 解析失败：reason 面向日志，说明坏在哪。 */
export interface MdFrontmatterError {
  readonly ok: false;
  readonly reason: string;
}

export type MdFrontmatterResult = MdFrontmatterOk | MdFrontmatterError;

/** 围栏行：`---`（容忍行首尾空白）。 */
const FENCE_RE = /^\s*---\s*$/;

/** 键值行：`key: value`（键用常用字符集，值可空再由校验方判定）。 */
const KV_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

/** 剥成对引号（单/双）。不成对则原样返回。 */
function unquote(value: string): string {
  const q = value.charAt(0);
  if ((q === '"' || q === "'") && value.length >= 2 && value.charAt(value.length - 1) === q) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 解析 markdown 文本开头的 frontmatter 围栏块。
 * 见文件头规则。不修改任何文件系统状态，可独立穷尽单测。
 */
export function parseMdFrontmatter(text: string): MdFrontmatterResult {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  const first = lines[0] ?? "";
  if (!FENCE_RE.test(first)) {
    return { ok: false, reason: "文件开头缺少 frontmatter 围栏 `---`" };
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i] ?? "")) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { ok: false, reason: "frontmatter 缺少闭合围栏 `---`" };
  }

  const data: Record<string, string> = {};
  let lastKey: string | undefined;
  for (let i = 1; i < closeIdx; i += 1) {
    const raw = lines[i] ?? "";
    if (raw.trim().length === 0) continue;
    if (/^\s*#/.test(raw)) continue; // YAML 风格注释行

    // 缩进续行：折叠进上一个键的值（多行 description 支持）。
    if (/^\s/.test(raw)) {
      if (lastKey === undefined) {
        return { ok: false, reason: `frontmatter 续行之前没有键: ${raw.trim()}` };
      }
      const prev = data[lastKey] ?? "";
      data[lastKey] = prev.length === 0 ? raw.trim() : `${prev} ${raw.trim()}`;
      continue;
    }

    const m = KV_RE.exec(raw);
    if (m === null) {
      return { ok: false, reason: `frontmatter 行非键值: ${raw.trim()}` };
    }
    const key = m[1] ?? "";
    data[key] = unquote((m[2] ?? "").trim());
    lastKey = key;
  }

  // body：闭合围栏之后的剩余文本，去掉围栏行后的第一个换行。
  const rest = lines.slice(closeIdx + 1);
  if (rest.length > 0 && (rest[0] ?? "").length === 0) {
    rest.shift();
  }
  return { ok: true, data, body: rest.join("\n") };
}

/**
 * 把 frontmatter 的 `tools` 值解析为工具名列表：
 * `[A, B]` / `A, B` / `A` 均可；空值 -> undefined（不造假数组）。
 */
export function parseToolsValue(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const inner = value.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  const names = inner
    .split(",")
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
  return names.length > 0 ? names : undefined;
}

/**
 * 把 frontmatter 的 `memory` 值解析为记忆注入 glob 列表（角色自声明注入，B 面设计）：
 * `[a/**, b.md]` / `a/**, b.md` / 单条均可；空值 -> undefined（不造假数组）。
 *
 * 语法约束（相对 workspace 根的 POSIX glob，只支持 `*` / `**` / `?`）：
 * 值里不得出现 `*`/`?` 以外的 glob 元字符——`[`、`]`、`{`、`}`、反引号会破坏
 * `[a, b]` 列表形状与 unquote（花括号展开本期不支持，解析前守卫）。
 * 空串元素静默剔除；含上述字符的条目整条剔除并保留其余（fail-soft：
 * 一个坏 glob 不拖垮整个声明，degrade 记账归调用方）。
 */
export function parseMemoryValue(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const inner = value.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  const globs = inner
    .split(",")
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0)
    .filter((g) => !/[[\]{}]/.test(g) && !g.includes("`"));
  return globs.length > 0 ? globs : undefined;
}
