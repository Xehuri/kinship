/**
 * skills —— 渐进式技能加载（issue #68 / O2）。
 *
 * 把一组 "skill"（一段命名的 prompt 全文 + 可选要激活的工具）做成 catalog + 加载工具：
 * - **发现**：`hook` 在 system prompt 末尾追加一段简洁 catalog（仅 name + description，
 *   **绝不含 body**），随 system prompt 每 turn 已发、无额外注入成本。模型据此挑技能。
 * - **加载**：`skill` 工具按名取回该 skill 的 body 全文作 toolResult 注入；若 skill 声明了
 *   `tools`，把它们写进 O1 的 `"deferred.activated"` 激活集，**下一 turn** 才在 listing 里出现
 *   （仅当也挂了 {@link deferredTools} 且这些工具被 deferred 时才有视觉效果——O1/O2 共享同一 seam）。
 *
 * domain-free：`SkillSpec` 不绑任何具体领域，纯 name/description/body/tools。
 * opt-in：不挂 skills 时行为与 0.2.x 一致（system prompt 不含 "Available skills"）。
 *
 * 注意（已知小限制，非本插件引入）：catalog 经 `transformSystemPromptBeforeLlm` 追加在 **pipe 之后**，
 * 而 `SessionConfigView.systemPrompt`（token-budget / autoCompaction 读的）暴露的是 **pipe 前**的 base，
 * 故 catalog 的字节不计入 token 估算。catalog 仅 name+description、体积小，影响可忽略。
 *
 * W25 热重载：specs 入参放宽为 `SkillSpecSource`（数组快照 或 供应函数）。供应函数形态下
 * catalog 在**每次 transformSystemPromptBeforeLlm（即每轮 LLM call）**现读构建——loader.reload()
 * 原子换入新目录视图后，下一请求的 system prompt 即携新 catalog；数组形态逐字节旧行为。
 */

import { Type } from "../index.js";
import type {
  HarnessTool,
  Hook,
  HookContext,
  ToolExecResult,
} from "../index.js";
import { KEY_ACTIVATED } from "./deferred-tools.js";

export interface SkillSpec {
  /** 技能名，调 `skill` 工具时按此名取回。catalog 内唯一。 */
  name: string;
  /** 进 catalog 给模型选用的简短描述（whenToUse 性质）。 */
  description: string;
  /** invoke 时注入的全文 prompt —— 只在被调用时进 toolResult，**绝不进 catalog**。 */
  body: string;
  /** 可选：invoke 时激活的工具名（复用 O1 的 deferred.activated 激活集）。 */
  tools?: string[];
}

export interface SkillsOptions {
  /** `skill` 工具名 —— 默认 `"skill"`。 */
  toolName?: string;
}

/**
 * W25 规格源：数组快照（旧调用面）或供应函数（热重载面）。
 * 供应函数由 loader 提供，每次调用返回**当前**原子换入后的目录视图（并发纪律：
 * reload 在扫描完成后一次性换视图，供应函数永远返回完整一致的快照，绝不见半新半旧）。
 */
export type SkillSpecSource = readonly SkillSpec[] | (() => readonly SkillSpec[]);

/**
 * catalog 块渲染唯一口径（W25 单点）：hook 每轮追加的尾块与 loader 嗅探基线
 * 必须逐字节同源，否则 context.notice 的 diff 对不上实际交付文本。
 * 只读 name + description，**绝不触碰 body**（懒读纪律，见 loader.ts）。
 */
export function renderSkillCatalog(toolName: string, specs: readonly SkillSpec[]): string {
  return (
    `\n\n## Available skills\n` +
    `Invoke the \`${toolName}\` tool with a skill name to load its full instructions.\n` +
    specs.map((s) => `- ${s.name}: ${s.description}`).join("\n")
  );
}

export function skills(
  specs: SkillSpecSource,
  opts: SkillsOptions = {},
): { hook: Hook; tool: HarnessTool } {
  const getSpecs: () => readonly SkillSpec[] =
    typeof specs === "function" ? specs : () => specs;

  // 构造期 fail-loud：空集 / 重名直接抛，别等运行时静默退化（供应函数形态首调校验，同语义）。
  const initial = getSpecs();
  if (initial.length === 0) {
    throw new Error("skills(): specs must be non-empty");
  }
  const initialNames = new Set<string>();
  for (const spec of initial) {
    if (initialNames.has(spec.name)) {
      throw new Error(`skills(): duplicate skill name "${spec.name}"`);
    }
    initialNames.add(spec.name);
  }

  const toolName = opts.toolName ?? "skill";

  const hook: Hook = {
    name: "skills",
    transformSystemPromptBeforeLlm(systemPrompt) {
      // W25：每轮现读当前 catalog（热重载换入后下一请求即见新清单）；只含 name + description，绝不含 body。
      return systemPrompt + renderSkillCatalog(toolName, getSpecs());
    },
  };

  const tool: HarnessTool = {
    name: toolName,
    description:
      "Load a skill's full instructions by name. " +
      "Available skill names are listed under '## Available skills' in the system prompt.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the skill to load." }),
    }),
    // 可能写 ctx.state（激活集），且注入语义应顺序化 —— 屏障型。
    isConcurrencySafe: () => false,
    async execute(args, ctx: HookContext): Promise<ToolExecResult> {
      const name = args.name as string;
      // W25：按名解析走现读（reload 后新增/移除的 skill 即刻生效，无快照粘滞）。
      const current = getSpecs();
      let spec: SkillSpec | undefined;
      for (const s of current) {
        if (s.name === name) {
          spec = s;
          break;
        }
      }
      if (!spec) {
        const available = current.map((s) => s.name).join(", ");
        throw new Error(`unknown skill "${name}" (available: ${available})`);
      }

      if (spec.tools?.length) {
        const cur = ctx.state.get(KEY_ACTIVATED) ?? new Set<string>();
        ctx.state.set(KEY_ACTIVATED, new Set([...cur, ...spec.tools]));
      }

      const note = spec.tools?.length
        ? `\n\n(activated tools: ${spec.tools.join(", ")} — available next turn.)`
        : "";
      return { content: [{ type: "text", text: spec.body + note }] };
    },
  };

  return { hook, tool };
}
