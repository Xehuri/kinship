# 数据源健康接口契约（GET /api/sources/health）

状态：已实现（T2B，2026-10-24）。本接口为纯增量能力，前端可不接入。

## 请求

| 项 | 值 |
| --- | --- |
| 路径 | `/api/sources/health` |
| 方法 | `GET` |
| 鉴权 | 标准 `Authorization: Bearer <token>`，由全局 `AuthMiddleware` 校验 |
| 查询参数 | 无。本路径不在 `QUERY_CREDENTIAL_PATH_PREFIXES`，`?token=` 一律忽略 |
| 请求体 | 无 |

未携带有效 Bearer Token 时返回 `401 {"detail": "未授权访问，请先登录"}`。

## 200 响应

`generated_at` 为东八区 ISO 8601 时间（`+08:00`）。`sources` 固定六项，顺序固定为
`phone_health`、`mi_cloud`、`pc_sensor`、`realtime`、`loom`、`files`。

```json
{
  "generated_at": "2026-10-24T18:07:41+08:00",
  "sources": [
    {
      "id": "phone_health",
      "name": "手机健康数据",
      "status": "stale",
      "last_sync": "2026-09-23T00:19:40+08:00",
      "records": 763,
      "detail": "分片 2026-09-22 最后写入已超过 6 小时"
    },
    {
      "id": "mi_cloud",
      "name": "小米健康云",
      "status": "ok",
      "last_sync": "2026-10-24T18:07:35+08:00",
      "records": 1017,
      "detail": "最近一次同步成功"
    },
    {
      "id": "pc_sensor",
      "name": "PC 感知采集",
      "status": "stale",
      "last_sync": "2026-10-23T21:42:55+08:00",
      "records": 530,
      "detail": "分片 2026-10-23 最后 PC 上报已超过 10 分钟"
    },
    {
      "id": "realtime",
      "name": "实时事件流",
      "status": "offline",
      "last_sync": null,
      "records": null,
      "detail": "当前无 SSE 订阅连接"
    },
    {
      "id": "loom",
      "name": "Loom AI 后端",
      "status": "unknown",
      "last_sync": null,
      "records": null,
      "detail": "尚未完成 Loom 健康探测"
    },
    {
      "id": "files",
      "name": "每日感知文件",
      "status": "ok",
      "last_sync": "2026-10-24T18:07:11+08:00",
      "records": 3892,
      "detail": "今日分片最近 10 分钟内有写入"
    }
  ]
}
```

`records` 为 `null` 表示该来源没有可计数的记录概念或无法读取，绝不填伪造值。
`last_sync` 为 `null` 表示没有可验证的最后同步时间。

## 状态语义

| status | 含义 |
| --- | --- |
| `ok` | 最近有可验证的新数据或服务状态正常 |
| `degraded` | 来源已配置/可达，但最近一次同步或解析失败 |
| `stale` | 有历史数据，但最后一次写入超过该来源的新鲜度阈值 |
| `offline` | 没有任何可验证数据，或来源被明确禁用/无活跃连接 |
| `unknown` | 采集过程无法确定状态（异常、首次探测未完成等），`detail` 给出原因 |

单个来源采集异常只把该来源降级为 `unknown`，接口仍返回 200。
只有响应组装本身发生未预期异常时才返回 `500 {"detail": "数据源健康检查失败"}`。

## 各来源判定口径

