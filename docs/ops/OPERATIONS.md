# 运行与运维注意事项

> 从 `AGENTS.md` 拆出（2026-10-22）。这里保留实现级运行细节；跨子系统硬规则仍在 `AGENTS.md`。

## 配置热应用与无配置启动

- 配置载体：YAML（默认）、JSON、SQLite、env 覆盖层。`AXEUH_CONFIG_BACKEND` 选后端，`AXEUH_CONFIG_PATH` / `AXEUH_CONFIG_SQLITE_PATH` 定位置，`AXEUH_SETTINGS__<DOTTED_UPPER>` 为只读覆盖层。完整契约见 [system-config-hot-reload.md](system-config-hot-reload.md)。
- 无配置启动：后端不因 `config.yaml` 缺失、为空或损坏而退出，按 schema 默认值降级运行；`GET /api/system/config/status` 的 `degraded` 会给出原因。无证书时 SSL 自动降级关闭，实际监听 `server.http_port`。已有用户时该端点需 user Bearer；仅无用户 bootstrap 可匿名。
- 保存与生效：Web 设置页或 `PUT /api/system/config` 保存后原子替换快照并按域应用。大多数键热生效；`qq_gateway.*` / `p2p.*`（实验，当前不可用）原地重连；`kernel.*` 重启内核；已退役 `launcher.*` 回滚元数据属部署接线，HTTP 只读。
- 认证：无用户时配置写入必须带 `X-Setup-Token`，令牌启动时生成于 `backend/config/.setup_token`（0600，已 gitignore）。启动日志以 INFO 输出完整令牌，并标记来源（`新生成` / `文件`）；`backend.log` 在 POSIX 启动时收紧为 0600。该令牌仅用于首次配置，创建管理员后失效。HTTP/WS 响应不回显令牌。已有用户时必须用 user Bearer 加当前密码；service/device Token 无权写配置。引导入口用只读 `POST /auth/verify-password` 一次性验证当前密码（user Bearer + `password`，5 次/60 秒限流，不签发 Token）；后续写请求仍逐次携带密码。
- 回滚：YAML/JSON 每次保存前生成 `<file>.bak-YYYYMMDD-HHMMSS[-N]`；先停服务，复制备份回原路径，`chmod 600`，再启动并检查 `/api/system/config/status`（已有用户需 user Bearer）。SQLite 无同名侧车备份，需定期 `.backup`。
- 载体切换：v1 不支持运行中切换，必须停进程、改环境变量、再启动。
- staging：`python3 backend/scripts/qa_config_staging.py --smoke`，默认报告 `<TMP_DIR>/system-config/staging-report.md`（内容为 JSON）。脚本已用 `AXEUH_AUTH_STATE_DIR` / `AEUH_ONBOARDING_STATE` / `AXEUH_PROJECT_ROOT` 隔离 auth、引导状态与初始化动作目标目录；不要在 staging 中省略 `AXEUH_PROJECT_ROOT`，否则 `copy_ai_template` 会指向代码仓库的生产 `ai/`。

## HTTPS 与反代一致性（2026-10-26）

- 生产 Caddy vhost 固定反代 `https://127.0.0.1:8768`。后端只有在 `ssl.enabled=true` 且证书、私钥都存在时才以 HTTPS 监听 `server.port`（8768）；`ssl.enabled` 缺失或为 false 时同一端口降级为 HTTP，协议不符会让 Caddy 返回 502。
- 502 排查顺序：`ss -lntp | grep 8768`、`journalctl -u axeuh-health` 查 `HTTP mode (no SSL)` / `HotServer` 迁移日志、核对 `ssl.enabled`、`ssl.cert`、`ssl.key` 与 Caddy vhost。不要先重启生产。
- 仅补证书路径不等于启用 HTTPS；三者缺一不可。修改 `ssl.enabled` 后 HotServer 支持热迁移监听（日志出现 `监听已迁移 ... ssl=True`），不需要重启后端；若未迁移，再按确认窗口重启。
- `frontend/mobile/dist` 与后端监听是两件事：前端 200 不代表 8768 可达；以 `https://<domain>/health` 和 `ss` 同时确认。

## 内核探针与声纹排障（2026-10-26）

- 分析日志中的 `vp=Nspk/Mco(raw|AS)` 来自外层只读探针；内核不可达或请求超时一律降级为 `0spk/0co`。这表示探针失败，不代表 `config.yaml` 的声纹配置或 state-dir 注册库被删除。
- 先查内核进程与 HTTP：`ps -eo pid,ppid,etime,%cpu,%mem,cmd | grep axeuh_kernel`，以及 `kernel_state/voiceprints/voiceprints.json`、`voiceprint/cohort_active.jsonl` 的大小与 mtime。注册库存在但探针为 0 时，优先排查内核卡住、CPU 饱和或 job 长时间 running。
- 内核是懒启动：后端启动不 spawn，第一条音频分析/ASR/声纹请求才触发 `ensure()`。没有新音频时“内核未运行”是正常状态，不要手动 `python -m axeuh_kernel`（会劫持共享 pidfile）。
- 确认内核卡死且需要重启时，按 PID 停止，由后端下一次请求重新 spawn；不要按名称杀进程。恢复后验证 `vp` 回到 `1spk/500co(AS)` 一类真实值。

