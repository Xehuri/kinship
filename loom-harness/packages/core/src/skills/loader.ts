/**
 * skills 加载器（T24：目录扫描 + 每会话 allowlist + 正文懒读）。
 *
 * 定位：**薄封装，喂数据给 vendored `plugins/skills.ts`**，不重复实现。
 * vendored 插件已覆盖：catalog 注入（system prompt 仅 name+description、绝不含 body）、
 * `skill` 工具按名取回 body、工具激活集复用（O1 seam）。它缺的是"数据从哪来"，
 * 本 loader 补齐——
 *   1. **allowlist 目录扫描**：只扫配置注入的目录白名单（路径全部参数化，禁硬编码）。
 *      目录布局两态（ai/skills/ 迁移族，D24）：`<dir>/<skill-name>/SKILL.md` 与 `<dir>/<name>.md`。
 *   2. **frontmatter 解析**（复用 `./frontmatter.js`，T11 的 ai/agents/*.md 加载同族共享）
 *      提取 name/description/tools -> 元数据清单 `SkillEntry`（**不含正文**）。
 *   3. **正文懒读**：SkillSpec.body 定义为 getter（getter 即懒读接缝）。vendored 插件
 *      的 catalog 构造只读 name/description，`spec.body` 仅在 invoke 的 execute 里被
 *      访问——故扫描期零正文驻留，正文**只在显式 invoke 时**从磁盘读入并注入当轮
 *      toolResult。invoke 后文件被改 -> 下次 invoke 读到新正文。
 *   4. **degrade 记录**：坏 frontmatter / 缺 description / 重名 -> 跳过该 skill 并记入
 *      `degraded`（含原因），绝不静默吞掉，也绝不让一个坏文件拖垮整个清单。
 *
 * fail-loud：allowlist 为空、目录不存在/不可读、扫描后零有效 skill —— 直接抛（配置错误
 * 要响）；单个文件坏 —— degrade（数据错误要降级）。
 *
 * W25 热重载：`reload()` 同步重扫 allowlist、重建清单与 degrade、**原子换入**目录视图；
 * 失败 fail-soft 保留旧 catalog（绝不空化）。hook 经供应函数每轮现读，reload 后下一次
 * 请求的 system prompt 即携新 catalog。正文纪律不变：扫描/清单/catalog/嗅探哈希面
 * **永不读正文**，spec.body 只在 invoke 的 execute 里求值。
 *
 * 接线点（留给 T10，本任务不做）：`const L = await loadSkills({allowlist})`，
 * 把 `L.hook` 塞进 AgentSession.hooks、`L.tool` 塞进 AgentSession.tools。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Hook, HarnessTool } from "../index.js";
import {
  renderSkillCatalog,
  skills as skillsPlugin,
  type SkillSpec,
} from "../plugins/skills.js";
import { parseMdFrontmatter, parseToolsValue } from "./frontmatter.js";

/** 一个已扫描进清单的 skill（元数据，**绝不含正文**）。 */
export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  /** SKILL.md / *.md 的绝对路径（invoke 时按此懒读正文）。 */
  readonly file: string;
  /** frontmatter `tools:` 声明的激活工具（invoke 时写进 O1 激活集）。 */
  readonly tools?: readonly string[];
}

/** 被跳过并记录的降级项（坏数据，不是配置错误）。 */
export interface SkillDegrade {
  /** 所属 allowlist 目录（绝对路径）。 */
  readonly dir: string;
  /** 出问题的文件（绝对路径）；目录级问题为 undefined。 */
  readonly file?: string;
  readonly reason: string;
}

export interface SkillScanResult {
  readonly entries: readonly SkillEntry[];
  readonly degraded: readonly SkillDegrade[];
}

export interface SkillsLoaderOptions {
  /**
   * 目录白名单（绝对路径或相对 cwd，内部统一 resolve 成绝对路径）。
   * 只有这些目录被扫描；其余目录里的 skill 对 catalog 不可见
   * （每会话 allowlist 由上层传入不同集合）。
   */
  readonly allowlist: readonly string[];
  /** `skill` 工具名，透传 vendored 插件（默认 "skill"）。 */
  readonly toolName?: string;
}

/** 一次成功 reload 换入的完整目录视图（W25：构建完成后**一次性换指针**，原子可见）。 */
interface CatalogView {
  /** 重加载代号：boot=0，每次成功 reload +1（水位 mtimeMs 槽的数据源）。 */
  readonly generation: number;
  readonly entries: readonly SkillEntry[];
  readonly degraded: readonly SkillDegrade[];
  readonly specs: readonly SkillSpec[];
  readonly byName: ReadonlyMap<string, SkillEntry>;
  /** 当前 catalog 块文本（与 hook 每轮追加的 system prompt 尾块逐字节同源）。 */
  readonly catalogText: string;
}

