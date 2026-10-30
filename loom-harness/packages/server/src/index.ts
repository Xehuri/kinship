// @axeuh/loom-server 占位导出（后续任务将实现 HTTP/SSE 服务与 CLI 入口）
export const LOOM_SERVER_PLACEHOLDER = "server" as const;

// T26：HTTP 骨架（router / auth / body / sse），见 docs/05-http-framework-decision.md
export * from "./http/index.js";

// T32：假模型 provider 接线（loom.yaml models[].provider: fake → 可注入 FakeModel）+ 离线守卫
export * from "./fake-model/index.js";

// T29：事件域 SSE 多订阅者扇出枢纽（D33 修正一）+ 前端硬契约信封
export * from "./events/index.js";

// T27：会话域 API（发送/语音中止再发/历史游标分页/中止/状态）
export * from "./session-api/index.js";
