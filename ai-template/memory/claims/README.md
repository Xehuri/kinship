# Claims Sidecar

> 独立、只读校验的断言侧车。当前不参与任何注入，也不改写现有记忆文件。

## 边界

- **仅侧车**：`claims.jsonl` 是新增数据源，现有 `{AI目录}/memory/` 文件、frontmatter、注入清单均不改。
- **不注入**：主会话常驻 6 件、批次角色注入 5 件 core 的口径保持不变；本目录不被任何注入列表引用。
- **不自动裁决**：矛盾不会自动消解；`superseded` 必须由人工或显式流程写入，且需有新的带来源断言。
- **不生成投影**：`projection_targets` 只是建议性字符串，本侧车不创建、不改写任何投影文件。
- **不使用向量或 FTS5**：纯 JSONL 文件，无 embedding、无索引库、无全文检索依赖。
- **追加式**：新增断言只追加行；当前快照内每个 `claim_id` 只出现一次，历史由 git 保存。
- **空文件起步**：模板随附的 `claims.jsonl` 为 0 字节空文件，不预置任何断言。

## 行格式

每条断言一行 JSON，字段顺序固定：

```json
{"claim_id":"claim_0123456789ab","version":1,"subject":"用户","predicate":"偏好","object":"{偏好值}","status":"active","confidence":"certain","valid_from":"{date}","source":{"path":"{AI目录}/memory/profile/core-lite.md","line":1,"quote":"{原文片段}"},"supersedes":null,"projection_targets":["profile/core-lite.md#{段落}"],"updated_at":"{带时区的 ISO-8601 时间}"}
```

- `claim_id`：`claim_` + 12 位小写十六进制，由 `subject`、`predicate`、`object` 以 `sha256` 确定性生成。示例值为占位，实际值必须按三元组重算。
- `version`：正整数；新建断言从 `1` 开始。
- `status`：`active` | `superseded` | `disputed` | `retired`。
- `confidence`：`certain` | `probable` | `uncertain`。
- `valid_from`：`YYYY-MM-DD`。
- `source.path`：仓库相对路径；`source.line` 必须存在；`source.quote` 必须出现在该行或前后 2 行内。
- `supersedes`：`null` 或另一个已存在的 `claim_id`；不得成环。
- `projection_targets`：建议性字符串列表，不做存在性校验。
- `updated_at`：带时区的 ISO-8601 时间。

文件按 `claim_id` 升序排列，UTF-8 编码，一行一个对象。

## 投影策略占位

`projection-policy.json` 只描述投影策略，不参与注入：

```json
{
  "schema_version": 1,
  "mode": "legacy",
  "snapshot_dir": "{项目根目录}/.memory-projection/legacy-snapshot",
  "claims_hash": ""
}
```

- `mode`：`legacy` 表示不使用 claims 生成投影；后续切换由显式流程决定。
- `snapshot_dir`：快照目录，使用 `{项目根目录}` 占位，实例初始化时替换。
- `claims_hash`：空字符串表示尚未绑定 claims 快照；写入前必须由校验流程计算。

## 校验

如实例提供 `{AI目录}/analysis/memory_claims.py`，可在仓库根执行：

```bash
{Python解释器路径} {AI目录}/analysis/memory_claims.py check \
  --root . --claims {AI目录}/memory/claims/claims.jsonl
```

输出 JSON 摘要；有错误时退出码为 1。摘要字段包括 `claims`、`active`、`unsourced`、`schema_errors`、`duplicate_ids`、`cycles`、`errors`。

```bash
{Python解释器路径} {AI目录}/analysis/memory_claims.py list
{Python解释器路径} {AI目录}/analysis/memory_claims.py list --json
```

只列出 `status=active` 的断言。模板不随附该脚本，是否启用由实例决定。

## 校验规则

1. 每行必须是 JSON 对象，字段集合与顺序符合上表。
2. `claim_id` 格式正确，且与三元组重新计算的结果一致；同一快照内不得重复。
3. `version`、`valid_from`、`updated_at` 类型与格式合法。
4. `status`、`confidence` 必须在枚举内。
5. `source.path` 必须位于仓库内且文件存在；`source.line` 必须在文件行数范围内；`source.quote` 必须精确出现在该行前后 2 行内。
6. `supersedes` 必须指向文件中存在的 `claim_id`，且不得形成环。
7. 文件必须按 `claim_id` 升序排列。
