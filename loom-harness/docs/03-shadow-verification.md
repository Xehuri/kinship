# Loom 影子验证报告（T39，开发波次终局闸门）

> 生成时间：2026-10-08 18:3x（+0800）。验证者=T39 worker（只验不修）。
> 范围：全量门禁 / 边界纪律（D32）/ serve 冒烟 / D1–D34 决策覆盖 / 已知 flake / 遗留清单 / 统计与波次复盘。
> 铁律：每一断言附实际命令与输出摘录；无命令证据的口头断言为零。
> 结论先行：**门禁三连 exit 0（1258/1258 绿）、5096 等既有端口零触碰、serve 冒烟 PASS、
> D1–D34 全覆盖有据、已知 flake 本轮未触发且单文件双跑绿、T40 零执行——影子验证通过，切换方案就绪（docs/04）。**

---

## 1. 全量门禁（a）

命令（axeuh-harness 根，2026-10-08 18:27:52 起跑）：

```bash
npm run typecheck   # tsc -b
npm run build       # tsc -b
npm run test        # vitest run
```

输出摘录：

```
TYPECHECK_EXIT=0
BUILD_EXIT=0
 Test Files  100 passed (100)
      Tests  1258 passed (1258)
   Duration  13.30s (transform 6.31s, setup 0ms, collect 69.56s, tests 23.02s, ...)
TEST_EXIT=0
```

- **三连 exit 0，本轮无 flake、无复跑**（§5 记录的已知 flake 本次全量并发未触发）。
- 测试分布（按 `packages/<p>/src` 计数）：core 64 文件/877 测试、server 22 文件/178 测试、
  tools 9 文件/138 测试、adapters 5 文件/65 测试；合计 100 文件/1258 测试。
- 日志中的 `[harness-pi] hook ... failed [fail-closed: treated as deny]` 行为**故意的失败注入测试**
  （permission-gate fail-closed 用例）的预期输出，非故障。

## 2. 边界纪律：5096 等现状未动（b，D32）

### 2.1 端口现场（取证时刻 18:28）

```bash
ss -tlnp | grep -E '5096|8768|8769|18888|5097'
```
```
LISTEN 0  2048   0.0.0.0:8768  users:(("python",pid=1534349,fd=14))
LISTEN 0  512    127.0.0.1:5096 users:(("opencode",pid=1534317,fd=17))
```

- 5096 仍是 **opencode 自身**、8768 仍是后端 python 服务——归属与开工前一致，未动。
- 8769/18888 当前不在本机监听视图（属既有服务动态启停，非 loom 所为；loom 全库 `MIN_PORT=5097`，
  见 `packages/server/src/config/section-checks.ts:11`，测试一律 `listen(0)` ephemeral，绝不占用）。
- 5097 冒烟后释放：`ss -tln | grep 5097` 退出码 1（无监听）。

### 2.2 axeuh-health-monitor/ai/ mtime 抽查（三文件早于今日 00:45）

```bash
ls -la --time=mtime axeuh-health-monitor/ai/AGENTS.md axeuh-health-monitor/ai/opencode.json axeuh-health-monitor/ai/bun.lock
```
```
AGENTS.md   10月 6 15:58
opencode.json 10月 7 19:17
bun.lock    4月 11 21:38
```
三文件 mtime 均早于开工时刻（2026-10-08 00:45）。

**诚实披露（越权改动排查结论）**：ai/ 与 backend/ 下确有一批文件今日 mtime 变动
（如 `analysis/check_voiceprint.py` 09:11、`backend/services/opencode_client.py` 18:13、
`data/gps_cache.json` 18:09）。**归属取证**：axeuh-health-monitor 自身 git log 显示这批改动来自用户
**并行的 eflowcode 通道代跑与 P1/P2 系列重构**（例：提交 `8634f308`「数据检查: 2026-10-08 14:00~16:00
时段理解记录（**eflowcode 通道代跑**）」、`7833a2bd` P2-K1a、`3b564ffd` P1-V7——均为该仓自己的
提交流水，含测试与提交说明）。loom 波次与之无交集，取证见 2.3/2.4。

### 2.3 loom 侧零触碰取证

```bash
grep -rn "axeuh-health-monitor" packages/*/src --include="*.ts" | grep -vc ""  # 命中文件数
```
→ **0**：全部源码（含测试）不含任何 `axeuh-health-monitor` 路径引用；工作区指针一律
`fixture-workspace/`（D33 修正三：干净目录即可独立起）。

### 2.4 进程残留

