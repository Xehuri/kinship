/**
 * todo Feature Plugin（P1 首个抽离）：工具构造从 tool-wiring 迁入本工厂。
 *
 * 依赖经工厂闭包注入（不扩宽通用 PluginContext）：boot 传入 todo.updated 上抛缝，
 * setup 返回唯一工具 todowrite。`plugins.todo.enabled=false` 时 Host 不调用 setup，
 * 工具面自然缺席。
 */

import { definePlugin, type LoomFeaturePlugin } from "@axeuh/loom-plugin-sdk";

import { TODO_MANIFEST } from "../../plugin-host/builtins.js";
import { createTodoWriteTool, type TodoUpdatedSink } from "../../serve/todo-tool.js";

export interface TodoPluginDeps {
  readonly onUpdated: TodoUpdatedSink;
}

export function createTodoPlugin(deps: TodoPluginDeps): LoomFeaturePlugin {
  return definePlugin({
    manifest: TODO_MANIFEST,
    setup: () => ({
      tools: [createTodoWriteTool({ onUpdated: deps.onUpdated })],
    }),
  });
}
