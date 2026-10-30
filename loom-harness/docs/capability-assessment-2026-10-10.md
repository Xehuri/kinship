# loom 胜任度评估 —— 2026-10-10 凌晨

> 对象：axeuh-harness（loom，live :5100）替换小贺同学现网后端 opencode serve:5096。
> 判据只有一条：**能否胜任小贺同学的工作，甚至做更好**。
> 本报告是工程判决书：每条断言附盘上证据路径，证据薄的地方直写"未测/待证"。
>
> 材料源（全部在盘已读）：
> - 对抗评审：/opt/kinship-work/opencode-tool-output/tool_121d4dda5001z0jPJJaJk7xMP4（ses_ede370d64ffe，10-10 02:02）
> - 账本核对：同目录 tool_121d45310001zVsHhrHxZ0y9PC（10-10 02:02）
> - W16 交付报告：axeuh-harness/state/fleet/out/w16-t1.md、w16-t2.md、w16-t3.md
> - 证据集：/opt/kinship-work/w16-evidence/（sim.jsonl、compat-*.json ×16、ctx 三捕、sse-w12-probe.txt、w16-results.json、重启前后会话快照）
> - harness git 链：基点 708b109/701eb2a（W15）→ 3179de4/085f79c/5b026df/7f8a081/a724627（W16-A~E）→ 1127a8b/b58d212/1074fed/e548d5e/e8fe8c6（W16-F 五刀），HEAD e8fe8c6，各提交均经盘上 git show 核实
> - 评审含两处过时论断（cmd_deny、sim.jsonl），本报告以盘上事实更正并如实注明（见 §1.3、§4）

## 1. 判定（三档）

### 1.1 今晚不可切换

判据不是能力不足，而是四个硬前置今晚全部不成立：

1. **部署通道断**。sudo 口令失效，两次重启挂起；账本核对确认自报的 01:35 第二次 boot 在 journal/systemd/config 三面均不存在（tool_121d4531… A1）。W16-E/F 五个提交全部只在代码里，live 未载。
2. **生产工作区从未实载**。现行 loom.yaml 与 compat-config.json 白纸黑字 `workspace: …/fixture-workspace`，八案模拟全部跑在 fixture 上。
3. **语音 busy 场景从未测**。F2 修复后需部署再测，现连第一轮数据都没有。
4. **会话面未收拢**。post-w16e-sessions.json count=166（01:34），W16-E（a724627）部署前切换，hm LoomEventHub 按 GET /sessions 逐会话开 166 条 SSE（axeuh-health-monitor/backend/routers/events.py:266，评审源码实证），面板被淹、僵尸流在场。

### 1.2 架构上可胜任，且观测面强于现网

- 对抗评审在推翻若干证据瑕疵后，仍确认 harness 本体活着、闭环成立。
- §2 的九条已实证链（注入、嗅探、恢复、后台任务、并发、兼容、面板、账本、缓存）覆盖小贺的五类真实负载：人格注入、记忆热更、重启续命、后台派工、面板运维。
- 增量项：账本/trace/请求面三层可对拍（sha256≡prefixHash 恒等式在 live 数据上成立），这是 opencode 现网没有的核验面；converge 盖棺把"半截流误判"从概率问题变成可观测事件。

### 1.3 距离 = 切换日清单，不是今晚可修面

剩余 BLOCKER 全部是"切换当日前置"（生产实载、迁移、部署+复测），可在切换日前数日逐步走实，无一条是架构缺陷。评审定级的两条行为回退已发生关键变化：

- **a（busy 无排队、hm 文本路 409→500）**：评审实证 backend/routers/session.py send 失败直抛 HTTPException(500)、批任务同面静默失败。**W16-F1（1127a8b）已在代码层关闭**：per-session FIFO 队列，busy 受理即 202 `queued:true`，上限 10 满则 409 回压，abort 只掐当前轮不清队列；session-api.test 钉死出队顺序「正文,排队A,排队B」turns=3、满员第 11 条 409、abort 后 10 条跑完 turns=11（w16-t1.md §9.1）。待部署+实弹排队顺序测。
  > [2026-10-19 起被超越] 生产已启用 `server.interruptOnSend=true`：忙时新消息 unshift 到队首并立即 abort 在途 turn，HTTP 202 返回 `interrupted:true`（不带 `queued`），该路径不检查 10 条容量闸。上句 FIFO、202 `queued:true`、上限 10 与 steer 的描述仅对 `server.interruptOnSend=false`/键缺席路径成立；「abort 只掐当前轮不清队列」两条路径均成立。见 docs/06 §5.1。
