# 定时任务配置

> 本文件随 `ai-template` 维护（2026-10-30 对齐）；与实例不一致时，以本文件与仓库代码为准。

此目录存放所有定时任务配置文件。

- `*.yaml` — YAML 定时任务（统一的任务定义方式）
- `*.py` — Python 自定义脚本（FileWatcher 自动管理，按 frontmatter 的 `enabled` 启停）

## 定时任务与业务的区分

系统里多处都叫"任务"，按下表区分，**不要混用**：

| 位置 | 名称 | 回答的问题 | 谁读 |
|------|------|-----------|------|
| `{AI目录}/data/tasks/*.yaml` \| `*.py` | **定时任务**（排班表） | **何时**触发、发什么 prompt | 后端调度器 / FileWatcher |
| `{AI目录}/memory/self/tasks/*.md` | **业务**（操作手册） | 挂上后**做什么**、怎么做、产出什么 | 数据检查批次（01 步骤 8） |
| `{AI目录}/agents/*.md` | 子智能体规范 | 独立子智能体的岗位职责 | 对应子智能体会话 |
| `{AI目录}/memory/self/任务.md` | 待办账本 | 主智能体要跟进的事 | 主智能体 |

**一句话判据：管时间的进 `data/tasks/`，管业务逻辑的进 `memory/self/tasks/`。**

业务分两级（frontmatter `执行:` 字段）：

- **顺带**（L1）：批次会话自己顺手做完，零增量成本
- **委托**（L2）：批次 `task()` 派孙代理跑、收结果并入本批转达；**批次分析本身仍独立完成，禁外包**

薄触发原则：`data/tasks/*.yaml` 的 prompt 只写"何时 + 执行哪个业务"，业务细节全部写在 `memory/self/tasks/`，排班表不塞操作步骤。

## 文件格式

```yaml
name: 任务名称
enabled: true                           # 是否启用，可选，默认 true
schedule: <schedule格式>                 # 触发计划
prompt: |-                              # 发给 AI 的提示词
  任务执行逻辑...
model: deepseek-flash                # 可选，覆盖全局默认模型
provider: deepseek                   # 可选，覆盖全局默认提供商
```

## model / provider 字段（可选）

不写则使用后端全局默认（`config.yaml` 的 `opencode.default_model` / `opencode.default_provider`，可在 Web 端"模型设置"覆盖）。

YAML 任务支持三种等价写法：

```yaml
# 1. 字符串简写：只指定模型 ID（provider 用全局默认）
model: deepseek-flash

# 2. model + provider 并列（推荐，写法最直观）
model: deepseek-flash
provider: deepseek

# 3. 结构化字典：在 model 内同时给出 id 与 provider
model:
  id: deepseek-flash
  provider: deepseek
```

> 顶层 `provider` 与 `model.provider` 等价；两者同时出现时**字典写法优先**。
> Python 脚本的 frontmatter 同样支持 `model:` 与 `provider:` 两个键（写法 1、2），见下方「脚本文件格式」。
> 模板随附的 YAML 任务不写 `model` / `provider`，统一使用全局默认；需要单独指定时再按上述写法添加。

可用模型见 `GET /api/screen/model` 接口返回的列表。

## schedule 格式

### 简写方式（推荐：一行搞定）

| 表达式                                         | 说明                    |
| ---------------------------------------------- | ----------------------- |
| `daily: "08:00"`                             | 每天 08:00              |
| `daily: "04:00"`                             | 每天 04:00              |
| `hourly: 30`                                 | 每小时的 30 分          |
| `weekly: {days: "mon,wed,fri", at: "09:00"}` | 每周一三五 09:00        |
| `monthly: "1,15 14:30"`                      | 每月 1 日和 15 日 14:30 |
| `delay: "5m"`                                | 5 分钟后执行一次        |

### 每月不同日期不同时间

```yaml
schedule:
  monthly:
    1: "14:30"
    15: "10:00"
```

### 字符串简写

```yaml
schedule: "daily 04:00"
schedule: "weekly mon,wed,fri 09:00"
schedule: "monthly 1,15 14:30"
schedule: "hourly"
schedule: "delay 5m"
```

规则：

- 第一个词是模式关键字：`daily` / `hourly` / `weekly` / `monthly` / `delay`
- 星期名用 3 字母小写：`mon,tue,wed,thu,fri,sat,sun`
- 时间格式 `HH:MM`（24 小时制）
- 延迟格式：数字+单位（`s`秒, `m`分, `h`时, `d`天）

## 默认值

| 字段                    | 默认值        | 说明             |
| ----------------------- | ------------- | ---------------- |
| `enabled`             | `true`      | 任务启用状态     |
| `schedule` 未指定时间 | `00:00`     | 凌晨执行         |
| `weekly` 未指定天数   | `mon`       | 周一             |
| `monthly` 未指定日期  | `1`         | 每月 1 号        |
| `user_id`             | `"default"` | 自动填充，不用写 |
| `target`              | `main-task` | 自动填充，不用写 |

