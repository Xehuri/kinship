# Windows 兼容性核对（onboarding 存储 / 内核 / Loom / 客户端，2026-10-26）

范围：提交 `54fce767` / `6b12fec1` / `9c603ec7` / `c7a190f7` 新增的存储根、内核模型注入、Loom 运行时与客户端回退。本文只列 Windows 专属核对项；安装步骤见 `docs/INSTALL.md`，设计见 `docs/onboarding-redesign-2026-10-26.md`。

## 自动化矩阵

- 文件：`backend/tests/test_windows_parity.py`
- 命令：`cd backend && /opt/kinship/.venv-health/bin/python -m pytest tests/test_windows_parity.py -q`
- 方式：Linux 上以平台标志、假路径与假进程句柄模拟 Windows，不启动真实进程、服务管理器或网络。
- 覆盖：
  - `config.paths` 的盘符 / UNC 绝对路径与项目根相对解析。
  - 内核模型环境：`LOCALAPPDATA` 不泄漏；`kernel.model_dir` 覆盖环境值。
  - 内核资产：Windows 进程探活不调用 `os.kill`；本地 venv 使用 `Scripts/python.exe`。
  - Loom：无 `systemctl` 的 child / none 模式；`DETACHED_PROCESS` 等启动标志；`TerminateProcess` 停止；PID 指纹拒绝；`chmod` 失败不阻断 token 供给。
  - 客户端：`local -> configured -> manifest -> GitHub` 回退顺序与平台无关。

## 真机核对（Windows 10/11 x64）

1. 路径：`AXEUH_DATA_ROOT=D:\...`、UNC `\\nas\share\...`、相对值 `runtime-data` 都落在预期位置；确认没有引用 `/home/...` 的 `models.dir`。
2. 模型：用后端下载时权重落在 `<models_root>\.cache\axeuh-kernel\models`（或显式 `kernel.model_dir` / `AXEUH_KERNEL_MODEL_DIR`），`%LOCALAPPDATA%\axeuh-kernel` 不应出现后端下载产物。
3. 内核：首次音频请求触发懒启动；`backend\data\kernel_state\kernel.pid` 存在时巡检只探活，不终止进程。
4. 内核解释器：`kernel.python` / `AXEUH_KERNEL_PYTHON` > `.venv-kernel\Scripts\python.exe` > 后端解释器。
5. Loom 模式：无 `systemctl` 时为 child（node + dist 均在）或 none（缺任一）；none 时页面给出手工命令，不应尝试 `systemctl`。
6. Loom child：启动后无控制台窗口，`var\logs\loom.log` 有输出；停止走 `TerminateProcess`，pidfile 指纹不符时拒绝操作。
7. token：`<data_root>\secrets\loom.env` 存在；Windows 下 `chmod` 不落 ACL，需确认目录 ACL 仅当前用户可读。
8. 客户端：本地 release -> 配置 URL -> 发行清单 -> GitHub 页面顺序不变；反斜杠路径按原文显示。
9. 前端：onboarding Loom 卡片显示 `C:\...` 路径不截断；手动命令在 child 模式为 `node ... serve`，systemd 命令仅在 systemd 模式出现。
10. 进程：确认没有 `systemctl` / `pkill` / `killall` / `taskkill` / `shell=True` 调用（静态用例已覆盖）。

## 残余风险（仅真机可证）

- `os.chmod(0o600)` 在 Windows 不设置 NTFS ACL，密钥保护依赖 `%...%` 用户目录 ACL。
- Windows 无 SIGTERM：child 停止不是优雅退出，Loom 可能来不及 flush；停止后需看 health 与日志。
- `_write_secret_env` 的目录 fsync 在 Windows 被跳过（异常已捕获）。
- `Popen(cwd=UNC)` 在 Windows 可能被拒绝；项目根建议放在本地盘。
- Windows 进程身份 / `TerminateProcess` 分支本次只在 Linux 上用假句柄验证，未在真机运行。
- `startup` 验证平面未纳入本次 Windows 自动化矩阵；其探针复用跨平台路径与 in-process 服务，仍需在真机确认无 systemd 时的行为。
- 本次范围外：`backend/services/phi4_client.py` 与 `backend/scripts/qa_config_staging.py` 仍用 `os.kill(pid, 0)`，属于既有代码，不在 onboarding 新链路。
