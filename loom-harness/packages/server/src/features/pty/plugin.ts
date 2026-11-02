/**
 * pty Feature Plugin（P1 第二个抽离）：五工具面与 dispose 生命周期从 tool-wiring 迁入本工厂。
 *
 * 依赖经工厂闭包注入（不扩宽通用 PluginContext）：
 *   - defaultWorkdir/workspaceRoot = boot 归一后的 workspace realpath；
 *   - validateSpawn = boot 的惰性授权闭包（wiring.executor.authorizeTool，同一条 D7 缝）；
 *   - onExit = pty 退出通知出口。
 * setup 构造唯一 PtyManager 并返回五工具；Host stop 经 contribution.stop 调 dispose。
 * `plugins.pty.enabled=false` 或 `pty.enabled=false` 时 Host 不调用 setup，工具面自然缺席。
 */

import { definePlugin, type LoomFeaturePlugin } from "@axeuh/loom-plugin-sdk";
import {
  createPtyFeature,
  type PtyCaps,
  type PtyExitNotifier,
  type PtyToolOptions,
} from "@axeuh/loom-tools/pty";

import { PTY_MANIFEST } from "../../plugin-host/builtins.js";

export interface PtyPluginDeps {
  readonly defaultWorkdir: string;
  readonly workspaceRoot: string;
  readonly caps?: Partial<PtyCaps>;
  readonly onExit?: PtyExitNotifier;
  readonly validateSpawn: (
    command: string,
    args: readonly string[],
    workdir: string,
  ) => void | Promise<void>;
  readonly log?: PtyToolOptions["log"];
  readonly now?: () => number;
}

export function createPtyPlugin(deps: PtyPluginDeps): LoomFeaturePlugin {
  return definePlugin({
    manifest: PTY_MANIFEST,
    setup: () => {
      const feature = createPtyFeature({
        defaultWorkdir: deps.defaultWorkdir,
        workspaceRoot: deps.workspaceRoot,
        ...(deps.caps === undefined ? {} : { caps: deps.caps }),
        ...(deps.onExit === undefined ? {} : { onExit: deps.onExit }),
        validateSpawn: deps.validateSpawn,
        ...(deps.log === undefined ? {} : { log: deps.log }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      return {
        tools: [...feature.tools],
        stop: () => feature.dispose(),
      };
    },
  });
}
