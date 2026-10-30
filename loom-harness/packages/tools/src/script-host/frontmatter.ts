// 挂载脚本 frontmatter 解析。
//
// 格式选择（简单、可测、零依赖、跨语言合法）：文件开头一段"注释围栏块"，
// 每行以 `#` 或 `//` 注释符开头（保证同一份 frontmatter 在 python / shell
// 里本身就是合法注释，脚本文件可直接交给解释器执行，宿主无需剥离）：
//
//   #---
//   #enabled: true
//   #name: emitter
//   #lang: python
//   #respawn: false
//   #---
//
// 规则：
//   - 首行必须是围栏行：`#---` / `//---` / `---`（容忍行首行尾空白）。
//   - 块内每个有效行是 `注释符 key: value`；纯注释行（无冒号）与空白行跳过。
//   - 块以第二个围栏行结束；未闭合视为解析错误。
//   - 文件不以围栏开头 => 无 frontmatter，全部走默认值（脚本仍可挂载）。
//   - 未知键 / 非法布尔 / 非法 lang => 解析错误（宿主拒绝挂载并记录，绝不 spawn）。
//
// 不选完整 YAML：宿主只需 4 个标量键，行式解析可穷尽，且不必把 `yaml`
// 依赖引入 tools 包（tools/package.json 由并行 worker T04 维护，不可改动）。

export type Lang = "python" | "ts" | "node" | "shell";

/** 一条已声明脚本的元数据。 */
export interface ScriptMeta {
  readonly enabled: boolean;
  readonly name: string;
  readonly lang: Lang;
  readonly respawn: boolean;
}

/** frontmatter 非法：宿主应拒绝挂载并记录，绝不 spawn。 */
export interface FrontmatterError {
  readonly ok: false;
  readonly reason: string;
}

export interface FrontmatterOk {
  readonly ok: true;
  readonly meta: ScriptMeta;
}

export type FrontmatterResult = FrontmatterOk | FrontmatterError;

const KNOWN_KEYS: ReadonlySet<string> = new Set(["enabled", "name", "lang", "respawn"]);

/** switch 穷尽收窄：字符串 -> Lang，未知值返回 undefined（不靠 as 断言）。 */
function parseLangValue(value: string): Lang | undefined {
  switch (value) {
    case "python":
    case "ts":
    case "node":
    case "shell":
      return value;
    default:
      return undefined;
  }
}

/** 围栏行：`(#|//)?---`（容忍行首行尾空白）。 */
const FENCE_RE = /^\s*(?:#|\/\/)?\s*---\s*$/;

/** 键值行：`注释符? key: value`。 */
const KV_RE = /^\s*(?:#|\/\/)?\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

function parseBoolValue(value: string): boolean | undefined {
  switch (value) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      return undefined;
  }
}

/** 按扩展名推断语言；未知扩展名兜底 python（存量脚本以 python 为主）。 */
function langFromFilename(fileName: string): Lang {
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "py":
      return "python";
    case "ts":
      return "ts";
    case "js":
    case "mjs":
      return "node";
    case "sh":
      return "shell";
    default:
      return "python";
  }
}

function defaultMeta(fileName: string): ScriptMeta {
  return {
    enabled: true,
    name: fileName.replace(/\.[^.]*$/, ""),
    lang: langFromFilename(fileName),
    respawn: true,
  };
}

/**
 * 解析脚本文本开头的 frontmatter 注释围栏块。
 * 见文件头注释中的格式规则。纯函数，可独立单测。
 */
export function parseFrontmatter(text: string, fileName: string): FrontmatterResult {
  const lines = text.split(/\r?\n/);
  const meta: {
    enabled: boolean;
    name: string;
    lang: Lang;
    respawn: boolean;
  } = defaultMeta(fileName);

  const first = lines[0] ?? "";
  if (!FENCE_RE.test(first)) {
    // 无 frontmatter：全默认值。
    return { ok: true, meta };
  }

  let closed = false;
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    if (FENCE_RE.test(raw)) {
      closed = true;
      break;
    }
    if (raw.trim().length === 0) {
      continue;
    }
    const m = KV_RE.exec(raw);
    if (m === null) {
      // 纯注释无键值（如 `# 说明文字`）：跳过。
      continue;
    }
    const key = m[1] ?? "";
    const value = (m[2] ?? "").trim();

    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, reason: `未知 frontmatter 键: ${key}` };
    }
    if (value.length === 0) {
      return { ok: false, reason: `frontmatter 键缺少值: ${key}` };
    }

    switch (key) {
      case "enabled": {
        const b = parseBoolValue(value);
        if (b === undefined) {
          return { ok: false, reason: `enabled 只接受 true|false: ${value}` };
        }
        meta.enabled = b;
        break;
      }
      case "respawn": {
        const b = parseBoolValue(value);
        if (b === undefined) {
          return { ok: false, reason: `respawn 只接受 true|false: ${value}` };
        }
        meta.respawn = b;
        break;
      }
      case "name": {
        meta.name = value;
        break;
      }
      case "lang": {
        const lang = parseLangValue(value);
        if (lang === undefined) {
          return { ok: false, reason: `lang 只接受 python|ts|node|shell: ${value}` };
        }
        meta.lang = lang;
        break;
      }
      default: {
        // KNOWN_KEYS 已过滤，不可达；守卫防未来加键漏分支。
        return { ok: false, reason: `未处理的 frontmatter 键: ${key}` };
      }
    }
  }

  if (!closed) {
    return { ok: false, reason: "frontmatter 缺少结束围栏 `---`" };
  }

  return { ok: true, meta };
}
