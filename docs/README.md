# 文档索引

> 最后更新：2026-11-17。中文是默认入口；English README 是摘要镜像。
>
> 本文只列公开文档。内部运维、迁移记录、生产拓扑、研究草稿和私有组件文档不在此索引中，也不在公开树承诺范围内。
>
> 分类清单位于 [`_meta/docs.public.json`](_meta/docs.public.json)。同一事实只维护一份：先改唯一真源，再改入口。

## 一、按读者入口

### 新使用者

| 文档 | 内容 |
| --- | --- |
| [../README.md](../README.md) | 项目定位、六个不同点、快速开始 |
| [user/README.md](user/README.md) | 第一次使用、可选功能、遇到问题 |
| [user/features.md](user/features.md) | MOSS、小米健康云、QQ、唤醒词、PC 采集的开启方式 |

### 自部署者

| 文档 | 内容 |
| --- | --- |
| [ops/STARTUP.md](ops/STARTUP.md) | Linux/macOS/Windows 的初始化、启动与首次引导 |
| [ops/INSTALL.md](ops/INSTALL.md) | 安装 1-5 阶段、AI 工作目录、唤醒词、PC 采集器 |
| [ops/CONFIGURATION.md](ops/CONFIGURATION.md) | `config.yaml` 配置键参考 |
| [ops/deploy-linux.md](ops/deploy-linux.md) | Linux / systemd 部署参考 |
| [ops/OPERATIONS.md](ops/OPERATIONS.md) | 运行、端口、健康检查与运维注意事项 |
| [ops/troubleshoot.md](ops/troubleshoot.md) | 故障排查手册 |
| [ops/backup-restore.md](ops/backup-restore.md) | 备份对象、恢复顺序与校验 |
| [ops/system-config-hot-reload.md](ops/system-config-hot-reload.md) | 配置热更新与回滚 |
| [ops/dsh-production-rollout.md](ops/dsh-production-rollout.md) | 把 Kinship 的 AI 切到生产 dsh：准备、重启、绑定、切流、回滚 |
| [ops/flow-retirement.md](ops/flow-retirement.md) | flow 面退役的配置开关、观察期与回滚步骤 |

### 开发者

| 文档 | 内容 |
| --- | --- |
| [dev/PROJECT_MAP.md](dev/PROJECT_MAP.md) | 目录结构与子系统地图 |
| [dev/API.md](dev/API.md) | HTTP API 端点表 |
| [dev/api-sources-health.md](dev/api-sources-health.md) | 数据源健康接口契约 |
| [dev/DATA_FORMAT.md](dev/DATA_FORMAT.md) | 感知与健康数据格式 |
| [dev/AUDIO_PIPELINE.md](dev/AUDIO_PIPELINE.md) | 音频采集、分段与上传链路 |
| [dev/AI_SYSTEM.md](dev/AI_SYSTEM.md) | AI 系统架构与三层工作流 |
| [dev/ai-runtimes.md](dev/ai-runtimes.md) | AI 运行时选择：Loom、dsh 与自带 harness |
| [dev/adapter-contract.md](dev/adapter-contract.md) | AI 运行时适配器契约（后端侧边界 + 适配器自身配置界面的可选约定） |
| [dev/plugin-host-p0.md](dev/plugin-host-p0.md) | Loom 插件系统：[P0](dev/plugin-host-p0.md) / [P2a trusted](dev/plugin-host-p2a.md) / [P2b 沙箱设计](dev/plugin-host-p2b.md)（暂缓） |
| [dev/loom-think-playbook-2026-10-30.md](dev/loom-think-playbook-2026-10-30.md) | Loom think/锦囊机制研究（公开脱敏版） |
| [dev/think-playbook-experiment-2026-10-30.md](dev/think-playbook-experiment-2026-10-30.md) | Think/Playbook 主会话实验报告（公开脱敏版） |
| [dev/qq-gateway.md](dev/qq-gateway.md) | QQ 单 WS 网关契约 |
| [dev/loom-inbox-contract.md](dev/loom-inbox-contract.md) | Loom 统一收件箱（letters）与任务结果契约 |
| [dev/flow-retirement-inventory.md](dev/flow-retirement-inventory.md) | flow 面退役落点清单（设计快照 + 现行 Phase A/B 状态） |
| [dev/index-layer-catalog-2026-11-02.md](dev/index-layer-catalog-2026-11-02.md) | 索引层目录与分类（历史设计，已由 stratum 取代） |
| [dev/onboarding-v4-2026-10-27.md](dev/onboarding-v4-2026-10-27.md) | 初始化引导 v4 契约 |
| [dev/add-a-service.md](dev/add-a-service.md) | 新增受管服务的模板与检查清单 |
| [dev/p2p-data-protocol.md](dev/p2p-data-protocol.md) | P2P DataChannel 协议（实验，当前不可用） |
| [dev/COHORT.md](dev/COHORT.md) | cohort 机制与现状 |
| [dev/UNKNOWN_SPEAKER_FEATURE.md](dev/UNKNOWN_SPEAKER_FEATURE.md) | 陌生人识别功能说明 |
| [dev/windows-parity-2026-10-26.md](dev/windows-parity-2026-10-26.md) | Windows 兼容性核对 |
| [dev/android-webview-token-bridge-2026-10-25.md](dev/android-webview-token-bridge-2026-10-25.md) | Android WebView Token 桥 |
| [dev/brand-assets.md](dev/brand-assets.md) | 品牌主 SVG 与图标生成 |