## 模型下载与源站排障（2026-10-26）

- 来源：required 模型全部走 ModelScope；`eres2netv2` 随内核包 bundled。`wespeaker` 必须使用公开仓库 `pyannote/wespeaker-voxceleb-resnet34-LM`，不要再用审批制 `ModelBulider` 包装仓库。`kws-zipformer` 走 GitHub Release，`cnn14` 走 Zenodo，两者已配置国内镜像。
- 自动回退：`kws-zipformer` 依次尝试 `ghfast.top`、`gh-proxy.com`、GitHub 官方；`cnn14` 先 `hf-mirror.com`，再 Zenodo。每个模型候选只试一次，单次超时 600 秒。发布 manifest 与资产先试 GitHub 官方，再 `ghfast.top`、`gh-proxy.com`；资产下载先试镜像，再回官源。
- 诊断：日志里的 `mirror=0/1/canonical result=failed error=...` 表示该候选失败后继续尝试；最终 `download_failed` 才表示全部候选失败。不要只看进度 0% 或 HTTP 202。下载临时目录在 `<models_root>/.cache/axeuh-kernel/models/.kernel-model-staging-*/`，失败后应被清理。
- 手动预置：模型仍可直接放进目标缓存，`status` 只读 `required_files` 判定 present；`kws` 目标为 `<models_root>/.cache/axeuh-kernel/models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`，`cnn14` 目标为 `<models_root>/.cache/axeuh-kernel/models/Cnn14_16k_mAP=0.438.pth`，`wespeaker` 目标为 `<models_root>/.cache/huggingface/hub/models--pyannote--wespeaker-voxceleb-resnet34-LM`。不要用不完整缓存冒充 present。
- 代理：仅 staging 可在启动后端时设置 `HTTPS_PROXY` / `HTTP_PROXY` 并把回环与内网段放进 `NO_PROXY`；生产不默认加代理，也不能把代理当作 GA 方案。
- 信任：`kws` 归档 SHA-256、`cnn14` SHA-256+MD5、发布资产 SHA-256 都会强校验。第三方 GitHub 代理能同时改 manifest 和资产，SHA 只能证明“与清单一致”，不能证明清单来自官方；生产建议自建镜像，把 `onboarding.release_manifest_url` 与 `onboarding.release_base_url` 指向正常 HTTPS 根。
- 模型步骤允许跳过；跳过会进入 degraded，`finish` 需要显式 `allow_degraded=true`。required 模型缺失时不要标记完成；用带 Bearer 的 `GET /api/system/onboarding/models` 或 `kernel_model_assets.status()` 核对 `present` 与 `missing_files`。

## 首次启动与 bootstrap 模式

