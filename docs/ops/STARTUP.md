# 启动与初始化

本页是新装、开发和生产的统一起点。默认中文；英文入口见 [README.en.md](../../README.en.md)。

## 平台矩阵

| 平台 | 初始化 | 启动 |
| --- | --- | --- |
| Linux | `./scripts/setup.sh` | `./scripts/start.sh` |
| macOS | `./scripts/setup.sh` | `./scripts/start.sh` |
| Windows | `setup.bat` | `start.bat` |
| Linux 生产 | 手动安装依赖 | `deploy/kinship.service.example` + systemd |

Android App 和 Windows 桌面端是客户端，不负责启动服务器；它们连接已启动的后端。

## 前置条件

- Python 3.10+
- `backend/requirements.txt` 可安装
- 可写的项目目录
- 音频功能需要单独的音频内核；没有内核时后端仍可启动，但音频能力不可用
- 前端 `dist/` 缺失时由首次引导下载发行资产；手动构建需要额外的 CircuitJS 仓库，普通启动脚本不会自动构建

## Linux / macOS

初始化：

```bash
cd kinship
chmod +x scripts/setup.sh scripts/start.sh
./scripts/setup.sh
```

脚本会创建 `.venv`、安装后端依赖、在缺失时从 `config.example.yaml` 生成 `config.yaml`，并从 `ai-template/` 生成 `ai/`。已有 `config.yaml`、`ai/` 和 `.venv` 不会被覆盖。

启动：

```bash
./scripts/start.sh
```

脚本在前台执行：

```text
cd backend && python -m core.hot_server
```

验证：

```bash
curl http://127.0.0.1:8768/health
```

首次启动后打开 Web UI 完成管理员注册和 11 步初始化。Loom 的 token 和模型配置在初始化流程中写入 `ai/.loom/config.yaml`。

## Windows

初始化：

```bat
setup.bat
```

或：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

启动：

```bat
start.bat
```

或：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

`start.ps1` 不会结束其他进程，也不会按名称清理端口。端口被占用时只报告占用者，不会自动杀进程。

## Linux 生产部署

开发启动脚本是前台进程，不负责守护。生产请使用 systemd 示例：

```bash
sudo cp deploy/kinship.service.example /etc/systemd/system/kinship.service
sudo systemctl daemon-reload
sudo systemctl enable --now kinship
```

示例中的 `/opt/kinship`、用户、Python 路径和凭据文件都是占位符，必须按实际部署修改。作者自己的生产单元不在公开树中，不要照抄私有部署配置。

## 首次初始化

1. 打开 `http://<host>:8768/`。
2. 完成管理员注册。
3. 按页面完成 11 步初始化：账户、依赖、内核、模型、小米健康云、QQ、MOSS、Loom、客户端、完成。
4. 在 Loom 步骤填写 provider、模型和密钥；初始化会写入 `ai/.loom/config.yaml` 并启动 Loom。
5. 内核模型由 `kernel_models` 步骤下载；内核压缩包本身不含模型目录。
6. 前端缺失时由 `onboarding.frontend_autodownload` 后台下载；下载完成前 API 仍然可用。

## 脚本不做什么

- 不构建前端。
- 不构建或下载音频内核。
- 不构建 Loom。
- 不修改系统 PATH、注册表或全局 Python。
- 不结束其他进程，也不按名称杀进程。
- 不自动修改生产 systemd 单元。

## 退出码

| 脚本 | 退出码 | 含义 |
| --- | --- | --- |
| `setup.sh` | 0 | 成功 |
| `setup.sh` | 2 | 参数错误 |
| `setup.sh` | 4 | Python/依赖/文件前置条件失败 |
| `start.sh` | 0 | 启动成功或 `--check` 通过 |
| `start.sh` | 2 | 参数错误 |
| `start.sh` | 3 | 缺少 venv、`config.yaml` 或 `ai/` |

`setup.sh --check` 和 `start.sh --check` 只检查，不写文件、不启动服务。
