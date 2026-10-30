# kinship_export

Kinship 的公开导出门禁。默认拒绝：只有 [allowlist.toml](allowlist.toml) 明确允许、且内容扫描无命中的已跟踪文件才会被复制。

## 命令

```bash
# 只检查，不写盘
python -m tools.kinship_export.cli export --dest /path/to/stage --dry-run --fail-closed

# 真正导出；目标目录必须不存在或为空
python -m tools.kinship_export.cli export --dest /path/to/stage --fail-closed

# 复核一个候选公开树；不写盘
python -m tools.kinship_export.cli verify --dest /path/to/stage --fail-closed
```

`--fail-closed` 是显式意图开关，导出门禁始终失败关闭，不能关闭。两条命令都只输出一份 JSON 报告到 stdout，退出码 `0` 表示通过，`1` 表示失败。报告包含顶层路径计数、被拒绝路径计数、扫描类别合计，以及只含路径/类别/计数的命中明细，不记录命中的原文。

## 失败关闭规则

- 源文件来自 `git ls-files`，未跟踪文件不会进入导出。
- 路径先过 `policy.is_public_path`；未匹配任何 allow 条目的一律拒绝。
- 目标目录在源仓库内、是符号链接、含 `..`、或非空时拒绝。
- 任一被允许文件扫描命中 secret/PII 时，整次导出失败且不写任何文件。
- `verify` 拒绝 allowlist 之外的路径、符号链接、`.git`、运行时数据、内核源码、模型权重、构建产物和内容扫描命中。

## 内容扫描类别

`scanner.py` 覆盖私钥、云厂商/代码托管/聊天平台令牌、JWT、Bearer 令牌、数据库 URL 凭据、密码赋值、手机号、身份证号、个人邮箱、QQ 号、带标签的 QQ/群/用户标识（`self_qq`、`self_cookie_uin`、`group_id`、`user_id`、`uin`、`--group`/`--friend`、`friend:`/`target:`、`peer_allowlist`/`group_allowlist`、`normalize_uin`）、Windows 用户目录、其他 Windows 盘符绝对路径、WSL `/mnt/<drive>/Users/<user>` 目录、其他 WSL `/mnt/<drive>/...` 主机挂载路径、Unix home 路径、十进制经纬度对（兼容 `lat,lon` 与 `lon,lat` 两种顺序），以及一组人工维护的个人叙事词。`windows_user_path`/`wsl_user_path` 与其他盘符/挂载路径类别互斥，不会重复计数；公开占位符 `/opt/kinship`、`<TMP_DIR>`、`C:\Kinship`、`D:\Kinship`、`%LOCALAPPDATA%` 以及常见系统/测试根不命中。

误报过滤规则（表在 `scanner_patterns.py`，均有测试）：

- 占位标记（如 `test`、`example`、`your`）和占位用户（如 `public`、`runner`）不计数；安全表不得包含真实账户名。
- 手机号、邮箱、QQ 号只豁免固定测试值；其余仍按格式命中。带标签的 QQ/群/用户标识只豁免 `scanner_patterns.py` 中 `SAFE_QQ_IDS`/`SAFE_COOKIE_UINS`/`SAFE_QQ_TIMESTAMPS` 列出的合成夹具；时间戳只豁免该固定表内的值，普通数字和短值不按标识计数。
- 经纬度要求两侧各至少 3 位小数，并排除全零、绝对值都小于 1 的矢量路径坐标、整数对，以及公开城市中心测试基准。
- 文档与测试示例统一写 `<lat>,<lon>` 或 `0.000000,0.000000`，不得写真实坐标。

`allowlist.toml` 显式拒绝原始单文件 SPA 备份、内部记忆研究/日志、Loom 测试作战手册等含个人叙事或本机路径的文件，这些文件不进入公开树。

## 与 docs-check 的边界

`tools/docs-check/check_docs.py` 只检查 Markdown/AGENTS 文档；本目录的签名、路径和内容门禁独立运行，不依赖 docs-check。
