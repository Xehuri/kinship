# 05 - HTTP 框架选型决策（T26，已冻结）

> 状态：**FROZEN（方案 A）**。本节记录决策与权衡；除非出现推翻性事实，后续任务（T27-T32）一律基于此实现，不再重开选型。
> 对应计划：`docs/02-实施计划-v1.md` 的 "Decision: HTTP framework" 与 "### T26"。

## 结论

采用 **方案 A：裸 `node:http` + 手写 method/path router + JSON body reader + SSE writer helper**。
新增外部运行时依赖数 = 0（server 包 package.json 不变），冻结不变量「pi-ai 是唯一外部运行时依赖」保持成立。

## 权衡表

| 维度 | A. 裸 node:http（选定） | B. express / fastify | C. vendor 一个 ~200 行 MIT 小路由 |
|---|---|---|---|
| 新增运行时依赖 | 0 | 是（直接违反冻结不变量） | 0 |
| 依赖面 / 供应链风险 | 仅 Node stdlib | express 系中等、fastify 系偏重（schema 生态更重） | 需自行长期维护 vendored 代码 |
| SSE 帧控制 | 完全自控（`data:` 行 + 空行、绝不写 `event:`，逐字节可测） | express 需手写、fastify 有插件（又一依赖） | 路由可借，SSE 反正要自己写，收益减半 |
| 前端信封兼容责任 | 自控即职责：信封 `{payload:{type,properties}}` 的约束由本层测试锁死 | 框架无关，仍需自控 | 同左 |
| Node 20 兼容 | 原生保证 | 需跟踪各框架对 Node 20 的支持矩阵 | 需审计 vendored 代码的兼容性 |
| 规模匹配 | 全 API ~15 端点 / 5 域，手写 plumbing ~150-250 LOC 一次性成本 | 样板更少，但引入的中间件模型本项目用不满 | 比 A 少几十行，但多养一份外部代码所有权 |
| 404/405/413 等语义 | 手写（已实现并有测试） | 框架代劳 | 路由部分代劳 |

## 为什么拒绝 B

计划冻结的硬约束是「pi-ai 是唯一外部运行时依赖」。express/fastify 直接违反；
且本服务真实需求（token 鉴权中间件、`:param` 路由、JSON body、SSE 扇出）全部是薄层，
框架价值主张（生态中间件、插件系统）在这里没有消费方，属于为 15 个端点买一整个运行时。

## 为什么 C 只是 fallback 而非首选

路由表本身约 100 行即完成（method 匹配 + 段级 `:param` + 405 探测）；vendored 代码带来的
许可证审计、后续合并、安全响应责任 > 省下的几十行。A 与 C 的差值是边际的，A 的所有权更干净。

## 实现落点（本决策的交付物）

`packages/server/src/http/`：

- `router.ts` — `Router.add(method, pathPattern, handler)` 注册式路由；`:param` 整段捕获；
  鉴权先于匹配（未知路径无 token 返回 401 而非 404，不泄漏路由表形状）；handler 异常统一
  映射 JSON 错误体（`{error:{code,message}}`）；未注册方法 405。
- `auth.ts` — `TokenAuth`：`Authorization: Bearer <t>` 或 `X-Loom-Token: <t>`；token 列表由
  构造参数注入；sha256 摘要 + `timingSafeEqual` 定长比较（防时序侧信道）；**没有未鉴权路径**，
  health 端点同样要求 token（前端可带 token——此要求刻意保留，见下）。
- `body.ts` — `readJsonBody`：上限 1MB（`Content-Length` 预检 + 流式累计双保险）→ 413；
  `Content-Type` 非 `application/json` → 415；坏 JSON → 400；空 body → `undefined`。
- `sse.ts` — `startSseStream`（`text/event-stream` / `no-cache` / `X-Accel-Buffering: no` /
  keep-alive）+ `writeSseFrame(res, obj)`：**只写 `data:` 行 + 空行，绝不写 `event:` 字段**
  （前端 `EventSource.onmessage` 硬约束，见计划 §约束-前端硬合同）。附 `writeSseKeepalive` 注释帧。
- `errors.ts` / `respond.ts` / `types.ts` — `HttpError`（status+code）、JSON 出口、handler 类型。

### SSE 会话事件枚举（与会话生命周期）

帧形状不变：只写 `data:` 行，不写 `event:` 行；信封 `{payload:{type,properties}}`，`properties` 恒存在。会话域事件：

| 事件 | 用途 |
|---|---|
| `session.created` | 会话建立 |
| `session.status` | 会话/回合状态推进（`session-start`、`turn-start` 投影） |
| `session.idle` | 回合结束、会话空闲；必带 `sessionID`（并镜像 `id`，否则 UI 挂 120s） |
| `session.error` | 回合错误 |
| `session.queue` | 待发队列快照；`properties={pending:[{text,at,state}],sessionID}`，state 为 `queued`/`running`/`drained`；队列每次变化都发，空队列也发 |

## health 端点也要 token 的理由（留档）

D33 的 health 端点不设公开路径：本机 launcher/网关在切换日会带 token 探测，而「无未鉴权路径」
是单一规则的审计成本最低形态——白名单每多一条，泄露面与心智负担都是乘法。若未来运维要求
匿名 liveness，届时以显式决策改冻结，而不是现在预留后门。

## 测试口径

`npx vitest run packages/server/src/http`：router.test.ts 覆盖 401（无/错 token）→ 200（Bearer /
X-Loom-Token）→ 404（未知路由）→ 405（方法不符）→ `:param` → handler 抛错 500 → SSE 帧形状；
body.test.ts 覆盖 200/415/400/413。全部 `listen(0)` ephemeral 端口（内核分配，不触碰 5096 固定
端口；部署默认端口 5097 由 T31 的 serve CLI 决定），每测试内 `closeAllConnections + close`，
不留句柄。
