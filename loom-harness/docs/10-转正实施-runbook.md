# 10 - 转正实施 Runbook（B 模式单实例，用户 2026-10-14 拍板）

> 状态：**草案待批准**——前置票 W36/W37/W38 全绿后，按 §3 顺序执行。
> 决策基线：回滚面在 hm（`ai_backend: opencode` 一键回现网），opencode:5096 launcher 全程不动兜底。
> 本 runbook 引用行号截至 harness @ d5bd068 / hm @ 3148c5a5，执行前重核。

## 0. 前置票清单（全部完成才可切）

| 票 | 内容 | 状态 |
|---|---|---|
| W36 | `sandbox:` 段配置化（围栏/拒绝引擎"配置才拦"） | 已完成 d5bd068，影子活体三门全过 |
| W37 | `task_cancel` 工具（模型可中止后台子智能体） | 进行中 |
| W38 | 真 ai-mcp 接入 loom mcp 段（tts_speak/send_notification）| 待开（形态已勘明，见 §2.3） |

## 1. 声明桥接（生产 ai/ 内新增，最小侵入）

生产是**两层声明**体系，loom 只扫 `<workspace>/agents/`，opencode 声明在 `.opencode/agents/`：

1. **`ai/agents/main.md`（新建，loom persona 真源）**
   - frontmatter：`name: main` + `kind: main` + `memory: [AGENTS.md, memory/self/必读.md, memory/self/关系.md, memory/self/价值校准.md, memory/self/纠错.md, memory/self/认知.md, memory/self/任务.md, memory/self/身份.md, memory/self/SELF-INDEX.md, memory/profile/core.md, memory/profile/state.md]`（与影子实例 15:08 活体门一致的 11 件）
   - 正文：搬 `.opencode/agents/main-task.md` 的执行原则+边界表（"ai/ 自由操作"等），opencode 的 `permission:` frontmatter 丢弃（loom 面由 sandbox: 段治理）；删除影子 main.md 的占位句与 HTML 注释
2. **`ai/agents/data-checker.md`、`ai/agents/reviewer.md`（新建，角色薄壳）**
   - loom 格式 frontmatter（`memory: [AGENTS.md]`），正文 = 短身份壳 + "具体工作指令按 prompt 所指 `agents/0N-*.md` 说明书加载"
   - 名字与生产投递提示词逐字对齐：`task(subagent_type="reviewer"/"data-checker")`（12-15 yaml + data_check_scheduler 模板）
   - opencode 不扫 `agents/` → 双引擎并存期零干扰
3. **说明书与库件不动**：`agents/01-05*.md`（loom 会扫成 `01_data_check` 等额外可派角色——无害共存）；`复盘-公共.md`/`规则-01-data-check.md` 保持原位（各 1 条路由 warn，与影子同现象；搬家属 V2 优化，转正窗口不动生产面）

## 2. `ai/.loom/` 实例 bootstrap

### 2.1 gitignore 防线（先做！config 含明文 key）
- `ai/.gitignore` 追加 `.loom/`（ai/ 由 hm 仓跟踪，key 绝不能入库）
- 验证：`git -C hm check-ignore -v ai/.loom/config.yaml` 命中后才写文件

### 2.2 `ai/.loom/config.yaml`（从影子 config 移植，逐段核）
- `server: {port: 5100, hostname: 127.0.0.1, convergenceEnforced: false, sourceContract: off, autoWakeEnabled: true}`
- `server.autoWakeEnabled`：缺省启用；显式 `false` 关闭主会话 converge 自动唤醒（主 schema 摘除 `wake`，带 wake 的调用拒收）；改配置需重启。
- `workspace: /opt/kinship/ai`（私有工作区）
- `sandbox:` 转正基线：`containment: off` + `net: allow` + `deny: [sudo, su, systemctl, shutdown, reboot, mkfs, mount, umount, "rm -rf /", "git push"]`（OS 底线保留，其余全放行=opencode 等价无围栏）
- `providers/models/pricing/credentials`：与影子逐字同（qwen3.8-flash ctx1M）
- `skills.allowlist`：暂指向 `ai/skills`（不存在=warn 软降级；生产 skills 面转正后再定）
- `mcp.servers`：`search`（key env 注入照搬影子）+ `ai_mcp`（见 2.3）+ **去掉 demo**（假回声不留生产）