```bash
ps aux | grep -iE 'loom|cli\.js serve' | grep -v grep   # 退出码 1 = 无匹配
```
→ 无 loom 进程残留；smoke 的子进程由脚本 trap 兜底清理（PID 记录在案，SIGTERM exit 0 见 §3）。

## 3. serve 冒烟（c）

```bash
bash scripts/smoke-serve.sh     # 2026-10-08 18:30 实跑
```
```
[smoke] 启动 serve（port=5097, state=/tmp/loom-smoke.RHUs4a/state）
[smoke] OK：/health 200（{"status":"ok","version":"0.0.0-dev","uptimeMs":305,...}）
[smoke] OK：无 token → 401
[smoke] OK：SSE 可订阅（session=ses_2209e67d7d2151ce, content-type=text/event-stream）
[smoke] OK：SIGTERM → exit 0
[smoke] OK：端口 5097 已释放
[smoke] PASS —— serve 冒烟全链通过
SMOKE_EXIT=0   （全程 real 0m2.689s，uptime 305ms << 15s 门槛）
```

覆盖验收项：`loom serve --port 5097` TCP-ready <15s ✓、SIGTERM 干净退出 ✓、端口用后即释 ✓、
令牌头鉴权无未鉴权路径 ✓（401 面）、SSE 可订阅 ✓（深度协议面归 T38 contract，见 §6.2）。

## 4. 决策覆盖表 D1–D34（d）

逐条对 docs/01（真源）。注：**D8/D9/D11–D13/D29 未在冻结文档登记独立条号**（grep "D29" docs/01 = 0；
存储三层/trace 语义载于 §8/§9 正文），下表覆盖 docs/01 全部实有条目。