| id | 数据依据 | `records` | `last_sync` | 新鲜度/状态 |
| --- | --- | --- | --- | --- |
| `phone_health` | `ai/data/users/{user_id}/health/{date}/phone.json` 最新分片 | `samples` 数组长度 | 分片文件 mtime | mtime 6 小时内为 `ok`，否则 `stale`；无分片为 `offline`；解析失败为 `degraded` |
| `mi_cloud` | `HealthCloudService.status(probe=False)` + 主用户最新 `cloud.json` | `samples` 数组长度 | `last_success`；缺失时用分片 mtime | `phase=ok` 且 `last_success` 在 `max(2×poll_interval+10min, 1h)` 内为 `ok`，超时为 `stale`；`disabled`/`unconfigured` 为 `offline`；`auth_expired`/`error`/`syncing` 为 `degraded` |
| `pc_sensor` | 最近 7 天 `perception.jsonl` 中 `_source=pc_sensor` 的行 | 该分片内 PC 事件数 | 最后一条 PC 事件的 `t_iso`（缺失时回退 `ts`/`t`，再回退 mtime） | 最后事件 10 分钟内为 `ok`，否则 `stale`；近 7 天无事件为 `offline` |
| `realtime` | 进程内 SSE hub 的 `has_subscribers`（Loom 事件通道） | `null` | `null` | Loom 通道有订阅为 `ok`，否则 `offline`。WebSocket 连接表未纳入本字段 |
| `loom` | `services.loom_health.get_loom_health()` 的后台探测缓存 | `null` | 探测 `checked_at` | 在线且探测 60 秒内为 `ok`；在线但探测过期或离线为 `stale`/`offline`；首次探测未完成为 `unknown` |
| `files` | `ai/data/daily/{date}/perception.jsonl` 最新分片 | 文件行数 | 文件 mtime | 最新分片为今日且 10 分钟内有写入为 `ok`；分片非今日或写入超 10 分钟为 `stale`；无分片为 `offline` |

补充：

- `phone_health` 使用当前认证用户的 `user_id`；`mi_cloud` 使用配置
  `health.primary_user`，未配置时回退当前用户。
- `mi_cloud` 不触发网络探测（`probe=False`），只读状态文件与云分片。
- `loom` 依赖后端 lifespan 启动的后台健康探针；探针未运行时返回 `unknown`，
  不会主动同步等待 Loom。

## 缓存

进程内 5 秒 TTL 缓存，按 `user_id` 隔离。缓存只避免同一用户 5 秒内重复扫描
文件，不改变状态判定逻辑；缓存过期后重新采集。后端重启即清空。

## 错误码

| 状态码 | 响应 | 触发条件 |
| --- | --- | --- |
| 401 | `{"detail": "未授权访问，请先登录"}` | 缺少/无效 Bearer Token（中间件直接返回） |
| 500 | `{"detail": "数据源健康检查失败"}` | 响应组装发生未预期异常；单个来源异常不会触发 |

## `/api/mobile/reports` 增量字段

同一批次的报告列表接口新增两个只读字段，既有字段、筛选和排序完全不变：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `size_bytes` | `integer` | 报告文件字节数，取自现有 `os.stat` 结果 |
| `kind` | `string` | `daily` / `weekly` / `monthly` / `audit` / `other` |

`kind` 由报告路径、标题和现有 frontmatter tags 推导，优先级：
`weekly`（每周/周报/周总结）→ `monthly`（每月/月度/月报/月总结）→
`audit`（复盘/回顾/审计/数据检查/核查）→ `daily`（日常理解/每日/理解/理解记录/
当日摘要/健康清单/`daily/` 路径）→ `other`。未命中任何关键词时回退 `other`。

旧响应示例（字段仍保留）：

```json
{
  "path": "daily/2026-10-23/复盘-2026-10-23.md",
  "title": "复盘-2026-10-23",
  "date": "2026-10-23",
  "mtime": "2026-10-24T00:03:46",
  "tags": ["基础信息", "复盘报告", "感知分析"],
  "size_bytes": 8123,
  "kind": "audit"
}
```

## 回滚

回滚为纯删除式，不涉及数据迁移：

1. 从 `backend/main.py` 删除 `from routers.sources import router as sources_router`
   和 `app.include_router(sources_router, prefix="/api")` 两行。
2. 删除 `backend/routers/sources.py`、`backend/services/source_health.py`、
   `backend/services/source_health_pc.py`。
3. 删除 `backend/tests/test_sources_health.py`。
4. 回滚报告字段：从 `backend/routers/mobile.py` 的 `list_reports` 响应字典中删除
   `size_bytes`、`kind` 两键，并删除 `_report_kind` 函数；删除
   `backend/tests/test_mobile_reports.py`。
5. 重启后端使路由变更生效（本任务未执行重启/部署）。
6. 前端把 404 或缺失字段视为 `unknown`，无需同步发布。

回滚后 `/api/sources/health` 返回 404，`GET /api/mobile/reports` 恢复旧响应形状。