## 运行时状态（不需要写，调度器自动管理）

以下字段由调度器自动管理，**不要在任务文件中填写**：

- `next_run` — 下次执行时间
- `last_run` — 上次执行时间
- `run_count` — 已执行次数
- `task_id` — 自动生成
- `created_at` — 自动生成

## 新增任务的步骤

1. 在 `{AI目录}/data/tasks/` 下新建 `.yaml` 文件
2. 写 `name`, `schedule`, `prompt` 三个字段
3. 可选：`enabled: false` 暂不启用
4. 保存文件，后端自动热加载，**无需重启**

## 示例

```yaml
# {AI目录}/data/tasks/example-task.yaml
name: 示例任务
schedule:
  daily: "08:00"
enabled: true
prompt: |-
  【示例任务】 按以下流程执行：

  1. 运行分析脚本
  2. 生成报告
  3. git add/commit
```

---

## Python 自定义脚本

此目录也支持 `.py` 文件——FileWatcher 自动检测、AST 安全审查后启动。

### 脚本文件格式

```python
"""
name: 脚本名称          # 必填
enabled: true            # true=自动启动, false=停止
note: 备注说明           # 可选
prompt: |               # 调用 trigger_task 时的默认提示词
  请分析今天的感知数据。
model: deepseek-flash    # 可选，覆盖全局默认模型
provider: deepseek       # 可选，覆盖全局默认提供商
"""

def run(context):
    """自循环模式：自己控制频率和心跳"""
    while True:
        context.log("检查中...")
        if 条件满足:
            context.trigger_task("任务名")  # 触发 AI 任务（可加 model=/provider= 覆盖）
        context.heartbeat()   # 必须每300秒至少调用一次
        time.sleep(60)
```

### Context API

| 方法                                     | 说明                        |
| ---------------------------------------- | --------------------------- |
| `context.log(msg)`                     | 记录结构化日志              |
| `context.trigger_task(target, prompt, model, provider)` | 触发 AI 任务（prompt/model/provider 均可选） |
| `context.alert(msg)`                   | 报告错误/异常               |
| `context.read_file(path)`              | 读取文件（沙箱路径）        |
| `context.getenv(key, default)`         | 读取环境变量                |
| `context.backend_info()`               | 获取后端运行信息（端口/会话ID） |
| `context.heartbeat()`                  | 保活信号（每300秒至少一次） |

### 与 YAML 任务的区别

YAML 任务：简单固定流程，静态 prompt，适合系统内部调度。
Python 脚本：完整编程能力，动态条件判断，适合复杂自动化。

### 沙箱限制

- 允许导入：`math, json, re, datetime, time, random, typing, collections, pathlib, os, socket, http, urllib, requests`
- 禁止导入：`subprocess`、`shutil`、`ctypes`、`tempfile`、`asyncio`、`threading`、`multiprocessing`、`aiohttp`、`flask`、`fastapi`、`builtins`、`importlib`；禁止内置 `eval/exec/compile/__import__/input`（另禁用 `getattr`、`globals`、`locals`、单参数 `type`）
- 内存限制 256MB，心跳超时 300 秒，trigger_task 速率限制 1次/分钟
- 脚本可以通过 `context.backend_info()` 获取当前会话 ID、后端端口与宿主端口
- 脚本可以读写目录（`os.listdir/mkdir/remove`）和发起网络请求（`socket/requests`）

### 示例

```python
# {AI目录}/data/tasks/hello_production.py
"""
name: 生产测试脚本
enabled: false
note: 完整功能演示，展示 Context API 全部能力
prompt: 这是一个自定义脚本的完整功能演示。
"""

import time
import os
from datetime import datetime

def run(context):
    # 获取后端运行信息
    info = context.backend_info()
    context.log(f"后端端口: {info['backend_port']}, 会话ID: {info['opencode_session_id']}")

    while True:
        # 检查数据文件
        if os.path.isdir("{AI目录}/data"):
            today = datetime.now().strftime("%Y-%m-%d")
            data_dir = f"{AI目录}/data/{today}"
            if os.path.isdir(data_dir):
                context.log(f"今日数据目录存在: {data_dir}")
                files = os.listdir(data_dir)
                context.log(f"文件数: {len(files)}")
            else:
                context.log("今日暂无数据")

        # 按条件触发 AI 任务
        # if some_condition:
        #     context.trigger_task("检查", "请分析数据")

        context.heartbeat()
        time.sleep(300)
```

## 参考

- `{AI目录}/data/tasks/*.yaml` — YAML 定时任务
- `{AI目录}/data/tasks/*.py` — Python 自定义脚本
- `{AI目录}/data/tasks/logs/{脚本名}/{日期}.log` — 脚本运行日志
- `{AI目录}/data/tasks/logs/audit/{日期}.jsonl` — 审计日志
- 后端解析逻辑见 `backend/services/schedule_parser.py`

## 现有任务与脚本