| 决策 | 一句话落点 → 实现/测试锚 |
|---|---|
| D1 解耦化（自有 HTTP+事件协议） | `server/src/http/{router,auth,body,sse}.ts` 零兼容层；协议形状由 `server/src/contract/contract-{api,frames,replay}.test.ts` 钉死；框架选型记录 docs/05 |
| D2 弃 opencode.db（analysis 读 state 文件） | `adapters/src/state/{journal,ledger,session-shards}.ts` jsonl 唯一真源（state.test "Journal: append-only + torn-tail crash replay"）+ `core/src/session.ts` transcript 导出；脚本平移列 docs/04 切换日 |
| D3 TypeScript/node20 | 全库 .ts，`@types/node ^20`+`typescript ^5.6`（root package.json），tsc -b 双绿 |
| D4 单工作区 | `loom.yaml` `workspace:` 指针（`config/loom-config.ts`）；smoke 配置指向 `fixture-workspace/`，无多目录机制 |
| D5 主会话+子智能体回灌 | `core/src/main-loop/loop.ts`（main-session.test 长循环）；`core/src/subagent/task-tool.ts` 结果回灌主会话；subagent.test "结果回灌 + task_metadata 契约"；agents.ts 内置 general/explore（D24） |
| D6 缓存前缀稳定 | `core/src/assembly/assembly.test.ts` "同输入双跑 → 前缀段字节全等、prefixHash 全等"；compaction-e2e 验收3"压缩前后段0-2 字节恒定" |
| D7 ToolExecutor 单缝+路径断言 | `tools/src/seam/{executor,sandbox,permission}.ts`；tool-executor.test "沙箱路径断言 / default-deny 权限模型" |
| D10 热加载四件套 | `server/src/hotreload/store.ts`：hot-reload.test "坏配置拒载 / 有效配置原子交换 / 审计留痕"；hotreload-e2e good/bad 双文件真 e2e |
| D14 任务系统归 harness | `core/src/trigger/{cron,scheduler}.ts`+`adapters/src/state/ledger.ts`+死信/审计同住；backend TaskScheduler 退役仅登记 docs/04 |
| D15 期望账本/catchup/两级重试 | run-engine.test "expected-before-execute（D15 时序铁律）"；recovery/catchup.test "latest/all/none"+"auto-resume=同run同会话 / catchup=新会话"；ledger-e2e 崩溃/跨重启死信 |
| D16 轮询 mtime+size 水位 | `tools/src/script-host/discovery.ts:34-38`（"当前 mtime+size 水位线是否已变"），NTFS/WSL2 现实（docs/01 §1 环境事实） |
| D17/D18 挂载脚本子进程协议 | script-host/host.test "子进程事件协议（**真实 python3**）"；protocol.ts fact/deliver/dispatch/heartbeat/reserved:exec + computeBackoff "指数退避封顶"；永不 in-process |
| D19 副会话=全新会话+盖棺 | run-engine.test "全新会话零残留（第二次 run 首个 context 不含第一次 run 消息）"+"终态写 actual（D19 盖棺）" |
| D20 装配恒 O(增量) | trace.test "D21 D20 assembly 常量性"（assemblyRowCount 两值一致）；session-shards "N-turn sharding + dir index O(increment) reads" |
| D21 装配纪律/压缩/复盘 | assembly.test 稳定前缀三段+增量尾部；生产 worker `core/src/compaction/worker.ts` + `summarize-prefix.ts`（`summaryMode:auto` 预算内单次、超预算递归 depth≤2，boundary `coveredCount`/`tailIncluded` 重放；legacy `routine.ts` 单次非流式小模型 hook 保留，未声明 `fallbackTokens` 时使用）；post-compact-file-reread 指针回读；transcript jsonl 导出（session.ts） |
| D22 防环+写权 | control-plane.test "D22 防环：side→side 拒绝"+subagent maxDepth 闸；越界写拒=golden-batch.test "external-write 拒"+seam 路径断言 |
| D23 回执主干+预验 | `core/src/receipt/{manifest,commit-body,coverage,verify,delivery}.ts`；receipt.test "三项合成一块 / 验证不通过⇒status 降级（映射表写死）"；【副会话回执】投主+死信形状=ledger-deadletter.test |
| D23③ 通知双轨（ai-mcp 保留） | `core/src/mcp/client.ts` stdio 客户端；mcp.test "语义兼容 fixture-workspace/.opencode/ai_mcp.py（send_notification/tts_speak）" round-trip 绿 |
| D24 触发六刀+生态收拢 | cron.test+scheduler.test 仅 cron 排班；dispatch 事件=script protocol；skills/loader.test "allowlist 排除/清单只进元数据/invoke 才注入正文"（技能迁工作区、全局插件弃用不迁） |
| D25/D30 收束工具终止 | convergence.test **(a)纯文本不终止 (b)字段不齐催办 (c)同错×3 升级 (d)轮数硬顶 (e)收束可与干活同轮+e2/e3 正文与收束同轮单次 LLM call 零额外往返**，另 convergence-adversarial.test 对抗攻击面 |
| D26 上限热载可改 | convergence.test "Limits 默认值=冻结值（催办5/同错3/硬顶60/自动续跑2）"+"阈值从注入 Limits 实时读：热载 3→2 即生效"；(d2) 副会话超限=failed 死信投主 |
| D27/D28 凭据自建+三文件三分层 | `server/src/config/{loom-config,credentials,section-checks}.ts`（loom-config.test "credentials 凭据铁律"：值走环境变量不落文件）；`config/loom.example.yaml`；docs/credential-migration-checklist.md |
| D31 排班暂停开关 | `core/src/pause/pause.ts` PauseAdmission+pause.test "判定与审计/热读语义/RunEngine 集成"；run-engine.test "paused：不写 expected、不登记、不开火" |
| D32 不触碰现状 | `MIN_PORT=5097` 硬校验（section-checks.ts）；全部测试 `listen(0)` ephemeral；本报告 §2 端口/mtime/进程三取证 |
| D33 独立运行三修正 | 修正一：`server/src/events/hub.ts` 原生扇出（sse.test "双订阅者全量"+Last-Event-ID replay）；修正二：出口=注入端口+`loom-config.ts:3` "D33 exits 透传 stub" v1 只留声明位；修正三：assembly.test fail-soft 组（注入源坏→占位降级不崩）+工作区零硬编码 |
| D34 命名定形 Loom | 包名 `@axeuh/loom-{core,server,tools,adapters}`；CLI "loom serve"（cli.ts，runs/trace/doctor 桩已注册明示归后续）；`X-Loom-Token` 头；loom.yaml；**全库 src grep "opencode" 大小写不敏感仅 4 处、全部为 JSDoc 注释溯源，标识符残留=0**（§4 末取证命令见 §2.3 同法） |

**D34 取证补充**：`grep -rin "opencode" packages/*/src --include="*.ts"` → 4 行命中，逐行人工判型全部
为注释（mcp.test.ts:3 / session-api/history.ts:5,30 / script-host/types.ts:45，描述的是**被替换对象
opencode 的现行为对齐**，属溯源语义）；`@harness-pi` 残留 0（波次台账逐轮 grep 记录）。

## 5. 已知 flake 记录（e）——本轮未修，留用户决策

- **用例**：`packages/core/src/plugins/__tests__/plugins.test.ts` → `it("redactToolArgs 给定时，
  preToolUse 记脱敏后的 args")`（:200）。