- 判定：无用户或引导状态未完成时进入 bootstrap；已有用户且没有状态文件的旧安装始终按完整模式启动，避免锁死生产。`AXEUH_ONBOARDING_BOOTSTRAP=1/0` 可在状态缺失或未完成时切换；磁盘状态已完成时始终按完整模式启动，env 不能重新锁死已完成实例。
- 门禁：bootstrap 期间只放行 `/health`、`/auth`、`/api/system/onboarding/*`、`/api/system/config/*`、`/api/ota/*`、`/api/clients/*`、`/mobile` 与静态资源；其他 HTTP 路径返回 503 `onboarding_required`，WebSocket 以 1013 关闭。`BootstrapRuntime.active` 为 false 时中间件完全透传。
- 完成：`finish` 在进程内激活服务面（调度器、脚本、音频 ingest、Health Cloud、Loom 探针、QQ、P2P（实验，当前不可用）、配置 watcher），不需要重启后端；单个子系统失败只写入 activation 报告。
- 11 步与 state v4：`welcome`、`account`、`dependencies`、`kernel`、`kernel_models`、`xiaomi`、`qq`、`moss`、`loom`、`clients`、`finish`。`preflight` 与 `startup` 不再是可见步骤，由 `POST /api/system/onboarding/finish` 统一执行预检、Xiaomi/QQ/MOSS 集成校验、启动校验、promote 与 commit；硬失败 409，软失败需 `allow_degraded=true`。v3/v2 已完成安装迁移到 v4 时补记合成 `xiaomi`/`qq`，不重新过门禁；未完成安装必须真实执行 v4 finish。模型根在 `kernel_models` 步选择，storage API 只写 `models.dir`，不搬运模型。MOSS 仅外部服务，Loom 仅内联 key 单动作，均无单元管理或 token 手填 UI。详见 [onboarding-v4-2026-10-27.md](../dev/onboarding-v4-2026-10-27.md)。
- 前端自愈：启动时若 `frontend/mobile/dist/index.html` 缺失，日志记录 warning、来源、进度、校验和重试结果，并后台下载 release 资产；已有 dist 不覆盖，API 在下载完成前仍可用。
- staging 隔离：至少设置 `AXEUH_PROJECT_ROOT`、`AXEUH_AUTH_STATE_DIR`、`AXEUH_ONBOARDING_STATE`（兼容 `AEUH_ONBOARDING_STATE`）、`CONFIG_PATH`、`AXEUH_ONBOARDING_BOOTSTRAP=1`；所有路径必须在临时根内。不要在没有 `AXEUH_PROJECT_ROOT` 时运行初始化动作。
- onboarding 复测：不要直接使用可能早于 onboarding 的生产 `frontend/mobile/dist`；用 `npm run build:atomic` 产出的 `dist-*`。启动日志必须出现 `[Bootstrap] mode=True` 与 `service plane deferred`；若出现 `mode=False`，立即按 PID 停止并检查启动器是否用 `os.execve(..., env)` 传递环境。首次复测清空 staging 的 `auth/` 与 `onboarding/`，否则“已有用户 + 无状态”会按 legacy 完成处理。
- 发行：`onboarding.release_manifest_url` 默认指向 `Xehuri/kinship` 的 `release-manifest.json`；清单固定 frontend/kernel/Android/Windows 的文件名、大小与 SHA-256。

## Loom 计划排班（master + WakeQueue；2026-10-28 06:45 live）

生产已于 2026-10-28 06:45 切到 live：`ai/.loom/config.yaml` 的 `scheduling` 为 `wakeQueue: live` / `planScheduler: live`；`axeuh-loom-plan.timer`（05:00）与 `axeuh-loom-review.timer`（07:30）已安装。旧固定时点 YAML 与 `data_check_scheduler.py`/`session_compactor.py` 已 `enabled: false`，文件保留回滚。执行记录保留在私有运维文档。

- 真源：`ai/data/plan/master.json`（版本化母版，含固定时段、7 个 coverage 锚点、长期条目）+ `ai/data/daily/{date}/plan-{date}.overlay.json`（当日 diff）+ `plan-ledger.jsonl`（只追加账本）。`master.md` 是人读视图，旧 `plan-{date}.json` 只读回退。
- 工具：`plan read/base/diff/revise/done/note/close`；`done` 只写覆盖层与账本，**主会话写完成字段，调度器不推断完成**。master 只能走显式 `loom plan master edit`（CAS），日计划不能改母版。工具输出为紧凑纯文本（2026-10-28 起）；`read`/`base` 用 `include_instruction: true | ["id"]` 按需展开任务正文，并支持 `status`/`kind` 过滤；`diff`/`revise` 支持 `user_intent`（只记录，不参与 coverage）；care 的 `done_when` 必须非空且含 `HH:MM` 或配非空 `window`，否则改用 `kind=note`。
- 队列：`{stateRoot}/session/wake-queue/{sid}.json`，plan/flow/special 多条目共存，一条最早定时器；投递失败只重试一次（+30 秒），随后归档 `failed` 并走死信；启动恢复并迁移旧单槽唤醒。Flow 只对账 `flow` 来源，不覆盖 plan。
- 对账：boot、05:00、07:30、看门狗与 `POST /plan/reconcile` 触发；默认 48 小时视野、8 小时追赶、8–24 小时迟到补做、超过 24 小时记欠账；连续迟到的 coverage 合并为一个补做条目。
- 配置：`ai/.loom/config.yaml` 的 `scheduling` 段，`wakeQueue`/`planScheduler` 取 `live|shadow|off`；`sessionId` 不配置，调度目标由 boot 解析出的主会话决定。缺省或两者 `off` = 旧路径。`shadow` 只写 `{stateRoot}/plan/shadow/{date}.jsonl`，不投递。
- 端点：`POST /plan/reconcile`（202，幂等；body `{reason?, anchor?}`）与 `GET /plan/state?sessionId=&date=`（master/overlay 版本、队列 pending/delivered 尾、账本尾、degraded）。
- 锚点：`ai/analysis/plan_anchor.py --anchor 05:00|07:30` 先 reconcile，失败才回退旧唤醒消息；`axeuh-loom-plan.timer` 与 `axeuh-loom-review.timer` 已安装并 enabled。旧 `plan_wake.py` 保留回滚。
- 回滚：停用两个 timer；把 `12-daily-review.yaml`、`13-biweekly-review.yaml`、`14-weekly-summary.yaml`、`16-weather-morning.yaml` 与 `data_check_scheduler.py`、`session_compactor.py` 恢复 `enabled: true`；把 `scheduling` 置 `off` 并重启 Loom；旧 YAML/脚本文件不删除。
- 自检：`python3 ai/analysis/plan_anchor.py --anchor 05:00 --dry-run --no-config --session-id <ses_...>`；`curl -X POST http://127.0.0.1:5100/plan/reconcile -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"anchor":"05:00"}'`；`curl "http://127.0.0.1:5100/plan/state?sessionId=<ses_...>" -H "Authorization: Bearer <token>"`。