/** reload 结局（fail-soft：ok=false 时旧 catalog 照常在场，字段 = 未动的现值）。 */
export interface SkillsReloadResult {
  readonly ok: boolean;
  /** 失败原因（仅 ok=false 在场）。 */
  readonly reason?: string;
  readonly generation: number;
  readonly entries: readonly SkillEntry[];
  readonly degraded: readonly SkillDegrade[];
}

export interface SkillsLoader {
  /** 挂进 AgentSession.hooks：catalog 只进 system prompt（name+description），每轮现读。 */
  readonly hook: Hook;
  /** 挂进 AgentSession.tools：显式 invoke 才注入正文。 */
  readonly tool: HarnessTool;
  /** 当前目录视图的清单（W25 起为活读：reload 后即刻新值）。 */
  readonly entries: readonly SkillEntry[];
  readonly degraded: readonly SkillDegrade[];
  /** 程序化懒读正文（与 tool invoke 同一数据通路；未知名/坏文件 throw）。 */
  invoke(name: string): Promise<string>;
  /**
   * W25 热重载：重扫配置的 skill 目录、重建清单与 degrade、原子换入新目录视图。
   * fail-soft：扫描抛（目录不可读）或零有效 skill ⇒ 保留旧 catalog 服务、返回
   * ok:false + reason，**绝不抛、绝不空化**。成功则 generation+1（嗅探据此判变）。
   */
  reload(): SkillsReloadResult;
  /** 当前 catalog 块文本（W25 嗅探基线数据源；绝不含正文）。 */
  catalogText(): string;
  /** 当前重加载代号（boot=0，每成功 reload +1）。 */
  generation(): number;
}

/** skill 目录形态下的正文文件名（固定约定）。 */
const SKILL_FILE = "SKILL.md";

/** 隐藏/内部目录条目（.git、_template 等）一律无视。 */
function isIgnoredEntry(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_");
}

/** `<dir>/<name>/SKILL.md` 是否存在（存在即视 `<name>` 为 skill 目录）。 */
function hasSkillFile(dirPath: string): boolean {
  try {
    return existsSync(join(dirPath, SKILL_FILE));
  } catch {
    return false;
  }
}

/** 从文件文本提取正文（frontmatter 之后的部分）；坏 frontmatter 抛（invoke 通路走 isError）。 */
function extractBody(text: string, file: string): string {
  const parsed = parseMdFrontmatter(text);
  if (!parsed.ok) {
    throw new Error(`skill body unreadable (${file}): ${parsed.reason}`);
  }
  return parsed.body;
}