- **g（voice 同步挂 300s 假失败）**：评审实证旧 registry.ts voiceSend 同步 `await rec.running`、hm 侧 aiohttp total=300s（backend/services/loom_client.py:90）。**响应挂起半边已由 W16-F2（b58d212）关闭**：/voice 立接立回 202，abort→收尾→起语音轮挪进 per-session 后台链 voiceTail，语音严格 FIFO 恰一次；单测哨钉 busy 中 elapsed<1000ms（旧实现必等满 3000ms）。busy 中断/barge-in/双发三子场景**仍未测**。
- **评审对 cmd_deny"未配置"的引用过时**：deny 前缀表已于 10-09 11:42 提交 6b0382a 扩充（缺口6 当日拍板），现行盘上 21 项（packages/server/src/serve/tool-wiring.ts:66-73：sudo/su/shutdown/reboot/halt/poweroff/mkfs/dd/mount/umount/kill/pkill/killall/systemctl/service/crontab/nsenter/docker/podman/chown/"git push"）。缺口清单第 6 条是 10-09 上午 10:4x 的记录，扩充落在其后，评审（10-10）引旧版为现状。

## 2. 已实证能力（场景 + 证据路径 + 关键数字）

1. **注入链：54.7KB 记忆前缀真进模型请求**
   - 场景：小贺人格/规则全靠记忆树注入，断链=人格失联。
   - 修复史：701eb2a（W15 Unit B）修"前缀只走簿记面不进请求"的断链。
   - 数字：live 快照 context-full.json（00:46，ses_9a61c4ed07bf309d）prefixByteLength=53727、memory 段 53654B、`systemPromptSha256===prefixHash`（sha256:bd69fdc5…）实测为真；同型 sha 在 ctx-v1.txt/ctx-v2.json/compat-ctxf.json 四捕全等。
   - 请求 token 面：部署前 terminal 累计 input=6292（state/session/loom-main.jsonl L865，22:48）→ 部署后首活轮单消息 input=18716（同文件 L867，00:46:50；ctx-v2.json messages[1] 同值），增量与 53727B CJK 前缀量级吻合（701eb2a 注记预估 15-20K tok）。
   - 模型点名五件：sim.jsonl C2 逐字列出 AGENTS.md、memory/README.md、memory/self/必读.md、memory/profile/core.md、memory/fact/总目录.md；五件正文均在 ctx-v1.txt 前缀内可检索。
   - 画像引用原文：C1 直接引必读.md §注意点与纠错.md 第一红线（idle 28.0s，聊天场景偏慢，如实记）。

2. **变更嗅探：dsh 同款语义，实弹全链通**
   - 场景：AGENTS.md/记忆文件被批任务改写后，运行中的会话下一轮自动吃到新全文。
   - 机制：W16-A（3179de4）mtime+size 水位→持久 prelude 注入本轮用户消息之前；W16-D（7f8a081）水位改 per-session（每既有会话各恰一次，dsh 基线同构）。
   - 数字：ctx-v2.json messages[5] 恰一条 `Updated instructions from: AGENTS.md`（19425B 整文替换，位置先于 messages[6] 用户消息）；前缀跨变更逐字冻结（四捕 prefixHash 全等）；notice 恰发不超发：账本核对全文件数得恰 2 条（loom-main.jsonl:872@00:48:52、:877@00:51:09）= AGENTS.md 加标记+还原两次变更一一对应，后续新会话零重发。