> 模板默认使用固定时间任务。生产可由 Loom 主计划接管；接管后下表固定时间 YAML 与 `data_check_scheduler.py` 都应设为 `enabled: false`，由 plan 唤醒驱动，避免双触发。模板默认值保留固定时间模式，便于未接 Loom 主计划的实例直接启动。

### YAML 定时任务

| 文件 | 频率 | 用途 | 状态 |
|------|------|------|------|
| `05-plan-wake.yaml` | 每天 05:00 | 日计划（Loom Plan mode：只读 + plan commit，不执行 care，不发用户通知） | enabled: false |
| `07-plan-review.yaml` | 每天 07:30 | 计划复核（Loom Plan mode：只读 + plan revise，不执行 care，不发用户通知） | enabled: false |
| `12-daily-review.yaml` | 每天 00:40 | 今日复盘（复盘昨天） | enabled |
| `13-biweekly-review.yaml` | 每月 1/15 18:30 | 双周深度回顾 | enabled |
| `14-weekly-summary.yaml` | 每周一 03:00 | 周报总结（上周一~上周日） | enabled |
| `15-night-audit.yaml` | 每天 02:00 | 夜间审计（审昨天，跑 `audit_collector.py`，结果写复盘审计小节；FAIL 由主会话发一条警告） | enabled: false |

> 复盘/审计任务（12-15）不写 `model` / `provider`，统一使用后端全局默认；通过 `task(subagent_type="reviewer", ...)` 委托 `{AI目录}/agents/02-daily-review.md` / `03-biweekly-review.md` / `04-weekly-review.md` / `05-audit.md` 规范执行。
>
> 15 号任务默认关闭；它依赖 `{AI目录}/analysis/audit_collector.py` 与 `{AI目录}/agents/05-audit.md`，两者随模板提供，实例若删除过需先补齐再启用。
>
> 05/07 是 Loom 主计划的 Plan mode 示例任务，默认关闭；主计划接管后由计划锚点驱动，固定时间 YAML 仅留作示范与回滚。

### 常驻 Python 脚本（FileWatcher 自动管理）

| 脚本 | 频率 | 用途 |
|------|------|------|
| `data_check_scheduler.py` | 每天 **7 窗口**（00/06/08/12/16/20/22 点，2026-10-27 v4；00 点读取前一天 22:00~00:00） | 触发数据检查流水线 |
| `session_compactor.py` | 每天 04:00 | 向主会话发送一次"整理信息"提醒；可以压缩会话，也可以不压缩；不自动调用压缩接口 |
| `deepseek_balance_monitor.py` | 30 分钟 | 查 DeepSeek 余额，低于阈值发 App 通知；余额每累计消耗一定金额写一条 perception 数据（`type=balance`）；阈值与 key 路径可用环境变量覆盖，默认关 |
| `foreground_watch.py` | 每 60 秒扫描 | 前台时长监控：回放当日 `perception.jsonl`（app 切换 + screen 亮灭边沿 + heartbeat 锁屏断言），按设备×应用累计「前台且亮屏」时长；超阈值（默认 60 分钟）且不在黑名单的应用经 `trigger_task` 提醒，同一段使用每再累计 60 分钟补发一档；阈值/黑名单/状态文件路径可配置，默认关 |
| `xiaomi_cloud_health.py` | 每 `health.cloud_poll_interval_min` 分钟 | 小米云健康拉取：按水位增量直写 `HealthStore` 的 `cloud` 分片（`users/{user}/health/{date}/cloud.json`）；**默认关**（`enabled: false`），凭据走 `config.yaml` 的 `health.cloud.*`；接入见 `docs/数据源-小米健康云.md` |

### 非任务 / 停用脚本

| 文件 | 说明 |
|------|------|
| `check.py` | AST 安全审查工具，供 AI 自检脚本用；非定时任务（无 `name`/`enabled` frontmatter） |
| `hello_production.py` | Context API 完整功能演示，`enabled: false` |
| `music_tracker.py` | 音乐追踪器，`enabled: false` |
| `test_trigger_task.py` | `trigger_task` 用法演示，`enabled: false` |

> 余额 key 存同目录 `deepseek_key.txt`（gitignored，不提交）。发通知/写感知数据走后端接口（`/api/notification/send`、`/api/screen/stt/perception-event`），token 从 `backend/config/auth.json` 本地读取。

## Loom 主计划接管（推荐生产模式，可选）

启用 Loom 主计划前，先用 `{Python解释器路径} {AI目录}/analysis/master_plan_seed.py --root {AI目录}/data` 播种 `data/plan/master.json`，确认 coverage 与任务都已进入计划；然后把 12-15 四个 YAML 与 `data_check_scheduler.py` 设为 `enabled: false`。固定时间任务与 Loom 主计划不要同时运行，两套调度叠加会重复触发。旧任务文件保留作回滚，不要删除。

## 可选 QQ 集成

模板不随附 QQ 网关与 QQ 相关任务；需要 QQ 的部署自行添加网关配置与 `data/tasks/` 任务。QQ 号、token 与其他凭据只写本地 gitignored 配置，不提交仓库。