### 旧 fallback（仅回滚）

`tools/loom-plan/systemd/axeuh-loom-plan.*` 现在调用 `plan_anchor.py`；`plan_wake.py` 仅保留回滚/手动补发。当前 plan/review timer 已安装，旧 05/07 YAML 已停发。`/etc/kinship-loom-plan/credentials.conf` 只需 `LOOM_TOKEN`；不再保存 `LOOM_PLAN_SESSION_ID`，reconcile 失败时 `plan_anchor.py` 现场查 `/sessions/main` 再回退。`loom_main` 已 archive，旧 `loom_main` 队列已移到 `.retired-*`；`ses_6320...` 已恢复为主会话（unarchive），调度也已统一到该会话。

- 预检：`python3 ai/analysis/plan_wake.py --dry-run --date <YYYY-MM-DD> --session-id <ses_...>`；`--kind review` 打印 07:30 payload；`--dry-run` 不发 HTTP、不要求 token。
- 凭据：`/etc/kinship-loom-plan/credentials.conf`（0600），只写 `LOOM_TOKEN=...`；会话 ID 不落配置，锚点回退现场查 `/sessions/main`。
- 安装（仅在明确需要 fallback 时由人工执行）：
  ```bash
  sudo install -d -m 700 /etc/kinship-loom-plan
  test -s /etc/kinship-loom-plan/credentials.conf || sudo install -m 600 /dev/null /etc/kinship-loom-plan/credentials.conf
  sudoedit /etc/kinship-loom-plan/credentials.conf   # 写入 LOOM_TOKEN=
  sudo cp tools/loom-plan/systemd/axeuh-loom-plan.service tools/loom-plan/systemd/axeuh-loom-plan.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now axeuh-loom-plan.timer
  systemctl list-timers axeuh-loom-plan.timer
  ```
- 手动验证：`sudo systemctl start axeuh-loom-plan.service`；日志 `journalctl -u axeuh-loom-plan -n 50 --no-pager`，脚本成功时 stdout 含 `"sent": true`。
- 回滚：
  ```bash
  sudo systemctl disable --now axeuh-loom-plan.timer
  sudo systemctl stop axeuh-loom-plan.service
  sudo rm -f /etc/systemd/system/axeuh-loom-plan.service /etc/systemd/system/axeuh-loom-plan.timer
  sudo systemctl daemon-reload
  ```
- timer 用系统时区；安装前确认 `timedatectl show -p Timezone` 为 `Asia/Shanghai`。unit 路径按标准安装位置写死，非标准部署需同步改 `WorkingDirectory` 与 `ExecStart`；装前先 `systemd-analyze verify tools/loom-plan/systemd/axeuh-loom-plan.service`。

## Loom 单主会话与 Web 会话绑定（2026-10-28）

