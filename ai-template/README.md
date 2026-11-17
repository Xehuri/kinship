# AI 根生产场景模板（ai-template）

`ai-template/` 是生产环境 AI 根的脱敏模板：它以实际运行中的 AI 目录为原型整理成公开骨架，发布前脱敏，不含真实数据、密钥、账号与实例绝对路径。

它是模板，不是运行时 AI 目录。后端与 Loom 读写的是配置里的 AI 根（`Config.AI_ROOT`，即 `config.yaml` 的 `data.ai_root`），本目录本身不会被运行时使用。新部署把模板复制到该 AI 根，填入占位符后即可接入后端。

模板同时适配两种 AI 后端：

| 后端 | 定位 | 配置入口 |
|------|------|----------|
| Loom | 生产推荐，独立进程 | `{AI目录}/.loom/config.yaml`，示例见 `loom-config.example.yaml` |
| OpenCode | 遗留/可选后端，模板不随附配置，生产用 Loom | 需自行创建 `{AI目录}/opencode.json`；MCP 脚本见 `mcp/ai_mcp.py` |

## Stratum 前置（v0.1.2+）

AI 子智能体的批次入库、卡片/claim 写入、review 与 query 通过 **Stratum CLI** 完成。Stratum 不是本仓库的 Python 依赖，也不是 git submodule；它是独立仓库和独立 CLI，仓库地址与固定版本写在安装脚本里。

- 版本：v0.1.2；Python 3.11+
- 安装脚本：`scripts/install-stratum.sh`（Linux/macOS）、`scripts/install-stratum.ps1`（Windows），脚本内固定仓库与版本
- 契约本地副本：`contracts/`（从 v0.1.2 同步，AI prompt 使用相对路径 `contracts/claim-schema.md`）

安装固定版本（脚本内已固化仓库安装源与 v0.1.2 版本号，并会顺带初始化 workspace）：

```bash
# Linux / macOS
./scripts/install-stratum.sh /path/to/ai

# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-stratum.ps1 -AiRoot D:\Kinship\ai
```

手工安装等价版本后，再单独验证并初始化 AI 根：

```bash
stratum --version
stratum init --root "{AI目录}" --name personal
stratum status
```

如果 `stratum` 不在 PATH，可使用 `python3 -m stratum`，或把 Python 用户级 bin 目录加入 PATH。

`.stratum/` 是运行时状态和 SQLite 数据库，必须加入 `.gitignore`，不要提交。

旧 `data/index/*.jsonl` 自 2026-11-05 起冻结：不再维护、不再写入、也不再作为回退。`data/index/DEPRECATED` 是机器可读的闸门：支持该标记的查询工具（新版 `analysis/query.py` 等）读到会直接报错，不再把冻结导出当主链回退。若实例已有旧索引，只在首次迁移时运行 `scripts/import-legacy-index.sh`（Windows 用 `.ps1`）；`migrate-legacy` 是一次性快照，导入后旧索引变更会报 `LEGACY_INDEX_CHANGED`，需要新建 workspace 重做。

旧索引导入（仅首次迁移）：

```bash
./scripts/import-legacy-index.sh /path/to/ai --dry-run
./scripts/import-legacy-index.sh /path/to/ai
```

导入前先确认目标 Stratum workspace 为空；旧索引目录默认是 `{AI目录}/data/index`，可用 `--index` 覆盖。Stratum 不可用时的失败计数由实例的 `fallback` 日志记录。

## 复制到 AI 根（data.ai_root）

复制目标是配置的 AI 根，不是固定路径 `ai/`。AI 根由 `Config.AI_ROOT` 决定（`config.yaml` 的 `data.ai_root`）；只有该键未配置时，后端才回落到默认 `<project>/ai`。私有/生产部署通常把 AI 根放在实例目录下，例如（路径按你的部署替换）：

```text
/path/to/ai
```

在仓库根目录执行，先确认目标 AI 根尚不存在：

```bash
AI_ROOT=/path/to/ai   # 换成你的 data.ai_root
cp -a ai-template "$AI_ROOT"
```

也可以用仓库根的安装脚本代劳，它们支持指定 AI 根，且只在目标缺失时复制：

```bash
# Linux / macOS
./scripts/setup.sh --ai-root "$AI_ROOT"

# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -AiRoot "D:\Kinship\ai"
```

两条硬约束：

- **不要把 `ai-template/` 原地复制成与它同级的 `ai/`**。`ai-template/ai/` 只是模板的副本，不会被任何配置识别，还会和真正的 AI 根混淆。
- **不要覆盖已有的 AI 根**。目标存在时只有两种安全做法：只补齐缺失文件，或直接拒绝操作。初始化引导不会覆盖：复制动作直接拒绝（`already_exists`），补齐动作只写缺失文件。手工补缺失文件可参考：

  ```bash
  cp -an ai-template/. "$AI_ROOT/"
  ```

复制完成后按顺序处理（以下 `{AI目录}` 均指这个已配置的 AI 根）：