3. **重启恢复：会话列表从盘找回**
   - 修复 708b109（W15）：boot 按主 store→副/子 store 硬序重登记。
   - 数字：pre-restart-sessions.json count=6 → 00:43:25 boot（compat-health.json startedAt 2026-10-09T16:43:25.830Z）→ post-restart-sessions.json count=160，与 compat-sessions.json（00:51）一致。
   - 注：160 含 154 个副/子 sid，域收拢属 W16-E（见 §3.5）。

4. **后台任务闭环：dispatch→done→delivery.notify→task_fetch 一字不差**
   - 场景：小贺核心形态"派后台活、完成后转述结果"。
   - 盘上三件一体：loom-main.jsonl 01:41 轮 task(background=true) 受理并 converge（receipt 含 task_id=run_b4be1335…）；01:44-01:45 主会话轮 task_fetch 取回后 converge 回执**逐字**记"子智能体回复「收到。」"；01:48 SSE 捕包 sse-w12-probe.txt seq115 见 `delivery.notify` 帧（title=后台任务完成，run_9111f99de71ef62e done），seq209 task_fetch 取回件在帧。
   - 评审疑义的如实并注：sim.jsonl C4a 400 是探测脚本缺 workflow 字段；C4b 01:40 判"6×30s 未见 reminder"是 **LEAD 探测器设计错位**（run-reminder 是 transient-by-design 附件，按 W12 契约不进历史不进转录视图，探测器盯错了观测面）。评审所称 c4b.json 不存在**属实**（该文件名从未存在，闭环真源即上三件）。"先败后成=非确定性"的质疑被机理解释消解，但跨小时稳定性**未测**，切换周应加长跑。

5. **并发 / 语音 idle / abort**
   - C6 三路并发会话各自闭环 ok（sim.jsonl，三个独立 sid）。
   - C5 语音 idle：POST /voice 0.4s 返 202（status busy、accepted true）。
   - compat-abort.json：空闲期 abort 如实回 `aborted:false`（幂等布尔与 opencode 恒 true 有别，loom_client.py 模块头注记在案，hm 编排层不消费该值）。

6. **兼容面 16 项全有效**
   - 409 忙拒语义：compat-409.json `{"error":{"code":"session_busy",…},"status":"busy"}`。
   - 400 路径穿越拒：compat-badid.json 对 `../../` 报 bad_session_id。
   - 401 无鉴权拒：s-compat-1.txt:53 "noauth 401" 在案。
   - 其余 13 件（catalog/config/create/pause/ctx/ctxf/health/hist/r404/runs/tasks/status/sessions）形状正常；r404 逐字回显 runID 形状正则。
   - 更正注：s-compat-1.txt 主体确是坏电池（满篇 `curl: (2) no URL specified`，评审指认**属实**）；有效电池以 16 个 compat-*.json 为准，lead 已复跑全绿。

7. **面板五视图 + markdown，真浏览器 DOM 证**
   - 代码面：w16-t3.md（harness-ui.test 35/35；`.innerHTML =` 全文件恰 1 处=setIcon 内置 SVG；XSS 构造性安全=纯数据 token + createElement/textContent + href 数值白名单 http(s)/mailto，javascript:/data:/vbscript:/协议相对拒；emoji 锁 0 命中；CDN 锁 0 命中）。
   - live 面：w16-results.json 真浏览器 :5100，9/11 通过。S-WEB-1 DOM 见 h2/4 行 2 列表格/Python 代码块/strong/link(rel=noopener)；S-WEB-1b `<img onerror>`/`<script>` 探针在 DOM 计数 img=0、script=0、iframe=0，文本原样保留；S-WEB-2 五视图标签全激活；S-WEB-3 上下文 tab 实测"前缀 54k B · 消息 7.1k B · 总 61k B · ~17k tok · 窗口 1.0m"，原始抽屉 9 段 60793B 一字不删；S-WEB-7 430/1440 双宽度 8 关键元素 0 溢出；S-WEB-9 console 0 异常。
   - 两条 fail 的裁决：S-WEB-6、BONUS-ABORT 均"Timeout waiting for element"，成因=QA 脚本在 idle 态去点**正确禁用**的发送/abort 钮，属测试脚本缺陷非产品缺陷（lead 复核）；面板侧无已知未过功能项。截图 23 张在盘（w16-evidence/w16-web-*.png）。