- 权威主会话：生产 `ses_6320a1b90e522bfa`（历史主会话，已 unarchive）；`server.mainSessionId` 与 `scheduling.sessionId` 均未配置，主会话由 marker `{stateRoot}/session/main-session.json` 固定为 6320，调度目标也回落到同一主会话。Loom boot 解析优先级：`server.mainSessionId` > 标记 > `scheduling.sessionId` > 首个已持久化会话 > 新生成；标记是运行时数据（`{sessionID,source,updatedAt}`，原子覆盖），不提交 git。
- Loom API：`GET /sessions/main` 返回单个 `{sessionID,status,createdAt,title?,archived}`，未解析 503 `main_session_unavailable`，未注册就地自愈；`GET /sessions` 与 `GET /sessions?archived=1` 缺省 404 `session_list_disabled`，仅 `server.sessionList: true` 开放。全部逐会话端点不受列表开关影响。详见 [06-Loom使用文档](../../loom-harness/docs/06-Loom使用文档.md) §3.4。
- 后端绑定：`loom:main-task` 是 Web 聊天的主会话缓存，`/sessions/main` 的 200 结果覆盖陈旧绑定；Loom 暂时不可用（503/传输故障）时降级复用该绑定，绝不创建；Loom 确实无主会话（404）时，仅 `POST /session/create` 与 `POST /session/message` 创建一次主会话并绑定，不产生随机会话或重复会话。裸 `main-task` 属语音/QQ，主会话解析器不读不写。
- `/api/screen/session/list`：保留，Loom 腿先解析主会话再按 id 取单行，恒 0/1 行（仅权威主会话），其余为本地 history；不调用 Loom `GET /sessions`。Loom 失败只进 `partial=["loom"]`，响应恒 200，不 500。
- SSE：T6 已提交（`3688775f`）为 `LoomEventHub` 只订阅 `/sessions/main` 与本地 `loom:` 绑定对应会话，子会话由 `session.children` 帧呈现，不再用 `GET /sessions` 发现会话。`backend/routers/events.py` 已无 `list_session_ids` 引用。
- 部署（2026-10-28 09:51-10:15 已按用户确认执行）：1) 09:51:42 Loom 先以 `sessionList: true` 启动，兼容旧后端；2) 09:52:01 重启新后端；3) 09:52:38 移除该标志并重启 Loom，回到缺省关闭；4) 09:56:24 恢复历史主会话 `ses_6320...`，09:56:34 后端缓存刷新；5) 10:05 调度会话与 25 条 WakeQueue 迁到 6320；6) 10:15 清除所有会话 ID 配置，main 由 marker 保持 6320，`queue.restore=25`、`degraded=false`。最终 `GET /sessions` 404、`GET /sessions/main` 200 `ses_6320...`、backend `/api/screen/session/list` 1 行、SSE `proxy.connected` 正常；下一条计划 `cov-12` 在 12:00。
- 回滚：Loom 侧把 `server.sessionList` 设为 true 并重启即恢复旧列表发现面；若需回退后端，Loom 与后端必须成对回退，不能只回退一端。
- 重启门：本次已按用户确认执行；后续任何生产重启（Loom 或后端）仍需先停下确认。

## 运行注意事项