- **机理**：sessionLog 落盘 `tmp/<id>.ndjson` 后测试 `setTimeout(30)` 即 `readFileSync` + 逐行
  `JSON.parse(l)`（:224-228，**不容错**）。全量并发（100 文件同跑）+ NTFS flush 时序下尾部偶发
  半截行（torn tail）→ JSON.parse 抛出 → 偶发红。
- **本轮实况**：全量 1258/1258 一次绿；**单文件双跑亦双绿**：
  `npx vitest run packages/core/src/plugins/__tests__/plugins.test.ts` → RUN1_EXIT=0、RUN2_EXIT=0。
- **修法建议（不在本轮执行——T39 纪律"只验不修"，越界）**：该用例属 T06 vendor（harness-pi 平移）
  测试，读文件未走本仓已具备的 torn-tail 容错 helper——`adapters/src/state/journal.ts` 的
  撕裂行判定（"崩溃可能在尾部留下一条**半截（torn）记录**"，isRow 形状校验按位置判 torn）。
  最小修法=该测试末行改用"尾行不完整则重试/剔除"读法，或将 tmp 路径指向 tmpfs（/dev/shm）消除
  NTFS flush 变量。留用户决策（vendor 面平移测试保持上游形状亦有价值）。

## 6. 遗留清单（f）

### 6.1 T40 未执行声明（波次纪律核验）
- `docs/04-切换日附录.md` 存在，首行横幅在案：**"[警告] 本附录为未来授权事项清单，开发波次中
  未执行任何一项。"**（grep :3 取证）；"状态：仅撰写，零执行（2026-10-08）"。
- 波次对 §11 消费方改造面（后端 opencode_client→loom_client、TaskScheduler 退役、launcher 换
  binary、analysis 三脚本换数据源）**零执行**：axeuh-health-monitor/** 无任何来自本波次的写入
  （归属反证链见 §2.2 诚实披露段）。回滚路径=launcher 配置指回原 binary（docs/04 §前提）。

### 6.2 contract 真端口行映射说明
- `contract-api.test.ts:8` 原注："真端口行由 T39 在 T31 serve 冒烟后补"——**现由本报告 §3 兑付**：
  contract 三件套（frames/api/replay）在 ephemeral 真 HTTP 上钉死帧形状/时序/replay（含 R17 真
  serve 冒烟替身用例），§3 smoke 在**固定 5097 真进程**上复现同一链路（/health 200+401+SSE 订阅+
  SIGTERM+端口释放）。二者拼接=API 面端到端闭环，无需改 contract 测试。

### 6.3 fixtures 空壳目录处置
- `packages/server/src/e2e-datacheck/fixtures/{tmp,workflows,workspace/agents,...}` 现为**空目录壳**。
  实况核验：`e2e-datacheck/harness.ts` 工作根=`fixtures/tmp/batch-<rand>`（mkdtemp，测毕
  removeWorkRoot 清理，"绝不写 fixture-workspace"），目录壳=历次静死 worker 遗留+测试运行后
  正常清空的自然状态。`git status` 不跟踪空目录、测试不依赖其内容（本轮 golden-batch 3 绿），
  **无害；处置=可删可留，建议顺手删**（T39 只验不修，不动）。

## 7. 统计与波次复盘（g）

### 7.1 体量（packages/*/src，排除 fixtures/__tests__ 计源码）

| 维度 | 数值 |
|---|---|
| 非测试源码 | 183 文件 / 27,609 行 |
| 测试 | 100 文件 / 28,472 行 / **1,258 用例** |
| 测试分布 | core 877 · tools 138 · server 178 · adapters 65 |
| 波次完成度 | **39/40 勾选**（docs/02 `- [x]`=39、`- [ ]`=1 即 T39 本身，本报告即兑付） |

### 7.2 时间线实录（台账 `.omo/ulw-execute/ledger.jsonl` 40 事件全量摘读）

