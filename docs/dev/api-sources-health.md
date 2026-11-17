# 数据源健康接口契约（GET /api/sources/health）

状态：已实现（T2B，2026-10-24；字段核对 2026-11-17）。移动端设置页已接入
（`frontend/mobile/src/api/sources.ts` + `components/settings/SettingsSources.vue`），
401/404/网络异常在前端归一为"不可用"，不会补齐或编造来源。

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
| `realtime` | 进程内 SSE hub 的 `has_subscribers`，`loom` 与 `opencode` 两个 hub **任一**有订阅即算在线（`services/source_health.py` 的 `_sse_connected`） | `null` | `null` | 任一双通道 hub 有订阅为 `ok`，否则 `offline`。WebSocket 连接表未纳入本字段 |
| `loom` | `services.loom_health.get_loom_health()` 的后台探测缓存 | `null` | 探测 `checked_at` | 在线且探测 60 秒内为 `ok`；在线但探测过期或离线为 `stale`/`offline`；首次探测未完成为 `unknown` |
| `files` | `ai/data/daily/{date}/perception.jsonl` 最新分片 | 文件行数 | 文件 mtime | 最新分片为今日且 10 分钟内有写入为 `ok`；分片非今日或写入超 10 分钟为 `stale`；无分片为 `offline` |

补充：

- `phone_health` 使用当前认证用户的 `user_id`；`mi_cloud` 使用配置
  `health.primary_user`，未配置时回退当前用户。
- `mi_cloud` 不触发网络探测（`probe=False`），只读状态文件与云分片。
  `phase` 落在已知五种（`disabled`/`unconfigured`/`auth_expired`/`error`/`syncing`）
  之外时返回 `unknown` 并回显原值；`phase=ok` 但没有任何成功记录时同样返回
  `unknown`（`detail` = 尚无成功同步记录）。
- `loom` 依赖后端 lifespan 启动的后台健康探针；探针未运行时返回 `unknown`，
  不会主动同步等待 Loom。
- **`loom` 只反映 Loom 通道**：`ai_backend` 不是 `loom` 时（例如当前生产实例跑
  `dsh`），后端启动期的 `ai_surface` 不会启动 Loom 探针，该来源恒为 `unknown`
  （`detail` = 尚未完成 Loom 健康探测）——它**不代表** AI 运行时离线。活跃运行时的
  在线状态看 `GET /health` 的 `loom` / `dsh` 键（键恒存在，非当前通道时为未探测态）。

## 缓存

进程内 5 秒 TTL 缓存，按 `user_id` 隔离。缓存只避免同一用户 5 秒内重复扫描
文件，不改变状态判定逻辑；缓存过期后重新采集。后端重启即清空。

## 错误码

| 状态码 | 响应 | 触发条件 |
| --- | --- | --- |
| 401 | `{"detail": "未授权访问，请先登录"}` | 缺少/无效 Bearer Token（中间件直接返回） |
| 500 | `{"detail": "数据源健康检查失败"}` | 响应组装发生未预期异常；单个来源异常不会触发 |

## `/api/mobile/reports` 相关字段

同一批次的报告列表接口在旧字段之外新增两列（`size_bytes`、`kind`），并给出类别筛选与汇总；
既有字段、日期/标签筛选与排序规则不变：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `size_bytes` | `integer` | 报告文件字节数，取自现有 `os.stat` 结果 |
| `kind` | `string` | `daily` / `weekly` / `monthly` / `audit` / `other` |
| `family` | `string` | `health` / `daily` / `weekly` / `review`（用户面报告类别，决定 `families` 汇总） |

`kind` 由报告路径、标题和现有 frontmatter tags 推导，优先级：
`weekly`（每周/周报/周总结）→ `monthly`（每月/月度/月报/月总结）→
`audit`（复盘/回顾/审计/数据检查/核查）→ `daily`（日常理解/每日/理解/理解记录/
当日摘要/健康清单/`daily/` 路径）→ `other`。未命中任何关键词时回退 `other`。

查询参数新增可选 `family`（`health` / `daily` / `weekly` / `review`），未知取值返回
`400 {"detail": "未知报告类别"}`。响应为对象而非裸数组：

```json
{
  "reports": [
    {
      "path": "daily/2026-10-23/复盘-2026-10-23.md",
      "title": "复盘-2026-10-23",
      "date": "2026-10-23",
      "mtime": "2026-10-24T00:03:46",
      "tags": ["基础信息", "复盘报告", "感知分析"],
      "size_bytes": 8123,
      "kind": "audit",
      "family": "review"
    }
  ],
  "total": 1,
  "counts": {"health": 0, "daily": 0, "weekly": 0, "review": 1},
  "families": [
    {"id": "health", "label": "健康清单", "count": 0},
    {"id": "daily", "label": "日报", "count": 0},
    {"id": "weekly", "label": "周报", "count": 0},
    {"id": "review", "label": "复盘", "count": 1}
  ]
}
```

## 回滚

回滚为纯删除式，不涉及数据迁移：

1. 从 `backend/main.py` 删除 `from routers.sources import router as sources_router`
   和 `app.include_router(sources_router, prefix="/api")` 两行。
2. 删除 `backend/routers/sources.py`、`backend/services/source_health.py`、
   `backend/services/source_health_pc.py`。
3. 删除 `backend/tests/test_sources_health.py`。
4. 回滚报告字段：从 `backend/routers/mobile.py` 的 `list_reports` 响应中删除
   `size_bytes`、`kind`、`family` 三键与 `total`/`counts`/`families` 汇总、`family`
   查询参数，并删除 `_report_kind`/`_classify_report`；删除
   `backend/tests/test_mobile_reports.py`。
5. 重启后端使路由变更生效（本任务未执行重启/部署）。
6. 前端需同步回滚：移动端已有消费方（`frontend/mobile/src/api/sources.ts` 与
   `components/settings/SettingsSources.vue`），删除端点后设置页显示"不可用"而非
   自动降级——不要把它当作零影响删除；`frontend/mobile/e2e/visual-fixtures.ts`
   里也有该端点的 mock fixture 需一并处理。
