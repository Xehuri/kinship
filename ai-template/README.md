# AI 工作目录模板（ai-template）

`ai-template/` 是 AI 工作目录的干净模板：不含真实数据、密钥、账号与实例绝对路径。新部署从本目录复制出一份 `{AI目录}`（通常为 `ai/`），填入占位符后即可接入后端。

模板同时适配两种 AI 后端：

| 后端 | 定位 | 配置入口 |
|------|------|----------|
| Loom | 生产推荐，独立进程 | `{AI目录}/.loom/config.yaml`，示例见 `loom-config.example.yaml` |
| OpenCode | 遗留/可选后端，模板不随附配置，生产用 Loom | 需自行创建 `{AI目录}/opencode.json`；MCP 脚本见 `mcp/ai_mcp.py` |

## 复制到 ai/

在仓库根目录执行（仅在全新部署时使用，不要覆盖已有实例）：

```bash
cp -r ai-template ai
```

若目标目录已存在且只想补齐模板文件：

```bash
cp -a ai-template/. ai/
```

复制完成后按顺序处理：

1. 按《占位符替换清单》替换 `{项目名称}`、`{主智能体名称}`、`{AI目录}` 等占位符。
2. 在项目根 `config.yaml` 配置后端端口、SSL、`ai_backend` 与 `data.*` 路径；AI 目录侧只填 `{AI目录}/.loom/config.yaml`。模板不再随附 OpenCode 配置，确实要用 OpenCode 时需自行创建 `opencode.json`。
3. 选 Loom：把 `loom-config.example.yaml` 复制为 `{AI目录}/.loom/config.yaml`，替换 Provider、模型与凭据环境变量；在项目根 `config.yaml` 设 `ai_backend: loom`。
4. 模板不再随附 OpenCode 配置。若确实要用 OpenCode，自行创建 `{AI目录}/opencode.json`，并把 MCP 命令注册为 `python mcp/ai_mcp.py`，cwd 指向 `{AI目录}`。
5. 启动后端（见 `启动说明.md`），然后按 `系统初始化指南.md` 完成首次初始化。

## 占位符表

完整清单与替换规则以 `系统初始化指南.md` 的「占位符替换清单」为准。常用项：

| 占位符 | 含义 | 主要出现位置 |
|--------|------|--------------|
| `{项目名称}` | 实例/服务名 | `AGENTS.md`、`mcp/ai_mcp.py` |
| `{主智能体名称}` | 主智能体人格名 | `AGENTS.md`、`agents/*.md` |
| `{用户称呼}` | 用户希望被称呼的名字 | `memory/` |
| `{AI目录}` | AI 工作目录（相对项目根，通常为 `ai`） | 全模板 |
| `{项目根目录}` | 仓库根绝对路径 | `loom-config.example.yaml` |
| `{后端HTTPS端口}` / `{后端HTTP端口}` | 后端监听端口 | 项目根 `config.yaml` |
| `{OpenCode端口}` | OpenCode 服务端口 | 项目根 `config.yaml` |
| `{Python解释器路径}` | Python 解释器绝对路径 | `loom-config.example.yaml`、项目根 `config.yaml` |
| `{opencode.cmd路径}` | OpenCode 可执行文件路径 | 项目根 `config.yaml` |
| `{SSL证书路径}` / `{SSL密钥路径}` | HTTPS 证书与私钥路径 | 项目根 `config.yaml` |
| `{百度地图AK}` | 百度地图开放平台 AK | `analysis/geocode_tool.py` |
| `{MiMo密钥}` / `{DashScope密钥}` | 可选第三方 API 密钥 | 项目根 `config.yaml` |
| `{PROVIDER_HOST}` | 云模型 Provider 域名 | `loom-config.example.yaml` |
| `{主模型ID}` / `{本地对照模型ID}` / `{本地模型端口}` | Loom 模型条目 | `loom-config.example.yaml` |

`loom-config.example.yaml` 中的 `${LOOM_KEY_*}` 是环境变量引用，不是明文密钥；实际值由 systemd `EnvironmentFile` 或启动环境注入。不要把填好的 `.loom/config.yaml` 提交到 git。

## 后端说明

### Loom

Loom 是独立进程，默认监听 `127.0.0.1:5100`，通过 `{AI目录}/.loom/config.yaml` 读取工作区、Provider、模型、MCP 与压缩策略。示例文件已脱敏：

- `workspace` 指向 `{项目根目录}/{AI目录}`
- Provider 使用占位 `baseUrl`
- 凭据只写 `${ENV_VAR}` 引用
- 只保留 `ai_mcp` 一个 MCP 示例，其他 MCP 按实例追加

### OpenCode（遗留，可选，需自行配置）

模板已不再随附 `opencode.json` 与 `.opencode/`；后端仍保留 `ai_backend: opencode` 这一代码级选项，生产用 Loom。确实要用 OpenCode 时自行创建配置，并把 `mcp.ai-mcp` 的命令指向 `python mcp/ai_mcp.py`、cwd 设为 `{AI目录}`。同时保持 Auto Memory 关闭（`tools.memory_*` 全部为 `false`），并沿用 `permission` 的 deny 规则（禁用 `question` 与 `interactive_bash`，禁止读取或编辑配置文件自身）。

## 目录结构

```text
{AI目录}/
├── AGENTS.md                  # 一级记忆与主智能体规则
├── AGENTS-operations.md       # Task / coverage / plan 操作规程
├── 系统初始化指南.md          # 首次启动的强制初始化流程
├── README.md                  # 本文件
├── 启动说明.md                # 启动方式与进程管理
├── pyproject.toml             # ai-mcp 包元数据（声明 PyYAML）
├── loom-config.example.yaml   # Loom 配置示例（脱敏）
├── .gitignore
├── mcp/                       # ai_mcp.py（4 工具 MCP，Loom 与 OpenCode 共用）
├── agents/                    # 子智能体 prompt
├── analysis/                  # 分析脚本
├── data/                      # 运行时数据
│   ├── daily/ reports/ cache/ # 按日数据、报告与缓存
│   ├── tasks/ uploads/ voice/ # 任务脚本、上传与语音文件
│   └── plan/                  # Loom 主计划与 coverage 契约
├── memory/                    # 长期记忆
│   ├── self/ profile/ fact/ archive/ topics/ _template/
│   ├── claims/                # 断言侧车（claims.jsonl 从空文件起步）
│   └── anchors/               # 消息锚点侧车（模板仅 .gitkeep）
└── misc/
```

## 验证命令

```bash
cd {AI目录}

# MCP 脚本语法
python3 -m py_compile mcp/ai_mcp.py

# 包元数据可解析（Python 3.11+ 自带 tomllib；3.10 用 tomli）
python3 - <<'PY'
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
tomllib.load(open("pyproject.toml", "rb"))
print("PYPROJECT OK")
PY

# 分析脚本可执行
python3 analysis/check_coverage.py --help
```

## 相关文档

- [AGENTS.md](AGENTS.md) - 主智能体规则与记忆体系
- [AGENTS-operations.md](AGENTS-operations.md) - Task / coverage / plan 操作规程
- [系统初始化指南.md](系统初始化指南.md) - 首次启动流程与完整占位符清单
- [analysis/README.md](analysis/README.md) - 分析脚本清单与编写规范
- [data/README.md](data/README.md) - 数据目录、任务与调度
- [memory/README.md](memory/README.md) - 记忆分层与维护规则
- [mcp/ai_mcp.py](mcp/ai_mcp.py) - MCP 四个工具与提醒板工作流
- [启动说明.md](启动说明.md) - systemd / launcher.py / Loom / OpenCode
