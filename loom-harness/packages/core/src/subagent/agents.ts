/**
 * 子智能体类型定义加载（T11 / D5 / D24）。
 *
 * D5：子智能体「定义 = 提示词文件 + 模型路由」。本文件只做**数据装配**，不碰会话/派发：
 *   - **内置类型**：`general`（通用）+ `explore`（探索）—— D24 冻结「内置类型自造」，
 *     提示词内联在本模块（不依赖磁盘，任何工作区都能派发）。
 *   - **工作区类型**：从注入的目录（典型 `fixture-workspace/agents/*.md`）扫描，正文 = 子会话
 *     systemPrompt（懒读：扫描期只留元数据，spawn 时才读盘，与 T24 skills loader 同一策略）。
 *     frontmatter 解析**复用** `../skills/frontmatter.js`（T24 完成品，同族机制）。
 *
 * 命名闸（路由标识 = tool 参数 `agent_type` 枚举值，须是稳定 ASCII token）：
 *   `name:` 声明优先，否则由文件名 stem 清洗（非 `[a-z0-9_]` 段折叠成 `_`）；清洗后为空
 *   （纯中文名）或撞名 → 记 degrade 跳过该文件，**绝不**让一个坏文件拖垮清单。
 *
 * W17-E 主次声明闸（frontmatter `kind:`）：`main` = 主智能体人格声明极（正文供 boot 装配
 *   主会话身份框，不进派发面）；`sub` = 可派发子智能体。**缺省 = sub**（旧文件零改动逐字
 *   向后兼容）。值大小写不敏感（main|MAIN|Main 皆可）；非法值 fail-soft：记 warning +
 *   按 sub 处理，**绝不 throw、绝不 degrade 丢文件**——声明坏了不改变该文件其余可用性。
 *
 * fail-loud：目录不存在/不可读 = 配置错误 → 抛。数据坏 = degrade。
 */

import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseMdFrontmatter, parseMemoryValue, parseToolsValue } from "../skills/frontmatter.js";

/** 路由标识合法形状：小写字母/数字/下划线，长度 2+（禁连字符——前端契约族）。 */
const TYPE_RE = /^[a-z0-9_]{2,}$/;

/**
 * W17-E 主次声明极（frontmatter `kind:` 值域）：
 *   - `main`：主智能体人格声明——正文（去 frontmatter）供 boot 装配主会话身份框，
 *     **不可派发**（task 枚举与 POST /runs 可派发面过滤掉 kind:main）。
 *   - `sub`：可派发子智能体（缺省值，旧文件无 kind 声明时逐字节等同现状）。
 */
export type AgentKind = "main" | "sub";

/** 一种可派发的子智能体类型（domain-free：只有标识 + 选择依据 + 怎么造提示词）。 */
export interface AgentTypeDef {
  /** 路由标识；父模型在 `agent_type` 参数里点名，同一批内唯一。 */
  readonly type: string;
  /** 给父模型看的选择依据（拼进 tool description）。 */
  readonly description: string;
  /** 来源：内置 or 工作区定义文件。 */
  readonly source: "builtin" | "file";
  /**
   * W17-E 主次声明极（缺省 sub；内置类型恒 sub）。main 条目只供主会话人格装配，
   * 派发面（task-tool 枚举 / 副会话角色引用）必须过滤掉它。
   */
  readonly kind: AgentKind;
  /** 定义文件绝对路径（source="file" 时存在）。 */
  readonly file?: string;
  /** frontmatter `model:` 声明的模型路由提示（D5；缺省由 sessionFactory 自行决定）。 */
  readonly model?: string;
  /** frontmatter `tools:` 声明（供 T10 侧组装子会话工具集）。 */
  readonly tools?: readonly string[];
  /**
   * frontmatter `memory:` 声明（角色自声明注入，B 面设计）：相对 workspace 根的
   * glob 列表。**未声明 = 只注入 AGENTS.md**（缺省语义 1，W8' 收紧，规则真源见
   * assembly/memory-declaration.ts；本层只如实暴露 undefined，缺省接线在
   * serve/side-binding）；空数组只可能来自内置类型。
   */
  readonly memoryGlobs?: readonly string[];
  /** 子会话 systemPrompt = 定义正文；懒读（仅 spawn 时读盘，文件改了下次 spawn 即生效）。 */
  loadSystemPrompt(): Promise<string>;
  /**
   * 同步版懒读（同步 spawn 工厂专用）：每次调用重读定义文件并重新解析；
   * 读盘失败回落扫描期正文，解析失败按原文返回。内置类型返回常量。
   */
  loadSystemPromptSync(): string;
}