8. **账本卫生**
   - tool_121d4531… 核对：ledger/2026-10-09.jsonl 104 行，expected=52/actual=52 逐对闭合，0 缺口、0 孤儿、今晚 0 死信新增（dead-letter 尾行 10-09 21:51:43）；nudge 摩擦今晚 0 条。
   - UTC 日分片口径正确：本地 01:41=UTC 10-09，"2026-10-10.jsonl 不存在"是应然而非缺陷（核对 A3 同时指出 ledger UTC 键 vs trace 本地键的双基准陷阱，见 §3.9）。
   - 核对发现的三个真实缺陷**全部已修**：converge 受理轮系统性误标 aborted（168/174 条，1074fed 落盘口改标 done、内存判别逐字节不动）；sub run_end totals 恒 0（e548d5e 四段 additive 补 usage 透传，boot 级双面 197/18 对拍钉死）；空 assistant 脏行（e8fe8c6 落盘口剔除+封一幂等，双封竞态未复现故该刀属防御闸，w16-t1.md §9.5 原文如实申明）。

9. **prompt cache 命中**
   - 收束催办轮 input=426（s-inject-1-live.txt；ctx-v2.json messages[3] 同值）：54.7KB 前缀走缓存、只算新增尾，converge 的边际 token 成本远低于直觉。

## 3. 切换日前置清单（按评审定级，含更正注记）

1. **生产 ai/ 工作区实载（阻断级前置）**
   - 全部能力证据产自 fixture-workspace；真实记忆树体积（C7 的 74850B 是 fixture 数）、五件实载齐备性、degrade 件走 set 分支的行为，均**未证**。
   - 切换日 loom.yaml 指真实 ai/ 后须整天影子暖机 + 全案复跑。
   - cmd_deny 21 前缀已在盘（§1.3 更正），但生产写路径的实弹验证（缝审计 allow/deny 双面、主会话 write/bash 对着 NTFS 源）从未做；链式绕过属 D7 已知朴素口径，bwrap 沙箱接管前"不改源不删源"仍半靠 prompt 自缚。
2. **opencode 转录迁移方案（零证据）**
   - loom rehydrate 只吃自家 jsonl；切换即"记忆文件在、对话史不在"的会话内失忆，用户问"昨天说的那事"就穿帮。
   - 迁移器格式/导入校验/回滚口径均需专刀，现无任何设计文档在盘。
3. **多模型 catalog（需用户提供模型 ID）**
   - compat-catalog.json count=1，仅 qwen3.8-flash（vision:true 旗标已声明）。
   - hm model_config 多模型与批任务 per-task model_id/provider_id 覆盖在 loom 全部失效（loom_client.py 模块头注记"接受但忽略"）；kimi-k3/omni 按 loom.yaml 注释"本波不猜数"，等 ID 再挂。
