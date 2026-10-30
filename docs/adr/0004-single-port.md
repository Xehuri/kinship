# ADR 0004：单一 server.port，ssl.enabled 只决定协议

- 状态：已实施
- 日期：2026-10-29
- 相关任务：1、2、29

## Context

改造前后端有两个端口键：`server.http_port` 与 `server.https_port`，同时 `ssl.enabled` 决定用哪个。实际部署里 HTTPS 8768、历史 8769 是双监听习惯，但生产只对外暴露 8768，历史 8769 仅本地开发。双键带来四个问题：

1. 配置、客户端、文档、CORS 白名单各维护两份端口。
2. `ssl.enabled` 翻转时端口也跟着变，反向代理与防火墙要同步两处。
3. Android、Web、桌面端的默认地址容易出现 8768 与历史 8769 混用。
4. 单进程 uvicorn 只能监听一个 socket，双端口实际需要两个 server 或外部转发。

## Decision

1. 唯一端口键 `server.port`，默认 8768，范围 1 到 65535（`backend/config/config_schema.py:246-248`）。`server.host` 仍在同一节（`backend/config/config_schema.py:244-245`）。

2. 协议只由 `ssl.enabled` 决定。`ssl.enabled=true` 且证书、私钥文件都存在时启用 TLS；请求了 TLS 但文件不可用时记录 WARNING 并回退 HTTP，端口不变（`backend/core/hot_server.py:135-151`、`backend/core/hot_server.py:169`）。`ssl.cert` 与 `ssl.key` 的键定义在 `backend/config/config_schema.py:255-260`。

3. 兼容别名。`BACKEND_PORT` 读取 `server.port`；`BACKEND_HTTP_PORT` 与 `BACKEND_HTTPS_PORT` 变成只读别名，恒等于 `BACKEND_PORT`（`backend/config/config.py:279-292`）。旧调用点不用一次性全改，但值只有一个来源。

4. 旧双键内存迁移。加载配置时若 `server.port` 缺失且存在 `http_port` 或 `https_port`，按以下规则折算并写回内存文档：两个旧键都在时，若 `ssl.enabled=true` 且证书与私钥文件就绪则选 `https_port`，否则选 `http_port`；只有一个旧键时选它（`backend/config/store.py:344-388`）。迁移幂等，同一组合只告警一次（`backend/config/store.py:372-387`）。

5. 文档与检查。`scripts/check_ports.sh:1-33` 禁止文档、App、桌面端出现未标注的历史 8769；历史提及必须带“已废弃”“历史”或“was 8769”。

## Consequences

正面：

- 配置、客户端、反向代理、防火墙只有一个端口事实。
- 协议切换不改变监听端口，代理配置稳定。
- 旧配置不需要手工改键，启动时自动折算并告警。
- CORS 白名单仍能同时覆盖 http 与 https 的本地来源，因为两个别名相等（`backend/main.py:739-748`）。

代价与边界：

- 破坏性变更。仍在使用双端口的外部脚本、书签、frp 配置必须改到 `server.port`；旧键只在内存里折算，不会回写 config.yaml。
- `ssl.enabled=true` 但证书缺失时静默降级为 HTTP，调用方可能以为仍是 HTTPS；日志有 WARNING，健康检查不会因此失败。
- 迁移只处理 `server.port` 缺失的情况。若三个键同时存在，以 `server.port` 为准，旧键被忽略且不再告警。
- 单端口意味着开发模式也不能同时开 HTTP 与 HTTPS。本地 HTTP 开发要把 `ssl.enabled` 设为 false，端口仍是 8768。
- 历史 8769 在旧文档与 Loom 旧文档中仍有提及。`check_ports.sh` 只覆盖 App、桌面端、docs 与两个 README，其他目录不在检查范围。

## Alternatives

1. 保留双端口，`ssl.enabled` 选其中一个。否决：两个 socket 需要两个 uvicorn 实例或前置代理，进程模型复杂化，且与单父进程模型冲突。
2. 同一端口做协议自动嗅探，按 TLS ClientHello 与明文 HTTP 分流。否决：uvicorn 不提供该能力，需要自己写前置监听与连接转发，故障面远大于收益。
3. 只保留 `server.port`，不做旧键迁移。否决：现有生产 config.yaml 会直接失效，升级需要手工改配置，违反迁移可回滚的约束。
4. 保留历史 8769 作为开发默认端口。否决：双默认值会让客户端与文档继续分叉，正是本次要消除的问题。