/** 被跳过并记录的降级项（数据问题，不是配置错误）。 */
export interface AgentDegrade {
  readonly dir: string;
  readonly file?: string;
  readonly reason: string;
}

/**
 * fail-soft 留痕项（W17-E）：数据可用但声明有瑕疵（如 kind 非法值按 sub 兜底）。
 * 与 degrade 的区别：degrade = 条目被丢出清单；warn = 条目照常入清单，只记日志。
 */
export interface AgentWarn {
  readonly dir: string;
  readonly file: string;
  readonly reason: string;
}

export interface AgentScanResult {
  readonly entries: readonly AgentTypeDef[];
  readonly degraded: readonly AgentDegrade[];
  readonly warnings: readonly AgentWarn[];
}

export interface LoadAgentsOptions {
  /** 定义目录（绝对或相对 cwd，内部统一 resolve）。只有这些目录被扫描，路径全部参数化。 */
  readonly dirs: readonly string[];
  /** 是否附带内置类型（默认 true）。 */
  readonly includeBuiltins?: boolean;
}

/**
 * 内置 general / explore（D24 冻结自造）。正文极短——真正的领域提示词在工作区定义文件里。
 */
const BUILTIN_GENERAL = "general";
const BUILTIN_EXPLORE = "explore";

export const BUILTIN_GENERAL_PROMPT = [
  "你是主智能体派发的通用子智能体（general）。",
  "- 只做派给你的这一个自包含任务，不越界调度其他子智能体、不直接与用户闲聊。",
  "- 结论必须基于你实际读到的内容；不确定就写「数据不足」，绝不编造。",
  "- 最终回答先给结论再给依据，简短直接。",
].join("\n");

export const BUILTIN_EXPLORE_PROMPT = [
  "你是主智能体派发的探索型子智能体（explore）。",
  "- 职责：在给定范围内检索、读文件、收集事实，产出结构化发现清单。",
  "- 只报告事实与出处（文件路径 + 行号/片段），不做修改、不做决策。",
  "- 穷尽性优先：列出全部相关命中并标注置信度，不确定就明说。",
].join("\n");

/** 内置类型清单（纯内存，零 IO）。 */
export function builtinAgentTypes(): readonly AgentTypeDef[] {
  return Object.freeze([
    builtin(BUILTIN_GENERAL, "通用子智能体：承接一个自包含的一般任务。", BUILTIN_GENERAL_PROMPT),
    builtin(BUILTIN_EXPLORE, "探索型子智能体：检索/读文件/收集事实并回传结构化发现。", BUILTIN_EXPLORE_PROMPT),
  ]);
}

function builtin(type: string, description: string, prompt: string): AgentTypeDef {
  return Object.freeze({
    type,
    description,
    source: "builtin" as const,
    // W17-E：内置类型恒 sub（人格声明只可能来自工作区文件）。
    kind: "sub" as const,
    loadSystemPrompt: () => Promise.resolve(prompt),
    loadSystemPromptSync: () => prompt,
  });
}

/**
 * frontmatter `kind:` 值 → 主次声明极（fail-soft）：
 *   缺省/空值 = sub（现状逐字节兼容）；main|sub 大小写不敏感；
 *   其余值 = sub + warn 文案（绝不 throw、绝不丢条目）。
 */
function parseKindValue(value: string | undefined): { kind: AgentKind; warn: string | null } {
  if (value === undefined || value.length === 0) {
    return { kind: "sub", warn: null };
  }
  const norm = value.toLowerCase();
  if (norm === "main" || norm === "sub") {
    return { kind: norm, warn: null };
  }
  return { kind: "sub", warn: `kind 值非法（仅 main|sub），已按 sub 处理: "${value}"` };
}