4. **视觉通道额度**
   - 视觉 QA 审查未跑成：盘上不存在 w16-t6-shots-audit.md（全库检索 0 命中）；lead 报称 provider 额度不足，无盘上账单证据可引，**待证**。
   - 截图集（w16-evidence/*.png、state/fleet/out/w16-t3-shots/）未经任何视觉模型逐张审读；面板正确性现靠 DOM 断言+人眼抽查，缺独立视觉闸。
5. **W16-E/F 部署 + 复测（通道修复后第一动作）**
   - 恢复 sudo 通道 → 重启 → 复测三件：voice busy 三子场景实测（中断/barge-in/双发）、排队顺序与满员 409 回压实弹、EventHub 会话面收拢生效（166→主域，post-w16e-sessions.json 归 1 才算数）。
6. **f 收束延迟的消费序改造（评审定级高，聊天场景）**
   - converge 每轮 +2~4s 收尾、每轮 +1 次调用（缓存面 426 tok）：编码/批任务值，闲聊是纯税。
   - 维持评审最小调法：服务端契约一字不动，hm 侧"先上屏后盖棺"（text delta 首现即上屏/进 TTS 缓冲，idle/converge 帧只驱动状态机）。属 hm 侧切换日改造项。
7. **评审保留定级不变项**
   - b（agent 参数忽略）高：人格等效性=生产注入待证；模型选择收缩=功能回退。
   - c（/children、/summarize REST 缺）高（面板面）/低（聊天面）：loom_client.py 显式 NotImplementedError 不静默，但调用方炸面清单评审未查完，标未验证风险。
   - d（session.updated/diff/compacted 帧不发）中：侧栏滞后，降级可用不炸。
   - e（无标题）低：stt_session_manager 兜底在。
8. **不可验证清单原样保留（评审 §3 全文有效）**
   - QQ/napcat 入站全链：代码路径未定位；若走 /messages 则与 a 同面，F1 部署后需连排队一起测；富媒体图片消息在单模型 catalog 下未验证。
   - 语音唤醒词→VAD→STT→send_voice→TTS 触发时序：idle 帧在 probe seq292 在盘，但 TTS 时延继承 f，busy 路径继承 g 未测半。
   - 每日批任务撞 busy 的失败/重试策略：task_executor 经 ai_client_factory 双通道确认（backend/services/task_executor.py:21），排队上线后同面复测。
   - 记忆写回路：fact/harvest 写端在生产权限面未实弹。
9. **账本口径统一**
   - ledger 按 UTC 日键 vs trace 按本地日键的双基准（核对 A3）切换前定死单一口径。
   - 今晚子会话装配 span 消失（A4）与主装配 193→5 行瘦身（A5）需人工签认"设计"还是"回归"。

## 4. 今晚欠账（如实）

- **两次重启挂起**：sudo 口令失效；第二次 boot（01:35）在 journal/systemd/config 三面均无痕迹（核对 A1），W16-E/F 全部未落 live；post-w16e-sessions.json 的 166 即"未生效"现场证据。
- **S-CTX 整文件替换成本无生产数据**：一次 AGENTS.md 变更注入 19425B 全文（ctx-v2.json msg[5]），单件预算 64KB；高频改记忆时日累积注入对历史窗口的挤占，生产规模下**未测**。
- **notice 语义边界**：每会话恰一次（W16-D，dsh 对齐）已证；但"变更后新建会话吃 boot 冻结旧前缀、直到下次重启才换新"是 w16-t1.md §6 白纸黑字的已申明限制，plan-refresh（跨 boot 前缀热换）出片未做。
- **评审过时论断的更正注（两处，均引盘）**：① cmd_deny"未配置"过时：6b0382a（10-09 11:42）已扩至 21 前缀，tool-wiring.ts:66-73 现行在位；② "sim.jsonl 不在盘"（核对 A2）过时：w16-evidence/sim.jsonl 现盘在位，9 条记录含 C4a/C4b 两条失败原案。另 s-compat-1.txt 电池损坏指认**属实**，有效面以 16 件 compat-*.json 为准（lead 已复跑绿）。
- **杂项敞口**：mtime+size 轮询固有盲区（同 tick 同尺寸改动不可见，D16 已接受的成本）；10-08 两个半截 run 的 expected 至今无 actual（核对 A7 昨夜僵尸）；F5 封一幂等属防御闸非根因修复（双封竞态未复现，提交原文申明）。

## 5. 结论

**loom 架构上能胜任小贺同学的工作，观测面已部分更好；但今晚不可切换，且"更好"成立的前提是 §3 清单全部走实。其中生产工作区实载、转录迁移、W16-E/F 部署+语音 busy/排队复测三项未闭环之前，切换等于拿生产用户当测试。**

### 证据索引

| # | 断言 | 盘上证据 |
|---|---|---|
| 1 | 前缀真进请求 53727B / sha≡prefixHash / input 6292→18716 | w16-evidence/context-full.json、ctx-v1.txt、ctx-v2.json、compat-ctxf.json；axeuh-harness/state/session/loom-main.jsonl L865/L867/L946；提交 701eb2a |
| 2 | 五件点名 + 画像引原文 | w16-evidence/sim.jsonl C1/C2/C3 |
| 3 | 嗅探 dsh 同款、前缀冻结、notice 恰 2 条 | ctx-v2.json messages[5]；loom-main.jsonl:872/:877；提交 3179de4、7f8a081；w16-t1.md §5/§7 |
| 4 | 重启重水化 6→160 | w16-evidence/pre-restart-sessions.json、post-restart-sessions.json、compat-sessions.json、compat-health.json；提交 708b109 |
| 5 | 后台闭环 task_fetch 逐字转述 + delivery.notify | loom-main.jsonl 01:41/01:44 轮；w16-evidence/sse-w12-probe.txt seq115/seq209 |
| 6 | 兼容 16 项（409/400/401） | w16-evidence/compat-*.json ×16；s-compat-1.txt:53（仅 401 行可信，余为坏记录） |
| 7 | 面板五视图 + md + XSS 面 + 真浏览器 DOM | state/fleet/out/w16-t3.md；w16-evidence/w16-results.json（9/11，两 fail 裁决非产品缺陷）+ 23 截图 |
| 8 | 账本 0 缺口 0 死信；三缺陷已修 | tool_121d45310001zVsHhrHxZ0y9PC；提交 1074fed、e548d5e、e8fe8c6 |
| 9 | 队列/语音 202 修复在码未部署 | w16-t1.md §9.1/§9.2；提交 1127a8b、b58d212；166 现场=post-w16e-sessions.json |
| 10 | cmd_deny 21 前缀（评审引用过时） | axeuh-harness/packages/server/src/serve/tool-wiring.ts:66-73；提交 6b0382a |
| 11 | 视觉审查未跑成 | 盘上无 w16-t6-shots-audit.md（全库检索 0 命中）；截图在盘无人审 |
| 12 | 评审原判与 a-g 定级 | tool_121d4dda5001z0jPJJaJk7xMP4 §1-§4 |


---

## 6. W17 增补（2026-10-10 上午，发线面+声明+连续性）

上午三条新需求（系统提示词全量可见/主次声明/diff SSE 回传）以 W17-A~G 七刀交付并部署实证（HEAD d091102，定向回归 101/101，fleet 粗筛 10P/0F）：

- **发线面（A/B/C）**：GET /sessions/:id/context/full 增 additive wire/manifest——post-hook 管道的完整 systemPrompt（含 skill 目录尾）、14 工具 JSON schema、逐条消息含 transient 附件标记、脱敏 params、provider onPayload 捕获的真实请求体（live 50.9KB→67.3KB 两次采样）。面板三区+字节抽屉，v1 键值逐字回归。
- **引用清单**：memory 五件（路径+字节+bootHash）、skill/mcp/角色文件（kind 徽章面就位）。
- **E 主次声明**：agents frontmatter kind:main|sub（缺省 sub 逐字节兼容）；main 绑定主会话身份框（现网无声明=占位保真，切换日可用 ai/memory/self/身份.md 立主格）。
- **F context.notice SSE**：diff 注入实时回传 {action,relPath,bytes,turnIdx}（不携内容），面板时间线+自动刷新扩至 idle/notice/run 终态。live 双向捕获（marker 添加/还原各一帧，per-session 恰一次语义现场成立）。
- **G 重启连续性**：live 抓出的真缺陷——重水化会话 create 不回放，模型请求丢历史（wire messages=1）。修复后有转录 sid 首跑前 hydrate 回放（compaction 边界/孤儿 toolCall 同 resume 唯一实现），**wire messages 1→29** 实证。
- **记忆写回路首秀**：连续性探针轮模型依纪律自写关键词入必读.md+任务.md（prefixHash 随之漂移，diff 唯一致因合法），上下文嗅探对后续改动将自动 notice。

### 切换日清单更新
原 §3 六项中"**生产 ai/ 实载**"风险面扩大：现证模型会真实写工作区记忆文件（不改源红线依赖 cmd_deny 22 前缀+prompt 自缚两层，切换日前建议对生产 ai/ 的写路径先做 T1 全真彩排再谈切）。其余五项不变。

### 面板人证未闭环（如实）
视觉模型提供方余额中断，浏览器像素层验收改由用户亲验（token 面板已交付）；功能层由真浏览器 DOM 断言+101 定向测覆盖。