### 2.3 ai-mcp 接入形态（W38 已勘明）
- 本体 `ai/mcp/ai_mcp.py`：FastMCP **stdio**，`cmd=/opt/kinship/.venv-health/bin/python`，`cwd=<ai 绝对路径>`（脚本按相对路径读 ai/ 状态，cwd 必对）
- loom 条目 name 取值待定：mcp 工具映射 `mcp_<name>_<tool>`，名字含连字符可能与工具标识校验冲突 → W38 实测定 `ai_mcp`（下划线，映射 `mcp_ai_mcp_tts_speak`），并把 AGENTS.md/persona 中 `tts_speak` 提及处核对（说明书引用名与 loom 工具名对齐）

## 3. 切换序列（执行时逐步留痕）

1. `cp -a /etc/systemd/system/axeuh-loom.service <同路径>.bak-<ts>`；unit 内 `LOOM_INSTANCE` 由 fixture-workspace 翻为 `.../axeuh-health-monitor/ai`（fixture 旧值注释保留，秒回切）
2. `daemon-reload` → `restart axeuh-loom` → 影子三门复验式活体：journal `persona bound`（file 指向 **ai/**agents/main.md）+ `memory roster count=11` + `sandbox policy{off,allow,10}`；`/context/full` 验 systemPrompt=main-task 正文版
3. hm：`cp -a config.yaml config.yaml.bak-<ts>` → `ai_backend: loom` → `systemctl restart axeuh-health`（launcher 会拉起 opencode 但 loom_client 不再被 web 用；5096 活着）
4. web 热开关切 loom（`POST /api/screen/backend`），浏览器聊天冒烟（persona/回复/SSE id 累积）
5. **真流量观察窗**（对齐偶数小时 data-check 点）：投递→主分级→派 data-checker→读 perception→写理解 md→`git commit`（生产 hm 仓！deny 面放行 commit 拦 push）→reminder 唤醒→验收；语音唤醒一次实测 tts 出声
6. 全程 journal+ledger 留痕；异常即 §4 回滚，**不带病调试**

### 3.1 移动端历史集成验收（health-monitor，必过项）

- `GET /api/screen/session/{id}/messages?backend=loom`：默认 `limit=50`，`before` 游标可上翻第二页，`next_cursor` 原样透传。
- 分页截断的孤儿 toolResult：原位保留独立壳（`info.role="toolResult"`），时间线顺序不挪，绝不并到末条 assistant。
- read 工具卡不得出现在最终纯文本回复下；验收时翻两页，确认早期 read 结果在原位置、末条文本气泡下无工具卡。
- 对照真源：`axeuh-health-monitor/backend/routers/session.py` 与 `backend/services/loom_messages.py`；异常按 §4 回滚。
- PTY 验收：主会话 pty_spawn（notifyOnExit=true）→ converge → 自动收到 <pty_exited> durable user 消息并起唤醒轮；wire.request.tools 含五件套；终端内 env 无 LOOM_/AXEUH_ 前缀；退出后无孤儿 PTY 子进程。
- 自动唤醒验收：新会话 converge(wake=1m) → `ai/.loom/state/session/wake/{sid}.json` → 到点 `【自动唤醒】` durable user 消息并起新一轮；SSE title=自动唤醒，不得误标 PTY 退出通知；测完 archive 会话。

## 4. 回滚剧本（秒级）

- 触发：生产投递失败/web 渲染异常/子智能体派不出/任何现网回归
- 动作：`config.yaml` 还原 `.bak`（cp -a）→ `systemctl restart axeuh-health` → opencode:5096 链路即回（launcher 全程在跑，会话史连续）
- loom 侧：unit `LOOM_INSTANCE` 注释位回切 fixture = 影子退役位还原；`ai/.loom/` 留着不碍事（gitignored）
- 数据面：切窗内 loom 若已写 ai/ 文件（理解 md/commit），均为生产格式产物，opencode 链路直接续用——**无数据回迁需求**

## 5. 残留风险（执行前对用户复述）

1. tts barge-in/busy 语义未对拍（opencode 有，loom /voice 忙时行为未测）——切窗首个语音点验证，失败即回滚
2. 语音唤醒的 tts 依赖 ai_mcp cwd 正确（§2.3），错配=静默失败——活体门必含一次真出声
3. `skills.allowlist` 指空目录 warn——软降级不阻 boot
4. 首启 `ai/.loom/` 无历史会话：loom_main 全新（影子 156+ 条测试会话留 fixture 不迁移）