/** 文件名 stem → 路由标识：折叠非法字符为 `_`，去首尾 `_`，转小写。 */
function sanitizeType(stem: string): string {
  const s = stem
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s;
}

/**
 * 从工作区目录 + 内置类型装配可用 agent 类型。
 * 返回 entries 已按 type 去重（内置优先占位，同名工作区定义 degrade）。
 */
export async function loadAgentTypes(
  opts: LoadAgentsOptions,
): Promise<AgentScanResult> {
  if (opts.dirs.length === 0) {
    throw new Error("loadAgentTypes: dirs must not be empty (配置错误要响)");
  }
  const includeBuiltins = opts.includeBuiltins ?? true;
  const entries: AgentTypeDef[] = [];
  const degraded: AgentDegrade[] = [];
  const warnings: AgentWarn[] = [];
  const taken = new Set<string>();

  const claim = (type: string): boolean => {
    if (taken.has(type)) return false;
    taken.add(type);
    return true;
  };

  if (includeBuiltins) {
    for (const b of builtinAgentTypes()) {
      claim(b.type);
      entries.push(b);
    }
  }

  for (const dirRaw of opts.dirs) {
    const dir = resolve(dirRaw);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      throw new Error(
        `loadAgentTypes: cannot read agents dir "${dir}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".md")) continue;
      const file = join(dir, name);
      const stem = basename(name, ".md");

      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        degraded.push({ dir, file, reason: `读取失败: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const fm = parseMdFrontmatter(text);
      if (fm.ok === false) {
        degraded.push({ dir, file, reason: fm.reason });
        continue;
      }

      const declared = fm.data["name"] ?? "";
      const type = declared.length > 0 ? declared.toLowerCase() : sanitizeType(stem);
      if (!TYPE_RE.test(type)) {
        degraded.push({ dir, file, reason: `路由标识不可用（需匹配 ${TYPE_RE.source}）: "${type}"` });
        continue;
      }
      if (!claim(type)) {
        degraded.push({ dir, file, reason: `路由标识重名，已跳过: "${type}"` });
        continue;
      }

      const body = fm.body;
      const description =
        fm.data["description"] ?? firstHeadingOrLine(body) ?? `agent type ${type}`;
      const declaredModel = fm.data["model"];
      const declaredTools = parseToolsValue(fm.data["tools"]);
      const declaredMemory = parseMemoryValue(fm.data["memory"]);
      const kindParsed = parseKindValue(fm.data["kind"]);
      if (kindParsed.warn !== null) {
        warnings.push({ dir, file, reason: kindParsed.warn });
      }

      entries.push(
        Object.freeze({
          type,
          description,
          source: "file" as const,
          kind: kindParsed.kind,
          file,
          ...(declaredModel !== undefined ? { model: declaredModel } : {}),
          ...(declaredTools !== undefined ? { tools: declaredTools } : {}),
          ...(declaredMemory !== undefined ? { memoryGlobs: declaredMemory } : {}),
          // 懒读正文：与 T24 skills loader 同一接缝（重读文件 → 取围栏后正文）。
          loadSystemPrompt: async () => {
            const cur = await readFile(file, "utf8");
            const again = parseMdFrontmatter(cur);
            return again.ok === true ? again.body : cur;
          },
          // 同步同源：spawn 时重读；读失败回落扫描期正文（body 为闭包捕获的 boot 快照）。
          loadSystemPromptSync: () => {
            try {
              const cur = readFileSync(file, "utf8");
              const again = parseMdFrontmatter(cur);
              return again.ok === true ? again.body : cur;
            } catch {
              return body;
            }
          },
        }),
      );
    }
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    degraded: Object.freeze(degraded),
    warnings: Object.freeze(warnings),
  });
}

/** 描述缺省：正文首个 `#` 标题（去标记）→ 否则首个非空行 → 否则 undefined。 */
function firstHeadingOrLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h !== null) {
      const title = (h[1] ?? "").trim();
      if (title.length > 0) return title;
      continue;
    }
    return t.replace(/^[-*]\s+/, "");
  }
  return undefined;
}