### 内核接入者

| 文档 | 内容 |
| --- | --- |
| [kernel/README.md](kernel/README.md#data-boundary) | 内核分发、数据边界、安装位置、模型与许可 |
| [kernel-contract.md](kernel-contract.md) | 闭源音频内核 API 契约（唯一真源） |
| [kernel/EULA.md](kernel/EULA.md) | 内核最终用户许可协议 |
| [kernel/COMMERCIAL.md](kernel/COMMERCIAL.md) | 商业许可说明 |

### 架构决策

| 文档 | 决策 |
| --- | --- |
| [adr/README.md](adr/README.md) | ADR 索引 |
| [adr/0001-single-parent-process.md](adr/0001-single-parent-process.md) | 后端是唯一父进程，父死子清 |
| [adr/0002-config-draft-apply.md](adr/0002-config-draft-apply.md) | 配置两阶段，apply 是唯一执行入口 |
| [adr/0003-remove-bootstrap-mode.md](adr/0003-remove-bootstrap-mode.md) | 删除 bootstrap 模式，用 blocked 服务取代延迟服务面 |
| [adr/0004-single-port.md](adr/0004-single-port.md) | 单一 `server.port`，`ssl.enabled` 只决定协议 |
| [adr/0006-ffmpeg-via-pypi.md](adr/0006-ffmpeg-via-pypi.md) | ffmpeg 经 imageio-ffmpeg wheel 落地 |

## 二、单一真源

| 事实 | 唯一真源 |
| --- | --- |
| 启动入口 | [`backend/core/hot_server.py`](../backend/core/hot_server.py) + [ops/STARTUP.md](ops/STARTUP.md) |
| 配置键与默认值 | [`config.example.yaml`](../config.example.yaml) + [ops/CONFIGURATION.md](ops/CONFIGURATION.md) |
| 数据检查排班 | [`ai-template/data/plan/coverage.yaml`](../ai-template/data/plan/coverage.yaml) |
| 感知与健康数据格式 | [dev/DATA_FORMAT.md](dev/DATA_FORMAT.md) |
| HTTP API | [dev/API.md](dev/API.md) + `backend/routers/` |
| AI 运行时选择 | [dev/ai-runtimes.md](dev/ai-runtimes.md) |
| AI 运行时适配契约 | [dev/adapter-contract.md](dev/adapter-contract.md) |
| 内核 API | [kernel-contract.md](kernel-contract.md) |
| 公开/私有边界 | [`_meta/docs.public.json`](_meta/docs.public.json) + `tools/kinship_export/allowlist.toml` |

## 三、公开/私有边界

- 公开文档只描述产品行为、接口契约、安装配置和运维方法。
- 音频内核源码、模型权重、用户数据、真实主机路径与凭据、内部迁移记录和研究草稿不进入公开文档。
- 公开文档不得链接内部文件；未列入本索引的文档不保证在公开树中存在。
- 公开索引只维护一份；新增文档必须同时登记到 [`_meta/docs.public.json`](_meta/docs.public.json)。

## 四、维护规则

1. 同一事实只维护一份；其他文档用链接，不复制正文。
2. 先改唯一真源，再改入口；入口包括 `README.md`、`README.en.md` 和本索引。
3. 新增文档必须有明确的读者、用途和公开/私有归属。
4. 不把运行时数据、真实凭据、用户 ID、QQ 号、真实主机路径写入公开文档。
5. 提交前运行 `python tools/docs-check/check_docs.py all`：它校验清单里的文档路径与相对链接是否真实存在，不检查锚点、孤儿文档或内容级泄露；公开导出另由 `tools/kinship_export/` 的 allowlist 与内容扫描负责。
