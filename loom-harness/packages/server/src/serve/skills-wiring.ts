// W5-A serve 装配 —— skills 接线（T24 loader 的调用方，loader 本体不动）。
//
// 接线图（loader.ts 头注释冻结的口径）：`loadSkills({allowlist})` →
//   - `hook`  → 进主会话（SessionRegistry.hooks → MainSessionLoop.extraHooks）
//               与副会话（createSideSessionPort.hooks）及 task 子会话（tool-wiring extraHooks）；
//   - `tool`  → 进 D7 单缝共用工具面（tool-wiring extraTools，trace.wrapAll 同批包痕）。
// 语义分工（与 loader 一致，装配层不放宽）：
//   - 配置级错误（allowlist 不可读 / 扫零有效 skill）→ loader 抛，装配期响亮 = boot 失败；
//   - 数据级坏项（坏 frontmatter / 缺 description / 重名）→ loader degrade，本模块逐条
//     warn 落 journald（观测面：`journalctl -u axeuh-loom | grep 'loom skills degrade'`）。

import type { HarnessTool, Hook } from "@axeuh/loom-core";
import {
  loadSkills,
  type SkillDegrade,
  type SkillEntry,
  type SkillsLoader,
} from "@axeuh/loom-core/skills/loader";

type WiringLog = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown>,
) => void;

export interface ServeSkillsWiring {
  readonly hook: Hook;
  readonly tool: HarnessTool;
  /** W25 起为 loader 活读面：reload 成功换入后即刻新值（观测/manifest 数据源）。 */
  readonly entries: readonly SkillEntry[];
  readonly degraded: readonly SkillDegrade[];
  readonly loader: SkillsLoader;
}

export interface ServeSkillsWiringOptions {
  /** loom.yaml skills.allowlist（目录白名单，绝对/相对 cwd 由 loader 归一）。 */
  readonly allowlist: readonly string[];
  readonly log?: WiringLog;
}

export async function createServeSkillsWiring(
  opts: ServeSkillsWiringOptions,
): Promise<ServeSkillsWiring> {
  const log = opts.log ?? (() => {});
  const loader = await loadSkills({ allowlist: opts.allowlist });

  for (const entry of loader.entries) {
    log("info", "loom skill loaded", {
      name: entry.name,
      file: entry.file,
      ...(entry.tools === undefined ? {} : { tools: [...entry.tools] }),
    });
  }
  for (const d of loader.degraded) {
    log("warn", "loom skills degrade", {
      dir: d.dir,
      ...(d.file === undefined ? {} : { file: d.file }),
      reason: d.reason,
    });
  }

  return {
    hook: loader.hook,
    tool: loader.tool,
    get entries() {
      return loader.entries;
    },
    get degraded() {
      return loader.degraded;
    },
    loader,
  };
}
