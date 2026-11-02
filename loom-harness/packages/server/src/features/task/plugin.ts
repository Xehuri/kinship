/**
 * task Feature Plugin（P1 第三个抽离）：task_fetch 工具构造从 tool-wiring 迁入本工厂。
 *
 * 只抽读侧取件工具，不动 task 派发/task_cancel（仍在 tool-wiring）。依赖经工厂闭包注入
 * （不扩宽通用 PluginContext）：store = loom-sessions.jsonl 转录库，kernel = task_id→sid
 * 双索引解析源。`plugins.task.enabled=false` 时 Host 不调用 setup，工具面自然缺席。
 */

import type { SessionStore } from "@axeuh/loom-core";
import type { SpawnKernel, TaskIndexPort } from "@axeuh/loom-core/kernel";
import { definePlugin, type LoomFeaturePlugin } from "@axeuh/loom-plugin-sdk";

import { TASK_MANIFEST } from "../../plugin-host/builtins.js";
import { createTaskFetchTool } from "../../serve/task-fetch.js";

export interface TaskPluginDeps {
  readonly store: SessionStore;
  readonly kernel?: SpawnKernel;
}

export function createTaskPlugin(deps: TaskPluginDeps): LoomFeaturePlugin {
  return definePlugin({
    manifest: TASK_MANIFEST,
    setup: () => ({
      tools: [
        createTaskFetchTool({
          store: deps.store,
          ...(deps.kernel === undefined
            ? {}
            : {
                taskIndex: {
                  resolve: (taskId: string) => {
                    const rec = deps.kernel!.getSub(taskId);
                    return rec === undefined
                      ? undefined
                      : { sessionId: rec.row.session_id, status: rec.state };
                  },
                } satisfies TaskIndexPort,
              }),
        }),
      ],
    }),
  });
}