- 前端为 3 个目录：`frontend/mobile/`（主 SPA）、`frontend/preview/`、`frontend/vaudit/`；开发 `npm run dev`（Vite proxy 到后端 HTTPS 8768），生产 `npm run build:atomic` + `npm run verify:dist` 后再原子替换 `frontend/mobile/dist/`（仅前端变更无需重启后端，后端代码/路由变更仍需重启；Android WebView Token 桥见 [android-webview-token-bridge-2026-10-25.md](../dev/android-webview-token-bridge-2026-10-25.md)）
- 子智能体支持多级嵌套 (parentChain 栈)，任何层级可继续打开子智能体列表
- 会话 Token 用量显示: 双路径更新 (SSE `info.tokens` 实时 + API 消息历史加载)
- `USE_MOCK_DATA` 开关位于 `frontend/mobile/src/composables/useMockData.ts`，生产部署时改为 `false`
- 聊天 Markdown 渲染支持图块: LaTeX 公式(KaTeX)、``svg 电路图(XSS过滤 + 自动扩展viewBox)、``mermaid 流程图(运行时渲染)、```circuitjs 电路仿真(CircuitJS1 iframe 内嵌, 查看模式隐藏菜单/侧边栏, 右上角放大按钮进完整可编辑仿真器)。图块点击打开全屏浮窗 (`DiagramPreview.vue`): 滚轮/双指缩放、拖拽平移、下载PNG；含图块消息气泡占满聊天框宽度，高度限制画面 2/3
- 未登录时聊天界面显示演示对话 (`frontend/mobile/src/data/demoMessages.ts`)，登录后自动切换真实会话
- 前端修改后需重新构建并原子替换 `frontend/mobile/dist/`；静态产物按请求读取，仅前端变更无需重启后端，后端代码/路由变更仍需重启后端
- 顶部页边距：全面屏手机的状态栏会压住页面顶部悬浮控件（如全屏浮窗关闭按钮），设置页「外观 → 顶部页边距」可手动调节（`useTopInset.ts` → `--app-top-inset`，仅移动端生效；PC 端强制归零）
- PC 采集端下载：设置页「设备」组（仅 PC 端显示）经一次性票据下载 `/api/pc-sensor/download`；exe 不入 git（`*.exe`/`dist/` 被忽略），服务端需先跑 `desktop/pc-sensor/build.bat`
- 新增后端路由后需重启后端才生效（用 `POST /api/screen/restart` 重启端点，勿按 PID 强杀）
- 语音唤醒：生产唤醒词为「小贺同学」（**支持配置多个**，词表 `ai/data/wake_word/keywords.txt`；内核检测模型按内核解析链自解析，`audio.wake_word.model_dir` 仅随编码请求下发）；`audio.wake_word.enabled` 本地为 true，代码默认与 `config.example.yaml` 为 false（fail-safe）。两条检测路径：**服务端流式 KWS（在内核 `/v1/stream` 检测，命中经 `wakeup.hit` 帧桥回外层状态机；内核不可达=降级不唤醒）**，或**端侧 KWS**（App `local_kws_enabled`，命中后 `audio_start` 带 `local_hit=true` 并回填约 2 秒预滚，外层不做 KWS 解码直入声纹进门验证，App 侧自连接就绪起 5 秒未收到 `wake/start` 即兜底退出）
- 音频上传频率与分段解耦：`data_collector` prefs `audio_segment_ms`（默认 60000，**固定分段时长**：App 端按此固定切段、不做语义切分，App 端不含 VAD 端点逻辑，语义连续性由后端无缝流负责）与 `audio_upload_batch_ms`（默认 600000 = 10 分钟，**只决定多久发一次**）相互独立；停止/中断/划后台或待上传累计达 30 分钟即立即上传
- 上传音质双档（2026-09-23，WAV/FLAC）：`data_collector` prefs `audio_upload_format`（默认 `wav`，可选 `flac`），App 设置页「环境音频 → 上传格式」两档 ChoicePicker（FLAC 无损约省 46% 流量：WAV 2.76 GB/天 vs FLAC 1.50 GB/天），**每段采集现读、改完下一段生效、无需重启**（音频设置仍按每段/每次调用现读；`OnSharedPreferenceChangeListener` 仅用于 Android token 桥，不用于音频设置）。App 侧编码 `FlacFinalizer`：MediaCodec `audio/flac` 首选 + java-flac-encoder 0.3.8 兜底（Maven Central，LGPL-2.1），**编码失败自动降级 WAV 绝不丢数据**。后端对 multipart 做 **magic 嗅探**（`RIFF`+8-11 位 `WAVE` / 偏移 0 `fLaC`，不信任 Content-Type），解码统一 PCM 进无缝流（水位/去重/切分全格式无关），chunk 按上传格式封装落盘 `daily/{date}/audio/...{.wav|.flac}`，`perception.jsonl` 单 `audio` 指针指实际落盘文件；嗅探未知回退 `audio.store.upload_ext`（默认 `wav`）。分析链 `_ensure_wav` 对非 WAV 走 `{stem}.analysis.wav` **旁路转码**（原文件字节不变；旁路瞬态，`analyze_audio_file` 的 `finally` 清理，数据目录只留 `.wav`/`.flac` 原件；`audio_compressor` 归档清单排除 `.analysis.wav`）；`audio_compressor` 归档清单收 `.wav`+`.flac` 且 rmtree 前 `_safe_purge_audio_dir` 断言防丢。消费方（vaudit/preview/mobile/check_coverage/audio_mimo_analyzer）全量双后缀兼容
- 崩溃安全 checkpoint：分段经 `PcmCheckpointWriter` 每 10 秒 flush+fsync 落 `filesDir/audio_checkpoint/pending/...`，收尾按上传格式编码（WAV 补 44 字节头 / FLAC 经 `FlacFinalizer`，编码失败自动降级 WAV 绝不丢数据）原子转 `cacheDir/upload_cache/`（JSON 含 `format` 字段）；启动时 `CheckpointRecovery` 恢复孤儿 `.part` 并按 sidecar `format` 重建对应后缀并补传；未上传成功的缓存条目永不淘汰（LRU + 7 天 TTL + 500MB 上限）。**可感知中断**（停止 / 关采集开关 / `onTaskRemoved` / `onDestroy` / 录音异常）即使本次未认领到进行中分段，也会当场补传已落盘条目（补传线程 in-flight 时排队再跑一轮，不并发重复上传同一条）；**进程被杀**才依赖 checkpoint + 下次启动 `CheckpointRecovery` 恢复
- 音频链路隔离（**两条独立链路，不可混谈**）：环境音频（multipart 上传）进增量数据 `perception.jsonl` + `daily/{date}/audio/`；语音唤醒（`WS /ws/audio-stream`）**不进**增量数据，音频落 `stream/{date}/audio/`，只把 ASR 结果作为语音指令投递主会话。隔离靠 `origin="upload"|"stream"` 溯源，`audio.stream.persist_perception`（默认 false）仅供调试回滚
- 上传分段**无缝流**（2026-09-15 上线，2026-09-25 C5 起切分上移内核）：`audio_ingest_registry`/`audio_ingest_session` 按 `device_id` 维护一条虚拟连续流，时间连续判定 `B.start_ms <= A.end_ms + audio.stream.stitch.tolerance_ms`（默认 1000ms，覆盖 App 500ms 前滚重叠）即追加、**不在文件边界切分**；逐帧静音切分**委托内核 WS `mode:"segment"` 通道**（`segment_channel.py`；静音端点 `stitch.silence_cut_s` 1.5s / `stitch.min_chunk_s` 10s、硬上限 `stitch.max_chunk_s` 120s），外层保留时间轴/水位/去重/holdback；**合并发生在音频层**（累积 PCM 整段送 ASR，避免跨文件断句）。超容差 / 设备变化 / 时间倒流 → 先冲刷当前流再开新流。`holdback_s`（90s，按接收空闲计）超时冲刷尾段；`stitch_enabled=false` 回退逐段独立分析；通道故障=该流降级逐段独立产出（镜像缓冲兜底、冷却 120s 后新流重试，**绝不回退本地切分**——本地 segmenter 已删）；产出块语音占比低于 `min_flush_speech_ratio`（默认 0.05）视为纯静音，不产出 voice 条目
- 提示音电平：`res/raw/start.mp3` / `end.mp3` 由峰值 −16/−18 dBFS 归一化到约 −1 dBFS（响度约 6 倍）；因 `SoundPool` gain 上限为 1.0 无法放大，只能改源文件（2026-09-15）
- 音频流 WS 建连 **IPv4 优先**：`AudioStreamClient` 用自定义 `Dns` 把 IPv4 排到最前（`example.com` 有 AAAA 但 IPv6 入口不可达，OkHttp 4.12 无 Happy Eyeballs，原会先连 IPv6 等满 15s `connectTimeout`）
- `SensorStateHolder.shared` 为进程内**共享单例**，`DataCollectorService` 与设置页 UI 必须读写同一实例（历史上两处各 new 一个，导致设置页传感器预览恒为初值）
- 非流式上传的 `client_time` 取分段真实起始时间（原 `recordingStartMs` 只赋值一次，兼容模式下所有分段同名互相覆盖）；现为毫秒精度（`yyyy-MM-dd'T'HH:mm:ss.SSSXXX`）并额外回传 `start_wall_ms` 表单字段，后端优先用它推算时间轴，避免秒级截断导致跨段裁剪多裁真实音频
- 设备标识：前端 `frontend/mobile/src/composables/useDeviceId.ts`（localStorage）与 App `app/.../util/DeviceId.kt`（SharedPreferences）生成并持久化 `device_id`；WS 握手携带 `device_id` + `client`（`web`/`native`），HTTP 发消息携带 `X-Device-Id`（可选 `X-Client-Type`），后端据此做 TTS 设备路由
- Android WebView token 桥（2026-10-25）：`axeuh_prefs["auth_token"]` 是 WebView 唯一真源；`WebTokenBridge` 在 `onPageFinished` / `onResume` / `auth_token` 变化时注入 `localStorage.mobile_token` + `axeuh-token-refresh`；SPA 关闭登录层并重连 SSE/WS；`axeuh://retry` 用当前 prefs 重建 URL，`axeuh://ignore` 暂停注入。详见 [android-webview-token-bridge-2026-10-25.md](../dev/android-webview-token-bridge-2026-10-25.md)。
- 配置节 `audio:`（store / stream / vad / voiceprint / wake_word / assistant）与 `tts:`（enabled / device_channel_ttl_seconds / fallback_client_types）已全量可配；保存后由配置应用器热生效，无需重启后端
- 音量设置：App 设置页「声音与播报」页内有「提示音音量」（`data_collector` prefs `hint_tone_volume`，默认 90）与「TTS 语音音量」（`tts_volume`，默认 100）两个滑块，各带「试听」按钮；提示音是 `HintTonePlayer` 用 SoundPool 播放的内置音效 `res/raw/start.mp3` | `end.mp3`（非 TTS 语音），TTS 音量经 App 注入的 `?tts_volume=` 与 `window.__axeuhSetTtsVolume(v)` 下发到 WebView 内网页播放器的 GainNode
- 后端日志：`backend/logs/backend.log`（按日轮转，保留 30 天），另有控制台彩色输出
- `start.ps1` 不再结束其他进程；端口被占用时只报告占用者。不要使用历史脚本的按进程名清理方式
- `kernel/` 是**闭源分发物**：内核源码在私有仓开发维护，对外分发经 PyArmor 保护构建（`kernel/build_dist.py`）+ `kernel/EULA.md`；对外契约只认 `docs/kernel-contract.md`（设计稿 `docs/kernel-design.md` 只读）。`AXEUH_KERNEL_TOKEN` 经环境变量注入内核进程（无命令行参数），任何文档/提交不得写入真实 token 或密钥
- `backend/models.py`（Pydantic 数据模型）与历史 ML 权重目录 `backend/models/`（Wave C3 已整体出库删除，权重归内核私有模型目录）同名易混，导入时注意前者才是现役模块
- `app/` 目录是 Android 模块（Gradle），不是 FastAPI 的 app 包
- 端口：后端 **8768**（HTTP 与 HTTPS 同端口，由 `ssl.enabled` 决定协议；本地与公网一致，frpc 8768→8768）、Loom 助手 **5100**（`127.0.0.1`，唯一助手宿主，`ai_backend: loom`；稳定态由后端作为受管子进程托管，systemd `axeuh-loom` 仅迁移与回滚）、PC 感知采集器 **18888**（本地 HTTP）、QQ 网关 **8770**（`127.0.0.1`，默认关闭；生产已启用）、Vite dev **5173**、音频内核 **127.0.0.1:动态端口**（`--port 0` spawn，实际端口记录在 `backend/data/kernel_state/kernel.pid` pidfile，非固定）、本地 LLM **8000**（`127.0.0.1`，systemd `vllm-27b`，Qwen3.8-27B-GPTQ-W4A16 TP=2 双 2080Ti，256K 上下文 turboquant_k8v4 KV，开机自启；运维 `docs/vram-3gpu-coexistence-20261018.md`）、MOSS serve **8100**（`127.0.0.1` 仅回环，systemd `axeuh-moss` 常驻**卡2（3060 Ti, x1 转接）fp8 量化**，`--max-num-seqs 1` 串行化；`axeuh-moss-watch` 唯一调用方；转正执行中，待两日回归 + 七天观察）、音频工作台 **8790**（`tools/audio-console/`，素材试听+人耳基线标注）

