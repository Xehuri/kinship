# 贡献指南

感谢你考虑为 Kinship 做出贡献！

## 报告问题

- 在 GitHub Issues 报告 bug 或功能请求
- 描述问题时请包含：运行环境、复现步骤、期望行为和实际表现
- 安全相关问题请私下联系维护者，不要提交公开 Issue
- 不要提交 `config.yaml`、`auth.json`、`.env`、日志、用户数据、模型权重或任何密钥

## 提交改动

本仓库是公开仓库，欢迎通过 Issue 和 Pull Request 参与。维护者审查后合入；发布发行资产由维护者统一生成。

本地流程：

1. Fork 仓库并创建特性分支 (`git checkout -b feature/amazing-feature`)
2. 在本地提交改动 (`git commit -m 'feat(tools): 新增 XXX'`)
3. Push 分支并提交 Pull Request

修改发布相关代码时，请同时更新对应文档和测试；不要手动提交 `dist/`、构建产物或运行时数据。

## Commit 规范

提交信息使用中文，推荐采用带范围的约定式格式（**推荐，非强制，仓库不做校验**）：

```
<类型>(<范围>): <简要描述>

类型:
- feat:     新功能
- fix:      Bug 修复
- refactor: 重构
- style:    代码风格调整 (不影响功能)
- docs:     文档更新
- test:     测试相关
- chore:    构建/工具链相关
```

`(<范围>)` 可省略，用于标注改动模块，例如 `tools`、`ai`、`ai-template`、`backend`、`web-ui`、`chat`、`docs`。仓库历史中还存在大量不带类型前缀的中文提交（例如 `数据检查: ...`、`复盘 2026-09-12：...`），这类写法同样被接受。

示例：
```
feat(tools): 新增 fail-closed 公开导出工具 kinship_export
refactor(ai): AGENTS.md 精简，行为准则迁入 memory/self
fix(chat): 修复 SSE 用户消息双显
docs: 更新 README 中的 API 文档
```

## 开发规范

### Python (backend/)

- 遵循 PEP 8 编码规范
- 类型注解必须完整 (Python 3.10+)
- 路由在 `backend/routers/` 中定义，业务逻辑在 `backend/services/` 中实现
- 配置项在 `backend/config/config.py` 中声明，值通过 `config.yaml` 注入
- 新增功能需包含 pytest 测试

### TypeScript (frontend/mobile/)

- Vue 3 Composition API + `<script setup lang="ts">`
- 严格 TypeScript 模式 (`strict: true`)
- 状态管理使用 composables，不使用 Pinia/Vuex
- 新增功能需包含 Vitest 单元测试

### Kotlin (app/)

- 遵循 Kotlin 官方编码规范
- 分层架构: 网络层 -> 状态层 -> 采集层 -> UI 层
- 测试使用 JUnit 5 + MockK + Truth + Robolectric

## 项目结构

完整目录树与子系统地图见 [docs/dev/PROJECT_MAP.md](docs/dev/PROJECT_MAP.md)。顶层包括 `backend/`、`kernel/`（闭源音频内核）、`app/`、`frontend/mobile/`、`desktop/`、`ai/`、`ai-template/`、`tools/`、`validation/`、`scripts/`、`docs/`、`archive/`。

## 文档改动

先改唯一真源（见 [docs/README.md](docs/README.md) 的真源矩阵），再改入口；历史文档归档到 `docs/archive/`，不直接删除。提交前运行 `python3 tools/docs-check/check_docs.py all`。

## 开发环境设置

详见 [docs/ops/INSTALL.md](docs/ops/INSTALL.md) 的安装指南。