1. 按《占位符替换清单》替换 `{项目名称}`、`{主智能体名称}`、`{用户称呼}`、`{AI目录}` 等占位符。`{AI目录}` 的取值就是 `data.ai_root`，可以是绝对路径。
2. 在项目根 `config.yaml` 配置后端端口、SSL、`ai_backend` 与 `data.*` 路径，其中 `data.ai_root` 指向刚才的 AI 根；AI 目录侧只填 `{AI目录}/.loom/config.yaml`。模板不再随附 OpenCode 配置，确实要用 OpenCode 时需自行创建 `opencode.json`。
3. 选 Loom：把 `loom-config.example.yaml` 复制为 `{AI目录}/.loom/config.yaml`，替换 Provider、模型与凭据环境变量；在项目根 `config.yaml` 设 `ai_backend: loom`。
4. 模板不再随附 OpenCode 配置。若确实要用 OpenCode，自行创建 `{AI目录}/opencode.json`，并把 MCP 命令注册为 `python mcp/ai_mcp.py`，cwd 指向 `{AI目录}`。
5. 启动后端（见 `启动说明.md`），然后按 `系统初始化指南.md` 完成首次初始化。初始化前先读 `{AI目录}/agents/main.md`（主会话提示词）与 `{AI目录}/memory/PROTOCOL.md`（记忆唯一规则源）。

## 占位符表

完整清单与替换规则以 `系统初始化指南.md` 的「占位符替换清单」为准。常用项：

| 占位符 | 含义 | 主要出现位置 |
|--------|------|--------------|
| `{项目名称}` | 实例/服务名 | `agents/main.md`、`mcp/ai_mcp.py` |
| `{主智能体名称}` | 主智能体人格名 | `agents/main.md`、`agents/*.md` |
| `{用户称呼}` | 用户希望被称呼的名字 | `memory/`、`agents/main.md` |
| `{用户}` | 后端用户目录名，健康数据在 `data/users/{用户}/` 下（运行期生成） | `data/README.md`、健康数据路径、部分任务脚本 |
| `{AI目录}` | AI 根，即 `data.ai_root` 的取值（默认 `<project>/ai`，可为绝对路径） | 全模板 |
| `{项目根目录}` | 仓库根绝对路径 | `loom-config.example.yaml` |
| `{后端HTTPS端口}` / `{后端HTTP端口}` | 后端监听端口 | 项目根 `config.yaml` |
| `{OpenCode端口}` | OpenCode 服务端口 | 项目根 `config.yaml` |
| `{Python解释器路径}` | Python 解释器绝对路径 | `loom-config.example.yaml`、项目根 `config.yaml`、`data/tasks/` |
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

- `workspace` 指向 `{AI目录}`（相对路径按项目根解析）
- Provider 使用占位 `baseUrl`
- 凭据只写 `${ENV_VAR}` 引用
- 只保留 `ai_mcp` 一个 MCP 示例，其他 MCP 按实例追加

### OpenCode（遗留，可选，需自行配置）

模板已不再随附 `opencode.json` 与 `.opencode/`；后端仍保留 `ai_backend: opencode` 这一代码级选项，生产用 Loom。确实要用 OpenCode 时自行创建配置，并把 `mcp.ai-mcp` 的命令指向 `python mcp/ai_mcp.py`、cwd 设为 `{AI目录}`。同时保持 Auto Memory 关闭（`tools.memory_*` 全部为 `false`），并沿用 `permission` 的 deny 规则（禁用 `question` 与 `interactive_bash`，禁止读取或编辑配置文件自身）。

## 目录结构

```text
{AI目录}/
├── agents/                    # 主会话提示词与子智能体规范
│   ├── main.md                # 主会话提示词（合并版；替代旧根 AGENTS.md 与操作规程）
│   ├── AGENTS-lite.md         # 批次/复盘轻量注入
│   ├── 01-data-check.md ~ 05-audit.md
│   ├── 复盘-公共.md / 公共-操作规范.md / 规则-01-data-check.md
│   └── data-checker.md / reviewer.md   # 投递薄壳，对应 task 的 agent_type
├── skills/                    # 技能包：comfyui-draw、qq-cli、playwright
├── memory/                    # 长期记忆（Phase A 骨架）
│   ├── PROTOCOL.md            # 唯一规则源（schema/预算/归属/冻结）
│   ├── README.md              # 导航，不重复规则
│   ├── MEMORY-STATUS.json     # 收尾门运行期产物（gitignored），未运行属正常
│   ├── ledger/                # facts.md / rules.md / open.md（内核真源）
│   ├── notes/                 # observations、cases、persona、judgments、dossiers、topics、proposals
│   ├── self/ profile/ topics/ # 投影层：必读、身份、active-tasks、state、core、topics-INDEX、SELF-INDEX
│   ├── eval/ EPISODIC.md      # 情景记忆设计模板（B0，未启用）
│   ├── legacy/FROZEN.md       # 旧文件冻结清单
│   ├── anchors/ archive/ _template/
├── data/                      # 运行时数据
│   ├── README.md              # 数据目录与任务调度说明
│   ├── daily/ reports/        # 按日数据、报告
│   ├── tasks/                 # 任务 YAML 与常驻 Python 脚本（格式见 tasks/AGENTS.md）
│   ├── plan/coverage.yaml     # 覆盖契约真源；master.json 运行期播种
│   ├── index/                 # 已冻结的旧索引（DEPRECATED 闸门）
│   └── cache/ uploads/ voice/ users/
├── analysis/                  # 分析脚本（清单见 analysis/README.md）
├── mcp/ai_mcp.py              # 4 工具 MCP（Loom 与 OpenCode 共用）
├── contracts/                 # Stratum 契约本地副本
├── scripts/                   # install-stratum / import-legacy-index（sh + ps1）
├── 系统初始化指南.md          # 首次启动的强制初始化流程
├── 启动说明.md                # 启动方式与进程管理
├── pyproject.toml             # ai-mcp 包元数据（声明 PyYAML）
├── loom-config.example.yaml   # Loom 配置示例（脱敏）
└── .gitignore
```