- MOSS 转正运维：`axeuh-moss`（serve）+ `axeuh-moss-watch`（watcher）+ `axeuh-moss-regression.timer`（每日 05:00，周日 full）+ `axeuh-moss-alert.timer`（hourly）；报告在 `tools/moss-shadow/state/regression/`，告警失败落 `state/alerts/failed.jsonl`；通知走后端 `POST /api/notification/send`。详见 `tools/moss-shadow/README.md` 与 `docs/moss-formalization-plan-2026-10-22.md`。
- Loom 交互式 PTY（2026-10-19）：`pty_spawn/pty_write/pty_read/pty_list/pty_kill`（node-pty）。`notifyOnExit` 默认 true，退出通知经 `deliverWake` 作为 durable user 消息投回发起会话：空闲立即起唤醒轮，忙则当前轮收尾后起新轮；env 剥离 `LOOM_`/`AXEUH_` 等前缀，spawn cwd 限 workspace，权限/deny/net 走 D7 缝。
- Loom 自动唤醒（2026-10-21）：主会话 converge 可选 `wake`（倒计时/带时区 ISO/本地时间/HH:MM/none），到点经 `deliverWake` 投 `【自动唤醒】` durable user 消息并起轮；sidecar `ai/.loom/state/session/wake/{sid}.json` 耐重启；`server.autoWakeEnabled` 缺省启用、显式 false 关闭需重启；侧会话/子智能体不可用。
- Loom 压缩（2026-10-21）：生产走 worker `summaryMode:auto` + `summaryReasoningEffort:low`；旧 compactable toolResult 先投影清空、预算内单次摘要、超预算递归 depth≤2；2026-10-22 起 worker 默认 ops+chat 双视角、合成一条摘要注入，`summaryPerspectives:["ops"]` 可回退；详见 `../loom-harness/docs/06-Loom使用文档.md` §5.4.1。
- Loom converge 回执简化（2026-10-21）：主会话只需 `status`（digest 自动派生、body 可省略）；侧会话 digest 亦内部派生。
- Loom 是唯一助手宿主（`127.0.0.1:5100`），`ai_backend: loom`。稳定态由 `core.hot_server` 作为受管子进程托管；systemd `axeuh-loom` 仅迁移期与回滚使用。`launcher.py` 已退役，不再管理助手或后端编排。助手调用点经 `services/ai_client_factory.py`（`acquire_ai_client()`）按 `ai_backend` 选择客户端，公开模板与生产均走 Loom。
- P2P（实验，当前不可用）：仅保留实验代码与配置骨架，当前不具备可用性。保持 `p2p.enabled: false`；不要部署 `axeuh-signal`、不要安装 `backend/requirements-p2p.txt`，也不要把 P2P 端点列入正式连接方案。
- Android 客户端网络（2026-10-25）：设置→网络维护有序连接层列表（网络地址 / P2P 占位），支持 AUTO_CHAIN / PINNED、测试并应用；仅 IOException 触发换层，401/4xx/5xx 不切；旧 `server_url` / `endpoint_candidates` / `transport_mode` 迁移后只读。桌面端仍按其自身配置模型。
- 具体配置以 `config.example.yaml` 与 `docs/system-config-hot-reload.md` 为准；生产承载文件可能是 `config.yaml`、JSON 或 SQLite。