/** 规范化 allowlist：拒绝空集、去重、统一绝对路径（fail-loud 配置纪律）。 */
function normalizeAllowlist(allowlist: readonly string[]): string[] {
  if (allowlist.length === 0) {
    throw new Error(
      "skills loader: allowlist must be non-empty（路径参数化，不接受隐式全局扫描）",
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of allowlist) {
    const abs = resolve(raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/**
 * 扫描 allowlist 目录，产出元数据清单 + degrade 记录（不建插件对象）——**同步核**。
 * 纯读取通路，也是 T11 复用的"目录发现"。W25 起为同步 fs（readdirSync/readFileSync）：
 * 主会话准入嗅探跑在同步语境（registry.send），热重载必须与 boot 扫描同一实现——
 * 单点扫描核，禁第二实现漂移。全程只读 frontmatter 元数据，正文零驻留（懒读纪律不变）。
 */
export function scanSkillsCore(allowlist: readonly string[]): SkillScanResult {
  const dirs = normalizeAllowlist(allowlist);
  const entries: SkillEntry[] = [];
  const degraded: SkillDegrade[] = [];
  const seenNames = new Set<string>();

  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (err) {
      throw new Error(
        `skills loader: allowlist dir unreadable: ${dir} (${String(err)})`,
      );
    }

    for (const name of names) {
      if (isIgnoredEntry(name)) continue;

      const child = join(dir, name);
      let file: string;
      let stem: string;
      if (hasSkillFile(child)) {
        file = join(child, SKILL_FILE); // 目录形态：ai/skills/<name>/SKILL.md
        stem = name;
      } else if (name.toLowerCase().endsWith(".md")) {
        file = child; // 平铺形态：ai/skills/<name>.md
        stem = basename(name, ".md");
      } else {
        continue; // 普通子目录/非 md 文件：静默忽略（不是 skill）
      }

      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        degraded.push({ dir, file, reason: `读取失败: ${String(err)}` });
        continue;
      }

      const parsed = parseMdFrontmatter(text);
      if (!parsed.ok) {
        degraded.push({ dir, file, reason: `坏 frontmatter: ${parsed.reason}` });
        continue;
      }
      const description = parsed.data["description"]?.trim() ?? "";
      if (description.length === 0) {
        degraded.push({ dir, file, reason: "frontmatter 缺少 description" });
        continue;
      }
      const skillName = parsed.data["name"]?.trim() || stem;
      if (seenNames.has(skillName)) {
        degraded.push({ dir, file, reason: `重名跳过: ${skillName}` });
        continue;
      }
      seenNames.add(skillName);

      const tools = parseToolsValue(parsed.data["tools"]);
      const entry: SkillEntry = tools
        ? { name: skillName, description, file, tools }
        : { name: skillName, description, file };
      entries.push(entry);
    }
  }

  return { entries, degraded };
}

/** 异步外观（T24 调用面逐字节不变）：内部走同一同步扫描核，Promise 契约仅签名兼容。 */
export async function scanSkills(
  allowlist: readonly string[],
): Promise<SkillScanResult> {
  return scanSkillsCore(allowlist);
}

/**
 * entry -> 喂给 vendored 插件的 SkillSpec。
 * body 用对象字面量里的 `get` 访问器实现懒读（注意：不能用展开复制 lazy 对象——
 * 展开会**求值** getter，把正文在扫描期就读进来）。插件构造期 catalog 只摸
 * name/description；`spec.body` 只在 invoke 的 execute 内被访问，届时同步读盘
 * （单文件正文小，且插件属性访问是同步语境）。invoke 后改文件可读到新正文。
 * exactOptionalPropertyTypes：无 tools 分支不显式传 undefined。
 */
function entryToSpec(entry: SkillEntry): SkillSpec {
  const readBody = (): string =>
    extractBody(readFileSync(entry.file, "utf8"), entry.file);
  if (entry.tools) {
    return {
      name: entry.name,
      description: entry.description,
      tools: [...entry.tools],
      get body() {
        return readBody();
      },
    };
  }
  return {
    name: entry.name,
    description: entry.description,
    get body() {
      return readBody();
    },
  };
}

/** 扫描结果 → 完整目录视图（specs/byName/catalogText 一次建齐；换入前无人可见）。 */
function buildView(scan: SkillScanResult, generation: number, toolName: string): CatalogView {
  const specs = scan.entries.map(entryToSpec);
  return {
    generation,
    entries: scan.entries,
    degraded: scan.degraded,
    specs,
    byName: new Map(scan.entries.map((e) => [e.name, e])),
    catalogText: renderSkillCatalog(toolName, specs),
  };
}

/**
 * 构建 skills 加载器：扫描 -> 元数据清单 -> 喂 vendored 插件（供应函数面，W25 每轮现读）。
 * 零有效 skill 时抛（配置级错误；degrade 明细经 `scanSkillsCore` 单独可查）。
 * 返回的 loader 持有**可变目录视图**：reload() 重建后一次性换指针，
 * hook/tool/entries/catalogText 全部经闭包读现视图——在飞回合已取走的字符串不受影响。
 */
export async function loadSkills(
  opts: SkillsLoaderOptions,
): Promise<SkillsLoader> {
  const scan = scanSkillsCore(opts.allowlist);
  if (scan.entries.length === 0) {
    throw new Error(
      `skills loader: no valid skills in allowlist（${scan.degraded.length} 项 degrade）`,
    );
  }

  const toolName = opts.toolName ?? "skill";
  let view = buildView(scan, 0, toolName);
  const inner = skillsPlugin(() => view.specs, { toolName });

  return {
    hook: inner.hook,
    tool: inner.tool,
    get entries() {
      return view.entries;
    },
    get degraded() {
      return view.degraded;
    },
    catalogText(): string {
      return view.catalogText;
    },
    generation(): number {
      return view.generation;
    },
    reload(): SkillsReloadResult {
      try {
        const next = scanSkillsCore(opts.allowlist);
        if (next.entries.length === 0) {
          // 零有效 = 数据灾难场景（全坏目录）：与扫描抛错同走 fail-soft，旧 catalog 继续服务。
          return {
            ok: false,
            reason: `no valid skills in allowlist（${next.degraded.length} 项 degrade）——保留旧 catalog`,
            generation: view.generation,
            entries: view.entries,
            degraded: view.degraded,
          };
        }
        view = buildView(next, view.generation + 1, toolName); // 原子换入：新视图整建后才指过去
        return {
          ok: true,
          generation: view.generation,
          entries: view.entries,
          degraded: view.degraded,
        };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
          generation: view.generation,
          entries: view.entries,
          degraded: view.degraded,
        };
      }
    },
    async invoke(name: string): Promise<string> {
      const entry = view.byName.get(name);
      if (!entry) {
        const available = [...view.byName.keys()].join(", ");
        throw new Error(`unknown skill "${name}" (available: ${available})`);
      }
      return extractBody(await readFile(entry.file, "utf8"), entry.file);
    },
  };
}