根目录不再有旧的 `AGENTS.md` 与独立操作规程文件：两者已合并到 `agents/main.md`（主会话提示词），任务排班规则在 `data/tasks/AGENTS.md`，记忆规则在 `memory/PROTOCOL.md`。

`cache/`、`users/`、`browser/` 等目录由运行时生成，模板不预置。`.loom/`、`.stratum/`、`.playwright/`、`data/browser/`、`data/tasks/logs/` 是运行期与个人态产物，已在 `.gitignore` 中忽略。

## 技能包（skills/）

`{AI目录}/skills/` 放运行时可加载的技能包，每个目录一个 `SKILL.md`（带 `name` / `description` frontmatter）。模板随附三个：

| 技能 | 用途 | 产物与边界 |
|------|------|------------|
| `comfyui-draw` | 用本机 ComfyUI 文生图（FLUX / MOSS-Image 等，支持画面中文） | 成品落 `data/images/{日期}/`；只调本机 ComfyUI（默认 `127.0.0.1:8188`），不接公网 |
| `qq-cli` | 用 `qq` 命令行收发私聊/群聊、读历史与未读、查联系人与 QZone | 经后端 QQ 网关 IPC，不直连 NapCat；账号与 token 只写本地 gitignored 配置 |
| `playwright` | 用固定版本 Playwright 驱动无头 Chromium：开网页、填表、截图、读控制台与网络 | profile 在 `.loom/playwright-profile`，截图与快照落 `data/browser/{日期}/`，均 gitignored |

> `qq-cli` 依赖实例启用 QQ 网关，`comfyui-draw` 依赖本机 ComfyUI 服务，缺失都不影响主链。技能执行仍受 `agents/main.md` 的边界约束：`{AI目录}/` 外的操作先问。

## 分析脚本（入口）

完整清单、参数与输出约定见 `analysis/README.md`；这里只列出最常用的入口。

| 脚本 | 用途 |
|------|------|
| `analysis/fact_extractor.py {date}` | 感知数据 → `data/daily/{date}/事实-全天.md`，`--update-summary` 同步当日摘要、批次索引与健康清单 |
| `analysis/query.py` | 统一只读检索入口：event / observation / report / evidence / memory / chat 单层或复合查询 |
| `analysis/query_chatlog.py` | 按时间窗查历史对话；缺省跟随后端 `ai_backend` |
| `analysis/memory_retrieve.py --query <词>` | 记忆词法检索，返回带行号片段与预算 |
| `analysis/memory_finalize.py --root . --changed-from git` | 记忆收尾门：校准/断链/PII/投影新鲜度检查，产物只写 `memory/MEMORY-STATUS.json` |
| `analysis/health_source.py` | 健康视图共享模块（无 CLI），分片不可用时回退派生 `health.json` |

记忆写入口径以 `memory/PROTOCOL.md` 为准：主会话不直接写 `ledger/`，日更由 02 日复盘统一收割。

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
python3 analysis/memory_finalize.py --help

# Stratum workspace 状态（初始化后）
stratum status
```

## 相关文档

- [agents/main.md](agents/main.md) - 主会话提示词（合并版，含身份、模式、子智能体与记忆纪律）
- [memory/PROTOCOL.md](memory/PROTOCOL.md) - 记忆唯一规则源（Phase A）
- [memory/README.md](memory/README.md) - 记忆分层导航与当前阶段
- [系统初始化指南.md](系统初始化指南.md) - 首次启动流程与完整占位符清单
- [analysis/README.md](analysis/README.md) - 分析脚本清单与编写规范
- [data/README.md](data/README.md) - 数据目录、任务与调度
- [data/tasks/AGENTS.md](data/tasks/AGENTS.md) - 任务 YAML / Python 脚本格式
- [mcp/ai_mcp.py](mcp/ai_mcp.py) - MCP 四个工具与提醒板工作流
- [启动说明.md](启动说明.md) - systemd / launcher.py / Loom / OpenCode