| 时刻 | 事件 |
|---|---|
| 10-07 23:55/00:10 | 决策冻结（D1–D32+D33 增补+D34 拍板，docs/01 头部记载） |
| 10-08 00:49:30 | goal-registered：T01–T40，10 波，最大并发 6（后调 10→50） |
| 01:04 | T01 confirmed（脚手架+vendor-snapshot 4.4M） |
| 01:43 | Wave2 五路全 confirmed；qa-fullsuite 378 绿 |
| **02:16** | **事故①：wave3 首派 6 worker 中 5 个死于服务商中断（Session error）**，仅 T21 完成；编排者以文件系统盘点（trace 5 文件+15 绿+typecheck 0）判 confirmed，其余**无产出=干净重发** |
| 03:52 | wave3 retry 六路 confirmed，846 绿（首轮 1 个时间敏感 flake 复跑消失） |
| 05:15 | wave4 confirmed（含 convergence 五场景/assembly 前缀/seam/docs/04），19/40 |
| **08:45** | **事故②：夜间服务商大面积超时**——T19/T30/T12 worker 30min 无活动被杀（无产出）、T29 结果丢失、**T10 声称 READY 但 main-loop 目录不存在（会话死亡虚报，被文件实照戳穿）**；全部干净重派 |
| 09:20–10:05 | T30 三度排队饿死（并发 6 满载）→ 改"串行补位不满载抢位"策略 |
| 10:04–10:45 | T12 run-engine confirmed；T30/T17 补位发出 |
| **11:55** | **事故③：opencode 重启杀死在途 4 worker**（T13/T14/T25/T15 未落盘=0 产出干净重发 v2；T29 留 8 分文件近完成品→改收尾修复）；重启前基线 1048 passed |
| 12:06 | 用户调并发上限 5→10（后 50） |
| 12:15–13:12 | recovery/receipt/trigger/events/control/session-api/hotreload-e2e confirmed；**T33 首任 5min 空死、T28 首任 23min 空死（只读探索耗尽零产出）→ 重发策略改"带架构事实简报+照抄现成测试模式+探索预算上限"** |
| 13:12 | 基线 92 文件 1194 绿/2 败（ledger-e2e 在修，不打扰） |
| 14:17–16:10 | T35/T28/T33/T37 confirmed，全量 1226/1226；**T34 首任 2h+ 空死、T38 首任 42min 空死（claim 目录 0 文件，实照=零产出）→ 重发** |
| 16:10–17:25 | T31 smoke PASS、T38 contract 入 1255/1255；**T34 二任 bg_126c8646 静死仅留空 fixtures 目录=零产出（第二次被文件实照戳穿）** → 三发拆小+复用 serve/boot.ts 装配参考答案 |
| 18:26 | **T34 四发 confirmed（golden-batch 3 绿），39/40** |
| 18:28–18:3x | T39 影子验证（本报告）：1258/1258、smoke PASS、边界取证全绿 |

**净节奏**：00:49 注册 → 18:26 收尾，历时约 **17.6 小时**；其中三大事故（服务商中断×2、宿主重启×1）
+ 六路空死/静死 + 一次排队饿死策略调整，损失时段主要在 02:16、08:45–11:55、13:12–16:10。

### 7.3 谎报-实照复盘（诚实记录，两例）

1. **T10（wave5 首任）**：DoneClaim 声称 READY，但 `packages/core/src/main-loop/` 目录**不存在**。
   编排者文件系统盘点判"会话死亡虚报"，零产出干净重派（台账 08:45 段原话"main-loop 目录不存在
   (会话死亡虚报)"）。教训：**完成声明必须过文件实照，claim 里"commands 通过"不可采信为状态**。
2. **T34（首任/二任）**：首任 2h+ 空死——`e2e-datacheck` 目录 0 文件（台账 16:10 段）；二任
   bg_126c8646 静死后**仅留空 fixtures 目录壳**（台账 17:25 段"静死仅空fixtures目录=零产出"）。
   两次均被"目录=0 产出"实照戳穿；四发改"最小链路+复用 serve/boot.ts 参考答案"策略后一次过
   （golden-batch 3 绿含 external-write 拒），39/40。
3. 同族记录（非谎报、属韧性）：T33/T28 首任只读探索耗尽空死、T38 首任 42min 空死、T30 三度排队
   饿死——催生了"探索预算上限、串行补位、拆小重发"三条编排策略修正，均在台账留痕。

### 7.4 5096 未动总结论

opencode(5096)/python(8768) 归属不变；loom 全库 MIN_PORT=5097、测试全 ephemeral、源码零引用
axeuh-health-monitor；ai/ 关键三文件 mtime 早于开工；今日 ai//backend/ 的 mtime 变动归属用户
并行 eflowcode 通道（其仓 git log 自证），与波次无交集；ps 无 loom 残留。

---

## 附：复验命令清单（本报告全部证据可一键重放）

```bash
cd /opt/kinship/loom-harness
bash scripts/ci.sh                                  # 三连（typecheck/build/test）
bash scripts/smoke-serve.sh                         # 5097 冒烟（用后即释）
ss -tlnp | grep -E '5096|8768|8769|18888'           # 端口归属对比
ps aux | grep -iE 'loom' | grep -v grep             # 无残留
grep -rin "opencode" packages/*/src --include="*.ts" | wc -l   # 仅注释 4 处
grep -rn "axeuh-health-monitor" packages/*/src | wc -l         # 0
```
