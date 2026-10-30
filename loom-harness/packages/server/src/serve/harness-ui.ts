/**
 * T39+ / W11a2 门面页 —— loom serve 的本地人工交互面板（单文件、零外部依赖、离线可用）。
 *
 * 定位：本地运维/测试用的单页面板（GET / 与 GET /ui），浏览器直开
 * http://127.0.0.1:5100/ 即可与 loom 主会话对话，并在右侧子智能体栏查看子会话。
 * API 面一字不新增：页面只消费既有端点（POST /sessions、GET /sessions、
 * POST /sessions/:id/messages、GET /sessions/:id/history、POST /sessions/:id/abort、
 * GET /events/stream、GET /health）。
 *
 * 鉴权边界（本模块唯一的接线约定）：静态页自身**免 token**，但必须由调用方
 * （boot.ts）在 Router 之前应答——Router 的「鉴权先于路由匹配」口径不动；
 * API 调用照旧带 X-Loom-Token（页面把 token 只存 sessionStorage）。
 * SSE 用 fetch-stream 而非 EventSource：EventSource 无法携带自定义头。
 *
 * W11a2 重做要点（用户实操反馈：只能看到 text delta、网页质量差）：
 *   1. 事件吃齐：全 16 个事件名（LoomEventName 联合）都有明确呈现位置——
 *      message.part.delta → 流式文本；message.part.updated → text/reasoning/tool
 *      三类 part（工具卡三态 pending→running→completed/error + state.output 增量）；
 *      message.updated → 消息指标；session.status/idle/error → 状态机；
 *      session.created/children、file.edited、server.connected/heartbeat、
 *      run.status、delivery.notify、watchdog.alarm、todo.updated、context.notice →
 *      各有落点（见 handleFrame switch）。
 *      事件名覆盖由 Record<LoomEventName, true> 编译期强制（见 EVENT_COVERAGE），
 *      后端新增事件名时本文件编译失败，强制前端补分派分支。
 *   2. 子智能体面板：右侧栏登记子会话（session.children 帧 + task 工具卡输出里的
 *      <task_metadata> 反解，两路合流、按 id 去重）；点击 = 在 #subpanels 分栏
 *      展开只读详情，多面板可同时展开对比。子会话没有事件 hub（loom 只给主会话
 *      建 hub），所以详情不订 SSE，改 **2s 轮询 GET /sessions/<sid>/history**
 *      增量渲染当前输出（面板顶标「轮询模式」）。转录由切片0 持久化保证可读。
 *   3. 视觉：暗色工程面板（状态色体系 pending 灰 / running 琥珀 / text 蓝白 /
 *      completed 绿 / error 红），消息流与工具卡收敛，微动效（状态过渡、流式光标、
 *      子卡登记闪示），响应式 ≥1180 三栏、≤1180 子栏抽屉、≤900 单栏。
 *
 * W13 追加（用户点名两项）：
 *   1. 流式思考：reasoning 双帧通道（注册 part.updated 无 text → part.delta 增量追加
 *      → llm-end 快照全量替换）；思考块默认折叠（暗灰斜体 + 左竖线 + 打字光标），
 *      多条 thinking 按 part id 归位不重影。
 *   2. 上下文预览：右栏「上下文」面板消费 GET /sessions/<sid>/context（旧面 404 回退）；
 *      每轮结束（session.idle）自动刷新 + 手动刷新钮。
 *      W17-F：自动刷新触发面扩为 session.idle + context.notice（水位检出即发帧）+
 *      run.status 终态；上下文 tab 增"增量时间线"（环形 ≤100 新在前，条目不含正文，
 *      点击 = 触发上下文刷新）。
 *      W18（用户判词：树/徽章/抽屉过度渲染不如读文本，路径复制按钮全下线）：上下文 tab
 *      重排为「完整上下文（按发送顺序）」单一纯文本板块（系统提示词全文含 skill 目录 →
 *      工具定义 → 逐条消息含【思考】/【正文】/【调用】/【结果】全文，解析失败回退原文）
 *      + 模块纯文本折叠块（系统段/记忆/工作流/参数/provider 载荷/引用清单/时间线）；
 *      transient/kind 徽章改文本尾注，wire==null 回退 v1 装配快照并明写来源。
 *
 * W24 追加（面板批次：只消费 W23-B/W23-A/W23-C 已接线端点，零服务端逻辑改动）：
 *   1. 会话列表三件套（W23-B）：标题回落 sid、行内改名（点标题→输入→POST title→拉回流）、
 *      每行归档 + 侧栏「归档」切换（默认 GET /sessions 隐藏归档；切换 = ?archived=1 只列
 *      归档并给「还原」）。createdAt 倒序按服务端视图序原样渲染，客户端零重排；
 *      列表变更后一律 pull-only 重拉 GET /sessions，不开任何新 SSE 面（用户冻结纪律）。
 *   2. 任务面历史合流（W23-C）：GET /tasks = 内核在飞 ∪ 账本 kind=sub 历史；行首来源标
 *      芯片（in_memory:true = 内存在飞 vs 键缺 = 账本历史）；按 dispatched_at 倒序渲染；
 *      有 session_id 的行给「转录」按钮 → 惰性 GET /sessions/{sid}/context/full
 *      （W23-A basis:"cache" 保证重启后子转录仍可读），长列表「加载更多」切片。
 *   3. 上下文面真相芯片（W23-A）：basis("live"|"cache") 与 wire.source("live"|"cache")
 *      以纯文本芯片呈现（基底=实时/基底=缓存 · 发线=实时/发线=缓存(重启残影)）；
 *      cache 基面如实呈现（segments 恒空不假装装配分段，note 口径入提示行）。
 *   布局不动：仍是 W16-C/W17-C 五视图同壳切换；W18 判词持续生效（不新增路径复制按钮）。
 *
 * 实现取舍（决策）：
 *   - HTML 以模板字符串内嵌（无构建链、无静态资源复制步骤）；页面 JS 不用模板
 *     字面量（防 TS 模板转义）、不用 emoji（图标 = 内联 SVG 常量表）。
 *   - XSS 纪律：一切动态文本走 textContent / createTextNode；innerHTML 只有一个
 *     赋值点 setIcon（只写内置 SVG 常量）。子会话面板与工具输出都遵守。
 *   - 可单测化：纯渲染逻辑（事件表、工具输出增量合并、task_metadata 反解、
 *     history 轮询差分、状态徽标映射）收敛在 HARNESS_UI_LOGIC_JS 字符串里，
 *     页面原样内嵌执行、测试用 new Function 直接调（DOM-less 单测）。
 *
 * 事件适配真源：events/{mapping,project,replay,tool-stream,hub}.ts 的帧字面量 +
 * mybot-web/docs/EVENT_API_DOC.md（类型名/properties 逐字对齐）。未知事件类型
 * 静默容忍（与后端 unknown-event tolerance 对称），绝不因新增事件类型而破页。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoomEventName } from "../events/types.js";

/** 免鉴权静态面路径（GET；trailing slash 归一后比较）。 */
export const HARNESS_UI_PATHS: readonly string[] = ["/", "/ui"];

/**
 * 全事件名覆盖表（编译期穷尽）：Record<LoomEventName, true> 让 TS 强制此表列出
 * 联合里的每个事件名——events/types.ts 新增名字时本文件编译失败，UI 被迫同步。
 */
const EVENT_COVERAGE: Readonly<Record<LoomEventName, true>> = {
  "message.part.delta": true,
  "message.part.updated": true,
  "message.updated": true,
  "session.idle": true,
  "session.status": true,
  "session.error": true,
  "session.children": true,
  "session.created": true,
  "session.compacted": true,
  "session.compaction.started": true,
  "session.compaction.chunk": true,
  "session.compaction.retry": true,
  "session.compaction.aborted": true,
  "session.compaction_failed": true,
  "file.edited": true,
  "server.connected": true,
  "server.heartbeat": true,
  "run.status": true,
  "delivery.notify": true,
  "watchdog.alarm": true,
  "todo.updated": true,
  "context.notice": true,
  "session.queue": true,
};

/** 覆盖表的事件名数组（测试与页面共用同一真源）。 */
export const HARNESS_UI_HANDLED_EVENTS: readonly LoomEventName[] = Object.keys(
  EVENT_COVERAGE,
) as LoomEventName[];

/**
 * 页面纯逻辑段（DOM-less）：先于主脚本单独内嵌，页面直接调用其中的函数；
 * 测试用 `new Function(HARNESS_UI_LOGIC_JS + "; return {...}" )` 加载后单测。
 * 纪律：只用 ES5 语法、不触碰 document/state，返回值都是纯数据。
 */
export const HARNESS_UI_LOGIC_JS: string = String.raw`
var LOOM_EVENT_NAMES = ${JSON.stringify(HARNESS_UI_HANDLED_EVENTS)};

function loomEventDispatchTable() { return LOOM_EVENT_NAMES.slice(); }

// 工具状态 → 徽标文案与色调（pending 灰 / running 琥珀 / completed 绿 / error 红 / aborted 灰）
function loomToolStatusMeta(status) {
  if (status === 'pending') return { label: '排队中', tone: 'pending' };
  if (status === 'running') return { label: '运行中', tone: 'running' };
  if (status === 'completed') return { label: '完成', tone: 'completed' };
  if (status === 'error') return { label: '失败', tone: 'error' };
  if (status === 'aborted') return { label: '已中止', tone: 'aborted' };
  return { label: status ? String(status) : '未知', tone: 'pending' };
}

// 工具输出快照合并：running 帧给的是全量 tail（16KB 截头）——前缀一致才走
// DOM 追加路径（真增量渲染），否则整段替换；same = 无变化（不动 DOM）。
function loomMergeToolOutput(prev, next) {
  var a = typeof prev === 'string' ? prev : '';
  var b = typeof next === 'string' ? next : '';
  if (b === a) return { text: b, mode: 'same', appended: 0 };
  if (b.length > a.length && b.slice(0, a.length) === a) {
    return { text: b, mode: 'append', appended: b.length - a.length };
  }
  return { text: b, mode: 'replace', appended: 0 };
}

// <task_metadata> 反解（与 core/subagent/metadata.ts 同款行解析）：task 工具卡
// 输出里出现即登记子会话；连字符归一为下划线（帧与 history 路由同口径），
// 脏 id（空 / 非法字符）不进子面板。支持一段文本多个块。
function loomExtractTaskSessions(text) {
  var out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  var re = /<task_metadata>([\s\S]*?)<\/task_metadata>/g;
  var m = re.exec(text);
  while (m !== null) {
    var fields = { sessionID: '', agentType: '', reason: '', turns: 0, depth: 0 };
    var lines = (m[1] || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var kv = /^([a-z_]+):\s*(.*)$/.exec(lines[i].trim());
      if (kv === null) continue;
      var key = kv[1];
      var value = kv[2];
      if (key === 'session_id') fields.sessionID = value.replace(/-/g, '_');
      else if (key === 'agent_type') fields.agentType = value;
      else if (key === 'reason') fields.reason = value;
      else if (key === 'turns') fields.turns = parseInt(value, 10) || 0;
      else if (key === 'depth') fields.depth = parseInt(value, 10) || 0;
    }
    if (fields.sessionID && /^[a-zA-Z0-9_]+$/.test(fields.sessionID)) out.push(fields);
    m = re.exec(text);
  }
  return out;
}

// history 轮询差分：prev = {count, last(末条指纹)}。返回下一次渲染的起点——
// reset（转录变短，整段重放）/ replaceFrom（末条仍在写，原位替换）/ appendFrom（只追加）
// / idle（无变化，不碰 DOM）。子会话无流事件，这个差分就是「增量渲染当前输出」的核。
function loomMessageFingerprint(message) {
  try { return JSON.stringify(message); } catch (err) { return ''; }
}

function loomHistoryDelta(prev, messages) {
  var list = Array.isArray(messages) ? messages : [];
  var count = prev && typeof prev.count === 'number' ? prev.count : 0;
  var last = prev && typeof prev.last === 'string' ? prev.last : '';
  var nextLast = list.length > 0 ? loomMessageFingerprint(list[list.length - 1]) : '';
  if (list.length < count) return { reset: true, appendFrom: 0, replaceFrom: -1, idle: false };
  if (list.length === count && nextLast === last) return { reset: false, appendFrom: count, replaceFrom: -1, idle: true };
  if (list.length === count) return { reset: false, appendFrom: count, replaceFrom: Math.max(0, count - 1), idle: false };
  return { reset: false, appendFrom: count, replaceFrom: -1, idle: false };
}

// W54 历史压缩事件 → 一卡视图（GET /sessions/:id/compactions 的 events[] 单条）。
// 坏的/缺摘要的帧返回 null（静默跳过，附属面绝不打断转录）；coveredCount 只接受
// 有限数，负值钳 0；只剥内核注入的单行标记，正文里同形文本原样保留。
// 返回形状 = 渲染契约五键；锚点/记录时刻由 loomCompactionEventList 以不可枚举
// 属性补齐（排布元数据，不污染视图比较）。
function loomCompactionEventView(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (typeof event.summaryText !== 'string') return null;
  var covered = typeof event.coveredCount === 'number' && isFinite(event.coveredCount)
    ? Math.max(0, Math.floor(event.coveredCount))
    : 0;
  var summary = event.summaryText.replace(/^\[auto-compacted summary of \d+ earlier messages\]\s*\n?/, '');
  return {
    id: typeof event.id === 'string' ? event.id : '',
    coveredCount: covered,
    topLabel: '会话压缩已开始',
    bottomLabel: '会话已压缩 · ' + covered + ' 条消息',
    summary: summary
  };
}

// 事件卡 key（DOM 状态表用）：有 id 按 id，缺 id 退回摘要全文——与去重口径一致。
// 前缀隔离 id/summary 两个命名空间，避免摘要文本恰好等于某 id 时串卡。
function loomCompactionEventKey(view) {
  if (!view || typeof view !== 'object') return '';
  if (typeof view.id === 'string' && view.id.length > 0) return 'id:' + view.id;
  return 'summary:' + (typeof view.summary === 'string' ? view.summary : '');
}

// 历史事件列表归一（{events:[...]} 或裸数组）：
//   1) 逐条走 loomCompactionEventView，坏帧丢弃；
//   2) 按 id（缺 id 时按摘要全文）防御性去重——同摘要不同 id 不丢（boundary/auto 各自成卡）；
//   3) 按 (anchorTimestampMs ?? recordedAt) 升序、再按 recordedAt、最后按服务端序稳定排。
// 返回值仍是视图数组；锚点等排布元数据挂不可枚举属性，按需读取。
function loomCompactionEventList(bodyOrEvents) {
  var raw = null;
  if (Array.isArray(bodyOrEvents)) raw = bodyOrEvents;
  else if (bodyOrEvents && typeof bodyOrEvents === 'object' && Array.isArray(bodyOrEvents.events)) raw = bodyOrEvents.events;
  if (!raw) return [];
  var seen = {};
  var rows = [];
  for (var i = 0; i < raw.length; i++) {
    var event = raw[i];
    var view = loomCompactionEventView(event);
    if (!view) continue;
    var key = loomCompactionEventKey(view);
    if (seen[key]) continue;
    seen[key] = true;
    var anchorTs = typeof event.anchorTimestampMs === 'number' && isFinite(event.anchorTimestampMs)
      ? event.anchorTimestampMs : null;
    var recordedAt = typeof event.recordedAt === 'number' && isFinite(event.recordedAt)
      ? event.recordedAt : 0;
    var anchorId = typeof event.anchorMessageId === 'string' && event.anchorMessageId.length > 0
      ? event.anchorMessageId : null;
    rows.push({
      view: view,
      key: key,
      anchorTimestampMs: anchorTs,
      anchorMessageId: anchorId,
      recordedAt: recordedAt,
      order: i
    });
  }
  rows.sort(function (a, b) {
    var ak = a.anchorTimestampMs === null ? a.recordedAt : a.anchorTimestampMs;
    var bk = b.anchorTimestampMs === null ? b.recordedAt : b.anchorTimestampMs;
    if (ak !== bk) return ak - bk;
    if (a.recordedAt !== b.recordedAt) return a.recordedAt - b.recordedAt;
    return a.order - b.order;
  });
  var out = [];
  for (var j = 0; j < rows.length; j++) {
    var row = rows[j];
    Object.defineProperty(row.view, 'key', { value: row.key, enumerable: false, configurable: true });
    Object.defineProperty(row.view, 'anchorTimestampMs', { value: row.anchorTimestampMs, enumerable: false, configurable: true });
    Object.defineProperty(row.view, 'anchorMessageId', { value: row.anchorMessageId, enumerable: false, configurable: true });
    Object.defineProperty(row.view, 'recordedAt', { value: row.recordedAt, enumerable: false, configurable: true });
    out.push(row.view);
  }
  return out;
}

// W52 auto-compaction 分隔卡：GET /sessions/:id/compaction 的 active 快照 → 卡片数据；
// none / 坏帧返回 null（静默无卡，附属面绝不打断转录）。文案纯数据，页面与测试共用。
// W54：active 快照与历史事件共用同一 view 归一（/compactions 404 的旧服务端回退面）。
function loomCompactionCardView(compaction) {
  if (!compaction || typeof compaction !== 'object' || compaction.status !== 'active') return null;
  var view = loomCompactionEventView({
    id: typeof compaction.id === 'string' ? compaction.id : '',
    coveredCount: compaction.coveredCount,
    summaryText: compaction.summaryText
  });
  if (!view) return null;
  return {
    coveredCount: view.coveredCount,
    topLabel: view.topLabel,
    bottomLabel: view.bottomLabel,
    summary: view.summary
  };
}

// 分隔卡插入位（messages 数组下标）：第一条 timestamp >= anchorTimestampMs 的消息之前。
// anchor 早于整页 → 0（顶部）；anchor 晚于整页（无过界消息）→ -1（不画卡）；
// anchor 非数值（未覆盖尾巴不存在 = 整页都在摘要里）→ 0（置顶）；空页 → -1。
function loomCompactionInsertIndex(messages, anchorTimestampMs) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;
  if (typeof anchorTimestampMs !== 'number' || !isFinite(anchorTimestampMs)) return 0;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!m || typeof m !== 'object') continue;
    if (typeof m.timestamp === 'number' && isFinite(m.timestamp) && m.timestamp >= anchorTimestampMs) return i;
  }
  return -1;
}

// 历史压缩排布（纯数据）：index 0 → 页首堆叠（anchor 为空/早于整页同归此处）；
// index > 0 → 该下标消息之前（同下标保持事件升序）；-1 → 尾部兜底（晚于整页也不丢卡）。
// 空 messages 时所有事件落 tail；有压缩史时调用方仍会 ingest，尾部卡片可见。
function loomCompactionPlacement(messages, events) {
  var list = Array.isArray(events) ? events : [];
  var out = { top: [], at: {}, tail: [] };
  for (var i = 0; i < list.length; i++) {
    var view = list[i];
    if (!view || typeof view !== 'object') continue;
    var at = loomCompactionInsertIndex(messages, view.anchorTimestampMs);
    if (at === 0) {
      out.top.push(view);
    } else if (at > 0) {
      if (!out.at[at]) out.at[at] = [];
      out.at[at].push(view);
    } else {
      out.tail.push(view);
    }
  }
  return out;
}

function loomFormatDuration(ms) {
  var n = typeof ms === 'number' && isFinite(ms) ? ms : 0;
  if (n < 1000) return Math.round(n) + 'ms';
  if (n < 60000) return (n / 1000).toFixed(1) + 's';
  return Math.floor(n / 60000) + 'm' + Math.round((n % 60000) / 1000) + 's';
}

// todo.updated 帧归一（真源 = serve/todo-tool.ts 的 publish properties.todos）：
// 整表替换语义下每帧都是全量清单。坏帧不烂面板——非数组给空表；条目只认
// {content,status,priority} 三键，脏 status/priority 退保守值（pending/medium），空 content 丢项。
function loomNormalizeTodos(raw) {
  var out = [];
  if (!Array.isArray(raw)) return out;
  var statuses = { pending: 1, in_progress: 1, completed: 1 };
  var priorities = { high: 1, medium: 1, low: 1 };
  for (var i = 0; i < raw.length; i++) {
    var t = raw[i];
    if (!t || typeof t !== 'object') continue;
    var content = typeof t.content === 'string' ? t.content : '';
    if (content.replace(/^\s+|\s+$/g, '') === '') continue;
    out.push({
      content: content,
      status: statuses[t.status] ? t.status : 'pending',
      priority: priorities[t.priority] ? t.priority : 'medium'
    });
  }
  return out;
}

// todo 头部徽标计数（完成/进行/总数，纯数据）。
function loomTodoCounts(todos) {
  var done = 0;
  var active = 0;
  var total = Array.isArray(todos) ? todos.length : 0;
  for (var i = 0; Array.isArray(todos) && i < todos.length; i++) {
    if (todos[i] && todos[i].status === 'completed') done += 1;
    if (todos[i] && todos[i].status === 'in_progress') active += 1;
  }
  return { done: done, active: active, total: total };
}

// 思考流合并（真源 = 后端 reasoning 双帧通道）：final=true 的 part.updated 快照整段替换
// （llm-end 落定稿）；否则 part.delta 增量按到达序追加——part id 稳定，同块多帧累加不重影。
function loomApplyReasoningDelta(prev, incoming, final) {
  var a = typeof prev === 'string' ? prev : '';
  if (final === true) return { text: typeof incoming === 'string' ? incoming : a, mode: 'final' };
  var b = typeof incoming === 'string' ? incoming : '';
  if (b.length === 0) return { text: a, mode: 'same' };
  return { text: a + b, mode: 'append' };
}

// 思考块显示态（纯数据）：流式 = 「思考中」+ 打字光标；终态 = 字数提示（默认折叠回看）。
function loomReasoningState(streaming, text) {
  var len = typeof text === 'string' ? text.length : 0;
  var live = streaming === true;
  return {
    label: '思考',
    hint: live ? '思考中' : (len > 0 ? len + ' 字' : ''),
    cursor: live,
    streaming: live,
    tone: live ? 'streaming' : 'done'
  };
}

// 数量缩写（上下文面板的 tok/字节计数；1.2k / 12k / 1.2m）。
function loomFormatCount(n) {
  var v = typeof n === 'number' && isFinite(n) ? n : 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'k';
  return (v / 1000000).toFixed(1) + 'm';
}

// 上下文预览响应 → 渲染树（纯数据；坏帧不烂面板）。段序固定 system→memory→workflow→increment；
// 副会话 trace 反推的行 bytes/tokens 为 null（渲染成 —，不伪造）；输出总量/占比与粗估口径标注。
function loomContextTree(view) {
  var out = {
    ok: false,
    badge: '',
    basis: '',
    meta: '',
    note: '',
    pct: null,
    groups: [],
    total: { bytes: null, lines: null, tokens: null }
  };
  if (!view || typeof view !== 'object') return out;
  var rows = Array.isArray(view.rows) ? view.rows : [];
  var order = ['system', 'memory', 'workflow', 'increment'];
  var labels = { system: '系统', memory: '记忆注入', workflow: '工作流', increment: '增量槽' };
  var bySeg = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || typeof r !== 'object') continue;
    var seg = order.indexOf(r.segment) >= 0 ? String(r.segment) : 'increment';
    if (!bySeg[seg]) bySeg[seg] = { segment: seg, label: labels[seg], rows: [] };
    bySeg[seg].rows.push({
      label: typeof r.label === 'string' && r.label ? r.label : seg,
      source: typeof r.source === 'string' ? r.source : '',
      lines: typeof r.lines === 'number' ? r.lines : null,
      bytes: typeof r.bytes === 'number' ? r.bytes : null,
      tokens: typeof r.estimatedTokens === 'number' ? r.estimatedTokens : null,
      degraded: typeof r.degraded === 'string' && r.degraded ? r.degraded : null
    });
  }
  for (var k = 0; k < order.length; k++) {
    if (bySeg[order[k]]) out.groups.push(bySeg[order[k]]);
  }
  out.ok = out.groups.length > 0;
  var tokens = typeof view.estimatedTokens === 'number' ? view.estimatedTokens : null;
  var win = typeof view.contextWindow === 'number' && view.contextWindow > 0 ? view.contextWindow : null;
  out.total = {
    bytes: typeof view.totalBytes === 'number' ? view.totalBytes : null,
    lines: typeof view.totalLines === 'number' ? view.totalLines : null,
    tokens: tokens
  };
  out.pct = tokens !== null && win !== null ? Math.min(100, (tokens / win) * 100) : null;
  out.badge = tokens !== null ? loomFormatCount(tokens) + ' tok' : '';
  out.basis = view.basis === 'trace' ? 'trace 反推' : '装配快照';
  var bits = [];
  if (out.pct !== null) bits.push(out.pct.toFixed(1) + '% 窗口');
  if (out.total.lines !== null) bits.push(loomFormatCount(out.total.lines) + ' 行');
  if (tokens !== null) bits.push('估算 ' + loomFormatCount(tokens) + ' tok');
  if (win !== null) bits.push('窗口 ' + loomFormatCount(win));
  out.meta = bits.join(' · ');
  out.note = typeof view.note === 'string' ? view.note : '';
  return out;
}

// ═════════ W16-C：自研消毒 markdown（块/行内解析 + DOM 构造，零 CDN） ═════════
// 消毒策略 = 构造性安全：解析器只产出纯数据 token；DOM 构造器只用
// createElement/createTextNode/textContent 装配——模型输出里的任何 HTML 字符
// 序列（script 标签 / img onerror / javascript: href）都注定成为不可执行的文本
// 节点，因为整条渲染路径没有任何 innerHTML 位置可落。链接走数值白名单。

// 链接协议白名单：http / https / mailto，其余（javascript:/data:/vbscript: 等）拒绝。
// 拒绝后调用方把整段 markdown 链接语法降级为纯文本——绝不产出 href 属性。
function loomSafeHref(raw) {
  var s = typeof raw === 'string' ? raw.replace(/^\s+|\s+$/g, '') : '';
  if (!s) return null;
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  if (/^mailto:[^\s]+$/i.test(s)) return s;
  return null;
}

// 可反斜杠转义的标点集（反引号不在其中：行内解析里它是代码跨度定界符）。
var LOOM_MD_ESCAPE = '\\*_{}[]()#+-.!|~>';

function loomMdRun(src, i, ch) {
  var n = 0;
  while (i + n < src.length && src.charAt(i + n) === ch) n += 1;
  return n;
}

function loomMdRepeat(ch, n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ch;
  return s;
}

// 列表项识别：- x / * x / + x / 1. x / 2) x；返回缩进/序号/正文。
function loomMdListItem(line) {
  var m = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/.exec(line);
  if (m === null) return null;
  return {
    indent: m[1].length,
    ordered: /\d/.test(m[2]),
    start: m[3] ? parseInt(m[3], 10) : 1,
    text: m[4]
  };
}

// 表格分隔行：|---|:---:| 至少两列（对齐号可有可无）。
function loomMdIsTableDelim(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function loomMdSplitRow(line) {
  var s = line.replace(/^\s+|\s+$/g, '');
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  var cells = s.split('|');
  var out = [];
  for (var i = 0; i < cells.length; i++) out.push(cells[i].replace(/^\s+|\s+$/g, ''));
  return out;
}

// 行首缩进去掉至多 n 个空格（嵌套列表/续行交给子块解析）。
function loomMdDedent(line, spaces) {
  var n = spaces > 0 ? spaces : 0;
  return line.replace(new RegExp('^ {0,' + n + '}'), '');
}

// 段落终止探测：该行是否开启一个新块（标题/围栏/分割线/引用/列表/表格）。
function loomMdStartsBlock(lines, i) {
  var line = lines[i];
  if (/^\s*(\u0060{3,}|~{3,})/.test(line)) return true;
  if (/^#{1,4}\s+/.test(line)) return true;
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (loomMdListItem(line) !== null) return true;
  if (line.indexOf('|') >= 0 && i + 1 < lines.length && loomMdIsTableDelim(lines[i + 1])) return true;
  return false;
}

// 列表块收集：更深缩进 = 上一项的子内容（递归解析）；空行仅在后续仍是
// 列表/缩进内容时留在块内。产出 { type:'list', ordered, start, items:[{text,ordered,children}] }。
function loomMdCollectList(lines, start) {
  var flat = [];
  var i = start;
  while (i < lines.length) {
    var line = lines[i];
    var item = loomMdListItem(line);
    if (item !== null) {
      var last = flat.length > 0 ? flat[flat.length - 1] : null;
      if (last !== null && item.indent > last.indent) {
        last.child.push(loomMdDedent(line, last.indent + 2));
      } else {
        flat.push({ indent: item.indent, ordered: item.ordered, start: item.start, text: item.text, child: [] });
      }
      i += 1;
      continue;
    }
    if (/^\s*$/.test(line)) {
      var nxt = i + 1 < lines.length ? lines[i + 1] : '';
      var nxtItem = loomMdListItem(nxt);
      // 空行后换列表类型（无序与有序互换）= 新列表：收束当前块，交给上层重新解析
      if (nxtItem !== null && flat.length > 0 && nxtItem.ordered !== flat[0].ordered) break;
      if (nxtItem !== null || /^\s{2,}\S/.test(nxt)) {
        if (flat.length > 0) flat[flat.length - 1].child.push('');
        i += 1;
        continue;
      }
      break;
    }
    if (/^\s+\S/.test(line) && flat.length > 0) {
      flat[flat.length - 1].child.push(loomMdDedent(line, flat[flat.length - 1].indent + 2));
      i += 1;
      continue;
    }
    break;
  }
  var items = [];
  for (var k = 0; k < flat.length; k++) {
    items.push({
      text: flat[k].text,
      ordered: flat[k].ordered,
      children: flat[k].child.length > 0 ? loomMdParseBlocks(flat[k].child) : []
    });
  }
  return {
    list: {
      type: 'list',
      ordered: flat.length > 0 ? flat[0].ordered : false,
      start: flat.length > 0 ? flat[0].start : 1,
      items: items
    },
    next: i
  };
}

function loomMdCollectTable(lines, start) {
  var head = loomMdSplitRow(lines[start]);
  var delims = loomMdSplitRow(lines[start + 1]);
  var align = [];
  for (var a = 0; a < delims.length; a++) {
    var d = delims[a];
    var left = d.charAt(0) === ':';
    var right = d.charAt(d.length - 1) === ':';
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  var rows = [];
  var i = start + 2;
  while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) {
    rows.push(loomMdSplitRow(lines[i]));
    i += 1;
  }
  return { table: { type: 'table', head: head, align: align, rows: rows }, next: i };
}

// 块解析入口：markdown 文本 → 块 token 数组（纯数据，可单测）。
function loomMarkdownBlocks(src) {
  var text = typeof src === 'string' ? src : '';
  text = text.replace(/\r\n?/g, '\n');
  return loomMdParseBlocks(text.split('\n'));
}

function loomMdParseBlocks(lines) {
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (/^\s*$/.test(line)) { i += 1; continue; }
    // 围栏代码：三反引号或三波浪线，允许 info string；未闭合吃到文末（不丢内容）
    var fence = /^\s*(\u0060{3,}|~{3,})\s*([^\u0060]*)$/.exec(line);
    if (fence) {
      var marker = fence[1].charAt(0);
      var runLen = fence[1].length;
      var lang = (fence[2] || '').replace(/\s+$/g, '');
      var buf = [];
      i += 1;
      while (i < lines.length) {
        var close = /^\s*(\u0060{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[1].charAt(0) === marker && close[1].length >= runLen) { i += 1; break; }
        buf.push(lines[i]);
        i += 1;
      }
      out.push({ type: 'code', lang: lang, text: buf.join('\n') });
      continue;
    }
    var heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ type: 'heading', level: heading[1].length, text: heading[2].replace(/\s+$/g, '') });
      i += 1;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push({ type: 'hr' }); i += 1; continue; }
    if (/^\s*>/.test(line)) {
      var qbuf = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (/^\s*$/.test(lines[i]) && /^\s*>/.test(lines[i + 1] || '')))) {
        qbuf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push({ type: 'quote', blocks: loomMdParseBlocks(qbuf) });
      continue;
    }
    if (loomMdListItem(line) !== null) {
      var lblock = loomMdCollectList(lines, i);
      out.push(lblock.list);
      i = lblock.next;
      continue;
    }
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && loomMdIsTableDelim(lines[i + 1])) {
      var tblock = loomMdCollectTable(lines, i);
      out.push(tblock.table);
      i = tblock.next;
      continue;
    }
    var pbuf = [line.replace(/\s+$/g, '')];
    i += 1;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !loomMdStartsBlock(lines, i)) {
      pbuf.push(lines[i].replace(/\s+$/g, ''));
      i += 1;
    }
    out.push({ type: 'paragraph', text: pbuf.join('\n') });
  }
  return out;
}

// 行内解析：代码跨度 > 加粗/斜体 > 链接；未闭合标记如实当字面文本。
// 下划线强调要求词边界（snake_case 保真）；深度上限防病态嵌套爆栈。
function loomMarkdownInline(text, depth) {
  var src = typeof text === 'string' ? text : '';
  var d = typeof depth === 'number' ? depth : 0;
  var out = [];
  var buf = '';
  var i = 0;
  while (i < src.length) {
    var ch = src.charAt(i);
    if (ch === '\\' && i + 1 < src.length && LOOM_MD_ESCAPE.indexOf(src.charAt(i + 1)) >= 0) {
      buf += src.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === '\n') {
      if (buf.length > 0) { out.push({ type: 'text', text: buf }); buf = ''; }
      out.push({ type: 'br' });
      i += 1;
      continue;
    }
    if (ch === '\u0060') {
      var run = loomMdRun(src, i, '\u0060');
      var closeTick = src.indexOf(loomMdRepeat('\u0060', run), i + run);
      if (closeTick >= 0) {
        if (buf.length > 0) { out.push({ type: 'text', text: buf }); buf = ''; }
        out.push({ type: 'code', text: src.slice(i + run, closeTick) });
        i = closeTick + run;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '*') {
      var strong = src.substr(i, 2) === '**';
      var mark = strong ? '**' : '*';
      var end = src.indexOf(mark, i + mark.length);
      if (end >= 0 && end > i + mark.length) {
        if (buf.length > 0) { out.push({ type: 'text', text: buf }); buf = ''; }
        var inner = src.slice(i + mark.length, end);
        out.push({ type: strong ? 'strong' : 'em', children: d < 6 ? loomMarkdownInline(inner, d + 1) : [{ type: 'text', text: inner }] });
        i = end + mark.length;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '_') {
      var prevOk = i === 0 || !/[a-zA-Z0-9]/.test(src.charAt(i - 1));
      var strongU = src.substr(i, 2) === '__';
      var markU = strongU ? '__' : '_';
      var endU = src.indexOf(markU, i + markU.length);
      var nextU = endU >= 0 ? src.charAt(endU + markU.length) : '';
      if (prevOk && endU > i + markU.length && !/[a-zA-Z0-9]/.test(nextU || ' ')) {
        if (buf.length > 0) { out.push({ type: 'text', text: buf }); buf = ''; }
        var innerU = src.slice(i + markU.length, endU);
        out.push({ type: strongU ? 'strong' : 'em', children: d < 6 ? loomMarkdownInline(innerU, d + 1) : [{ type: 'text', text: innerU }] });
        i = endU + markU.length;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '[') {
      var closeB = src.indexOf(']', i + 1);
      if (closeB > i + 1 && src.charAt(closeB + 1) === '(') {
        var closeP = src.indexOf(')', closeB + 2);
        if (closeP > closeB + 2) {
          var label = src.slice(i + 1, closeB);
          var href = src.slice(closeB + 2, closeP);
          var safe = loomSafeHref(href);
          if (buf.length > 0) { out.push({ type: 'text', text: buf }); buf = ''; }
          if (safe !== null) {
            out.push({ type: 'link', href: safe, children: d < 6 ? loomMarkdownInline(label, d + 1) : [{ type: 'text', text: label }] });
          } else {
            out.push({ type: 'text', text: src.slice(i, closeP + 1) });
          }
          i = closeP + 1;
          continue;
        }
      }
      buf += ch;
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.length > 0) out.push({ type: 'text', text: buf });
  // 相邻文本节点合并（链接被白名单拒绝后整段降级会产生多个碎片文本）
  var merged = [];
  for (var m = 0; m < out.length; m++) {
    var t = out[m];
    if (t.type === 'text' && merged.length > 0 && merged[merged.length - 1].type === 'text') {
      merged[merged.length - 1].text += t.text;
    } else {
      merged.push(t);
    }
  }
  return merged;
}

// DOM 构造器（纯函数形态：doc 由调用方注入，测试可传记录型假 document）。
// 只用 createElement/createTextNode/appendChild/setAttribute/textContent。
function loomMarkdownRender(doc, src) {
  var root = typeof doc.createDocumentFragment === 'function' ? doc.createDocumentFragment() : doc.createElement('div');
  var blocks = loomMarkdownBlocks(src);
  for (var i = 0; i < blocks.length; i++) loomMdAppendBlock(doc, root, blocks[i]);
  return root;
}

function loomMdAppendInline(doc, parent, tokens) {
  var list = Array.isArray(tokens) ? tokens : [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'text') {
      parent.appendChild(doc.createTextNode(t.text));
    } else if (t.type === 'br') {
      parent.appendChild(doc.createElement('br'));
    } else if (t.type === 'code') {
      var code = doc.createElement('code');
      code.textContent = t.text;
      parent.appendChild(code);
    } else if (t.type === 'strong' || t.type === 'em') {
      var wrap = doc.createElement(t.type === 'strong' ? 'strong' : 'em');
      loomMdAppendInline(doc, wrap, t.children);
      parent.appendChild(wrap);
    } else if (t.type === 'link') {
      var a = doc.createElement('a');
      a.setAttribute('href', t.href);
      a.setAttribute('rel', 'noopener');
      a.setAttribute('target', '_blank');
      loomMdAppendInline(doc, a, t.children);
      parent.appendChild(a);
    } else if (typeof t.text === 'string') {
      parent.appendChild(doc.createTextNode(t.text));
    }
  }
}

function loomMdAppendList(doc, parent, block) {
  var items = Array.isArray(block.items) ? block.items : [];
  var listEl = null;
  var listOrdered = null;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var ordered = item.ordered === true;
    if (listEl === null || ordered !== listOrdered) {
      listEl = doc.createElement(ordered ? 'ol' : 'ul');
      if (ordered && block.start > 1 && listOrdered === null) listEl.setAttribute('start', String(block.start));
      parent.appendChild(listEl);
      listOrdered = ordered;
    }
    var li = doc.createElement('li');
    loomMdAppendInline(doc, li, loomMarkdownInline(item.text, 0));
    var kids = Array.isArray(item.children) ? item.children : [];
    for (var k = 0; k < kids.length; k++) loomMdAppendBlock(doc, li, kids[k]);
    listEl.appendChild(li);
  }
}

function loomMdAppendBlock(doc, parent, block) {
  if (!block || typeof block !== 'object') return;
  if (block.type === 'heading') {
    var lvl = block.level < 1 ? 1 : (block.level > 4 ? 4 : block.level);
    var h = doc.createElement('h' + lvl);
    loomMdAppendInline(doc, h, loomMarkdownInline(block.text, 0));
    parent.appendChild(h);
    return;
  }
  if (block.type === 'code') {
    var wrap = doc.createElement('div');
    wrap.className = 'md-code';
    var head = doc.createElement('div');
    head.className = 'md-code-head';
    var lang = doc.createElement('span');
    lang.className = 'md-lang';
    lang.textContent = block.lang || 'text';
    var btn = doc.createElement('button');
    btn.className = 'md-copy';
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-md-copy', 'code');
    btn.textContent = '复制';
    head.appendChild(lang);
    head.appendChild(btn);
    var pre = doc.createElement('pre');
    var code = doc.createElement('code');
    code.textContent = block.text;
    pre.appendChild(code);
    wrap.appendChild(head);
    wrap.appendChild(pre);
    parent.appendChild(wrap);
    return;
  }
  if (block.type === 'list') { loomMdAppendList(doc, parent, block); return; }
  if (block.type === 'table') {
    var table = doc.createElement('table');
    var thead = doc.createElement('thead');
    var htr = doc.createElement('tr');
    var head2 = Array.isArray(block.head) ? block.head : [];
    for (var c = 0; c < head2.length; c++) {
      var th = doc.createElement('th');
      loomMdAppendInline(doc, th, loomMarkdownInline(head2[c], 0));
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = doc.createElement('tbody');
    var rows = Array.isArray(block.rows) ? block.rows : [];
    for (var r = 0; r < rows.length; r++) {
      var tr = doc.createElement('tr');
      var row = Array.isArray(rows[r]) ? rows[r] : [];
      for (var c2 = 0; c2 < row.length; c2++) {
        var td = doc.createElement('td');
        loomMdAppendInline(doc, td, loomMarkdownInline(row[c2], 0));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    parent.appendChild(table);
    return;
  }
  if (block.type === 'quote') {
    var bq = doc.createElement('blockquote');
    var qblocks = Array.isArray(block.blocks) ? block.blocks : [];
    for (var q = 0; q < qblocks.length; q++) loomMdAppendBlock(doc, bq, qblocks[q]);
    parent.appendChild(bq);
    return;
  }
  if (block.type === 'hr') { parent.appendChild(doc.createElement('hr')); return; }
  var p = doc.createElement('p');
  loomMdAppendInline(doc, p, loomMarkdownInline(block.text, 0));
  parent.appendChild(p);
}

// ═════════ W16-C：context/full 新契约（Lane B 冻结）→ 面板纯数据 ═════════
// 响应形状：{ sessionID, capturedAt, basis:"live", prefixHash, systemPromptSha256,
//   systemPrompt, prefixByteLength, segments:[{index,label,offset,byteLength,text}],
//   messages:[{index,role,offset,byteLength,text}], messagesByteLength,
//   totalPromptByteLength, contextWindow, transientExcluded, note }
// 字节布局口径：offset 缺失时用累计游标补齐（前段 end 即本段起点）；end = offset +
// byteLength；total 优先取契约值，缺失回退 prefix+messages，再回退最大 end。
// 分段一字不裁：text 原样进 pieces，渲染层只折叠不截断。
function loomContextPieceGroup(piece) {
  if (!piece || piece.kind === 'message') return 'increment';
  var label = String(piece.label || '').toLowerCase();
  if (label.indexOf('identity') >= 0 || label.indexOf('身份') >= 0 || label.indexOf('system') >= 0) return 'identity';
  if (label.indexOf('memory') >= 0 || label.indexOf('记忆') >= 0) return 'memory';
  if (label.indexOf('workflow') >= 0 || label.indexOf('工作流') >= 0) return 'workflow';
  if (label.indexOf('increment') >= 0 || label.indexOf('增量') >= 0) return 'increment';
  return 'other';
}

function loomContextFullView(view) {
  var out = {
    ok: false, sessionID: '', capturedAt: 0, basis: '', live: false,
    prefixHash: '', systemPromptSha256: '', systemPrompt: '',
    prefixByteLength: 0, messagesByteLength: 0, totalPromptByteLength: 0,
    contextWindow: null, transientExcluded: '', note: '',
    estimateTokens: null, pct: null,
    source: 'transcript', wireSource: '', wireMessageCount: 0, sourceNote: '',
    transcriptPrefixByteLength: 0, transcriptMessagesByteLength: 0,
    transcriptTotalPromptByteLength: 0, transcriptEstimateTokens: null, transcriptPct: null,
    pieces: [], groups: [], rawText: '', maxEnd: 0,
    segmentCount: 0, messageCount: 0
  };
  if (!view || typeof view !== 'object') return out;
  out.ok = true;
  out.sessionID = typeof view.sessionID === 'string' ? view.sessionID : '';
  out.capturedAt = typeof view.capturedAt === 'number' ? view.capturedAt : 0;
  out.basis = typeof view.basis === 'string' ? view.basis : '';
  out.live = out.basis === 'live';
  out.prefixHash = typeof view.prefixHash === 'string' ? view.prefixHash : '';
  out.systemPromptSha256 = typeof view.systemPromptSha256 === 'string' ? view.systemPromptSha256 : '';
  out.systemPrompt = typeof view.systemPrompt === 'string' ? view.systemPrompt : '';
  out.transientExcluded = typeof view.transientExcluded === 'string' ? view.transientExcluded : '';
  out.note = typeof view.note === 'string' ? view.note : '';
  out.contextWindow = typeof view.contextWindow === 'number' && view.contextWindow > 0 ? view.contextWindow : null;

  var segs = Array.isArray(view.segments) ? view.segments : [];
  var msgs = Array.isArray(view.messages) ? view.messages : [];
  out.segmentCount = segs.length;
  out.messageCount = msgs.length;
  var cursor = 0;
  var i;
  var prefixSum = 0;
  for (i = 0; i < segs.length; i++) {
    var seg = segs[i] && typeof segs[i] === 'object' ? segs[i] : {};
    var segText = typeof seg.text === 'string' ? seg.text : '';
    var segBytes = typeof seg.byteLength === 'number' && seg.byteLength >= 0 ? seg.byteLength : segText.length;
    var segOffset = typeof seg.offset === 'number' && seg.offset >= 0 ? seg.offset : cursor;
    out.pieces.push({
      kind: 'segment',
      index: typeof seg.index === 'number' ? seg.index : i,
      label: typeof seg.label === 'string' && seg.label ? seg.label : '段 ' + i,
      role: '',
      offset: segOffset,
      byteLength: segBytes,
      end: segOffset + segBytes,
      text: segText
    });
    prefixSum += segBytes;
    if (segOffset + segBytes > cursor) cursor = segOffset + segBytes;
  }
  // 契约同时给 systemPrompt 全文：segments 缺席时作为身份段单件兜底（绝不空白）
  if (segs.length === 0 && out.systemPrompt.length > 0) {
    var sysBytes = typeof view.prefixByteLength === 'number' && view.prefixByteLength >= 0 ? view.prefixByteLength : out.systemPrompt.length;
    out.pieces.push({ kind: 'segment', index: 0, label: 'systemPrompt', role: '', offset: 0, byteLength: sysBytes, end: sysBytes, text: out.systemPrompt });
    prefixSum = sysBytes;
    if (sysBytes > cursor) cursor = sysBytes;
  }
  var msgSum = 0;
  for (i = 0; i < msgs.length; i++) {
    var msg = msgs[i] && typeof msgs[i] === 'object' ? msgs[i] : {};
    var msgText = typeof msg.text === 'string' ? msg.text : '';
    var msgBytes = typeof msg.byteLength === 'number' && msg.byteLength >= 0 ? msg.byteLength : msgText.length;
    var msgOffset = typeof msg.offset === 'number' && msg.offset >= 0 ? msg.offset : cursor;
    var msgIndex = typeof msg.index === 'number' ? msg.index : i;
    var msgRole = typeof msg.role === 'string' && msg.role ? msg.role : 'message';
    out.pieces.push({
      kind: 'message',
      index: msgIndex,
      label: msgRole + ' #' + msgIndex,
      role: msgRole,
      offset: msgOffset,
      byteLength: msgBytes,
      end: msgOffset + msgBytes,
      text: msgText
    });
    msgSum += msgBytes;
    if (msgOffset + msgBytes > cursor) cursor = msgOffset + msgBytes;
  }
  out.prefixByteLength = typeof view.prefixByteLength === 'number' && view.prefixByteLength >= 0 ? view.prefixByteLength : prefixSum;
  out.messagesByteLength = typeof view.messagesByteLength === 'number' && view.messagesByteLength >= 0 ? view.messagesByteLength : msgSum;
  out.maxEnd = cursor;
  var total = typeof view.totalPromptByteLength === 'number' && view.totalPromptByteLength >= 0 ? view.totalPromptByteLength : 0;
  if (total <= 0) total = out.prefixByteLength + out.messagesByteLength;
  if (total <= 0) total = cursor;
  out.totalPromptByteLength = total;
  out.estimateTokens = total > 0 ? Math.round(total / 3.5) : null;
  out.pct = out.estimateTokens !== null && out.contextWindow !== null
    ? Math.min(100, (out.estimateTokens / out.contextWindow) * 100)
    : null;

  // durable 转录口径先留档；wire.request 在场且结构完整时以其精确字节覆盖顶线。
  out.transcriptPrefixByteLength = out.prefixByteLength;
  out.transcriptMessagesByteLength = out.messagesByteLength;
  out.transcriptTotalPromptByteLength = out.totalPromptByteLength;
  out.transcriptEstimateTokens = out.estimateTokens;
  out.transcriptPct = out.pct;
  var totals = loomContextRequestTotals(view);
  if (totals.ok) {
    out.source = 'wire';
    out.wireSource = totals.wireSource;
    out.wireMessageCount = totals.messageCount;
    out.prefixByteLength = totals.prefixByteLength;
    out.messagesByteLength = totals.messagesByteLength;
    out.totalPromptByteLength = totals.totalPromptByteLength;
    out.estimateTokens = Math.round(out.totalPromptByteLength / 3.5);
    out.pct = out.contextWindow !== null
      ? Math.min(100, (out.estimateTokens / out.contextWindow) * 100)
      : null;
    if (out.transcriptTotalPromptByteLength !== out.totalPromptByteLength) {
      out.sourceNote = 'durable 转录 ' + loomFormatCount(out.transcriptTotalPromptByteLength)
        + ' B（含压缩前历史/图片 base64，未进本次请求）';
    }
  } else if (view.wire !== null && view.wire !== undefined) {
    out.sourceNote = '发线请求面不完整（缺 systemPrompt/messages），已回退 durable 转录口径';
  }

  var order = ['identity', 'memory', 'workflow', 'increment', 'other'];
  var groupLabels = { identity: '身份框', memory: 'memory 注入', workflow: '工作流', increment: '增量槽', other: '其它' };
  var byKey = {};
  for (i = 0; i < out.pieces.length; i++) {
    var key = loomContextPieceGroup(out.pieces[i]);
    if (!byKey[key]) byKey[key] = { key: key, label: groupLabels[key], bytes: 0, pieces: [] };
    byKey[key].bytes += out.pieces[i].byteLength;
    byKey[key].pieces.push(out.pieces[i]);
  }
  for (i = 0; i < order.length; i++) { if (byKey[order[i]]) out.groups.push(byKey[order[i]]); }

  // 复制全文/原始抽屉的字节装配：systemPrompt 在场即以其为前缀全文（segments 只是它的
  // 分段拆解，拼 segments 会重复），否则拼 segments；消息恒按序追加。逐字拼接不加分隔。
  var raw = out.systemPrompt;
  if (!raw) {
    for (i = 0; i < segs.length; i++) {
      if (segs[i] && typeof segs[i].text === 'string') raw += segs[i].text;
    }
  }
  for (i = 0; i < msgs.length; i++) {
    if (msgs[i] && typeof msgs[i].text === 'string') raw += msgs[i].text;
  }
  out.rawText = raw;
  return out;
}

// 上下文顶线文案（纯数据）：发线请求 / 转录快照二选一，空估值为破折号，绝不落 NaN。
function loomContextHeaderText(t, basisChip) {
  var v = t && typeof t === 'object' ? t : {};
  var label = v.source === 'wire' ? '发线请求' : '转录快照';
  var chip = basisChip ? '[' + basisChip + '] ' : '';
  var est = typeof v.estimateTokens === 'number' && isFinite(v.estimateTokens) ? loomFormatCount(v.estimateTokens) : '—';
  var win = typeof v.contextWindow === 'number' && isFinite(v.contextWindow) ? loomFormatCount(v.contextWindow) : '—';
  return chip + label + ' · 前缀 ' + loomFormatCount(v.prefixByteLength)
    + ' B · 消息 ' + loomFormatCount(v.messagesByteLength)
    + ' B · 总 ' + loomFormatCount(v.totalPromptByteLength)
    + ' B · 估算 ~' + est + ' tok · 窗口 ' + win;
}

// ═════════ W16-C：任务/运行视图纯数据 ═════════
// RunState 词表（queued/admitted/running/done/failed/partial）+ 视图侧暂停/死信/取消。
function loomTaskStatusMeta(status) {
  var s = typeof status === 'string' ? status : '';
  if (s === 'running') return { label: '运行中', tone: 'running' };
  if (s === 'admitted') return { label: '已准入', tone: 'running' };
  if (s === 'queued') return { label: '排队中', tone: 'pending' };
  if (s === 'done') return { label: '完成', tone: 'completed' };
  if (s === 'failed') return { label: '失败', tone: 'error' };
  if (s === 'partial') return { label: '部分完成', tone: 'warn' };
  if (s === 'paused') return { label: '已暂停', tone: 'pending' };
  if (s === 'dead-letter') return { label: '死信', tone: 'error' };
  if (s === 'cancelled') return { label: '已取消', tone: 'aborted' };
  return { label: s || '未知', tone: 'pending' };
}

function loomTaskFingerprint(row) {
  try { return JSON.stringify(row); } catch (err) { return ''; }
}

// 任务列表轮询差分：与 history 差分同思路——只在 changed 时允许整表重绘，
// added/updated 供行级闪示。坏帧（非数组/无 task_id）当空表，不砸面板。
function loomTaskMerge(prev, next) {
  var before = Array.isArray(prev) ? prev : [];
  var after = Array.isArray(next) ? next : [];
  var beforeMap = {};
  var afterMap = {};
  var i;
  var key;
  for (i = 0; i < before.length; i++) {
    if (before[i] && typeof before[i].task_id === 'string') beforeMap[before[i].task_id] = loomTaskFingerprint(before[i]);
  }
  for (i = 0; i < after.length; i++) {
    if (after[i] && typeof after[i].task_id === 'string') afterMap[after[i].task_id] = true;
  }
  var added = [];
  var updated = [];
  var removed = [];
  for (i = 0; i < after.length; i++) {
    var row = after[i];
    if (!row || typeof row.task_id !== 'string') continue;
    if (!(row.task_id in beforeMap)) added.push(row.task_id);
    else if (beforeMap[row.task_id] !== loomTaskFingerprint(row)) updated.push(row.task_id);
  }
  for (key in beforeMap) {
    if (Object.prototype.hasOwnProperty.call(beforeMap, key) && !afterMap[key]) removed.push(key);
  }
  return {
    count: after.length,
    added: added,
    updated: updated,
    removed: removed,
    changed: added.length + updated.length + removed.length > 0
  };
}

// 事件帧一行摘要（事件 tab 的可读附注；纯数据，未知类型给空串）。
function loomEventBrief(type, props) {
  var p = props && typeof props === 'object' ? props : {};
  if (type === 'message.part.delta') {
    var d = typeof p.delta === 'string' ? p.delta : '';
    return '增量 ' + String(p.field || '') + ' +' + d.length;
  }
  if (type === 'message.part.updated') {
    var part = p.part && typeof p.part === 'object' ? p.part : {};
    var bits = [String(part.type || 'part')];
    if (part.tool) bits.push(String(part.tool));
    if (part.state && typeof part.state === 'object' && part.state.status) bits.push(String(part.state.status));
    return bits.join(' · ');
  }
  if (type === 'message.updated') {
    var info = p.info && typeof p.info === 'object' ? p.info : {};
    var ib = [];
    if (info.model) ib.push(String(info.model));
    if (info.stopReason) ib.push(String(info.stopReason));
    if (info.tokens && typeof info.tokens.total === 'number') ib.push('tok ' + info.tokens.total);
    return ib.join(' · ') || '消息更新';
  }
  if (type === 'session.status') return p.status && p.status.type ? String(p.status.type) : 'busy';
  if (type === 'session.idle') {
    return p.convergence && p.convergence.status ? '收束 · ' + String(p.convergence.status) : '空闲';
  }
  if (type === 'session.error') {
    if (p.error && p.error.message) return String(p.error.message);
    return p.replay_error ? String(p.replay_error) : '未知错误';
  }
  if (type === 'session.created') {
    var ci = p.info && typeof p.info === 'object' ? p.info : {};
    return String(ci.id || '') + (ci.parentID ? ' ← ' + String(ci.parentID) : '');
  }
  if (type === 'session.children') return Array.isArray(p.children) ? p.children.length + ' 个子会话' : '';
  if (type === 'file.edited') return String(p.file || '');
  if (type === 'server.connected' || type === 'server.heartbeat') return '—';
  if (type === 'run.status') {
    var rb = [];
    if (p.terminal === true) rb.push('终态 ' + String(p.status || ''));
    else if (p.stage) rb.push(String(p.stage));
    if (typeof p.durationMs === 'number') rb.push(loomFormatDuration(p.durationMs));
    return rb.join(' · ');
  }
  if (type === 'delivery.notify') return String(p.title || '通知') + (p.message ? ' · ' + String(p.message) : '');
  if (type === 'watchdog.alarm') return String(p.event || '未知');
  if (type === 'todo.updated') return Array.isArray(p.todos) ? p.todos.length + ' 项' : '';
  if (type === 'context.notice') {
    var nb = [];
    if (Array.isArray(p.notices)) nb.push(p.notices.length + ' 条变更');
    if (typeof p.turnIdx === 'number') nb.push('轮 ' + p.turnIdx);
    return nb.join(' · ');
  }
  return '';
}

// ═════════ W17-C：发线面（wire）/ 引用清单（manifest）纯数据归一 ═════════
// 契约冻结（GET /context/full v2 顶层追加 wire/manifest 两键，v1 键不动）。
// 本段只做数据归一与诚实缺席，不触碰 DOM；渲染层全部 createElement/textContent。

function loomWireStr(v) { return typeof v === 'string' ? v : ''; }
function loomWireNum(v) { return typeof v === 'number' && v >= 0 ? v : null; }

// UTF-8 字节数（ES5 手扫：ASCII 1 / 2 字节 / BMP 3 / 代理对 4）。byteLength 脏值或缺席时
// 的唯一回退口径——text.length 是 UTF-16 码元数，中文/emoji 会低报。
function loomUtf8ByteLength(text) {
  var s = typeof text === 'string' ? text : '';
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i += 1; }
    else n += 3;
  }
  return n;
}

// POST hook 管道在系统提示词尾部追加的 skill 目录**不再切分高亮**（W18 用户判词：
// 结构展览不如读文本，目录尾段就在 systemPrompt 全文里逐字呈现）；loomWireSplitPrompt 退役。

// wire.request.messages 视图归一：只认契约五键；transient 仅布尔 true（脏值不误标尾注）；
// byteLength 缺失回退 text 字符数（不伪造精确字节）；非数组空表。
function loomWireMessagesView(messages) {
  var list = Array.isArray(messages) ? messages : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i] && typeof list[i] === 'object' ? list[i] : {};
    var text = loomWireStr(m.text);
    out.push({
      index: typeof m.index === 'number' ? m.index : i,
      role: loomWireStr(m.role) || 'message',
      byteLength: typeof m.byteLength === 'number' && isFinite(m.byteLength) && m.byteLength >= 0 ? m.byteLength : loomUtf8ByteLength(text),
      text: text,
      transient: m.transient === true
    });
  }
  return out;
}

// providerPayload 视图：string→present+UTF-8 字节数（ES5 手扫，代理对 4 字节）；
// null/缺失→逐字转呈 providerPayloadAbsentReason（''=服务端未说明，渲染层诚实兜底）。
function loomWirePayloadAbsentView(wire) {
  var out = { hasWire: false, present: false, text: '', bytes: 0, reason: '', capturedAt: 0 };
  if (!wire || typeof wire !== 'object') return out;
  out.hasWire = true;
  out.capturedAt = typeof wire.capturedAt === 'number' ? wire.capturedAt : 0;
  if (typeof wire.providerPayload === 'string') {
    out.present = true;
    out.text = wire.providerPayload;
    out.bytes = loomUtf8ByteLength(wire.providerPayload);
    return out;
  }
  out.reason = loomWireStr(wire.providerPayloadAbsentReason);
  return out;
}

// 最后一次发线请求的精确字节口径（wire.request）：systemPrompt 真 UTF-8 字节 + 逐消息
// byteLength（脏值回退 text 真字节，非对象条目按 0 中和）+ 消息块分隔符 1B（有消息时）。
// 结构不完整 = ok:false（wire.source 仍如实转呈），调用方回退 durable 转录。
function loomContextRequestTotals(view) {
  var out = { ok: false, wireSource: '', prefixByteLength: 0, messagesByteLength: 0, totalPromptByteLength: 0, messageCount: 0 };
  var v = view && typeof view === 'object' && !Array.isArray(view) ? view : null;
  if (!v) return out;
  var wire = v.wire;
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return out;
  out.wireSource = loomWireStr(wire.source);
  var req = wire.request;
  if (!req || typeof req !== 'object' || Array.isArray(req)) return out;
  if (typeof req.systemPrompt !== 'string') return out;
  if (!Array.isArray(req.messages)) return out;
  var sum = 0;
  for (var i = 0; i < req.messages.length; i++) {
    var m = req.messages[i];
    if (!m || typeof m !== 'object') continue;
    if (typeof m.byteLength === 'number' && isFinite(m.byteLength) && m.byteLength >= 0) sum += m.byteLength;
    else if (typeof m.text === 'string') sum += loomUtf8ByteLength(m.text);
  }
  out.ok = true;
  out.prefixByteLength = loomUtf8ByteLength(req.systemPrompt);
  out.messagesByteLength = sum;
  out.messageCount = req.messages.length;
  out.totalPromptByteLength = out.prefixByteLength + (out.messageCount > 0 ? 1 : 0) + sum;
  return out;
}

// manifest → 五组固定序（memoryFiles/skillFiles/mcpServers/agentRoleFiles/runtime）。
// 缺键=空组如实呈现（证明未漏显而非伪造）；行形状供 W18 纯文本清单行（loomCtxManifestPlain）直出。
function loomManifestGroup(manifest) {
  var out = {
    ok: false, groups: [], model: null, configPath: '', workspaceRoot: '',
    counts: { memoryFiles: 0, skillFiles: 0, mcpServers: 0, agentRoleFiles: 0 }
  };
  if (!manifest || typeof manifest !== 'object') return out;
  out.ok = true;
  var i;
  var rows;
  var r;
  var mem = [];
  var list = Array.isArray(manifest.memoryFiles) ? manifest.memoryFiles : [];
  for (i = 0; i < list.length; i++) {
    r = list[i] && typeof list[i] === 'object' ? list[i] : {};
    var rel = loomWireStr(r.relPath);
    var hash = loomWireStr(r.bootHash);
    mem.push({
      label: rel || ('memoryFiles[' + i + ']'),
      source: rel,
      bytes: loomWireNum(r.bytes),
      degraded: loomWireStr(r.degrade) || null,
      mark: hash ? 'boot ' + hash.slice(0, 12) : null,
      badge: null
    });
  }
  out.counts.memoryFiles = mem.length;

  var sk = [];
  list = Array.isArray(manifest.skillFiles) ? manifest.skillFiles : [];
  for (i = 0; i < list.length; i++) {
    r = list[i] && typeof list[i] === 'object' ? list[i] : {};
    sk.push({
      label: loomWireStr(r.name) || ('skillFiles[' + i + ']'),
      source: loomWireStr(r.file),
      bytes: null,
      degraded: r.degraded === true ? '降级' : null,
      mark: null,
      badge: null
    });
  }
  out.counts.skillFiles = sk.length;

  var mcp = [];
  list = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [];
  for (i = 0; i < list.length; i++) {
    r = list[i] && typeof list[i] === 'object' ? list[i] : {};
    var cmd = loomWireStr(r.cmd);
    var args = Array.isArray(r.args) ? r.args.map(loomWireStr).filter(function (x) { return x.length > 0; }) : [];
    var cwd = loomWireStr(r.cwd);
    var names = Array.isArray(r.toolNames) ? r.toolNames.map(loomWireStr).filter(function (x) { return x.length > 0; }) : [];
    mcp.push({
      label: loomWireStr(r.name) || ('mcpServers[' + i + ']'),
      source: (cmd + (args.length ? ' ' + args.join(' ') : '')).trim(),
      bytes: null,
      degraded: null,
      mark: cwd ? 'cwd ' + cwd : null,
      badge: r.ok === true ? { text: '在线', tone: 'on' } : (r.ok === false ? { text: '未启动', tone: 'off' } : { text: '状态缺失', tone: 'dim' }),
      toolCount: names.length
    });
  }
  out.counts.mcpServers = mcp.length;

  var roles = [];
  list = Array.isArray(manifest.agentRoleFiles) ? manifest.agentRoleFiles : [];
  for (i = 0; i < list.length; i++) {
    r = list[i] && typeof list[i] === 'object' ? list[i] : {};
    // W17-E kind（main|sub，缺省面由 server 侧保证）→ W18：kind 徽章下线，原值直出纯文本；
    // 缺席/脏值 = null 不伪造。badge 位仅 mcp 组仍作纯文本词源（在线/未启动/状态缺失）。
    var roleKind = loomWireStr(r.kind);
    roles.push({
      label: loomWireStr(r.name) || ('agentRoleFiles[' + i + ']'),
      source: loomWireStr(r.file),
      bytes: null,
      degraded: null,
      mark: r.builtin === true ? '内置' : (r.builtin === false ? '自定义' : null),
      badge: null,
      kind: roleKind === 'main' || roleKind === 'sub' ? roleKind : null
    });
  }
  out.counts.agentRoleFiles = roles.length;

  if (manifest.model && typeof manifest.model === 'object') {
    out.model = {
      id: loomWireStr(manifest.model.id),
      api: loomWireStr(manifest.model.api),
      baseUrl: loomWireStr(manifest.model.baseUrl),
      apiKeyMasked: loomWireStr(manifest.model.apiKeyMasked)
    };
  }
  out.configPath = loomWireStr(manifest.configPath);
  out.workspaceRoot = loomWireStr(manifest.workspaceRoot);

  var modelSrc = out.model
    ? [out.model.id || '—', out.model.api || '—', out.model.baseUrl || '—', 'key=' + (out.model.apiKeyMasked || '—')].join(' · ')
    : '';
  var runtime = [];
  if (out.model) {
    runtime.push({ label: 'model', source: modelSrc, bytes: null, degraded: null, mark: '脱敏', badge: null });
  }
  runtime.push({ label: 'configPath', source: out.configPath, bytes: null, degraded: null, mark: null, badge: null });
  runtime.push({ label: 'workspaceRoot', source: out.workspaceRoot, bytes: null, degraded: null, mark: null, badge: null });

  out.groups = [
    { key: 'memoryFiles', label: '记忆文件 · boot 注入', rows: mem },
    { key: 'skillFiles', label: '技能文件', rows: sk },
    { key: 'mcpServers', label: 'MCP 服务', rows: mcp },
    { key: 'agentRoleFiles', label: '角色定义', rows: roles },
    { key: 'runtime', label: '运行装配 · 模型脱敏', rows: runtime }
  ];
  return out;
}

// ═════════ W18：上下文纯文本重排（用户判词：显示乱排版乱，结构展览不如读文本） ═════════
// 单一真源 = 一组纯文本装配函数：板块「完整上下文（按发送顺序）」整块 textContent 呈现，
// 无树/无徽章/无路径按钮。解析失败一律回退原文逐字（"一个字都不能少"的新口径：
// 不可解析时原始文本完整在场，绝不吞字节）。

// pi-ai Message（context-full 的 canonical JSON 条目文本）→ 可读正文：
//   thinking→【思考】 text→【正文】 toolCall→【调用】name(args JSON verbatim)
//   toolResult→【结果】（isError=true 时记【结果·isError】） image→【图片】mime·字符数
// 解析失败/非对象/无 content 字段 → 原文逐字回退。
function loomCtxReadableBody(text) {
  var raw = loomWireStr(text);
  var msg;
  try { msg = JSON.parse(raw); } catch (err) { return raw; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return raw;
  var role = loomWireStr(msg.role);
  var isResult = role === 'toolResult';
  var resultMark = '【结果' + (isResult && msg.isError === true ? '·isError' : '') + '】';
  var lines = [];
  var pushBlock = function (block) {
    if (typeof block === 'string') { lines.push('【正文】' + block); return; }
    if (!block || typeof block !== 'object') { lines.push('【条目】' + JSON.stringify(block === undefined ? null : block)); return; }
    var type = loomWireStr(block.type);
    if (type === 'thinking') {
      lines.push('【思考】' + loomWireStr(block.thinking) + (block.redacted === true ? '（redacted 安全过滤）' : ''));
    } else if (type === 'text') {
      lines.push((isResult ? resultMark : '【正文】') + loomWireStr(block.text));
    } else if (type === 'toolCall') {
      lines.push('【调用】' + loomWireStr(block.name) + '(' + JSON.stringify(block.arguments === undefined ? null : block.arguments) + ')');
    } else if (type === 'image') {
      lines.push('【图片】' + loomWireStr(block.mimeType) + ' · ' + loomWireStr(block.data).length + ' 字符');
    } else {
      lines.push('【' + (type || '未知块') + '】' + JSON.stringify(block));
    }
  };
  var content = msg.content;
  if (typeof content === 'string') { lines.push('【正文】' + content); }
  else if (Array.isArray(content)) { for (var i = 0; i < content.length; i++) pushBlock(content[i]); }
  else return raw;
  return lines.join('\n');
}

// 板块「完整上下文（按发送顺序）」装配全文：wire 在场 → post-pipe 发线字节真序
// （系统提示词全文含 skill 目录尾段 → 工具定义 → 对话消息逐条全文）；
// wire 缺席/null → v1 装配快照走同一装配器（note 明写 来源=装配快照非发线）。
function loomContextPlainView(view) {
  var out = { ok: false, fromWire: false, note: '', text: '' };
  var v = view && typeof view === 'object' ? view : null;
  if (!v) return out;
  var wire = v.wire && typeof v.wire === 'object' ? v.wire : null;
  var lines = [];
  var i;
  if (wire) {
    var req = wire.request && typeof wire.request === 'object' ? wire.request : {};
    var model = wire.model && typeof wire.model === 'object' ? wire.model : {};
    out.ok = true;
    out.fromWire = true;
    out.note = '来源=post-pipe 发线捕获 · turn #' + (typeof wire.turnIdx === 'number' ? wire.turnIdx : '—')
      + ' · ' + (loomWireStr(model.id) || 'model —')
      + ' · 捕获 ' + (typeof wire.capturedAt === 'number' ? wire.capturedAt : '—');
    // W23-A：wire.source=cache = 内存槽空、取自 wire/{sid}.json 持久缓存——note 明标重启残影，
    // 绝不冒充本轮现捕获（键缺席=v1-era 服务端，无从断言，不硬标实时）。
    if (loomWireStr(wire.source) === 'cache') out.note += ' · 发线=缓存(重启残影)';
    lines.push('══ 系统提示词（post-pipe 全文） ══');
    lines.push(loomWireStr(req.systemPrompt) || '（缺席：request.systemPrompt 未提供）');
    lines.push('');
    lines.push('══ 工具定义 ══');
    var tools = Array.isArray(req.tools) ? req.tools : [];
    if (tools.length === 0) lines.push('（request.tools 缺席或为空）');
    for (i = 0; i < tools.length; i++) {
      var t = tools[i] && typeof tools[i] === 'object' ? tools[i] : {};
      lines.push('▸ ' + (loomWireStr(t.name) || '(无名工具)'));
      lines.push('描述: ' + loomWireStr(t.description));
      lines.push('参数: ' + loomWireStr(t.schemaText));
    }
    lines.push('');
    var rows = loomWireMessagesView(req.messages);
    lines.push('══ 对话消息（共' + rows.length + '条） ══');
    for (i = 0; i < rows.length; i++) {
      var m = rows[i];
      lines.push('[' + m.index + '] ' + m.role + ' · ' + m.byteLength + ' B · —' + (m.transient ? ' [瞬态附件]' : ''));
      lines.push(loomCtxReadableBody(m.text));
    }
    out.text = lines.join('\n') + '\n';
    return out;
  }
  var sys = loomWireStr(v.systemPrompt);
  var segs = Array.isArray(v.segments) ? v.segments : [];
  if (!sys) {
    var joined = '';
    for (i = 0; i < segs.length; i++) {
      if (segs[i] && typeof segs[i].text === 'string') joined += segs[i].text;
    }
    sys = joined;
  }
  var msgs = Array.isArray(v.messages) ? v.messages : [];
  if (!sys && msgs.length === 0) return out;
  out.ok = true;
  // W23-A：basis=cache 的无 wire 面（理论形态：缓存重建必带 wire，防御性兜底）不得谎称
  // 「装配快照」——装配对象根本不可恢复，note 如实写缓存重建口径。
  out.note = loomWireStr(v.basis) === 'cache'
    ? '来源=缓存重建（wire/{sid}.json 持久缓存 + durable 转录，非本轮内存现读；segments 恒空不假装装配分段）'
    : '来源=装配快照非发线（v1 面：工具定义/瞬态尾标/provider 载荷不在本面）';
  lines.push('══ 系统提示词（装配前缀全文） ══');
  lines.push(sys);
  lines.push('');
  lines.push('══ 工具定义 ══');
  lines.push('（未捕获：v1 装配快照无 wire 面）');
  lines.push('');
  lines.push('══ 对话消息（共' + msgs.length + '条） ══');
  for (i = 0; i < msgs.length; i++) {
    var q = msgs[i] && typeof msgs[i] === 'object' ? msgs[i] : {};
    var qText = loomWireStr(q.text);
    var qBytes = typeof q.byteLength === 'number' && q.byteLength >= 0 ? q.byteLength : qText.length;
    var qOff = typeof q.offset === 'number' && q.offset >= 0 ? String(q.offset) : '—';
    lines.push('[' + (typeof q.index === 'number' ? q.index : i) + '] ' + (loomWireStr(q.role) || 'message')
      + ' · ' + qBytes + ' B · ' + qOff);
    lines.push(loomCtxReadableBody(qText));
  }
  out.text = lines.join('\n') + '\n';
  return out;
}

// v1 memory 段 → 按 '### memory[i] <source>' 标题拆每文件小节；与 manifest.memoryFiles
// 按序号关联出 字节/bootHash 前缀/降级（清单缺席 → 仅标题，绝不伪造）。
// 无标题命中 → 段全文直通（一字不裁）。
function loomCtxMemoryPlain(view) {
  var v = view && typeof view === 'object' ? view : {};
  var segs = Array.isArray(v.segments) ? v.segments : [];
  var memText = '';
  var i;
  for (i = 0; i < segs.length; i++) {
    var s = segs[i] && typeof segs[i] === 'object' ? segs[i] : {};
    if (loomWireStr(s.label) === 'memory' && typeof s.text === 'string' && s.text.length > 0) { memText = s.text; break; }
  }
  if (!memText) return '';
  var memRows = [];
  var g = loomManifestGroup(v.manifest);
  if (g.ok) {
    for (i = 0; i < g.groups.length; i++) { if (g.groups[i].key === 'memoryFiles') memRows = g.groups[i].rows; }
  }
  var hits = [];
  var re = /^### memory\[(\d+)\][ \t]*(.*)$/gm;
  var mt;
  while ((mt = re.exec(memText)) !== null) {
    hits.push({ idx: Number(mt[1]), source: mt[2], start: mt.index, headEnd: re.lastIndex });
  }
  if (hits.length === 0) return memText;
  var lines = [];
  for (i = 0; i < hits.length; i++) {
    var h = hits[i];
    var body = memText.slice(h.headEnd, i + 1 < hits.length ? hits[i + 1].start : memText.length);
    var row = memRows[h.idx] || null;
    var bits = [];
    if (row) {
      if (row.bytes !== null) bits.push(row.bytes + ' B');
      if (row.source && row.source !== h.source) bits.push('清单=' + row.source);
      if (row.mark) bits.push(row.mark);
      if (row.degraded) bits.push('降级:' + row.degraded);
    }
    // 头行与 body 直连（body 以换行起 = 段内原文逐字，不多不少）
    lines.push('### memory[' + h.idx + '] ' + h.source + (bits.length ? ' · ' + bits.join(' · ') : '') + body);
  }
  // 清单比段头多出的行：正文缺席如实标注（不猜内容）
  for (i = 0; i < memRows.length; i++) {
    var extra = memRows[i];
    var seen = false;
    for (var k = 0; k < hits.length; k++) { if (hits[k].idx === i) seen = true; }
    if (seen) continue;
    var eb = [ '### memory[' + i + '] ' + (extra.label || '—') ];
    if (extra.bytes !== null) eb.push(extra.bytes + ' B');
    if (extra.mark) eb.push(extra.mark);
    if (extra.degraded) eb.push('降级:' + extra.degraded);
    eb.push('（段内无正文：如实标注）');
    lines.push(eb.join(' · '));
  }
  return lines.join('\n');
}

// manifest → 引用清单纯文本行（五组固定序，条目一行一文本；W18：徽章/路径按钮全下线，
// kind/ok 以原值或中文词直出文本）。组形状与 loomManifestGroup 同构（诚实缺席保留）。
function loomCtxManifestPlain(manifest) {
  var g = loomManifestGroup(manifest);
  if (!g.ok) return '';
  var lines = [];
  for (var i = 0; i < g.groups.length; i++) {
    var grp = g.groups[i];
    lines.push('── ' + grp.label + ' · ' + grp.rows.length + ' 项 ──');
    if (grp.rows.length === 0) { lines.push('（无：诚实缺席，非未渲染）'); continue; }
    for (var j = 0; j < grp.rows.length; j++) {
      var r = grp.rows[j];
      var bits = [r.label];
      if (grp.key === 'memoryFiles') {
        if (r.bytes !== null) bits.push(r.bytes + ' B');
        if (r.mark) bits.push(r.mark);
        if (r.degraded) bits.push('降级:' + r.degraded);
      } else if (grp.key === 'mcpServers') {
        if (r.source) bits.push(r.source);
        if (r.badge) bits.push(r.badge.text);
        bits.push('工具 ' + (r.toolCount || 0));
        if (r.mark) bits.push(r.mark);
      } else if (grp.key === 'agentRoleFiles') {
        if (r.source) bits.push(r.source);
        if (r.kind) bits.push('kind=' + r.kind);
        if (r.mark) bits.push(r.mark);
      } else {
        if (r.source) bits.push(r.source);
        if (r.mark) bits.push(r.mark);
        if (grp.key === 'skillFiles' && r.degraded) bits.push('降级:' + r.degraded);
      }
      lines.push(bits.join(' · '));
    }
  }
  return lines.join('\n') + '\n';
}

// 参数模块纯文本（服务端已脱敏后原样美化；不可序列化 → 诚实标注，绝不抛）。
function loomCtxParamsPlain(params) {
  try { return JSON.stringify(params === undefined || params === null ? {} : params, null, 2); }
  catch (err) { return typeof params === 'string' ? params : '（参数不可序列化：如实标注）'; }
}

// ═════════ W17-F：context.notice 增量时间线（纯数据，DOM-less） ═════════
// 契约（events/types.ts 冻结）：properties = { notices:[{action,relPath,bytes}],
// turnIdx, sessionID }——帧**不含正文**，时间线条目自然也只有 时刻/动作/路径/字节。

// context.notice 帧 → 时间线环形（≤100，新帧在前；同帧多 notice 保持声明序入头部）。
// 传入环拷贝不 mutate；脏帧/坏条目安全跳过绝不抛（未知事件容忍同纪律）。
// at = 客户端收帧时刻（Date.now，条目间同帧同值）。
function loomNoticeTimelinePush(ring, frame) {
  var out = Array.isArray(ring) ? ring.slice() : [];
  var payload = frame && typeof frame === 'object' && frame.payload && typeof frame.payload === 'object' ? frame.payload : null;
  if (!payload || payload.type !== 'context.notice') return out;
  var props = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  var list = Array.isArray(props.notices) ? props.notices : [];
  var turn = typeof props.turnIdx === 'number' && isFinite(props.turnIdx) ? props.turnIdx : null;
  var at = Date.now();
  var batch = [];
  for (var i = 0; i < list.length; i++) {
    var n = list[i] && typeof list[i] === 'object' ? list[i] : null;
    if (!n) continue;
    var action = loomWireStr(n.action);
    var relPath = loomWireStr(n.relPath);
    if (!action && !relPath) continue;
    batch.push({
      at: at,
      action: action,
      relPath: relPath,
      bytes: typeof n.bytes === 'number' && isFinite(n.bytes) ? n.bytes : null,
      turnIdx: turn
    });
  }
  for (var j = batch.length - 1; j >= 0; j--) out.unshift(batch[j]);
  if (out.length > 100) out.length = 100;
  return out;
}

// action → 中文徽章词表（钉死：set 新增 / replace 更新 / remove 移除；
// 未知动作原样呈现 dim 档——后端扩档不破页，与事件容忍面对称）。
function loomNoticeActionMeta(action) {
  if (action === 'set') return { label: '新增', tone: 'on' };
  if (action === 'replace') return { label: '更新', tone: 'dim' };
  if (action === 'remove') return { label: '移除', tone: 'off' };
  return { label: loomWireStr(action), tone: 'dim' };
}

// ═════════ W24：消费面纯函数（会话列表三件套 / /tasks 历史合流 / live-cache 真相） ═════════
// 只消费 W23-B/W23-A/W23-C 已接线端点的冻结形状：GET /sessions 行（createdAt/title/archived）、
// POST title/archive/unarchive、GET /tasks 行（in_memory 键位=来源标）、GET /context/full
// （basis/wire.source）。零服务端新语义、零重排序、缺值不伪造：序与缺席都以服务端为真源。

// 会话行 → 渲染行（无题回落 sid 显示；archived 只认真布尔 true——脏值不当归档，
// 与 loomWireMessagesView.transient 同纪律）。
function loomSessionRowView(session) {
  var out = { id: '', status: '', title: '', hasTitle: false, archived: false, createdAt: 0 };
  if (!session || typeof session !== 'object') return out;
  out.id = loomWireStr(session.sessionID);
  out.status = loomWireStr(session.status);
  // 持久面真源=服务端 trim 后落盘（空=删键），此处对全空格脏值同口径判无题（回落 sid 可读性优先）。
  var title = loomWireStr(session.title).replace(/^\s+|\s+$/g, '');
  out.hasTitle = title.length > 0;
  out.title = out.hasTitle ? title : out.id;
  out.archived = session.archived === true;
  out.createdAt = typeof session.createdAt === 'number' && isFinite(session.createdAt) ? session.createdAt : 0;
  return out;
}

// 显示侧过滤：archivedOnly=true 只留归档行；false 隐藏归档行。服务端本已过滤（W23-B），
// 这里是面板对旧构建/竞态的客户端复核，**绝不重排序**——createdAt 倒序是视图真源。
function loomVisibleSessions(list, archivedOnly) {
  var rows = Array.isArray(list) ? list : [];
  var only = archivedOnly === true;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || typeof r !== 'object') continue;
    var arch = r.archived === true;
    if (only ? arch : !arch) out.push(r);
  }
  return out;
}

// 长列表切片（「加载更多」递增上限；2.5MB+ 转录按行惰性开、列表只画可见片）。
function loomListSlice(rows, shown) {
  var list = Array.isArray(rows) ? rows : [];
  var n = typeof shown === 'number' && shown > 0 ? Math.floor(shown) : list.length;
  return { rows: list.slice(0, n), hidden: Math.max(0, list.length - n) };
}

// GET /sessions 查询路径：默认（隐藏归档）= '/sessions'；archivedOnly = '?archived=1'。
// 口径注：服务端查询真值是 "1" 开关=只列归档（routes.ts W23-B 冻结），无第三取值——
// 面板不发明参数形状；"全部同列" 面不存在，切换即两态。
function loomSessionListPath(archivedOnly) {
  return archivedOnly === true ? '/sessions?archived=1' : '/sessions';
}

// POST title 请求规格（path/method/body 纯数据：页面与测试同源直发；trim+120 码点上限
// 由服务端强制、空串=清除标题声明——面板不重复校验，只如实回拉结果）。
function loomTitleRequest(sid, title) {
  return {
    path: '/sessions/' + encodeURIComponent(String(sid === null || sid === undefined ? '' : sid)) + '/title',
    method: 'POST',
    body: JSON.stringify({ title: typeof title === 'string' ? title : '' })
  };
}

// POST archive/unarchive 规格：archived=true → /archive，false → /unarchive（幂等端点）。
function loomArchiveRequest(sid, archived) {
  return {
    path: '/sessions/' + encodeURIComponent(String(sid === null || sid === undefined ? '' : sid)) + (archived === true ? '/archive' : '/unarchive'),
    method: 'POST',
    body: '{}'
  };
}

// /tasks 来源标（W23-C 形状冻结）：内核在飞行 in_memory:true（toTaskView 恒标）；
// 账本-only 行恒缺键 → 历史。严格 === true：脏值绝不误标「内存在飞」。
function loomTaskSourceBadge(row) {
  var live = !!row && typeof row === 'object' && row.in_memory === true;
  return { live: live, label: live ? '内存在飞' : '账本历史' };
}

// 任务呈现序：dispatched_at 倒序（新在前）。同刻并列保持服务端合流序
// （内核行在前、账本行时间序）——ES2019 sort 稳定性，不为排次伪造第二时间戳。
function loomTasksNewestFirst(list) {
  var rows = Array.isArray(list) ? list.slice() : [];
  rows.sort(function (a, b) {
    var ta = a && typeof a.dispatched_at === 'number' && isFinite(a.dispatched_at) ? a.dispatched_at : 0;
    var tb = b && typeof b.dispatched_at === 'number' && isFinite(b.dispatched_at) ? b.dispatched_at : 0;
    return tb - ta;
  });
  return rows;
}

// 任务行转录入口路径：只读 GET /sessions/{sid}/context/full——W23-A 保证子会话重启后
// 仍 200（basis:"cache" 持久缓存+durable 转录重建），这正是该按钮存在的意义。
function loomTaskTranscriptPath(sessionID) {
  return '/sessions/' + encodeURIComponent(String(sessionID === null || sessionID === undefined ? '' : sessionID)) + '/context/full';
}

// live/cache 真相芯片（三态语义 routes.ts W23-A 注释冻结）：
//   basis=cache ⇒ 无 live loop，整面 = 持久缓存+durable 重建（segments 恒空）；
//   basis=live + source=cache ⇒ loop 活着但发线面是重启残影；
//   'wire' 键缺席 = v1-only 服务端（compat 提示已负责，不发芯片）；键在值 null = 未捕获。
function loomContextTruthBits(view) {
  var out = { basis: '', basisChip: '', wireState: '', wireChip: '', cache: false, line: '' };
  var v = view && typeof view === 'object' ? view : null;
  if (!v) return out;
  out.basis = loomWireStr(v.basis);
  if (out.basis === 'live') out.basisChip = '基底=实时';
  else if (out.basis === 'cache') out.basisChip = '基底=缓存';
  else if (out.basis) out.basisChip = '基底=' + out.basis;
  out.cache = out.basis === 'cache';
  if (!('wire' in v)) out.wireState = 'absent';
  else if (v.wire === null || v.wire === undefined) out.wireState = 'none';
  else if (typeof v.wire !== 'object') out.wireState = 'dirty';
  else out.wireState = loomWireStr(v.wire.source) || 'nosrc';
  if (out.wireState === 'live') out.wireChip = '发线=实时';
  else if (out.wireState === 'cache') out.wireChip = '发线=缓存(重启残影)';
  else if (out.wireState === 'none') out.wireChip = '发线=未捕获';
  else if (out.wireState !== 'absent') out.wireChip = '发线=未标源'; // nosrc/dirty/未知取值：不猜档，统一如实呈现
  var bits = [];
  if (out.basisChip) bits.push(out.basisChip);
  if (out.wireChip) bits.push(out.wireChip);
  out.line = bits.join(' · ');
  return out;
}
`;

/** 单文件门面页（内嵌 CSS/JS，无外部 CDN 引用；离线可用）。 */
export const HARNESS_UI_HTML: string = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>loom harness</title>
<style>
  :root {
    --bg: #090c10;
    --bg-1: #0d1218;
    --bg-2: #121a23;
    --bg-3: #0a0f14;
    --line: #1b232d;
    --line-2: #2a3543;
    --text: #dce6f2;
    --text-2: #9dadc0;
    --text-3: #67788c;
    --amber: #e2b35e;
    --amber-2: #f0cd8a;
    --amber-ink: #191204;
    --green: #5fca8c;
    --red: #ef7070;
    --blue: #7cb8ef;
    --slate: #8ea2b8;
    --radius: 10px;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.6;
    background:
      radial-gradient(1100px 560px at 88% -12%, rgba(226, 179, 94, .05), transparent 62%),
      radial-gradient(900px 520px at -12% 112%, rgba(124, 184, 239, .045), transparent 62%),
      var(--bg);
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #1d2731; border-radius: 5px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: #2a3746; }
  * { scrollbar-width: thin; scrollbar-color: #1d2731 transparent; }
  :focus-visible { outline: 2px solid rgba(226, 179, 94, .7); outline-offset: 2px; }

  #app { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100vh; }

  /* ── 左栏：品牌 / 新建 / 会话列表 / 页脚 ── */
  #sidebar {
    display: flex; flex-direction: column; min-height: 0;
    background: linear-gradient(180deg, #0e1319, #0b0e12 64%);
    border-right: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; }
  .brand .ic { width: 22px; height: 22px; color: var(--amber); flex: none; display: inline-flex; }
  .brand .ic svg { width: 22px; height: 22px; }
  .brand .name { font-weight: 650; letter-spacing: .04em; font-size: 15px; }
  .brand .sub { color: var(--text-3); font-size: 10.5px; letter-spacing: .2em; text-transform: uppercase; margin-top: 1px; }
  .side-pad { padding: 0 12px; }
  #newSession { width: 100%; justify-content: center; }
  .side-head { display: flex; align-items: center; gap: 6px; padding: 16px 12px 6px; }
  .side-label { flex: 1; font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-3); padding-left: 4px; }
  .icon-mini {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border: 1px solid transparent; border-radius: 6px;
    background: transparent; color: var(--text-3); cursor: pointer; padding: 0;
  }
  .icon-mini:hover { color: var(--text); border-color: var(--line-2); background: rgba(255, 255, 255, .03); }
  .icon-mini .ic { display: inline-flex; }
  .icon-mini .ic svg { width: 14px; height: 14px; }
  #sessionList { flex: 1; overflow-y: auto; margin: 0; padding: 2px 8px 12px; list-style: none; }
  .session-item {
    display: flex; align-items: center; gap: 9px;
    padding: 8px 10px; border-radius: 8px; cursor: pointer;
    border: 1px solid transparent; transition: background .12s, border-color .12s;
  }
  .session-item:hover { background: rgba(255, 255, 255, .03); }
  .session-item.active { background: rgba(226, 179, 94, .08); border-color: rgba(226, 179, 94, .28); }
  .session-id { font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  /* W24：有题会话用正文字体（标题是读的对象），无题回落 sid 保持等宽 */
  .session-id.titled { font-family: var(--sans); }
  .session-rename {
    flex: 1; min-width: 0; font: inherit; font-size: 12px; color: var(--text);
    background: var(--bg-3); border: 1px solid rgba(226, 179, 94, .55); border-radius: 6px; padding: 1px 6px; outline: none;
  }
  .session-act {
    flex: none; border: 1px solid var(--line-2); background: transparent; color: var(--text-3);
    border-radius: 6px; font: inherit; font-size: 10.5px; padding: 1px 6px; cursor: pointer;
  }
  .session-act:hover { color: var(--text); border-color: #3a4757; }
  .session-state { margin-left: auto; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); }
  .session-item.active .session-state { color: rgba(226, 179, 94, .85); }
  .list-more { display: flex; justify-content: center; padding: 4px 0 2px; }
  .side-empty { padding: 10px 12px; font-size: 12px; color: var(--text-3); line-height: 1.7; }
  .side-foot {
    border-top: 1px solid var(--line); padding: 10px 16px;
    font-family: var(--mono); font-size: 11px; color: var(--text-3);
  }

  /* 状态圆点：idle 绿 / busy 琥珀脉冲 / error 红 */
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex: none; }
  .dot.idle { background: var(--green); }
  .dot.busy { background: var(--amber); animation: pulse 1.6s ease-out infinite; }
  .dot.error { background: var(--red); }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(226, 179, 94, .45); }
    70% { box-shadow: 0 0 0 6px rgba(226, 179, 94, 0); }
    100% { box-shadow: 0 0 0 0 rgba(226, 179, 94, 0); }
  }

  /* ── 中栏：顶栏 / 状态条 / 舞台（消息流 + 子面板分栏）/ 输入区 ── */
  #main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  #topbar {
    display: flex; align-items: center; gap: 14px;
    padding: 10px 18px; border-bottom: 1px solid var(--line);
    background: rgba(9, 12, 16, .82); backdrop-filter: blur(8px);
  }
  .tb-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
  .tb-title { font-family: var(--mono); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tb-title.none { color: var(--text-3); font-family: var(--sans); font-size: 13px; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px; flex: none;
    font-size: 11.5px; padding: 2px 9px; border: 1px solid var(--line-2);
    border-radius: 999px; color: var(--text-2); font-family: var(--mono);
  }
  .pill.busy { color: var(--amber); border-color: rgba(226, 179, 94, .4); }
  .pill.error { color: var(--red); border-color: rgba(239, 112, 112, .4); }
  .stream { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--text-3); flex: none; font-family: var(--mono); }
  .stream-dot { width: 7px; height: 7px; border-radius: 50%; background: #37424f; flex: none; }
  .stream-dot.ok { background: var(--green); }
  .stream-dot.busy { background: var(--amber); animation: pulse 1.4s ease-out infinite; }
  .stream-dot.err { background: var(--red); }
  .stream-dot.warn { background: #e09a4e; }
  .stream.open { color: rgba(95, 202, 140, .85); }
  .stream.error { color: rgba(239, 112, 112, .9); }
  .tb-right { display: flex; align-items: center; gap: 14px; flex: none; }
  .health { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-2); }
  .token-box {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--line-2); border-radius: 8px;
    padding: 3px 4px 3px 9px; background: var(--bg-3);
  }
  .token-box:focus-within { border-color: rgba(226, 179, 94, .55); }
  .token-box .ic { display: inline-flex; color: var(--text-3); flex: none; }
  .token-box .ic svg { width: 13px; height: 13px; }
  .token-box input {
    width: 148px; border: 0; outline: 0; background: transparent;
    color: var(--text); font-family: var(--mono); font-size: 12px; padding: 3px 0;
  }
  .token-box input::placeholder { color: var(--text-3); }
  .mini {
    border: 1px solid var(--line-2); background: transparent; color: var(--text-2);
    border-radius: 6px; font: inherit; font-size: 11.5px; padding: 3px 9px; cursor: pointer;
  }
  .mini:hover { color: var(--text); border-color: #3a4757; background: rgba(255, 255, 255, .04); }
  /* W24 归档切换钮激活态（选中态走底色/字色 ramp，不加彩色描边——状态编码纪律） */
  .mini.on { color: var(--amber-2); border-color: rgba(226, 179, 94, .45); background: rgba(226, 179, 94, .08); }
  .tok-state { font-size: 11px; color: var(--text-3); flex: none; }
  .tok-state.ok { color: rgba(95, 202, 140, .9); }
  #childJump {
    display: inline-flex; align-items: center; gap: 6px; flex: none;
    border: 1px solid var(--line-2); background: transparent; color: var(--text-2);
    border-radius: 8px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer;
  }
  #childJump:hover { color: var(--text); border-color: #3a4757; }
  #childJump .ic { display: inline-flex; }
  #childJump .ic svg { width: 14px; height: 14px; }
  #childJump .badge {
    min-width: 16px; text-align: center; font-family: var(--mono); font-size: 10.5px;
    background: rgba(226, 179, 94, .16); color: var(--amber-2); border-radius: 999px; padding: 0 5px;
  }

  #statusBar { display: none; padding: 8px 18px; font-size: 13px; border-bottom: 1px solid var(--line); }
  #statusBar.show { display: block; }
  #statusBar.busy { background: rgba(226, 179, 94, .07); color: #e8c98a; }
  #statusBar.error { background: rgba(239, 112, 112, .09); color: #f2a3a3; }
  #statusBar.warn { background: rgba(230, 150, 80, .09); color: #e8b48a; }
  #statusBar.info { background: rgba(124, 184, 239, .09); color: #a8cdec; }

  #stage { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }

  /* ── W16-C 标签栏：五视图（聊天/上下文/子会话/任务/事件）同壳切换 ── */
  #tabbar {
    display: flex; align-items: stretch; gap: 0; padding: 0 16px;
    border-bottom: 1px solid var(--line); background: rgba(9, 12, 16, .82);
    flex: none; overflow-x: auto;
  }
  .tab {
    appearance: none; border: 0; border-bottom: 2px solid transparent; background: transparent;
    color: var(--text-3); font: inherit; font-size: 13px; letter-spacing: .02em;
    padding: 11px 13px 9px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px;
    white-space: nowrap; transition: color .12s ease, border-color .12s ease;
  }
  .tab:hover { color: var(--text-2); }
  .tab.active { color: var(--amber-2); border-bottom-color: var(--amber); }
  .tab .ic { display: inline-flex; }
  .tab .ic svg { width: 14px; height: 14px; }
  .tab .tab-badge {
    min-width: 16px; text-align: center; font-family: var(--mono); font-size: 10.5px;
    background: rgba(226, 179, 94, .16); color: var(--amber-2); border-radius: 999px; padding: 0 5px;
  }
  .tab .tab-badge.warn { background: rgba(239, 112, 112, .16); color: #f2a3a3; }
  #views { flex: 1; min-height: 0; min-width: 0; display: flex; }
  .view { display: none; flex: 1; min-width: 0; min-height: 0; }
  .view.active { display: flex; flex-direction: column; }
  #viewChildren.active { flex-direction: row; }
  #viewChildren > #childRail {
    width: 264px; flex: none; display: flex; flex-direction: column; min-height: 0;
    border-right: 1px solid var(--line); background: rgba(10, 14, 19, .35);
  }
  #viewChildren > #subpanels { flex: 1; min-width: 0; }
  #messages { flex: 1; overflow-y: auto; padding: 22px 28px 10px; min-height: 0; min-width: 0; }
  #thread { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }

  .empty {
    max-width: 480px; margin: 12vh auto 0; text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--text-3);
  }
  .empty .ic { color: #2a3746; display: inline-flex; }
  .empty .ic svg { width: 40px; height: 40px; }
  .empty .empty-title { color: var(--text-2); font-size: 15px; }
  .empty .empty-sub { font-size: 12.5px; line-height: 1.9; }
  .empty .empty-sub code {
    font-family: var(--mono); font-size: 11.5px; color: var(--text-2);
    background: #12171d; border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px;
  }

  .msg { display: flex; flex-direction: column; animation: rise .18s ease-out; }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .msg-user { align-items: flex-end; }
  .msg-user .bubble {
    max-width: 86%; white-space: pre-wrap; word-break: break-word;
    background: #17202b; border: 1px solid var(--line-2);
    border-radius: 12px 12px 3px 12px; padding: 9px 13px;
  }

  /* 待发消息区：只显示队列/侧车里的消息（排队中 / 已发送两态），不混入 #thread 转录。
     空队列整体隐藏；行/气泡沿用用户消息右对齐形态并压暗，徽标为等宽小胶囊。 */
  .pending-area {
    max-width: 860px; margin: 4px auto 0;
    display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  }
  .pending-area[hidden], .pending-area:empty { display: none; }
  .pending-row {
    display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
    opacity: .62; animation: rise .18s ease-out;
  }
  .pending-row[data-state="running"] { opacity: .78; }
  .pending-bubble {
    max-width: 86%; white-space: pre-wrap; word-break: break-word;
    background: #131a22; border: 1px dashed var(--line-2);
    border-radius: 12px 12px 3px 12px; padding: 8px 12px;
    color: var(--text-2); line-height: 1.65;
  }
  .pending-badge {
    font-family: var(--mono); font-size: 10px; letter-spacing: .08em;
    color: var(--text-3); border: 1px solid var(--line);
    border-radius: 999px; padding: 1px 7px; white-space: nowrap;
  }
  .pending-row[data-state="running"] .pending-badge,
  .pending-row[data-state="drained"] .pending-badge { color: var(--slate); border-color: var(--line-2); }
  .msg-assistant .msg-head { display: flex; align-items: baseline; gap: 9px; margin-bottom: 6px; }
  .msg-assistant .who { font-size: 11.5px; font-weight: 650; letter-spacing: .1em; color: var(--amber); text-transform: uppercase; }
  .msg-assistant .mid { font-family: var(--mono); font-size: 11px; color: var(--text-3); }
  .msg-assistant .meta { font-family: var(--mono); font-size: 11px; color: var(--text-3); margin-left: auto; text-align: right; }
  .msg-body {
    display: flex; flex-direction: column; gap: 10px;
    border-left: 2px solid rgba(226, 179, 94, .22); padding-left: 14px; margin-left: 2px;
  }
  .part-text { white-space: pre-wrap; word-break: break-word; line-height: 1.72; color: #e2ecf8; }
  .part-text.streaming::after { content: "▍"; color: var(--blue); margin-left: 2px; animation: blink 1s steps(2, start) infinite; }
  @keyframes blink { 50% { opacity: 0; } }

  /* 思考块（W13 reasoning 流）：暗灰斜体 + 左竖线，与正文气泡视觉分层；默认折叠回看 */
  details.reason { border: 0; border-left: 2px solid #33404f; border-radius: 0 8px 8px 0; background: rgba(13, 18, 24, .55); overflow: hidden; }
  details.reason > summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px;
    padding: 5px 10px; color: var(--text-3); font-size: 12px; user-select: none;
  }
  details.reason > summary::-webkit-details-marker { display: none; }
  details.reason .ic { display: inline-flex; }
  details.reason .ic svg { width: 13px; height: 13px; }
  details.reason .reason-label { letter-spacing: .06em; }
  details.reason .reason-hint { margin-left: auto; font-family: var(--mono); font-size: 10.5px; }
  details.reason.streaming { border-left-color: var(--slate); }
  details.reason.streaming .reason-hint { color: var(--slate); }
  details.reason.streaming .reason-hint::after {
    content: "▍"; margin-left: 3px; animation: blink 1s steps(2, start) infinite;
  }
  .reason-body {
    padding: 7px 12px 9px; white-space: pre-wrap; word-break: break-word;
    color: #8b99aa; font-style: italic; font-size: 12.5px; line-height: 1.7;
    border-top: 1px dashed var(--line); max-height: 260px; overflow: auto;
  }
  .reason-body.streaming::after {
    content: "▍"; margin-left: 2px; color: var(--slate); font-style: normal;
    animation: blink 1s steps(2, start) infinite;
  }

  /* 事件轻行：run 轨迹 / 看门狗 / 投递通知 / 子会话登记 */
  .ev-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-3); padding-left: 2px; animation: rise .18s ease-out; }
  .ev-row .ic { display: inline-flex; flex: none; }
  .ev-row .ic svg { width: 13px; height: 13px; }
  .ev-row .ev-text { min-width: 0; word-break: break-word; }
  .ev-row.run { color: var(--text-2); }
  .ev-row.run .ic { color: var(--slate); }
  .ev-row.warn { color: #e8b48a; }
  .ev-row.warn .ic { color: var(--amber); }
  .ev-row.child { color: #e6c98e; }
  .ev-row.child .ic { color: var(--amber); }
  .ev-row.notify { color: var(--blue); }
  .ev-row.notify .ic { color: var(--blue); }
  .ev-row.sys { justify-content: center; }
  .ev-row.sys .sys-line {
    font-size: 11.5px; color: var(--text-3); font-family: var(--mono);
    border: 1px dashed var(--line-2); border-radius: 999px; padding: 2px 12px;
  }

  /* file.edited：消息流里的轻量文件行（连续同文件合并计数） */
  .msg-file { flex-direction: row; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; padding-left: 2px; }
  .msg-file .file-ic { display: inline-flex; color: var(--blue); flex: none; }
  .msg-file .file-ic svg { width: 14px; height: 14px; }
  .msg-file .file-name { color: #cfe3f7; }
  .msg-file .file-dir { color: var(--text-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%; }
  .msg-file .file-tag {
    font-size: 10.5px; color: var(--blue); border: 1px solid rgba(124, 184, 239, .3);
    padding: 0 6px; border-radius: 999px; flex: none;
  }
  .msg-file .file-count { color: var(--text-3); font-size: 11px; }

  /* auto-compaction：opencode 同构，上下分隔线夹完整摘要（不折叠、不截高）。
     W54：历史多条压缩各自成卡；页首「更早的压缩摘要」堆叠容器 + 细分隔线。 */
  [data-component="session-compaction-message"] {
    width: 100%; display: flex; flex-direction: column; align-items: stretch;
  }
  .compaction { width: 100%; display: flex; flex-direction: column; }
  .compaction + .compaction { margin-top: 2px; }
  .compaction-stack {
    width: 100%; display: flex; flex-direction: column; gap: 2px;
    padding-bottom: 8px; border-bottom: 1px solid var(--line);
  }
  .compaction-stack-head {
    display: flex; align-items: center; gap: 10px; min-height: 18px;
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em;
    color: var(--text-3); padding: 0 2px;
  }
  .compaction-stack-head::after { content: ""; flex: 1 1 auto; height: 1px; background: var(--line-2); }
  .compaction-divider {
    display: flex; align-items: center; gap: 12px; height: 32px; margin: 8px 0; width: 100%;
  }
  .compaction-line { flex: 1 1 auto; height: 1px; background: var(--line-2); }
  .compaction-label {
    flex: none; font-family: var(--sans); font-size: 12px; font-weight: 400;
    letter-spacing: -.04px; color: var(--text-3); white-space: nowrap;
  }
  .compaction-summary { width: 100%; max-width: 100%; margin: 0 0 4px; }

  /* 工具卡：状态色左描边 + 折叠体 + running 实时输出窗 */
  details.tool {
    border: 1px solid var(--line); border-left: 3px solid var(--line-2); border-radius: var(--radius);
    background: var(--bg-1); overflow: hidden;
    transition: border-color .25s ease, box-shadow .25s ease;
  }
  details.tool > summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; gap: 9px;
    padding: 9px 12px; user-select: none; min-width: 0;
  }
  details.tool > summary::-webkit-details-marker { display: none; }
  details.tool[open] > summary { border-bottom: 1px solid var(--line); }
  details.tool[data-status="pending"] { border-left-color: #4c5a6b; }
  details.tool[data-status="running"] {
    border-left-color: var(--amber);
    box-shadow: 0 0 0 1px rgba(226, 179, 94, .07), 0 10px 30px -24px rgba(226, 179, 94, .6);
  }
  details.tool[data-status="completed"] { border-left-color: var(--green); }
  details.tool[data-status="error"] { border-left-color: var(--red); }
  details.tool[data-status="aborted"] { border-left-color: #7a8798; }
  .tool-glyph { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; flex: none; }
  .tool-glyph .ic { display: inline-flex; }
  .tool-glyph .ic svg, .tool-glyph svg { width: 15px; height: 15px; }
  .tool-glyph .ok { color: var(--green); }
  .tool-glyph .err { color: var(--red); }
  .tool-glyph .warn { color: var(--amber); }
  .tool-glyph .tool { color: var(--text-3); }
  .tool-name { font-family: var(--mono); font-size: 12.5px; color: var(--text); flex: none; }
  .tool-sub {
    font-size: 11.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; min-width: 0; flex: 1;
  }
  .tool-badge {
    margin-left: auto; flex: none; font-size: 10.5px; letter-spacing: .06em;
    border: 1px solid var(--line-2); border-radius: 999px; padding: 1px 8px; color: var(--text-2);
    transition: color .2s ease, border-color .2s ease, background .2s ease;
  }
  .tool-badge.tone-pending { color: var(--text-3); }
  .tool-badge.tone-running { color: var(--amber-2); border-color: rgba(226, 179, 94, .45); background: rgba(226, 179, 94, .08); }
  .tool-badge.tone-completed { color: #9be3b9; border-color: rgba(95, 202, 140, .4); background: rgba(95, 202, 140, .07); }
  .tool-badge.tone-error { color: #f2a3a3; border-color: rgba(239, 112, 112, .45); background: rgba(239, 112, 112, .08); }
  .tool-badge.tone-aborted { color: var(--text-2); }
  .chev { color: var(--text-3); transition: transform .18s ease; display: inline-flex; flex: none; }
  .chev svg { width: 14px; height: 14px; }
  details.tool[open] .chev { transform: rotate(180deg); }
  .tool-body { padding: 10px 12px 12px; display: grid; gap: 10px; }
  .block-label { font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-3); margin-bottom: 4px; }
  .tool-body pre, .sub-pre {
    margin: 0; font-family: var(--mono); font-size: 12px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word; color: #c6d2de;
    background: var(--bg-3); border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 10px; max-height: 300px; overflow: auto;
  }
  .tool-out-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .tool-out-head .block-label { margin-bottom: 0; }
  .tool-out-head .block-label.live { color: var(--amber-2); }
  .tool-out-head .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); animation: pulse 1.4s ease-out infinite; flex: none; }
  .tool-out-meta { margin-left: auto; font-family: var(--mono); font-size: 10.5px; color: var(--text-3); }
  pre.tool-output[data-empty="1"]::before { content: "等待输出…"; color: var(--text-3); }
  .tool-children { display: flex; flex-wrap: wrap; gap: 8px; }
  .tool-child-link {
    display: inline-flex; align-items: center; gap: 7px;
    border: 1px solid rgba(226, 179, 94, .4); background: rgba(226, 179, 94, .07);
    color: var(--amber-2); border-radius: 8px; padding: 6px 11px; font: inherit; font-size: 12px; cursor: pointer;
  }
  .tool-child-link:hover { background: rgba(226, 179, 94, .14); }
  .tool-child-link .ic { display: inline-flex; }
  .tool-child-link .ic svg { width: 14px; height: 14px; }
  .spin {
    width: 13px; height: 13px; border-radius: 50%; flex: none;
    border: 2px solid rgba(226, 179, 94, .22); border-top-color: var(--amber);
    animation: rot .8s linear infinite;
  }
  @keyframes rot { to { transform: rotate(360deg); } }

  /* ── 子会话详情（W16-C：移入「子会话」标签视图，全尺寸并排对比） ── */
  #subpanels {
    display: flex; flex: 1; flex-direction: column; min-width: 0;
    background: rgba(10, 14, 19, .55);
  }
  .subpanels-head {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    border-bottom: 1px solid var(--line); flex: none;
  }
  .subpanels-head .label { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-3); }
  .subpanels-head .badge {
    font-family: var(--mono); font-size: 10.5px; color: var(--amber-2);
    background: rgba(226, 179, 94, .14); border-radius: 999px; padding: 0 7px;
  }
  .subpanels-head .hint { font-size: 11px; color: var(--text-3); margin-left: auto; }
  #subPanelsRow { display: flex; flex: 1; min-height: 0; overflow-x: auto; }
  .subpanel {
    display: flex; flex-direction: column; width: 400px; min-width: 330px; min-height: 0;
    border-right: 1px solid var(--line); animation: slidein .2s ease-out;
  }
  @keyframes slidein { from { opacity: .3; transform: translateX(14px); } to { opacity: 1; transform: none; } }
  .subpanel.flash { animation: flashpanel .9s ease-out; }
  @keyframes flashpanel { 0% { background: rgba(226, 179, 94, .1); } 100% { background: transparent; } }
  .sp-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); flex: none; min-width: 0; }
  .sp-who { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
  .sp-type { font-size: 12.5px; color: var(--text); }
  .sp-id { font-family: var(--mono); font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-mode {
    flex: none; font-size: 10px; letter-spacing: .06em; color: var(--amber-2);
    border: 1px solid rgba(226, 179, 94, .4); border-radius: 999px; padding: 1px 7px;
    cursor: help;
  }
  .sp-dot { width: 6px; height: 6px; border-radius: 50%; background: #37424f; flex: none; }
  .sp-dot.beating { background: var(--amber); animation: pulse 1.2s ease-out infinite; }
  .sp-time { margin-left: auto; font-family: var(--mono); font-size: 10.5px; color: var(--text-3); flex: none; }
  .sp-body { flex: 1; overflow-y: auto; min-height: 0; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .sp-list { display: flex; flex-direction: column; gap: 10px; }
  .sp-empty { color: var(--text-3); font-size: 12px; line-height: 1.8; border: 1px dashed var(--line-2); border-radius: 8px; padding: 10px 12px; }
  .sub-msg { display: flex; flex-direction: column; animation: rise .18s ease-out; }
  .sub-msg.sub-user { align-items: flex-end; }
  .sub-bubble {
    max-width: 92%; white-space: pre-wrap; word-break: break-word; font-size: 12.5px;
    background: #17202b; border: 1px solid var(--line-2); border-radius: 10px 10px 2px 10px; padding: 7px 10px;
  }
  .sub-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .sub-mid { font-family: var(--mono); font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub-meta { margin-left: auto; font-family: var(--mono); font-size: 10.5px; color: var(--text-3); flex: none; }
  .sub-text { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.7; color: #dbe6f2; }
  .sub-tool { border: 1px solid var(--line); border-radius: 8px; background: var(--bg-1); overflow: hidden; margin-top: 6px; }
  .sub-tool > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 7px; padding: 6px 9px; }
  .sub-tool > summary::-webkit-details-marker { display: none; }
  .sub-tool .ic { color: var(--text-3); display: inline-flex; }
  .sub-tool .ic svg { width: 13px; height: 13px; }
  .sub-tool-name { font-family: var(--mono); font-size: 12px; color: var(--text-2); }
  .sub-tool-body { padding: 8px 9px 9px; display: grid; gap: 8px; border-top: 1px solid var(--line); }
  .sub-pre { font-size: 11.5px; max-height: 180px; }
  .sp-hidden { display: none; }
  .sp-foot {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid var(--line);
    font-family: var(--mono); font-size: 10.5px; color: var(--text-3); flex: none;
  }
  .sp-err { color: #f2a3a3; margin-left: auto; }

  /* ── 子会话登记列表（W16-C：左列；session.children 帧 + task 卡反解合流） ── */
  #childRail .rail-head { display: flex; align-items: center; gap: 7px; padding: 10px 10px 8px; flex: none; }
  #childRail .rail-head .label { flex: 1; font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-3); padding-left: 4px; }
  #childRail .rail-head .badge {
    font-family: var(--mono); font-size: 10.5px; color: var(--amber-2);
    background: rgba(226, 179, 94, .14); border-radius: 999px; padding: 0 7px;
  }
  #childList { flex: 1; overflow-y: auto; padding: 2px 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .child-card {
    display: flex; align-items: center; gap: 9px; padding: 9px 10px;
    border: 1px solid var(--line); border-radius: 9px; background: var(--bg-1);
    cursor: pointer; transition: border-color .15s ease, background .15s ease;
  }
  .child-card:hover { border-color: var(--line-2); background: var(--bg-2); }
  .child-card.open { border-color: rgba(226, 179, 94, .45); background: rgba(226, 179, 94, .06); }
  .child-card.fresh { animation: freshcard 1.4s ease-out; }
  @keyframes freshcard { 0% { box-shadow: 0 0 0 2px rgba(226, 179, 94, .5); } 100% { box-shadow: none; } }
  .child-dot { width: 8px; height: 8px; border-radius: 50%; background: #4c5a6b; flex: none; }
  .child-dot.ok { background: var(--green); }
  .child-dot.err { background: var(--red); }
  .child-dot.warn { background: var(--amber); }
  .child-dot.off { background: #6b7889; }
  .child-main { min-width: 0; flex: 1; }
  .child-name { font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .child-id { font-family: var(--mono); font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .child-badge { flex: none; font-size: 10px; font-family: var(--mono); color: var(--text-3); }
  .rail-empty { padding: 12px 14px; font-size: 12px; color: var(--text-3); line-height: 1.9; }
  .rail-empty .ic { color: #33404f; display: block; margin-bottom: 6px; }
  .rail-empty .ic svg { width: 26px; height: 26px; }
  .rail-empty .mono { font-family: var(--mono); font-size: 11px; color: var(--text-2); }
  .rail-foot {
    border-top: 1px solid var(--line); padding: 9px 14px;
    font-size: 11px; color: var(--text-3); line-height: 1.7;
  }

  /* ── 聊天视图顶部：todo 计划条（todo.updated 帧整表重绘；无 todo 时隐藏） ── */
  #todoPanel { border-bottom: 1px solid var(--line); padding: 2px 0 8px; flex: none; max-height: 30vh; overflow-y: auto; background: rgba(13, 18, 24, .45); }
  .todo-head { display: flex; align-items: center; gap: 7px; padding: 6px 18px 2px; }
  .todo-head .label { flex: 1; font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-3); padding-left: 4px; }
  .todo-head .badge { font-family: var(--mono); font-size: 10.5px; color: var(--green); background: rgba(95, 202, 140, .13); border-radius: 999px; padding: 0 7px; }
  .todo-list { list-style: none; margin: 0; padding: 0 16px; display: flex; flex-direction: column; gap: 3px; }
  .todo-item { display: flex; align-items: baseline; gap: 7px; padding: 3px 6px; border-radius: 7px; font-size: 12px; }
  .todo-item:hover { background: var(--bg-2); }
  .todo-ic { display: inline-flex; flex: none; align-self: center; width: 13px; }
  .todo-ic svg { width: 13px; height: 13px; }
  .todo-text { min-width: 0; flex: 1; word-break: break-word; color: var(--text); }
  .todo-pr { flex: none; font-family: var(--mono); font-size: 10px; border-radius: 5px; padding: 0 5px; align-self: center; }
  .todo-pr.p-high { color: #f2a3a3; background: rgba(239, 112, 112, .14); }
  .todo-pr.p-medium { color: var(--blue); background: rgba(124, 184, 239, .13); }
  .todo-pr.p-low { color: var(--text-3); background: rgba(103, 120, 140, .16); }
  /* 状态色（与工具卡同系）：pending 灰 / in_progress 琥珀 / completed 绿+打勾划线 */
  .todo-item.st-pending .todo-ic { color: #6b7889; }
  .todo-item.st-pending .todo-text { color: var(--text-2); }
  .todo-item.st-progress .todo-ic { color: var(--amber); }
  .todo-item.st-progress .todo-text { color: var(--amber-2); }
  .todo-item.st-done .todo-ic { color: var(--green); }
  .todo-item.st-done .todo-text { color: var(--text-3); text-decoration: line-through; }

  /* ══ W16-C 上下文视图（/context/full 新契约：用量条 + 分段树 + 原始字节抽屉） ══ */
  #contextPanel { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .ctx-head { display: flex; align-items: center; gap: 7px; padding: 10px 18px 6px; flex: none; }
  .ctx-head .label { flex: 1; font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-3); padding-left: 4px; }
  .ctx-head .badge { font-family: var(--mono); font-size: 10.5px; color: var(--blue); background: rgba(124, 184, 239, .13); border-radius: 999px; padding: 0 7px; }
  /* W24 真相芯片：basis/wire.source 纯文本直出（cache 档走琥珀色底，与「重启残影」语义同系） */
  .ctx-truth { flex: none; font-family: var(--mono); font-size: 10.5px; color: var(--text-2); border: 1px solid var(--line-2); border-radius: 999px; padding: 1px 8px; }
  .ctx-truth.cache { color: var(--amber-2); border-color: rgba(226, 179, 94, .45); background: rgba(226, 179, 94, .08); }
  .ctx-scroll { flex: 1; overflow-y: auto; min-height: 0; }
  .ctx-wrap { max-width: 1000px; margin: 0 auto; padding: 12px 24px 48px; display: flex; flex-direction: column; gap: 14px; }
  .ctx-total { padding: 0; }
  .ctx-bar { height: 6px; border-radius: 999px; background: #10161d; border: 1px solid var(--line); overflow: hidden; }
  .ctx-bar span { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--blue), var(--amber)); transition: width .3s ease; }
  .ctx-meta { margin-top: 6px; font-family: var(--mono); font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx-submeta { margin-top: 3px; font-family: var(--mono); font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx-notice {
    border: 1px solid rgba(226, 179, 94, .35); background: rgba(226, 179, 94, .07);
    color: var(--amber-2); border-radius: 8px; padding: 8px 12px; font-size: 12px; line-height: 1.7;
  }
  /* ══ W17-F 上下文增量时间线（context.notice 帧环形留档：时刻·动作徽章·路径·字节） ══ */
  .ctx-timeline { display: flex; flex-direction: column; gap: 4px; }
  .ctx-tl-row {
    display: flex; align-items: baseline; gap: 8px; cursor: pointer;
    border: 1px solid var(--line); border-radius: 8px; background: var(--bg-1);
    padding: 6px 10px; font-family: var(--mono); font-size: 11px;
  }
  .ctx-tl-row:hover { border-color: var(--line-2); background: var(--bg-2); }
  .ctx-tl-time { flex: none; color: var(--blue); }
  .ctx-tl-path { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx-tl-bytes { margin-left: auto; flex: none; color: var(--text-3); }
  .ctx-tree { display: flex; flex-direction: column; gap: 10px; }
  .ctx-group { border: 1px solid var(--line); border-radius: 10px; background: var(--bg-1); overflow: hidden; }
  .ctx-group-head {
    display: flex; align-items: center; gap: 7px; padding: 7px 11px;
    font-size: 10.5px; letter-spacing: .12em; color: var(--text-2); text-transform: uppercase;
    border-bottom: 1px solid var(--line); background: #0d1218;
  }
  .ctx-group-head .n { margin-left: auto; font-family: var(--mono); color: var(--text-3); }
  .ctx-textline { padding: 5px 11px; font-family: var(--mono); font-size: 11px; color: var(--text-2); border-top: 1px solid rgba(27, 35, 45, .6); }
  .ctx-textline:first-of-type { border-top: 0; }
  .ctx-raw { border: 1px solid var(--line-2); border-radius: 10px; background: #0b0f14; overflow: hidden; }
  .ctx-raw > summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; gap: 9px;
    padding: 9px 12px; user-select: none;
  }
  .ctx-raw > summary::-webkit-details-marker { display: none; }
  .ctx-raw > summary .ic { display: inline-flex; color: var(--blue); }
  .ctx-raw > summary .ic svg { width: 15px; height: 15px; }
  .ctx-raw-title { font-size: 12.5px; color: var(--text); }
  .ctx-raw-hint { margin-left: auto; font-family: var(--mono); font-size: 10.5px; color: var(--text-3); }
  .ctx-raw-body { border-top: 1px solid var(--line); max-height: 62vh; overflow-y: auto; padding: 6px 0 10px; }
  .ctx-raw-body pre {
    margin: 0 12px; font-family: var(--mono); font-size: 11.5px; line-height: 1.6; color: #c6d2de;
    background: var(--bg-3); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px;
    white-space: pre-wrap; word-break: break-word; overflow: auto;
  }
  .ctx-empty { padding: 10px 24px; font-size: 12px; color: var(--text-3); line-height: 1.8; }
  /* ══ W18 上下文纯文本面：板块一「完整上下文（按发送顺序）」+ 模块分块（用户判词：读文本，不要结构展览） ══ */
  .ctx-zone-head {
    display: flex; align-items: center; gap: 8px; margin-top: 8px;
    border-top: 1px dashed var(--line); padding-top: 14px;
  }
  .ctx-zone-head .label { flex: 1; font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-3); }
  .ctx-zone-head .badge { font-family: var(--mono); font-size: 10.5px; color: var(--blue); background: rgba(124, 184, 239, .13); border-radius: 999px; padding: 0 7px; }
  .ctx-plain-note { font-family: var(--mono); font-size: 10.5px; color: var(--text-3); }
  .ctx-plain {
    margin: 0; padding: 14px 16px; max-height: calc(100vh - 300px); overflow: auto;
    font-family: var(--mono); font-size: 11.5px; line-height: 1.65; color: #c6d2de;
    background: #0b0f14; border: 1px solid var(--line-2); border-radius: 10px;
    white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4;
  }
  .ctx-mods { display: flex; flex-direction: column; gap: 10px; }
  .ctx-mod { border: 1px solid var(--line); border-radius: 10px; background: var(--bg-1); overflow: hidden; }
  .ctx-mod > summary {
    list-style: none; cursor: pointer; padding: 8px 12px; font-size: 12px; color: var(--text); user-select: none;
  }
  .ctx-mod > summary::-webkit-details-marker { display: none; }
  .ctx-mod-body { border-top: 1px dashed var(--line); }
  .ctx-mod-body pre {
    margin: 0; padding: 10px 14px; max-height: 44vh; overflow: auto;
    font-family: var(--mono); font-size: 11px; line-height: 1.6; color: #c6d2de;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .ctx-raw > summary .mini { margin-left: 6px; }

  /* ── 输入区 ── */
  #composer-bar { border-top: 1px solid var(--line); padding: 12px 28px 10px; background: rgba(9, 12, 16, .9); }
  .composer-wrap { max-width: 860px; margin: 0 auto; display: flex; align-items: flex-end; gap: 10px; }
  #composer {
    flex: 1; resize: none; min-height: 44px; max-height: 200px;
    background: var(--bg-3); color: var(--text);
    border: 1px solid var(--line-2); border-radius: var(--radius);
    padding: 11px 13px; font: inherit; line-height: 1.55; outline: none;
  }
  #composer:focus { border-color: rgba(226, 179, 94, .55); }
  #composer::placeholder { color: var(--text-3); }
  .composer-actions { display: flex; gap: 8px; }
  .composer-hint { max-width: 860px; margin: 7px auto 0; font-size: 11px; color: var(--text-3); font-family: var(--mono); }

  .btn {
    display: inline-flex; align-items: center; gap: 7px;
    border: 1px solid var(--line-2); background: transparent; color: var(--text);
    border-radius: 8px; padding: 9px 14px; font: inherit; font-size: 13px;
    cursor: pointer; transition: background .15s, border-color .15s, transform .05s;
  }
  .btn .ic { display: inline-flex; }
  .btn .ic svg { width: 15px; height: 15px; }
  .btn:hover { background: rgba(255, 255, 255, .04); border-color: #3a4757; }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: .4; cursor: default; transform: none; }
  .btn:disabled:hover { background: transparent; border-color: var(--line-2); }
  .btn.primary { background: var(--amber); border-color: var(--amber); color: var(--amber-ink); font-weight: 600; }
  .btn.primary:hover { background: #ecc272; }
  .btn.primary:disabled:hover { background: var(--amber); }

  /* 投递通知 toast（delivery.notify）：右下角悬浮——避开右栏/子面板头部控件 */
  #toasts { position: fixed; bottom: 96px; right: 18px; z-index: 120; display: flex; flex-direction: column-reverse; gap: 8px; max-width: 360px; }
  .toast {
    display: flex; align-items: flex-start; gap: 9px;
    background: #10161d; border: 1px solid var(--line-2); border-left: 3px solid var(--blue);
    border-radius: 9px; padding: 9px 11px; box-shadow: 0 14px 40px -22px rgba(0, 0, 0, .9);
    animation: slidein .2s ease-out;
  }
  .toast.tone-success { border-left-color: var(--green); }
  .toast.tone-warning { border-left-color: var(--amber); }
  .toast.tone-error { border-left-color: var(--red); }
  .toast .ic { color: var(--blue); display: inline-flex; margin-top: 2px; flex: none; }
  .toast.tone-success .ic { color: var(--green); }
  .toast.tone-warning .ic { color: var(--amber); }
  .toast.tone-error .ic { color: var(--red); }
  .toast .ic svg { width: 14px; height: 14px; }
  .toast .toast-main { min-width: 0; flex: 1; }
  .toast .toast-title { font-size: 12.5px; color: var(--text); }
  .toast .toast-msg { font-size: 11.5px; color: var(--text-2); word-break: break-word; margin-top: 1px; }
  .toast .icon-mini { width: 20px; height: 20px; flex: none; }

  /* ══ W16-C markdown 渲染（自研解析器产出的块/行内结构样式） ══ */
  .md { white-space: normal; word-break: break-word; line-height: 1.72; color: #e2ecf8; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3, .md h4 { margin: 14px 0 6px; line-height: 1.35; color: #eef4fb; }
  .md h1 { font-size: 19px; }
  .md h2 { font-size: 17px; }
  .md h3 { font-size: 15px; }
  .md h4 { font-size: 13.5px; color: var(--text-2); }
  .md p { margin: 6px 0; }
  .md ul, .md ol { margin: 6px 0; padding-left: 22px; }
  .md li { margin: 2px 0; }
  .md li > ul, .md li > ol { margin: 3px 0; }
  .md blockquote {
    margin: 8px 0; padding: 3px 12px; border-left: 2px solid var(--line-2);
    color: var(--text-2); background: rgba(13, 18, 24, .5); border-radius: 0 8px 8px 0;
  }
  .md code {
    font-family: var(--mono); font-size: 12px; background: #10161d; border: 1px solid var(--line);
    border-radius: 4px; padding: 1px 5px; color: #d7e4f2;
  }
  .md table { border-collapse: collapse; margin: 8px 0; font-size: 12.5px; display: block; max-width: 100%; overflow-x: auto; }
  .md th, .md td { border: 1px solid var(--line-2); padding: 4px 9px; text-align: left; vertical-align: top; }
  .md th { background: #10161d; color: var(--text-2); }
  .md a { color: var(--blue); text-decoration: none; border-bottom: 1px solid rgba(124, 184, 239, .4); }
  .md a:hover { color: #a8cdec; }
  .md hr { border: 0; border-top: 1px solid var(--line-2); margin: 12px 0; }
  .md pre {
    margin: 0; font-family: var(--mono); font-size: 12px; line-height: 1.55; color: #c6d2de;
    background: var(--bg-3); padding: 9px 11px; overflow: auto; max-height: 420px;
    white-space: pre-wrap; word-break: break-word;
  }
  .md-code { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin: 8px 0; background: var(--bg-3); }
  .md-code-head { display: flex; align-items: center; gap: 8px; padding: 3px 6px 3px 10px; border-bottom: 1px solid var(--line); background: #0d1218; }
  .md-lang { font-family: var(--mono); font-size: 10.5px; color: var(--text-3); letter-spacing: .05em; text-transform: uppercase; }
  .md-copy {
    margin-left: auto; border: 1px solid var(--line-2); background: transparent; color: var(--text-2);
    border-radius: 6px; font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer;
  }
  .md-copy:hover { color: var(--text); border-color: #3a4757; background: rgba(255, 255, 255, .04); }
  .part-text.md { white-space: normal; }
  .sub-text.md { margin-top: 2px; }

  /* ══ W16-C 任务/运行视图（GET /tasks、/runs；cancel 两段确认） ══ */
  .tk-scroll { flex: 1; overflow-y: auto; min-height: 0; }
  .tk-wrap { max-width: 1040px; margin: 0 auto; padding: 14px 24px 48px; display: flex; flex-direction: column; gap: 14px; }
  .tk-bar { display: flex; align-items: center; gap: 10px; }
  .tk-bar .label { font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-3); }
  .tk-bar .badge { font-family: var(--mono); font-size: 10.5px; color: var(--amber-2); background: rgba(226, 179, 94, .14); border-radius: 999px; padding: 0 7px; }
  .tk-bar .tk-hint { margin-left: auto; font-size: 11px; color: var(--text-3); }
  .tk-list { display: flex; flex-direction: column; gap: 8px; }
  .tk-empty { border: 1px dashed var(--line-2); border-radius: 10px; padding: 14px 16px; color: var(--text-3); font-size: 12.5px; line-height: 1.8; }
  .tk-card {
    border: 1px solid var(--line); border-left: 3px solid var(--line-2); border-radius: 10px;
    background: var(--bg-1); overflow: hidden; animation: rise .18s ease-out;
  }
  .tk-card[data-tone="running"] { border-left-color: var(--amber); }
  .tk-card[data-tone="completed"] { border-left-color: var(--green); }
  .tk-card[data-tone="error"] { border-left-color: var(--red); }
  .tk-card[data-tone="warn"] { border-left-color: #e09a4e; }
  .tk-card[data-tone="aborted"] { border-left-color: #7a8798; }
  .tk-card.fresh { animation: freshcard 1.4s ease-out; }
  .tk-head { display: flex; align-items: center; gap: 9px; padding: 9px 12px; cursor: pointer; min-width: 0; }
  .tk-id { font-family: var(--mono); font-size: 12.5px; color: var(--text); }
  .tk-agent { flex: none; font-size: 10.5px; color: var(--blue); border: 1px solid rgba(124, 184, 239, .3); border-radius: 999px; padding: 0 7px; }
  .tk-sub { min-width: 0; flex: 1; font-size: 11.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tk-time { flex: none; font-family: var(--mono); font-size: 10.5px; color: var(--text-3); }
  .tk-actions { display: flex; align-items: center; gap: 6px; flex: none; }
  .tk-actions button.danger { color: #f2a3a3; border-color: rgba(239, 112, 112, .45); }
  .tk-body { border-top: 1px solid var(--line); padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
  .tk-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 4px 14px; }
  .tk-field { display: flex; gap: 7px; font-size: 11.5px; min-width: 0; }
  .tk-field .k { flex: none; color: var(--text-3); font-family: var(--mono); font-size: 10.5px; padding-top: 1px; }
  .tk-field .v { font-family: var(--mono); color: var(--text-2); overflow-wrap: anywhere; }
  .tk-field .v.warn { color: #e8b48a; }
  .tk-field .v.err { color: #f2a3a3; }
  .tk-badge {
    flex: none; font-size: 10.5px; letter-spacing: .06em;
    border: 1px solid var(--line-2); border-radius: 999px; padding: 1px 8px; color: var(--text-2);
  }
  .tk-badge.tone-pending { color: var(--text-3); }
  .tk-badge.tone-running { color: var(--amber-2); border-color: rgba(226, 179, 94, .45); background: rgba(226, 179, 94, .08); }
  .tk-badge.tone-completed { color: #9be3b9; border-color: rgba(95, 202, 140, .4); background: rgba(95, 202, 140, .07); }
  .tk-badge.tone-error { color: #f2a3a3; border-color: rgba(239, 112, 112, .45); background: rgba(239, 112, 112, .08); }
  .tk-badge.tone-warn { color: #e8b48a; border-color: rgba(224, 154, 78, .45); background: rgba(224, 154, 78, .08); }
  .tk-badge.tone-aborted { color: var(--text-2); }
  /* W24 来源标芯片：内存在飞=实线琥珀 / 账本历史=虚线灰（一眼分真源，不靠颜色猜） */
  .tk-src { flex: none; font-size: 10px; letter-spacing: .04em; color: var(--text-3); border: 1px dashed var(--line-2); border-radius: 999px; padding: 0 7px; }
  .tk-src.live { color: var(--amber-2); border: 1px solid rgba(226, 179, 94, .4); background: rgba(226, 179, 94, .06); }
  .tk-truth { font-family: var(--mono); font-size: 10.5px; color: var(--text-3); }
  .tk-detail { display: flex; flex-direction: column; gap: 8px; }
  .tk-detail pre {
    margin: 0; font-family: var(--mono); font-size: 11px; line-height: 1.55; color: #c6d2de;
    background: var(--bg-3); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px;
    max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  }
  .tk-detail .block-label { margin-top: 2px; }
  .tk-runs { border: 1px solid var(--line); border-radius: 10px; background: var(--bg-1); overflow: hidden; }
  .tk-runs > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 9px 12px; user-select: none; }
  .tk-runs > summary::-webkit-details-marker { display: none; }
  .tk-runs > summary .ic { display: inline-flex; color: var(--slate); }
  .tk-runs > summary .ic svg { width: 14px; height: 14px; }
  .tk-run-list { border-top: 1px solid var(--line); display: flex; flex-direction: column; }
  .tk-run-row {
    display: flex; align-items: baseline; gap: 10px; padding: 6px 12px;
    border-top: 1px solid rgba(27, 35, 45, .55); font-family: var(--mono); font-size: 11.5px; min-width: 0;
  }
  .tk-run-row:first-child { border-top: 0; }
  .tk-run-id { color: var(--text-2); }
  .tk-run-wf { color: var(--blue); }
  .tk-run-status { margin-left: auto; color: var(--text-3); }

  /* ══ W16-C 事件视图（SSE 帧滚动缓冲；类型/时刻/会话归属） ══ */
  .ev-toolbar { display: flex; align-items: center; gap: 12px; padding: 8px 18px; border-bottom: 1px solid var(--line); flex: none; }
  .ev-toolbar .label { font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-3); }
  .ev-toolbar .badge { font-family: var(--mono); font-size: 10.5px; color: var(--amber-2); background: rgba(226, 179, 94, .14); border-radius: 999px; padding: 0 7px; }
  .ev-toolbar .badge.warn { color: #f2a3a3; background: rgba(239, 112, 112, .14); }
  .ev-toolbar .spacer { flex: 1; }
  .ev-filter { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-2); user-select: none; cursor: pointer; }
  .ev-scroll { flex: 1; overflow-y: auto; min-height: 0; }
  .ev-frame { border-bottom: 1px solid rgba(27, 35, 45, .5); animation: rise .12s ease-out; }
  .ev-frame > summary {
    list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 10px;
    padding: 5px 18px; font-family: var(--mono); font-size: 11.5px; min-width: 0;
  }
  .ev-frame > summary::-webkit-details-marker { display: none; }
  .ev-frame:hover { background: rgba(255, 255, 255, .02); }
  .ev-frame.unknown > summary { color: #e8b48a; }
  .ev-type { flex: none; color: var(--blue); }
  .ev-frame.unknown .ev-type { color: var(--amber); }
  .ev-at { flex: none; color: var(--text-3); }
  .ev-seq { flex: none; color: var(--text-3); }
  .ev-session { flex: none; color: var(--slate); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
  .ev-brief { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .ev-json {
    margin: 0; padding: 8px 20px 12px; font-family: var(--mono); font-size: 11px; line-height: 1.6;
    color: #c6d2de; background: #0b0f14; white-space: pre-wrap; word-break: break-word;
    border-top: 1px dashed var(--line);
  }
  .ev-empty { padding: 18px 20px; color: var(--text-3); font-size: 12.5px; line-height: 1.8; }

  /* 聊天视图：composer 只在聊天标签下出现（其它视图是全尺寸观读面） */
  #composer-bar { display: none; }
  #main.view-chat #composer-bar { display: block; }

  @media (max-width: 1360px) {
    .subpanel { width: 350px; min-width: 300px; }
    #viewChildren > #childRail { width: 236px; }
  }
  @media (max-width: 1180px) {
    #app { grid-template-columns: 244px minmax(0, 1fr); }
    #subPanelsRow { flex-direction: column; overflow-x: hidden; overflow-y: auto; }
    .subpanel { width: 100%; min-width: 0; flex: 0 0 auto; min-height: 280px; border-right: 0; border-bottom: 1px solid var(--line); }
    #viewChildren > #childRail { width: 220px; }
  }
  @media (max-width: 900px) {
    #app { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
    #sidebar { border-right: 0; border-bottom: 1px solid var(--line); max-height: 36vh; }
    .side-foot { display: none; }
    #sessionList { display: flex; flex-wrap: wrap; gap: 4px; }
    .session-item { flex: 0 1 auto; }
    #messages { padding: 16px 14px 8px; }
    .pending-bubble { max-width: 92%; }
    .compaction-divider { height: 26px; margin: 6px 0; gap: 8px; }
    .compaction-label { font-size: 11.5px; }
    .compaction-stack { padding-bottom: 6px; }
    #composer-bar { padding: 10px 14px 8px; }
    #topbar { flex-wrap: wrap; row-gap: 8px; }
    .tb-left { flex: 1 1 100%; }
    .tb-right { flex: 1 1 100%; flex-wrap: wrap; justify-content: space-between; gap: 10px; }
    .health { flex: 1; }
    .tok-state { order: 2; }
    .token-box { flex: 1 1 100%; order: 3; min-width: 0; }
    .token-box input { width: 100%; min-width: 0; flex: 1; }
    #toasts { right: 10px; left: 10px; bottom: 128px; max-width: none; }
    #tabbar { padding: 0 8px; }
    #viewChildren.active { flex-direction: column; }
    #viewChildren > #childRail { width: auto; max-height: 34vh; border-right: 0; border-bottom: 1px solid var(--line); }
    .ctx-wrap, .tk-wrap { padding: 12px 14px 40px; }
    .ev-frame > summary { padding: 5px 12px; }
    .ev-session { max-width: 110px; }
  }
  @media (max-width: 640px) {
    .subpanels-head .hint { display: none; }
    .sp-head { flex-wrap: wrap; row-gap: 4px; }
    .sp-time { display: none; }
    .sp-mode { margin-left: auto; }
    .sp-head .icon-mini { margin-left: auto; }
    .tab { padding: 10px 9px 8px; font-size: 12.5px; }
    .tk-head { flex-wrap: wrap; row-gap: 4px; }
    .ev-brief { display: none; }
  }
</style>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <div class="brand">
      <span class="ic" id="brandIcon"></span>
      <div>
        <div class="name">loom</div>
        <div class="sub">harness</div>
      </div>
    </div>
    <div class="side-pad">
      <button id="newSession" class="btn primary" type="button">
        <span class="ic" id="newSessionIcon"></span>
        <span>新建会话</span>
      </button>
    </div>
    <div class="side-head">
      <span class="side-label">会话</span>
      <button id="archivedToggle" class="mini" type="button" aria-pressed="false" title="切换归档会话列表（默认隐藏归档；切换后 GET /sessions?archived=1 只列归档）">归档</button>
      <button id="refreshSessions" class="icon-mini" type="button" title="刷新会话列表" aria-label="刷新会话列表">
        <span class="ic" id="refreshIcon"></span>
      </button>
    </div>
    <ul id="sessionList"></ul>
    <div class="side-foot" id="sideFoot">127.0.0.1:5100</div>
  </aside>

  <main id="main">
    <header id="topbar">
      <div class="tb-left">
        <div id="activeTitle" class="tb-title none">未选择会话</div>
        <div id="sessionStatus" class="pill"><span id="statusDot" class="dot"></span><span id="statusText">idle</span></div>
        <div id="streamState" class="stream"><span id="streamDot" class="stream-dot"></span><span id="streamText">流：未连接</span></div>
      </div>
      <div class="tb-right">
        <button id="childJump" type="button" title="跳到子会话标签" aria-label="跳到子会话标签">
          <span class="ic" id="childJumpIcon"></span>
          <span>子会话</span>
          <span class="badge" id="childCount"></span>
        </button>
        <div class="health"><span id="healthDot" class="dot"></span><span id="healthText">未连接</span></div>
        <div class="token-box">
          <span class="ic" id="tokenIcon"></span>
          <input id="tokenInput" type="password" placeholder="X-Loom-Token" autocomplete="off" spellcheck="false" aria-label="loom 访问令牌">
          <button id="tokenSave" class="mini" type="button">保存</button>
          <button id="tokenClear" class="mini" type="button">清除</button>
        </div>
        <span id="tokenState" class="tok-state">未保存</span>
      </div>
    </header>

    <div id="statusBar"></div>

    <div id="stage">
      <nav id="tabbar" role="tablist" aria-label="面板视图">
        <button id="tabChat" class="tab active" type="button" role="tab" aria-selected="true" data-view="chat">
          <span class="ic" id="tabChatIcon"></span><span>聊天</span>
        </button>
        <button id="tabContext" class="tab" type="button" role="tab" aria-selected="false" data-view="context">
          <span class="ic" id="tabContextIcon"></span><span>上下文</span>
        </button>
        <button id="tabChildren" class="tab" type="button" role="tab" aria-selected="false" data-view="children">
          <span class="ic" id="tabChildrenIcon"></span><span>子会话</span><span class="tab-badge" id="tabChildrenBadge" style="display:none"></span>
        </button>
        <button id="tabTasks" class="tab" type="button" role="tab" aria-selected="false" data-view="tasks">
          <span class="ic" id="tabTasksIcon"></span><span>任务</span><span class="tab-badge" id="tabTasksBadge" style="display:none"></span>
        </button>
        <button id="tabEvents" class="tab" type="button" role="tab" aria-selected="false" data-view="events">
          <span class="ic" id="tabEventsIcon"></span><span>事件</span><span class="tab-badge warn" id="tabEventsBadge" style="display:none"></span>
        </button>
      </nav>

      <div id="views">
        <section id="viewChat" class="view active" role="tabpanel" aria-label="聊天">
          <section id="todoPanel" class="todo-panel" aria-label="Todo 计划" hidden>
            <div class="todo-head">
              <span class="label">Todo</span>
              <span class="badge" id="todoCount"></span>
            </div>
            <ol id="todoList" class="todo-list"></ol>
          </section>
          <div id="messages" role="log" aria-live="polite">
            <div id="emptyState" class="empty">
              <span class="ic" id="emptyIcon"></span>
              <div class="empty-title">本地 loom 控制台</div>
              <div class="empty-sub">
                右上角填入 <code>X-Loom-Token</code>（仅存本标签页 sessionStorage，不外发）<br>
                然后「新建会话」或从左侧选择会话；顶部标签切换 聊天 / 上下文 / 子会话 / 任务 / 事件<br>
                主会话调用 task 工具后，子会话出现在「子会话」标签（历史转录 2s 轮询）
              </div>
            </div>
            <div id="thread"></div>
            <div id="pending-area"></div>
          </div>
        </section>

        <section id="viewContext" class="view" role="tabpanel" aria-label="上下文">
          <section id="contextPanel" class="ctx-panel" aria-label="上下文构成">
            <div class="ctx-head">
              <span class="label">上下文 · 模型实际收到的完整字节</span>
              <span class="ctx-truth" id="ctxTruth" hidden></span>
              <span class="badge" id="ctxBadge" style="display:none"></span>
              <button id="ctxCopyAll" class="mini" type="button" style="display:none">复制全文</button>
              <button id="ctxRefresh" class="icon-mini" type="button" title="刷新上下文快照" aria-label="刷新上下文快照">
                <span class="ic" id="ctxRefreshIcon"></span>
              </button>
            </div>
            <div class="ctx-scroll">
              <div class="ctx-wrap">
                <div class="ctx-total">
                  <div class="ctx-bar" title="估算 token / 模型上下文窗口（字节/3.5 粗估）"><span id="ctxBarFill"></span></div>
                  <div class="ctx-meta" id="ctxMeta">未选择会话</div>
                  <div class="ctx-submeta" id="ctxSourceNote" hidden></div>
                  <div class="ctx-submeta" id="ctxSubMeta"></div>
                </div>
                <div class="ctx-notice" id="ctxNotice" hidden></div>
                <div class="ctx-zone-head" id="ctxTimelineHead" hidden>
                  <span class="label">上下文增量 · 水位检出（最新在前 · 环形 ≤100 · 帧不含正文）</span>
                  <span class="badge" id="ctxTimelineBadge" style="display:none"></span>
                </div>
                <div class="ctx-timeline" id="ctxNoticeTimeline" hidden></div>
                <div class="ctx-zone-head">
                  <span class="label">完整上下文 · 按发送顺序（系统提示词 → 工具定义 → 对话消息全文）</span>
                </div>
                <div class="ctx-plain-note" id="ctxPlainNote" hidden></div>
                <pre class="ctx-plain" id="ctxPlain" tabindex="0" aria-label="完整上下文纯文本（按发送顺序）" hidden></pre>
                <div class="ctx-empty" id="ctxEmpty">发送一轮消息后，这里按发送顺序显示模型实际收到的完整上下文纯文本：系统提示词（含技能目录尾段）、工具定义、逐条消息（含思考/正文/工具调用与工具结果全文）。一个字都不能少。</div>
                <div class="ctx-notice" id="ctxV1Compat" hidden></div>
                <div id="ctxTree" class="ctx-tree" hidden></div>
                <div class="ctx-mods" aria-label="上下文模块">
                  <details class="ctx-mod" id="ctxModSystem" hidden>
                    <summary>系统段 · v1 装配 system 段全文</summary>
                    <div class="ctx-mod-body"><pre id="ctxModSystemBody"></pre></div>
                  </details>
                  <details class="ctx-mod" id="ctxModMemory" hidden>
                    <summary>记忆 · v1 memory 段按文件小节（### memory[i] 拆分 · 字节/bootHash/降级关联引用清单）</summary>
                    <div class="ctx-mod-body"><pre id="ctxModMemoryBody"></pre></div>
                  </details>
                  <details class="ctx-mod" id="ctxModWorkflow" hidden>
                    <summary>工作流 · v1 workflow 段全文</summary>
                    <div class="ctx-mod-body"><pre id="ctxModWorkflowBody"></pre></div>
                  </details>
                  <details class="ctx-mod" id="ctxModParams" hidden>
                    <summary>参数 · 发线请求参数（服务端已脱敏 · JSON 美化）</summary>
                    <div class="ctx-mod-body"><pre id="ctxModParamsBody"></pre></div>
                  </details>
                  <details class="ctx-raw" id="ctxPayload" hidden>
                    <summary>
                      <span class="ic" id="ctxPayloadIcon"></span>
                      <span class="ctx-raw-title">provider 请求载荷（序列化原文 · 逐字节全文）</span>
                      <span class="ctx-raw-hint" id="ctxPayloadHint"></span>
                      <button class="mini" id="ctxPayloadCopy" type="button">复制全文</button>
                    </summary>
                    <div class="ctx-raw-body" id="ctxPayloadBody"></div>
                  </details>
                  <div class="ctx-notice" id="ctxPayloadAbsent" hidden></div>
                  <details class="ctx-mod" id="ctxModManifest" hidden>
                    <summary>引用清单 · memory/skill/mcp/角色/运行 · 纯文本行</summary>
                    <div class="ctx-mod-body"><pre id="ctxModManifestBody"></pre></div>
                  </details>
                </div>
              </div>
            </div>
          </section>
        </section>

        <section id="viewChildren" class="view" role="tabpanel" aria-label="子会话">
          <aside id="childRail" aria-label="子会话登记">
            <div class="rail-head">
              <span class="label">子会话登记</span>
              <span class="badge" id="childCountRail"></span>
              <button id="childrenRefresh" class="icon-mini" type="button" title="重绘子会话列表" aria-label="重绘子会话列表">
                <span class="ic" id="childrenRefreshIcon"></span>
              </button>
            </div>
            <div id="childList"></div>
            <div class="rail-empty" id="railEmpty">
              <span class="ic" id="railEmptyIcon"></span>
              暂无子会话。主会话调用 task 工具、或收到 <span class="mono">session.children</span> 帧后，子会话会登记在这里；点击卡片展开详情。
            </div>
            <div class="rail-foot">来源：session.children 帧 + task 工具卡 &lt;task_metadata&gt; 反解<br>子会话无事件流，详情读 GET /sessions/&lt;sid&gt;/history</div>
          </aside>
          <section id="subpanels" aria-label="子会话详情">
            <div class="subpanels-head">
              <span class="label">子会话详情</span>
              <span class="badge" id="subPanelCount"></span>
              <span class="hint">2s 轮询 history · 可同时展开对比</span>
              <button id="subCollapseAll" class="mini" type="button">全部收起</button>
            </div>
            <div id="subPanelsRow"></div>
          </section>
        </section>

        <section id="viewTasks" class="view" role="tabpanel" aria-label="任务">
          <div class="tk-scroll">
            <div class="tk-wrap">
              <div class="tk-bar">
                <span class="label">后台任务</span>
                <span class="badge" id="taskCount"></span>
                <span class="tk-hint">GET /tasks · 3s 轮询（仅本标签可见时）</span>
                <button id="taskRefresh" class="icon-mini" type="button" title="刷新任务列表" aria-label="刷新任务列表">
                  <span class="ic" id="taskRefreshIcon"></span>
                </button>
              </div>
              <div id="taskNotice" class="tk-empty" hidden></div>
              <div id="taskList" class="tk-list"></div>
              <details id="runBox" class="tk-runs">
                <summary>
                  <span class="ic" id="runIcon"></span>
                  <span>运行记录（只读）</span>
                  <span class="badge" id="runCount"></span>
                  <span class="tk-hint" style="margin-left:auto">GET /runs · 本页不发 POST /runs</span>
                </summary>
                <div id="runList" class="tk-run-list"></div>
              </details>
            </div>
          </div>
        </section>

        <section id="viewEvents" class="view" role="tabpanel" aria-label="事件">
          <div class="ev-toolbar">
            <span class="label">SSE 帧</span>
            <span class="badge" id="eventCount"></span>
            <span class="badge warn" id="eventUnknown" style="display:none"></span>
            <span class="spacer"></span>
            <label class="ev-filter"><input type="checkbox" id="eventHideDelta" checked> 隐藏流式增量帧</label>
            <button id="eventClear" class="mini" type="button">清空缓冲</button>
          </div>
          <div class="ev-scroll" id="eventScroll">
            <div id="eventList"></div>
            <div class="ev-empty" id="eventEmpty">等待事件帧。订阅会话后，所有 SSE 帧（含未知类型）都会在此滚动留档；点行展开原始 JSON。</div>
          </div>
        </section>
      </div>
    </div>

    <footer id="composer-bar">
      <div class="composer-wrap">
        <textarea id="composer" rows="1" placeholder="给 loom 主会话发消息…"></textarea>
        <div class="composer-actions">
          <button id="abortBtn" class="btn" type="button" disabled>
            <span class="ic" id="abortIcon"></span>
            <span>停止</span>
          </button>
          <button id="sendBtn" class="btn primary" type="button">
            <span class="ic" id="sendIcon"></span>
            <span>发送</span>
          </button>
        </div>
      </div>
      <div class="composer-hint">Enter 发送 · Shift+Enter 换行 · token 只进 sessionStorage · 子会话详情走 2s 轮询（子会话无事件 hub）</div>
    </footer>
  </main>
</div>
<div id="toasts"></div>

<script>
${HARNESS_UI_LOGIC_JS}
</script>
<script>
(function () {
  'use strict';

  var TOKEN_KEY = 'loom-harness-token';
  var SUB_POLL_MS = 2000;          // 子会话详情轮询周期（决策：子会话无 hub，history 落盘增量读）
  var HEARTBEAT_STALE_MS = 30000;  // 心跳停滞判定（后端 10s 一跳，3 跳缺席才亮黄）
  var TASK_POLL_MS = 3000;         // 任务面轮询周期（GET /tasks + /runs；仅任务标签可见时发请求）
  var EVENT_CAP = 400;             // 事件缓冲上限（滚动留档；超出丢最旧）
  var SESSION_LIST_CAP = 50;       // W24 会话列表首渲染片（「加载更多」递增；面板对长列表不卡）
  var TASK_LIST_CAP = 50;          // W24 任务列表首渲染片（账本历史随时光累积，必须切片）

  var ICONS = {
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    xcircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    ring: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/></svg>',
    slash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/></svg>',
    message: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 9.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59"/><path d="m6.08 14.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
    zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>'
  };

  // 唯一 innerHTML 赋值点：只写内置 SVG 常量（动态数据一律 textContent，XSS 纪律）
  function setIcon(node, name) { node.innerHTML = ICONS[name] || ''; }

  var state = {
    token: '',
    sessions: [],
    activeId: null,
    busy: false,
    streamCtl: null,
    streamOpen: false,
    streamWasOpened: false, // 已成功开过流：下一次 subscribe 是重连，需先按 store 重建转录
    reconnectTimer: null,
    reconnectDelay: 1500,
    fallbackMsg: 0,
    epoch: 0,
    lastLabel: null,
    msgs: {},
    parts: {},
    compactionCards: {},   // W54：压缩事件 key → DOM 卡（历史多条压缩各自成卡）
    compactionKeys: [],    // 当前渲染顺序的卡 key（idle 差分、防重复插入）
    compactionStack: null, // 页首「更早的压缩摘要」容器（仅 top 事件在场时存在）
    statusTimer: null,
    connectedNoted: false,
    lastBeatAt: 0,
    childrenByParent: {},
    panels: {},
    openPanels: [],
    lastFileRow: null,
    unknownEvents: 0,
    atBottom: true,
    pending: [],      // 待发消息队列/侧车快照（GET /pending 或 session.queue；不写进 #thread 转录）
    pendingKeys: [],  // 上帧 pending 的多重键（at|text），用于识别「消失即已落盘」并对齐 history
    todos: [],  // 当前订阅会话的 todo 表（todo.updated 整表替换；会话切换即清空——todo 无历史面，如实缺席）
    view: 'chat',          // 活动标签视图（chat/context/children/tasks/events）
    contextFull: null,     // 最近一次 /context/full 响应（复制全文/重建抽屉的原料）
    ctxNotices: [],        // W17-F context.notice 时间线环形（≤100 新在前；会话切换清空）
    tasks: [],             // GET /tasks 列表（3s 轮询差分合并）
    tasksFresh: {},        // task_id → 本帧闪示（added/updated 的行）
    taskDetail: {},        // task_id → 已取回的详情（点开缓存；刷新手回收）
    taskOpen: {},          // task_id → 详情展开态（3s 重绘不折叠用户已开的面板）
    runs: [],              // GET /runs 列表（只读最小面）
    events: [],            // SSE 帧滚动缓冲（新在前；EVENT_CAP 封顶）
    eventsTimer: null,     // 事件列表重绘节流计时器（高频 delta 下合并渲染）
    eventHideDelta: true,  // 事件视图默认折叠 message.part.delta 噪音
    showArchived: false,   // W24 侧栏「归档」切换：false=GET /sessions（服务端默认排除归档）；true=?archived=1 只列归档
    sessionsShown: SESSION_LIST_CAP, // W24 会话列表渲染片（归档切换时复位到上限）
    tasksShown: TASK_LIST_CAP,       // W24 任务列表渲染片（「加载更多」递增）
    taskTranscript: {},    // task_id → 已取回的 context/full JSON（惰性：仅点「转录」才发请求；账本历史同样只取一次）
    taskTranscriptOpen: {} // task_id → 转录展开态（3s 重绘保态，与 taskOpen 同纪律）
  };

  function $(id) { return document.getElementById(id); }

  var els = {
    app: $('app'),
    main: $('main'),
    sessionList: $('sessionList'),
    newSession: $('newSession'),
    refreshSessions: $('refreshSessions'),
    archivedToggle: $('archivedToggle'),
    sideFoot: $('sideFoot'),
    healthDot: $('healthDot'),
    healthText: $('healthText'),
    activeTitle: $('activeTitle'),
    sessionStatus: $('sessionStatus'),
    statusDot: $('statusDot'),
    statusText: $('statusText'),
    streamState: $('streamState'),
    streamDot: $('streamDot'),
    streamText: $('streamText'),
    childJump: $('childJump'),
    childrenRefresh: $('childrenRefresh'),
    childCount: $('childCount'),
    childCountRail: $('childCountRail'),
    childList: $('childList'),
    railEmpty: $('railEmpty'),
    todoPanel: $('todoPanel'),
    todoList: $('todoList'),
    todoCount: $('todoCount'),
    contextPanel: $('contextPanel'),
    ctxBadge: $('ctxBadge'),
    ctxTruth: $('ctxTruth'),
    ctxRefresh: $('ctxRefresh'),
    ctxTree: $('ctxTree'),
    ctxEmpty: $('ctxEmpty'),
    ctxMeta: $('ctxMeta'),
    ctxSourceNote: $('ctxSourceNote'),
    ctxSubMeta: $('ctxSubMeta'),
    ctxBarFill: $('ctxBarFill'),
    ctxPlain: $('ctxPlain'),
    ctxPlainNote: $('ctxPlainNote'),
    ctxNotice: $('ctxNotice'),
    ctxCopyAll: $('ctxCopyAll'),
    ctxV1Compat: $('ctxV1Compat'),
    ctxModSystem: $('ctxModSystem'),
    ctxModSystemBody: $('ctxModSystemBody'),
    ctxModMemory: $('ctxModMemory'),
    ctxModMemoryBody: $('ctxModMemoryBody'),
    ctxModWorkflow: $('ctxModWorkflow'),
    ctxModWorkflowBody: $('ctxModWorkflowBody'),
    ctxModParams: $('ctxModParams'),
    ctxModParamsBody: $('ctxModParamsBody'),
    ctxPayload: $('ctxPayload'),
    ctxPayloadHint: $('ctxPayloadHint'),
    ctxPayloadBody: $('ctxPayloadBody'),
    ctxPayloadCopy: $('ctxPayloadCopy'),
    ctxPayloadAbsent: $('ctxPayloadAbsent'),
    ctxModManifest: $('ctxModManifest'),
    ctxModManifestBody: $('ctxModManifestBody'),
    ctxTimelineHead: $('ctxTimelineHead'),
    ctxTimelineBadge: $('ctxTimelineBadge'),
    ctxNoticeTimeline: $('ctxNoticeTimeline'),
    statusBar: $('statusBar'),
    tokenInput: $('tokenInput'),
    tokenSave: $('tokenSave'),
    tokenClear: $('tokenClear'),
    tokenState: $('tokenState'),
    messages: $('messages'),
    thread: $('thread'),
    pendingArea: $('pending-area'),
    emptyState: $('emptyState'),
    composer: $('composer'),
    sendBtn: $('sendBtn'),
    abortBtn: $('abortBtn'),
    stage: $('stage'),
    subPanelCount: $('subPanelCount'),
    subPanelsRow: $('subPanelsRow'),
    subCollapseAll: $('subCollapseAll'),
    taskCount: $('taskCount'),
    taskList: $('taskList'),
    taskNotice: $('taskNotice'),
    taskRefresh: $('taskRefresh'),
    runBox: $('runBox'),
    runCount: $('runCount'),
    runList: $('runList'),
    eventList: $('eventList'),
    eventCount: $('eventCount'),
    eventUnknown: $('eventUnknown'),
    eventClear: $('eventClear'),
    eventHideDelta: $('eventHideDelta'),
    eventEmpty: $('eventEmpty'),
    eventScroll: $('eventScroll'),
    tabChildrenBadge: $('tabChildrenBadge'),
    tabTasksBadge: $('tabTasksBadge'),
    tabEventsBadge: $('tabEventsBadge'),
    tabs: {
      chat: $('tabChat'),
      context: $('tabContext'),
      children: $('tabChildren'),
      tasks: $('tabTasks'),
      events: $('tabEvents')
    },
    views: {
      chat: $('viewChat'),
      context: $('viewContext'),
      children: $('viewChildren'),
      tasks: $('viewTasks'),
      events: $('viewEvents')
    },
    toasts: $('toasts')
  };

  // ── DOM 小工具 ──

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function textEl(tag, cls, text) {
    var node = el(tag, cls);
    node.textContent = text;
    return node;
  }

  function iconEl(name, cls) {
    var node = el('span', cls || 'ic');
    setIcon(node, name);
    return node;
  }

  function buttonEl(cls, iconName, label) {
    var btn = el('button', cls);
    btn.type = 'button';
    if (iconName) btn.appendChild(iconEl(iconName, 'ic'));
    if (label !== null && label !== undefined) btn.appendChild(textEl('span', null, label));
    return btn;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function clockText(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function baseName(p) {
    var s = String(p);
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function dirName(p) {
    var s = String(p);
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : '';
  }

  function nearBottom(node, slack) {
    return node.scrollHeight - node.scrollTop - node.clientHeight <= (slack || 40);
  }

  // ── 视图切换（W16-C：五标签共用 #stage；切走即停该视图的定时活动） ──

  var VIEW_NAMES = ['chat', 'context', 'children', 'tasks', 'events'];

  function setView(name) {
    var n = VIEW_NAMES.indexOf(name) >= 0 ? name : 'chat';
    state.view = n;
    for (var i = 0; i < VIEW_NAMES.length; i++) {
      var key = VIEW_NAMES[i];
      var on = key === n;
      if (els.tabs[key]) {
        els.tabs[key].className = 'tab' + (on ? ' active' : '');
        els.tabs[key].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      if (els.views[key]) els.views[key].className = 'view' + (on ? ' active' : '');
    }
    els.main.className = 'view-' + n;
    if (n === 'context') loadContext();
    else if (n === 'tasks') { loadTasks(); loadRuns(); }
    else if (n === 'events') renderEvents();
    else if (n === 'children') { renderChildList(); kickChildrenPoll(); }
    else autoScroll();
  }

  function updateTabBadges() {
    var bucket = subBucketRead();
    var n = bucket.order.length;
    els.tabChildrenBadge.textContent = n ? String(n) : '';
    els.tabChildrenBadge.style.display = n ? '' : 'none';
    var active = 0;
    for (var i = 0; i < state.tasks.length; i++) {
      if (!taskIsTerminal(state.tasks[i].status)) active += 1;
    }
    els.tabTasksBadge.textContent = active ? String(active) : '';
    els.tabTasksBadge.style.display = active ? '' : 'none';
    els.tabEventsBadge.textContent = state.unknownEvents > 0 ? String(state.unknownEvents) : '';
    els.tabEventsBadge.style.display = state.unknownEvents > 0 ? '' : 'none';
  }

  // ── markdown 渲染入口（单一文本绘制路径：实时流/history 回放/子转录同走这里） ──
  // 构造只经 loomMarkdownRender（createElement/createTextNode），全程无 innerHTML。

  function copyPlainText(text, btn) {
    if (!btn.dataset.label0) btn.dataset.label0 = btn.textContent;
    var restore = function () {
      setTimeout(function () { btn.textContent = btn.dataset.label0; }, 1500);
    };
    var value = typeof text === 'string' ? text : '';
    if (navigator.clipboard && navigator.clipboard.writeText && value) {
      navigator.clipboard.writeText(value).then(function () {
        btn.textContent = '已复制';
        restore();
      }, function () {
        legacyCopyText(value, btn);
        restore();
      });
      return;
    }
    legacyCopyText(value, btn);
    restore();
  }

  function renderMarkdownInto(node, text) {
    node.replaceChildren(loomMarkdownRender(document, typeof text === 'string' ? text : ''));
    if (node.dataset.mdWired !== '1') {
      node.dataset.mdWired = '1';
      node.addEventListener('click', function (ev) {
        var target = ev.target;
        var btn = target && target.closest ? target.closest('.md-copy') : null;
        if (!btn || !node.contains(btn)) return;
        var wrap = btn.closest ? btn.closest('.md-code') : null;
        var pre = wrap ? wrap.querySelector('pre') : null;
        if (!pre) return;
        copyPlainText(pre.textContent || '', btn);
      });
    }
  }

  // ── 基础工具 ──

  function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (err) { return ''; }
  }

  function writeToken(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (err) { /* 隐私模式下 sessionStorage 可能不可写：内存态仍可用 */ }
  }

  function request(path, opts) {
    opts = opts || {};
    var headers = {};
    if (state.token) headers['X-Loom-Token'] = state.token;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      signal: opts.signal
    });
  }

  function handle401() {
    setHealth('bad', '令牌无效');
    showStatus('error', '令牌无效或未设置（401）：请在右上角更新 X-Loom-Token', 0);
    paintTokenState();
  }

  function pretty(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (err) { return String(value); }
  }

  // ── 状态条 / 健康探针 / 徽标 ──

  function showStatus(kind, message, autoClearMs) {
    els.statusBar.className = 'status-bar show ' + kind;
    els.statusBar.textContent = message;
    if (state.statusTimer) { clearTimeout(state.statusTimer); state.statusTimer = null; }
    if (autoClearMs && autoClearMs > 0) state.statusTimer = setTimeout(hideStatus, autoClearMs);
  }

  function hideStatus() {
    els.statusBar.className = '';
    els.statusBar.textContent = '';
    if (state.statusTimer) { clearTimeout(state.statusTimer); state.statusTimer = null; }
  }

  function hideStatusIfBusy() {
    var cls = els.statusBar.className;
    if (cls.indexOf('busy') >= 0 || cls.indexOf('info') >= 0) hideStatus();
  }

  function setHealth(mode, message) {
    els.healthDot.className = 'dot' + (mode === 'ok' ? ' idle' : mode === 'bad' ? ' error' : '');
    els.healthText.textContent = message;
  }

  function probeHealth() {
    if (!state.token) { setHealth('idle', '未设置令牌'); return Promise.resolve(false); }
    return request('/health').then(function (res) {
      if (res.status === 401) { handle401(); return false; }
      if (!res.ok) { setHealth('bad', 'HTTP ' + res.status); return false; }
      return res.json().then(function (body) {
        setHealth('ok', 'loom ' + (body && body.version ? body.version : '') + ' 在线');
        return true;
      });
    }).catch(function () {
      setHealth('bad', '服务不可达');
      return false;
    });
  }

  function setSessionStatus(status) {
    var s = status || 'idle';
    state.busy = s === 'busy';
    els.statusDot.className = 'dot' + (s === 'busy' ? ' busy' : s === 'error' ? ' error' : ' idle');
    els.statusText.textContent = s;
    els.sessionStatus.className = 'pill' + (s === 'busy' ? ' busy' : s === 'error' ? ' error' : '');
    els.abortBtn.disabled = !(state.busy && state.activeId);
    paintSessionBadge();
  }

  // 侧栏活跃项徽标就地重绘：busy 帧与 idle 帧之间列表缓存可能旧，不等 loadSessions 回来
  function paintSessionBadge() {
    if (!state.activeId) return;
    var items = els.sessionList.querySelectorAll('.session-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.dataset.id !== state.activeId) continue;
      var shown = state.busy ? 'busy' : (item.dataset.status || 'idle');
      var dot = item.querySelector('.dot');
      if (dot) dot.className = 'dot' + (shown === 'busy' ? ' busy' : shown === 'error' ? ' error' : shown === 'idle' ? ' idle' : '');
      var badge = item.querySelector('.session-state');
      if (badge) badge.textContent = shown;
      return;
    }
  }

  function setStreamState(mode, label) {
    var text = label || '';
    if (!text) {
      if (mode === 'open') text = '流：已连接';
      else if (mode === 'connecting') text = '流：连接中';
      else if (mode === 'retry') text = '流：重连中';
      else if (mode === 'error') text = '流：断开';
      else if (mode === 'stall') text = '流：心跳停滞';
      else text = '流：未连接';
    }
    els.streamText.textContent = text;
    var dotCls = 'stream-dot';
    if (mode === 'open') dotCls += ' ok';
    else if (mode === 'connecting' || mode === 'retry') dotCls += ' busy';
    else if (mode === 'error') dotCls += ' err';
    else if (mode === 'stall') dotCls += ' warn';
    els.streamDot.className = dotCls;
    els.streamState.className = 'stream' + (mode === 'open' ? ' open' : mode === 'error' ? ' error' : '');
    state.streamOpen = mode === 'open' || mode === 'stall';
  }

  // 心跳只做连接指示灯：10s 帧超 30s 未到 → 亮黄「心跳停滞」，恢复即回绿
  function tickHeartbeat() {
    if (!state.streamOpen) return;
    if (state.lastBeatAt && Date.now() - state.lastBeatAt > HEARTBEAT_STALE_MS) setStreamState('stall');
    else setStreamState('open');
  }

  function paintTokenState() {
    if (state.token) {
      els.tokenState.textContent = '已保存（本标签页）';
      els.tokenState.className = 'tok-state ok';
    } else {
      els.tokenState.textContent = '未保存';
      els.tokenState.className = 'tok-state';
    }
  }

  function paintActiveHeader() {
    if (state.activeId) {
      els.activeTitle.textContent = state.activeId;
      els.activeTitle.className = 'tb-title';
    } else {
      els.activeTitle.textContent = '未选择会话';
      els.activeTitle.className = 'tb-title none';
    }
    els.abortBtn.disabled = !(state.busy && state.activeId);
  }

  function paintFooter() {
    // 未知事件计数已移居「事件」标签（#eventUnknown / tab 角标）；页脚只留主机标识
    els.sideFoot.textContent = location.host;
  }

  // ── 消息 DOM：创建 / 增量更新（textContent 注入，防 XSS） ──

  function hideEmpty() { els.emptyState.style.display = 'none'; }

  function showEmpty(title, sub) {
    els.emptyState.style.display = '';
    if (title) els.emptyState.querySelector('.empty-title').textContent = title;
    if (sub !== undefined) els.emptyState.querySelector('.empty-sub').textContent = sub;
  }

  function clearMessages() {
    els.thread.replaceChildren();
    state.msgs = {};
    state.parts = {};
    state.compactionCards = {};
    state.compactionKeys = [];
    state.compactionStack = null;
    state.epoch = 0;
    state.lastLabel = null;
    state.lastFileRow = null;
    state.atBottom = true;
    state.pending = [];
    state.pendingKeys = [];
    renderPending();
  }

  // 尾随滚动：在 DOM 变更前记录用户是否贴底（scroll 事件维护），变更后按记录强制贴底。
  // 若按变更后测量，工具卡展开一次涨 300px 会把「距底 <150」判否，导致跟随中断。
  function autoScroll() {
    if (!state.atBottom) return;
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function addUserMessage(text) {
    var wrap = el('div', 'msg msg-user');
    var bubble = el('div', 'bubble');
    bubble.textContent = text;
    wrap.appendChild(bubble);
    els.thread.appendChild(wrap);
    hideEmpty();
    autoScroll();
  }

  // 待发消息区（session.queue / GET /pending）：独立容器，绝不 append 到 #thread。
  function normalizePending(raw) {
    var items = [];
    if (!Array.isArray(raw)) return items;
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!item || typeof item !== 'object') continue;
      var text = typeof item.text === 'string' ? item.text : '';
      if (!text) continue;
      var queueState = item.state === 'running' || item.state === 'drained' ? item.state : 'queued';
      var at = typeof item.at === 'number' || typeof item.at === 'string' ? item.at : 0;
      items.push({ text: text, at: at, state: queueState });
    }
    return items;
  }

  function pendingKeysOf(items) {
    var keys = [];
    for (var i = 0; i < items.length; i++) keys.push(String(items[i].at) + '|' + items[i].text);
    return keys;
  }

  // 多重集比较：旧键在新快照里数量变少 = 该消息已离开队列（通常已落盘进 history）。
  function pendingLost(prevKeys, nextKeys) {
    if (!prevKeys.length) return false;
    var counts = {};
    for (var i = 0; i < nextKeys.length; i++) counts[nextKeys[i]] = (counts[nextKeys[i]] || 0) + 1;
    for (var j = 0; j < prevKeys.length; j++) {
      if (counts[prevKeys[j]]) counts[prevKeys[j]] -= 1;
      else return true;
    }
    return false;
  }

  function setPending(items) {
    state.pending = items;
    state.pendingKeys = pendingKeysOf(items);
  }

  function renderPending() {
    if (!els.pendingArea) return;
    els.pendingArea.replaceChildren();
    if (!state.pending.length) {
      els.pendingArea.hidden = true;
      return;
    }
    els.pendingArea.hidden = false;
    for (var i = 0; i < state.pending.length; i++) {
      var item = state.pending[i];
      var row = el('div', 'pending-row');
      row.dataset.state = item.state;
      row.appendChild(textEl('div', 'pending-bubble', item.text));
      row.appendChild(textEl('span', 'pending-badge', item.state === 'queued' ? '排队中' : '已发送'));
      els.pendingArea.appendChild(row);
    }
    autoScroll();
  }

  function fetchPending(sessionID) {
    if (!sessionID) return Promise.resolve([]);
    return request('/sessions/' + encodeURIComponent(sessionID) + '/pending').then(function (res) {
      if (!res.ok) return []; // 附属面静默：401/404/5xx 不弹错误条
      return res.json().then(function (body) {
        return normalizePending(body && body.pending);
      });
    }).catch(function () { return []; });
  }

  function loadPending(sessionID) {
    if (!sessionID) return Promise.resolve();
    var hadPending = state.pendingKeys.length > 0;
    return fetchPending(sessionID).then(function (items) {
      if (state.activeId !== sessionID) return;
      setPending(items);
      renderPending();
      // 队列事件丢失时的兜底：原有 pending 现已清空，补拉 history 把落盘消息搬进转录。
      if (hadPending && items.length === 0) loadHistory(sessionID);
    });
  }

  function addSystemLine(text) {
    var row = el('div', 'ev-row sys');
    var line = el('div', 'sys-line');
    line.textContent = text;
    row.appendChild(line);
    els.thread.appendChild(row);
    hideEmpty();
    autoScroll();
  }

  // ── 自动压缩分隔卡（W52）：GET /sessions/:id/compaction live 快照（旧服务端回退面） ──

  function fetchCompaction(sessionID) {
    if (!sessionID) return Promise.resolve(null);
    return request('/sessions/' + encodeURIComponent(sessionID) + '/compaction').then(function (res) {
      if (!res.ok) return null; // 401/404/5xx：附属面静默无卡，不弹错误条
      return res.json().then(function (body) {
        return loomCompactionCardView(body) ? body : null;
      });
    }).catch(function () { return null; });
  }

  // ── 自动压缩历史（W54）：GET /sessions/:id/compactions → 原始事件数组 ──
  // 404 = 旧服务端未布置该端点：回退 /compaction 的单条 active 快照（包成一条 auto 事件）；
  // 其它非 OK / 网络错误静默 []，绝不弹错误条打断转录。归一由消费端
  // loomCompactionEventList 统一做（raw → view），避免二次归一吞掉已转换的视图。
  function fetchCompactions(sessionID) {
    if (!sessionID) return Promise.resolve([]);
    return request('/sessions/' + encodeURIComponent(sessionID) + '/compactions').then(function (res) {
      if (res.status === 404) {
        return fetchCompaction(sessionID).then(function (snapshot) {
          if (!snapshot) return [];
          var anchorTs = typeof snapshot.anchorTimestampMs === 'number' && isFinite(snapshot.anchorTimestampMs)
            ? snapshot.anchorTimestampMs : null;
          return [{
            id: 'live:' + String(snapshot.anchorMessageId || snapshot.anchorTimestampMs || 'active'),
            kind: 'auto',
            coveredCount: snapshot.coveredCount,
            summaryText: snapshot.summaryText,
            anchorMessageId: snapshot.anchorMessageId === undefined ? null : snapshot.anchorMessageId,
            anchorTimestampMs: anchorTs,
            recordedAt: anchorTs === null ? 0 : anchorTs
          }];
        });
      }
      if (!res.ok) return [];
      return res.json().then(function (body) {
        return body && typeof body === 'object' && Array.isArray(body.events) ? body.events : [];
      }).catch(function () { return []; });
    }).catch(function () { return []; });
  }

  function paintCompactionCard(card, view) {
    card.setAttribute('data-compaction-id', view.id || '');
    var top = card.querySelector('[data-compaction-label="top"]');
    if (top) top.textContent = view.topLabel;
    var bottom = card.querySelector('[data-compaction-label="bottom"]');
    if (bottom) bottom.textContent = view.bottomLabel;
    var body = card.querySelector('.compaction-summary');
    if (body) {
      renderMarkdownInto(body, view.summary);
      body.style.display = view.summary.trim() ? '' : 'none';
    }
  }

  // opencode 同构：顶部「会话压缩已开始」分隔线 + 完整摘要 markdown + 底部「会话已压缩」分隔线。
  // 每事件一张卡（keyed）；同 key 已在场则就地重绘，绝不重复插入。
  function createCompactionCard(view) {
    var key = loomCompactionEventKey(view);
    var existing = key ? state.compactionCards[key] : null;
    if (existing && existing.parentNode) {
      paintCompactionCard(existing, view);
      return existing;
    }
    var card = el('div', 'compaction');
    card.setAttribute('data-component', 'session-compaction-message');
    card.setAttribute('data-compaction-id', view.id || '');
    var top = el('div', 'compaction-divider');
    top.appendChild(el('span', 'compaction-line'));
    var topLabel = textEl('span', 'compaction-label', view.topLabel);
    topLabel.setAttribute('data-compaction-label', 'top');
    top.appendChild(topLabel);
    top.appendChild(el('span', 'compaction-line'));
    var body = el('div', 'compaction-summary md');
    var bottom = el('div', 'compaction-divider');
    bottom.appendChild(el('span', 'compaction-line'));
    var bottomLabel = textEl('span', 'compaction-label', view.bottomLabel);
    bottomLabel.setAttribute('data-compaction-label', 'bottom');
    bottom.appendChild(bottomLabel);
    bottom.appendChild(el('span', 'compaction-line'));
    card.appendChild(top);
    card.appendChild(body);
    card.appendChild(bottom);
    paintCompactionCard(card, view);
    if (key) {
      state.compactionCards[key] = card;
      state.compactionKeys.push(key);
    }
    return card;
  }

  function removeCompactionCards() {
    if (state.compactionStack && state.compactionStack.parentNode) {
      state.compactionStack.parentNode.removeChild(state.compactionStack);
    }
    state.compactionStack = null;
    for (var i = 0; i < state.compactionKeys.length; i++) {
      var card = state.compactionCards[state.compactionKeys[i]];
      if (card && card.parentNode) card.parentNode.removeChild(card);
    }
    state.compactionCards = {};
    state.compactionKeys = [];
  }

  function compactionKeysOf(views) {
    var keys = [];
    for (var i = 0; i < views.length; i++) keys.push(loomCompactionEventKey(views[i]));
    return keys;
  }

  function sameCompactionKeys(keys) {
    if (keys.length !== state.compactionKeys.length) return false;
    var seen = {};
    for (var i = 0; i < state.compactionKeys.length; i++) seen[state.compactionKeys[i]] = true;
    for (var j = 0; j < keys.length; j++) {
      if (!seen[keys[j]]) return false;
    }
    return true;
  }

  // idle 差分：同 key 集合原地重绘（摘要全文可能已更新）；有新增/变更则整页重放
  // （loadHistory 内部 clearMessages 后按锚点重排，杜绝重复卡）；API 空列表才清卡。
  function refreshCompactions() {
    var sid = state.activeId;
    if (!sid) return Promise.resolve(null);
    return fetchCompactions(sid).then(function (raw) {
      if (state.activeId !== sid) return null;
      var list = loomCompactionEventList(raw);
      if (list.length === 0) {
        removeCompactionCards();
        return null;
      }
      var keys = compactionKeysOf(list);
      if (sameCompactionKeys(keys)) {
        var painted = true;
        for (var i = 0; i < list.length; i++) {
          var card = state.compactionCards[keys[i]];
          if (!card || !card.parentNode) { painted = false; break; }
          paintCompactionCard(card, list[i]);
        }
        if (painted) return list;
      }
      return loadHistory(sid);
    });
  }

  function iconForKind(kind) {
    if (kind === 'run') return 'activity';
    if (kind === 'warn') return 'alert';
    if (kind === 'child') return 'users';
    if (kind === 'notify') return 'bell';
    return 'circle';
  }

  function addEventRow(kind, text) {
    var row = el('div', 'ev-row ' + kind);
    row.appendChild(iconEl(iconForKind(kind), 'ic'));
    row.appendChild(textEl('span', 'ev-text', text));
    els.thread.appendChild(row);
    hideEmpty();
    autoScroll();
  }

  // file.edited：轻量文件行；连续同一文件合并计数（写/改工具会连发同路径）
  function addFileRow(path) {
    var full = String(path);
    if (state.lastFileRow && state.lastFileRow.path === full && state.lastFileRow.el.parentNode) {
      state.lastFileRow.count += 1;
      state.lastFileRow.countEl.textContent = '×' + state.lastFileRow.count;
      return;
    }
    var row = el('div', 'msg msg-file');
    row.title = full;
    row.appendChild(iconEl('file', 'ic file-ic'));
    row.appendChild(textEl('span', 'file-name', baseName(full)));
    row.appendChild(textEl('span', 'file-dir', dirName(full)));
    row.appendChild(textEl('span', 'file-tag', '已写入'));
    var cnt = textEl('span', 'file-count', '');
    cnt.style.display = 'none';
    row.appendChild(cnt);
    els.thread.appendChild(row);
    state.lastFileRow = { path: full, el: row, count: 1, countEl: cnt };
    hideEmpty();
    autoScroll();
  }

  // W32 后事实：后端 messageSeq 改会话级单调（每个 LLM call 的 live message_start
  // 推进），每条 assistant 消息的 msg_/part_ id 天然唯一，前端按 id 累积即正确。
  // 「run epoch」作用域键控降级为防御冗余保留（半路重连的订阅者可能错过
  // message_start tick、落进退化序号场景——epoch 隔离保证旧轮气泡不被污染）。
  function entryKey(id) { return 'e' + state.epoch + '/' + id; }

  function ensureAssistant(messageID) {
    var id = messageID && messageID.length ? messageID : 'msg_stream_' + (state.fallbackMsg++);
    var key = entryKey(id);
    var entry = state.msgs[key];
    if (entry) return entry;

    var wrap = el('div', 'msg msg-assistant');
    var head = el('div', 'msg-head');
    var who = textEl('span', 'who', 'loom');
    var mid = textEl('span', 'mid', id);
    // W32 后 id 唯一、此分支正常不触发；保留兜同帧面退化场景（半路订阅者）——连续同 id 只标第一处
    if (id === state.lastLabel) mid.style.display = 'none';
    else state.lastLabel = id;
    var meta = textEl('span', 'meta', '');
    head.appendChild(who); head.appendChild(mid); head.appendChild(meta);
    var body = el('div', 'msg-body');
    wrap.appendChild(head); wrap.appendChild(body);
    els.thread.appendChild(wrap);

    entry = { id: id, key: key, el: wrap, body: body, meta: meta };
    state.msgs[key] = entry;
    hideEmpty();
    autoScroll();
    return entry;
  }

  function ensurePartEntry(entry, partID) {
    var id = partID && partID.length ? partID : 'part_stream';
    var slot = state.parts[entry.key + '/' + id];
    if (slot) return slot;
    var node = el('div');
    slot = { el: node, model: null, ui: null, paintTimer: null };
    state.parts[entry.key + '/' + id] = slot;
    return slot;
  }

  // 助手正文 = markdown 单一绘制路径（history 回放/实时 delta/终态快照同走）。
  function paintTextPart(slot, part) {
    if (slot.paintTimer) { clearTimeout(slot.paintTimer); slot.paintTimer = null; }
    slot.el.className = 'part-text md' + (part.streaming ? ' streaming' : '');
    renderMarkdownInto(slot.el, part.text);
  }

  // 流式期间的渲染节流：高频 delta 下合并到 ~70ms 一帧（终态 upsert 会立刻冲刷）。
  function scheduleTextPaint(slot) {
    if (slot.paintTimer) return;
    slot.paintTimer = setTimeout(function () {
      slot.paintTimer = null;
      if (slot.model && slot.model.type === 'text') paintTextPart(slot, slot.model);
    }, 70);
  }

  function appendDelta(messageID, partID, delta) {
    var entry = ensureAssistant(messageID);
    var slot = ensurePartEntry(entry, partID);
    var part = slot.model;
    if (part && part.type === 'reasoning') {
      // 注册帧已定型的思考块：增量追加（终态定稿后迟到的增量丢弃）
      if (part.final) return;
      var merged = loomApplyReasoningDelta(part.text, delta, false);
      part.text = merged.text;
      part.streaming = true;
      paintReasoningPart(slot, part);
      setSessionStatus('busy');
      autoScroll();
      return;
    }
    if (!part) {
      part = { type: 'text', text: '', streaming: true, final: false };
      slot.model = part;
      entry.body.appendChild(slot.el);
    }
    if (part.type !== 'text' || part.final) return; // 终态快照已定稿：迟到的 delta 丢弃
    part.streaming = true;
    part.text += delta;
    scheduleTextPaint(slot);
    setSessionStatus('busy');
    autoScroll();
  }

  function upsertTextPart(entry, partID, text) {
    var slot = ensurePartEntry(entry, partID);
    var part = slot.model;
    if (!part) {
      part = { type: 'text', text: '', streaming: false, final: true };
      slot.model = part;
      entry.body.appendChild(slot.el);
    }
    part.text = typeof text === 'string' ? text : part.text;
    part.streaming = false;
    part.final = true;
    paintTextPart(slot, part);
    autoScroll();
  }

  // 思考块（W13 reasoning 流）：默认折叠；注册帧建块、增量帧追加、终态快照整段替换
  function ensureReasoningElements(slot) {
    if (slot.ui) return slot.ui;
    var card = el('details', 'reason');
    var head = el('summary', 'reason-head');
    head.appendChild(iconEl('activity', 'ic'));
    head.appendChild(textEl('span', 'reason-label', '思考'));
    var hint = textEl('span', 'reason-hint', '');
    head.appendChild(hint);
    var body = el('div', 'reason-body');
    card.appendChild(head); card.appendChild(body);
    slot.el = card;
    slot.ui = { card: card, hint: hint, body: body };
    return slot.ui;
  }

  function paintReasoningPart(slot, model) {
    var ui = ensureReasoningElements(slot);
    var st = loomReasoningState(model.streaming === true, model.text);
    ui.body.textContent = model.text;
    ui.body.className = 'reason-body' + (st.cursor ? ' streaming' : '');
    ui.hint.textContent = st.hint;
    ui.card.className = 'reason' + (st.streaming ? ' streaming' : '');
  }

  function upsertReasoningPart(entry, partID, text, final) {
    var slot = ensurePartEntry(entry, partID);
    var part = slot.model;
    if (part && part.final === true && final !== true) return; // 混用 epoch 的迟到注册：与正文 delta 同纪律丢弃
    if (part && part.type !== 'reasoning') {
      // 断流重连后先落了正文占位、终态快照才定型为思考块：换掉旧元素，不回填正文槽
      if (slot.el.parentNode) slot.el.parentNode.removeChild(slot.el);
      slot.model = null;
      slot.ui = null;
      slot.el = el('div');
      part = null;
    }
    if (!part) {
      part = { type: 'reasoning', text: '', streaming: final !== true, final: final === true };
      slot.model = part;
      ensureReasoningElements(slot); // 先成形 details 卡（slot.el 换成 card）再挂载，否则挂的是空 div
      entry.body.appendChild(slot.el);
    }
    var merged = loomApplyReasoningDelta(part.text, text, final === true);
    part.text = merged.text;
    part.streaming = final !== true;
    part.final = final === true;
    paintReasoningPart(slot, part);
    autoScroll();
  }

  // ── 工具卡（三态 + running 实时输出窗 + task 子会话链接） ──

  function renderStatusGlyph(node, status) {
    node.replaceChildren();
    if (status === 'running') {
      node.appendChild(el('span', 'spin'));
      return;
    }
    var name = status === 'completed' ? 'check'
      : status === 'error' ? 'xcircle'
      : status === 'aborted' ? 'slash'
      : 'ring';
    setIcon(node, name);
    var ic = node.querySelector('svg');
    if (ic) ic.setAttribute('class', status === 'completed' ? 'ok' : status === 'error' ? 'err' : status === 'aborted' ? 'tool' : 'warn');
  }

  function ensureToolElements(slot) {
    if (slot.ui) return slot.ui;
    var card = el('details', 'tool');
    card.dataset.status = 'pending';
    var summary = el('summary', 'tool-sum');
    var glyph = el('span', 'tool-glyph');
    var name = el('span', 'tool-name');
    var sub = el('span', 'tool-sub');
    sub.style.display = 'none';
    var badge = el('span', 'tool-badge tone-pending');
    var chev = iconEl('chev', 'chev');
    summary.appendChild(glyph); summary.appendChild(name); summary.appendChild(sub);
    summary.appendChild(badge); summary.appendChild(chev);

    var body = el('div', 'tool-body');
    var inputLabel = textEl('div', 'block-label', '输入');
    var inputPre = el('pre', 'tool-input');
    var out = el('div', 'tool-out');
    var outHead = el('div', 'tool-out-head');
    var live = el('span', 'live-dot');
    live.style.display = 'none';
    var outLabel = textEl('span', 'block-label out-label', '输出');
    var outMeta = textEl('span', 'tool-out-meta', '');
    outHead.appendChild(live); outHead.appendChild(outLabel); outHead.appendChild(outMeta);
    var outputPre = el('pre', 'tool-output');
    outputPre.dataset.empty = '1';
    out.appendChild(outHead); out.appendChild(outputPre);
    var children = el('div', 'tool-children');
    children.style.display = 'none';
    body.appendChild(inputLabel); body.appendChild(inputPre); body.appendChild(out); body.appendChild(children);
    card.appendChild(summary); card.appendChild(body);

    var ui = {
      card: card, glyph: glyph, name: name, sub: sub, badge: badge,
      inputLabel: inputLabel, inputPre: inputPre,
      out: out, live: live, outLabel: outLabel, outMeta: outMeta, outputPre: outputPre,
      outputText: '', follow: true, linked: {}, children: children
    };
    // running 期 tail 跟随；用户上滚则暂停跟随，回底自动恢复
    outputPre.addEventListener('scroll', function () { ui.follow = nearBottom(outputPre, 60); });
    slot.el = card;
    slot.ui = ui;
    return ui;
  }

  function applyToolOutput(ui, next) {
    var prevLen = ui.outputText.length;
    var merged = loomMergeToolOutput(ui.outputText, next);
    if (merged.mode === 'same') return;
    if (merged.mode === 'append') {
      ui.outputPre.appendChild(document.createTextNode(merged.text.slice(prevLen)));
    } else {
      ui.outputPre.textContent = merged.text;
    }
    ui.outputText = merged.text;
    ui.outputPre.dataset.empty = merged.text.length ? '0' : '1';
    ui.outMeta.textContent = merged.text.length
      ? (merged.text.length + ' 字符 · ' + merged.text.split('\n').length + ' 行')
      : '';
    if (ui.follow) ui.outputPre.scrollTop = ui.outputPre.scrollHeight;
  }

  // task 工具卡：输出（含 <task_metadata>）→ 登记子会话 + 卡内显式「打开子会话」按钮
  function maybeLinkTaskChildren(ui, model) {
    var text = typeof model.output === 'string' ? model.output : '';
    if (!text) return;
    var found = loomExtractTaskSessions(text);
    for (var i = 0; i < found.length; i++) {
      var child = found[i];
      registerChild({ id: child.sessionID, name: child.agentType, type: child.agentType, status: child.reason }, 'task');
      if (!ui.linked[child.sessionID]) {
        ui.linked[child.sessionID] = true;
        ui.children.style.display = '';
        var btn = el('button', 'tool-child-link');
        btn.type = 'button';
        btn.appendChild(iconEl('users', 'ic'));
        btn.appendChild(textEl('span', null, '打开子会话 ' + child.sessionID));
        (function (cid) {
          btn.addEventListener('click', function () { openChildPanel(cid); });
        })(child.sessionID);
        ui.children.appendChild(btn);
      }
    }
  }

  function paintToolPart(slot, model) {
    var ui = ensureToolElements(slot);
    var status = model.status || 'pending';
    var meta = loomToolStatusMeta(status);
    ui.card.dataset.status = meta.tone;
    // 首次进场即运行中的工具自动展开一次：running 实时输出窗默认可见（用户点名诉求），
    // 之后用户手动折叠/展开不再被覆盖
    if (status === 'running' && !ui.autoOpened) {
      ui.autoOpened = true;
      ui.card.open = true;
    }
    renderStatusGlyph(ui.glyph, status);
    ui.name.textContent = model.tool || 'unknown';
    var desc = '';
    if (model.tool === 'task' && model.input && typeof model.input === 'object' && typeof model.input.description === 'string') {
      desc = model.input.description;
    }
    if (desc) { ui.sub.textContent = desc; ui.sub.style.display = ''; }
    else { ui.sub.style.display = 'none'; }
    ui.badge.textContent = meta.label;
    ui.badge.className = 'tool-badge tone-' + meta.tone;

    var inputText = pretty(model.input);
    if (inputText) {
      ui.inputLabel.style.display = '';
      ui.inputPre.style.display = '';
      ui.inputPre.textContent = inputText;
    } else {
      ui.inputLabel.style.display = 'none';
      ui.inputPre.style.display = 'none';
    }

    var outputText = typeof model.output === 'string' ? model.output : '';
    var showOut = status === 'running' || outputText.length > 0;
    ui.out.style.display = showOut ? '' : 'none';
    ui.live.style.display = status === 'running' ? '' : 'none';
    ui.outLabel.textContent = status === 'running' ? '实时输出' : status === 'error' ? '错误输出' : '输出';
    ui.outLabel.className = 'block-label out-label' + (status === 'running' ? ' live' : '');
    if (showOut && !(status === 'running' && outputText.length === 0)) applyToolOutput(ui, outputText);
    if (status === 'running' && outputText.length === 0 && ui.outputText.length === 0) {
      ui.outputPre.dataset.empty = '1';
      ui.outMeta.textContent = '';
    }
    maybeLinkTaskChildren(ui, model);
    autoScroll();
  }

  function upsertToolPart(entry, partID, part) {
    var slot = ensurePartEntry(entry, partID);
    var model = slot.model;
    if (!model) {
      model = { type: 'tool', tool: '', status: 'pending', input: null, output: '' };
      slot.model = model;
      ensureToolElements(slot); // 先成形详情卡（slot.el 换成 card），再挂载
      entry.body.appendChild(slot.el);
    }
    model.tool = typeof part.tool === 'string' ? part.tool : model.tool;
    var st = part.state && typeof part.state === 'object' ? part.state : {};
    model.status = typeof st.status === 'string' ? st.status : model.status;
    if (st.input !== undefined) model.input = st.input;
    if (typeof st.output === 'string') model.output = st.output;
    paintToolPart(slot, model);
  }

  function paintInfo(entry, info) {
    if (!info) return;
    var bits = [];
    if (typeof info.model === 'string') bits.push(info.model);
    else if (typeof info.modelID === 'string') bits.push(info.modelID);
    if (typeof info.provider === 'string') bits.push(info.provider);
    if (info.tokens && typeof info.tokens.total === 'number') bits.push('tokens ' + info.tokens.total);
    if (info.stopReason) bits.push(String(info.stopReason));
    entry.meta.textContent = bits.join(' · ');
  }

  function attachInfo(messageID, info) {
    var msg = info && typeof info.message === 'object' && info.message !== null ? info.message : info;
    if (msg && typeof msg === 'object' && typeof msg.role === 'string' && msg.role !== 'assistant') return;
    var entry = ensureAssistant(messageID);
    paintInfo(entry, msg);
  }

  // ── 子智能体登记（session.children 帧 + task 卡反解，两路合流按 id 去重） ──

  function subBucket() {
    var parent = state.activeId || '_none';
    var bucket = state.childrenByParent[parent];
    if (!bucket) {
      bucket = { order: [], map: {} };
      state.childrenByParent[parent] = bucket;
    }
    return bucket;
  }

  function subBucketRead() {
    var parent = state.activeId || '_none';
    return state.childrenByParent[parent] || { order: [], map: {} };
  }

  function childTone(status) {
    var s = String(status || '');
    if (s === 'done' || s === 'completed') return 'ok';
    if (s === 'error' || s === 'failed') return 'err';
    if (s === 'aborted') return 'off';
    if (s === 'max_turns' || s === 'max_continuations' || s === 'partial') return 'warn';
    return 'neutral';
  }

  function registerChild(info, origin) {
    if (!info || typeof info.id !== 'string' || info.id.length === 0) return;
    if (!state.activeId) return; // 子会话帧只在主会话订阅里出现；无主会话无法归属
    var id = info.id.replace(/-/g, '_');
    if (!/^[a-zA-Z0-9_]+$/.test(id)) return;
    var bucket = subBucket();
    var item = bucket.map[id];
    var isNew = false;
    if (!item) {
      item = { id: id, name: '', type: '', status: '', origin: origin || '', fresh: true };
      bucket.map[id] = item;
      bucket.order.push(id);
      isNew = true;
    }
    if (typeof info.name === 'string' && info.name) item.name = info.name;
    if (typeof info.type === 'string' && info.type) item.type = info.type;
    if (typeof info.status === 'string' && info.status) item.status = info.status;
    if (origin) item.origin = origin;
    renderChildList();
    paintPanels();
    if (isNew) {
      addEventRow('child', '子会话已登记 · ' + id + (item.name ? '（' + item.name + '）' : ''));
      var target = item;
      setTimeout(function () {
        target.fresh = false;
        renderChildList();
      }, 1500);
    }
  }

  function renderChildList() {
    var bucket = subBucketRead();
    els.childList.replaceChildren();
    var count = bucket.order.length ? String(bucket.order.length) : '';
    els.childCount.textContent = count;
    els.childCount.style.display = count ? '' : 'none';
    els.childCountRail.textContent = count;
    els.railEmpty.style.display = bucket.order.length ? 'none' : '';
    updateTabBadges();
    for (var i = 0; i < bucket.order.length; i++) {
      (function (info) {
        var card = el('div', 'child-card'
          + (state.panels[info.id] ? ' open' : '')
          + (info.fresh ? ' fresh' : ''));
        card.dataset.id = info.id;
        card.tabIndex = 0;
        card.title = '点击展开只读转录（2s 轮询）';
        card.appendChild(el('span', 'child-dot ' + childTone(info.status)));
        var main = el('div', 'child-main');
        main.appendChild(textEl('div', 'child-name', info.name || info.type || '子会话'));
        main.appendChild(textEl('div', 'child-id', info.id));
        card.appendChild(main);
        var badge = textEl('span', 'child-badge', info.status || '');
        if (!info.status) badge.style.display = 'none';
        card.appendChild(badge);
        card.addEventListener('click', function () { toggleChildPanel(info.id); });
        card.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleChildPanel(info.id); }
        });
        els.childList.appendChild(card);
      })(bucket.map[bucket.order[i]]);
    }
  }

  // ── 子会话详情面板（分栏；多面板同时展开；2s 轮询 history 增量） ──

  function paintPanels() {
    var n = state.openPanels.length;
    els.subPanelCount.textContent = n > 0 ? String(n) : '';
  }

  // 回到子会话标签时对已开面板各补一次拉取（切走期间轮询暂停，回来立刻追平）。
  function kickChildrenPoll() {
    var ids = state.openPanels.slice();
    for (var i = 0; i < ids.length; i++) pollSub(ids[i]);
  }

  function toggleChildPanel(id) {
    if (state.panels[id]) closeChildPanel(id);
    else openChildPanel(id);
  }

  function openChildPanel(id) {
    // 从任务卡「打开子会话」进入也要落到子会话视图（进入本视图的另一路径是卡片点击）
    setView('children');
    var existing = state.panels[id];
    if (existing) {
      existing.el.classList.remove('flash');
      void existing.el.offsetWidth;
      existing.el.classList.add('flash');
      return;
    }
    var bucket = subBucketRead();
    var info = bucket.map[id] || { id: id, name: '', type: '', status: '' };
    var panel = {
      id: id,
      hist: { count: 0, last: '' },
      msgEls: [],
      toolSlots: {},
      toolSeq: 0,
      timer: null
    };

    var root = el('section', 'subpanel');
    root.dataset.child = id;
    var head = el('header', 'sp-head');
    var who = el('div', 'sp-who');
    who.appendChild(textEl('span', 'sp-type', info.name || info.type || '子会话'));
    who.appendChild(textEl('span', 'sp-id', id));
    var mode = textEl('span', 'sp-mode', '轮询模式');
    mode.title = '子会话没有事件 hub：本面板每 2 秒轮询 GET /sessions/'
      + id + '/history 增量渲染当前输出';
    var dot = el('span', 'sp-dot');
    var time = textEl('span', 'sp-time', '等待首次轮询');
    var close = buttonEl('icon-mini', 'x', null);
    close.title = '收起面板';
    close.setAttribute('aria-label', '收起面板');
    close.addEventListener('click', function () { closeChildPanel(id); });
    head.appendChild(who); head.appendChild(mode); head.appendChild(dot);
    head.appendChild(time); head.appendChild(close);

    var body = el('div', 'sp-body');
    var list = el('div', 'sp-list');
    var empty = el('div', 'sp-empty');
    empty.textContent = '尚未读到转录。子会话每 2s 轮询 GET /sessions/' + id + '/history，落盘内容会自动增量渲染。';
    body.appendChild(list); body.appendChild(empty);
    var foot = el('footer', 'sp-foot');
    foot.appendChild(textEl('span', null, '只读转录 · history 轮询'));
    var err = textEl('span', 'sp-err', '');
    foot.appendChild(err);

    root.appendChild(head); root.appendChild(body); root.appendChild(foot);
    els.subPanelsRow.appendChild(root);

    panel.el = root; panel.body = body; panel.list = list; panel.emptyEl = empty;
    panel.timeEl = time; panel.errEl = err; panel.dot = dot;
    state.panels[id] = panel;
    state.openPanels.push(id);
    paintPanels();
    renderChildList();
    pollSub(id);
    panel.timer = setInterval(function () { pollSub(id); }, SUB_POLL_MS);
  }

  function closeChildPanel(id) {
    var panel = state.panels[id];
    if (!panel) return;
    if (panel.timer) clearInterval(panel.timer);
    if (panel.el.parentNode) panel.el.parentNode.removeChild(panel.el);
    delete state.panels[id];
    var idx = state.openPanels.indexOf(id);
    if (idx >= 0) state.openPanels.splice(idx, 1);
    paintPanels();
    renderChildList();
  }

  function closeAllPanels() {
    var ids = state.openPanels.slice();
    for (var i = 0; i < ids.length; i++) closeChildPanel(ids[i]);
  }

  function pollSub(id) {
    var panel = state.panels[id];
    if (!panel) return;
    // 浏览器标签隐藏 / 面板所在视图切走 → 本轮跳过（省流；切回由 kickChildrenPoll 追平）
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    if (state.view !== 'children') return;
    panel.dot.className = 'sp-dot beating';
    request('/sessions/' + encodeURIComponent(id) + '/history?limit=200').then(function (res) {
      var current = state.panels[id];
      if (!current) return;
      if (res.status === 401) { handle401(); return; }
      if (!res.ok) {
        current.errEl.textContent = '历史读取失败 HTTP ' + res.status;
        return;
      }
      return res.json().then(function (body) {
        var live = state.panels[id];
        if (!live) return;
        current.errEl.textContent = '';
        var messages = body && Array.isArray(body.messages) ? body.messages : [];
        applySubHistory(id, messages);
      });
    }).catch(function () {
      var failed = state.panels[id];
      if (failed) failed.errEl.textContent = '服务不可达，2s 后重试';
    }).then(function () {
      var done = state.panels[id];
      if (done) done.dot.className = 'sp-dot';
    });
  }

  function truncateSubBody(panel, from) {
    for (var i = from; i < panel.msgEls.length; i++) {
      var old = panel.msgEls[i];
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    panel.msgEls.length = Math.min(panel.msgEls.length, from);
  }

  function appendSubMessage(panel, message, index) {
    var node = subMessageEl(panel, message, index);
    panel.msgEls[index] = node;
    panel.list.appendChild(node);
  }

  function applySubHistory(id, messages) {
    var panel = state.panels[id];
    if (!panel) return;
    var delta = loomHistoryDelta(panel.hist, messages);
    if (delta.idle) return;
    var wasNear = nearBottom(panel.body, 80);
    if (delta.reset) {
      truncateSubBody(panel, 0);
      panel.toolSlots = {};
      for (var i = 0; i < messages.length; i++) appendSubMessage(panel, messages[i], i);
    } else if (delta.replaceFrom >= 0) {
      truncateSubBody(panel, delta.replaceFrom);
      for (var j = delta.replaceFrom; j < messages.length; j++) appendSubMessage(panel, messages[j], j);
    } else {
      for (var k = delta.appendFrom; k < messages.length; k++) appendSubMessage(panel, messages[k], k);
    }
    panel.hist = {
      count: messages.length,
      last: messages.length > 0 ? loomMessageFingerprint(messages[messages.length - 1]) : ''
    };
    panel.timeEl.textContent = '更新 ' + clockText(Date.now());
    panel.emptyEl.style.display = messages.length > 0 ? 'none' : '';
    if (wasNear) panel.body.scrollTop = panel.body.scrollHeight;
  }

  function historyText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      var out = [];
      for (var i = 0; i < content.length; i++) {
        var c = content[i];
        if (c && c.type === 'text' && typeof c.text === 'string') out.push(c.text);
      }
      return out.join('\n');
    }
    return '';
  }

  function subToolRow(panel, call) {
    var card = el('details', 'sub-tool');
    card.open = true; // 子会话面板以「看结果」为目的：工具行默认展开，输出直接可见
    var sum = el('summary', 'sub-tool-sum');
    sum.appendChild(iconEl('terminal', 'ic'));
    sum.appendChild(textEl('span', 'sub-tool-name', String(call.name || 'tool')));
    var badge = textEl('span', 'tool-badge tone-pending', '已调用');
    sum.appendChild(badge);
    var body = el('div', 'sub-tool-body');
    body.appendChild(textEl('div', 'block-label', '输入'));
    var inPre = el('pre', 'sub-pre');
    inPre.textContent = pretty(call.arguments);
    body.appendChild(inPre);
    body.appendChild(textEl('div', 'block-label', '输出'));
    var outPre = el('pre', 'sub-pre');
    outPre.textContent = '等待结果…';
    body.appendChild(outPre);
    card.appendChild(sum); card.appendChild(body);
    var key = String(call.id || ('call_' + (panel.toolSeq++)));
    panel.toolSlots[key] = {
      pre: outPre,
      settle: function (status) {
        var meta = loomToolStatusMeta(status);
        badge.textContent = meta.label;
        badge.className = 'tool-badge tone-' + meta.tone;
        if (outPre.textContent === '等待结果…') outPre.textContent = '';
      }
    };
    return card;
  }

  function subMessageEl(panel, message, index) {
    var m = message;
    if (m && m.role === 'user') {
      var userWrap = el('div', 'sub-msg sub-user');
      var bubble = el('div', 'sub-bubble');
      bubble.textContent = historyText(m.content);
      userWrap.appendChild(bubble);
      return userWrap;
    }
    if (m && m.role === 'assistant') {
      var wrap = el('div', 'sub-msg sub-assistant');
      var head = el('div', 'sub-head');
      head.appendChild(textEl('span', 'sub-mid', m.id ? String(m.id) : 'assistant'));
      var bits = [];
      if (typeof m.model === 'string') bits.push(m.model);
      if (typeof m.stopReason === 'string') bits.push(m.stopReason);
      head.appendChild(textEl('span', 'sub-meta', bits.join(' · ')));
      wrap.appendChild(head);
      var content = Array.isArray(m.content) ? m.content : [];
      for (var j = 0; j < content.length; j++) {
        var block = content[j];
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          // 子转录的助手正文与主聊天同走 markdown 单一路径（用户气泡仍为纯文本）
          var text = el('div', 'sub-text md');
          renderMarkdownInto(text, String(block.text || ''));
          wrap.appendChild(text);
        } else if (block.type === 'thinking') {
          var reason = el('details', 'reason');
          var rhead = el('summary', 'reason-head');
          rhead.appendChild(iconEl('activity', 'ic'));
          rhead.appendChild(textEl('span', 'reason-label', '思考'));
          var rbody = el('div', 'reason-body');
          rbody.textContent = String(block.thinking || '');
          reason.appendChild(rhead); reason.appendChild(rbody);
          wrap.appendChild(reason);
        } else if (block.type === 'toolCall') {
          wrap.appendChild(subToolRow(panel, block));
        }
      }
      return wrap;
    }
    if (m && m.role === 'toolResult') {
      var resultText = historyText(m.content);
      var slot = m.toolCallId ? panel.toolSlots[String(m.toolCallId)] : null;
      if (slot) {
        slot.pre.textContent = resultText;
        slot.settle(m.isError ? 'error' : 'completed');
        return el('span', 'sp-hidden'); // 结果并入既有工具行：占位保持消息索引一一对应
      }
      var row = el('div', 'sub-msg sub-toolresult');
      var rhead2 = el('div', 'sub-head');
      rhead2.appendChild(textEl('span', 'sub-mid', '工具结果 · ' + String(m.toolName || 'tool')));
      row.appendChild(rhead2);
      var pre = el('pre', 'sub-pre');
      pre.textContent = resultText;
      row.appendChild(pre);
      return row;
    }
    return el('span', 'sp-hidden');
  }

  // ── toast（delivery.notify；变体 info/success/warning/error） ──

  function toastIcon(variant) {
    if (variant === 'success') return 'check';
    if (variant === 'warning') return 'alert';
    if (variant === 'error') return 'xcircle';
    return 'bell';
  }

  function pushToast(variant, title, message) {
    var v = variant === 'success' || variant === 'warning' || variant === 'error' ? variant : 'info';
    var toast = el('div', 'toast tone-' + v);
    toast.appendChild(iconEl(toastIcon(v), 'ic'));
    var main = el('div', 'toast-main');
    main.appendChild(textEl('div', 'toast-title', title || '通知'));
    if (message) main.appendChild(textEl('div', 'toast-msg', message));
    toast.appendChild(main);
    var close = buttonEl('icon-mini', 'x', null);
    close.setAttribute('aria-label', '关闭通知');
    toast.appendChild(close);
    function remove() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }
    close.addEventListener('click', remove);
    els.toasts.appendChild(toast);
    while (els.toasts.children.length > 4) els.toasts.removeChild(els.toasts.firstElementChild);
    setTimeout(remove, 8000);
  }

  // ── todo 计划条（todo.updated 整表重绘；空表隐藏 = 该栏缺席不占位） ──

  var TODO_STATE_CLASS = { pending: 'st-pending', in_progress: 'st-progress', completed: 'st-done' };
  var TODO_STATE_ICON = { pending: 'circle', in_progress: 'ring', completed: 'check' };
  var TODO_PRIORITY_LABEL = { high: '高', medium: '中', low: '低' };

  function renderTodoPanel() {
    var todos = state.todos;
    if (!todos || todos.length === 0) {
      els.todoPanel.hidden = true;
      els.todoList.replaceChildren();
      els.todoCount.textContent = '';
      return;
    }
    els.todoPanel.hidden = false;
    var nodes = [];
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i];
      var li = el('li', 'todo-item ' + (TODO_STATE_CLASS[t.status] || TODO_STATE_CLASS.pending));
      li.appendChild(iconEl(TODO_STATE_ICON[t.status] || TODO_STATE_ICON.pending, 'todo-ic'));
      li.appendChild(textEl('span', 'todo-text', t.content));
      var pr = textEl('span', 'todo-pr p-' + t.priority, TODO_PRIORITY_LABEL[t.priority] || t.priority);
      li.appendChild(pr);
      nodes.push(li);
    }
    els.todoList.replaceChildren.apply(els.todoList, nodes);
    var c = loomTodoCounts(todos);
    els.todoCount.textContent = c.done + '/' + c.total + (c.active > 0 ? ' · 进行' + c.active : '');
  }

  // ── 上下文面板（W18 纯文本重排：按发送顺序一块全文 + 模块纯文本分块；路径复制按钮全下线） ──

  // 纯字符串复制（复制全文）：临时 textarea + execCommand 兜底（无 clipboard API 的环境也能用）。
  function legacyCopyText(text, btn) {
    var area = el('textarea');
    area.value = typeof text === 'string' ? text : '';
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.setAttribute('readonly', 'readonly');
    document.body.appendChild(area);
    try {
      area.select();
      document.execCommand('copy');
      btn.textContent = '已复制';
    } catch (err) {
      btn.textContent = '复制失败';
    }
    if (area.parentNode) area.parentNode.removeChild(area);
  }

  function hideFullContext() {
    els.ctxPlain.hidden = true;
    els.ctxPlain.textContent = '';
    els.ctxPlainNote.hidden = true;
    els.ctxPlainNote.textContent = '';
    els.ctxCopyAll.style.display = 'none';
    // W24 真相芯片只属于 /context/full v2 面：回退/清空路径必须一起收起（旧 /context 无 basis 语义）
    els.ctxTruth.hidden = true;
    els.ctxTruth.textContent = '';
    els.ctxSourceNote.hidden = true;
    els.ctxSourceNote.textContent = '';
    els.ctxSourceNote.title = '';
    hideSegmentModules();
    hideContextZones();
  }

  // 旧 /context（trace 反推/装配快照）渲染：/context/full 404 时的回退面。
  // W18：纯文本行（原 contextRowEl 树卡+路径复制面随用户判词下线）。
  function paintContext(view) {
    var tree = loomContextTree(view);
    if (!tree.ok) {
      hideFullContext();
      els.ctxTree.hidden = true;
      els.ctxTree.replaceChildren();
      els.ctxEmpty.hidden = false;
      els.ctxEmpty.textContent = state.activeId
        ? '暂无装配快照：发送一轮消息后生成（快照仅内存保存，服务重启清空）'
        : '未选择会话';
      els.ctxBadge.style.display = 'none';
      els.ctxBadge.textContent = '';
      els.ctxMeta.textContent = '';
      els.ctxMeta.title = '';
      els.ctxSubMeta.textContent = '';
      els.ctxBarFill.style.width = '0';
      return;
    }
    hideFullContext();
    els.ctxEmpty.hidden = true;
    els.ctxTree.hidden = false;
    els.ctxTree.replaceChildren();
    for (var g = 0; g < tree.groups.length; g++) {
      var group = tree.groups[g];
      var box = el('div', 'ctx-group');
      var head = el('div', 'ctx-group-head');
      head.appendChild(textEl('span', null, group.label));
      head.appendChild(textEl('span', 'n', group.rows.length + ' 项'));
      box.appendChild(head);
      for (var i = 0; i < group.rows.length; i++) {
        var row = group.rows[i];
        var size = [];
        if (row.lines !== null) size.push(row.lines + ' 行');
        if (row.bytes !== null) size.push(row.bytes + ' 字节');
        if (row.tokens !== null) size.push('~' + loomFormatCount(row.tokens) + ' tok');
        if (row.degraded) size.push('降级:' + row.degraded);
        box.appendChild(textEl('div', 'ctx-textline',
          row.label + ' · ' + (row.source || '—') + ' · ' + (size.join(' · ') || '—')));
      }
      els.ctxTree.appendChild(box);
    }
    els.ctxBadge.style.display = tree.badge ? '' : 'none';
    els.ctxBadge.textContent = tree.badge;
    els.ctxMeta.textContent = '[' + tree.basis + '] ' + tree.meta;
    els.ctxMeta.title = tree.note;
    els.ctxSubMeta.textContent = '';
    els.ctxBarFill.style.width = (tree.pct === null ? 0 : Math.max(1, tree.pct)).toFixed(1) + '%';
  }

  // ── /context/full 新面渲染（W18：板块一纯文本 + 用量条顶线不变） ──

  // 三分段模块（系统段/记忆/工作流）：v1 segments 直出纯文本，无正文即折叠隐藏。
  function fillSegModule(card, body, seg) {
    if (!seg) {
      card.hidden = true;
      body.textContent = '';
      return;
    }
    card.hidden = false;
    body.textContent = '[offset ' + (typeof seg.offset === 'number' ? seg.offset : '—')
      + ' · ' + (typeof seg.byteLength === 'number' ? seg.byteLength : 0) + ' B]\n' + loomWireStr(seg.text);
  }

  function hideSegmentModules() {
    els.ctxModSystem.hidden = true;
    els.ctxModSystemBody.textContent = '';
    els.ctxModMemory.hidden = true;
    els.ctxModMemoryBody.textContent = '';
    els.ctxModWorkflow.hidden = true;
    els.ctxModWorkflowBody.textContent = '';
  }

  function renderSegmentModules(view) {
    var v = view && typeof view === 'object' ? view : {};
    var segs = Array.isArray(v.segments) ? v.segments : [];
    var byLabel = {};
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i] && typeof segs[i] === 'object' ? segs[i] : {};
      var lb = loomWireStr(s.label);
      if (byLabel[lb] === undefined) byLabel[lb] = s;
    }
    fillSegModule(els.ctxModSystem, els.ctxModSystemBody, byLabel['system'] || null);
    fillSegModule(els.ctxModWorkflow, els.ctxModWorkflowBody, byLabel['workflow'] || null);
    var memText = loomCtxMemoryPlain(v);
    els.ctxModMemory.hidden = memText === '';
    els.ctxModMemoryBody.textContent = memText;
  }

  function paintContextFull(view) {
    var t = loomContextFullView(view);
    if (!t.ok) { hideContextZones(); return false; }
    state.contextFull = view;
    // W24 真相芯片：basis/wire.source 纯文本直出（live/cache 不猜——routes.ts W23-A 三态语义）。
    var truth = loomContextTruthBits(view);
    els.ctxTruth.textContent = truth.line;
    els.ctxTruth.className = 'ctx-truth' + (truth.cache ? ' cache' : '');
    els.ctxTruth.hidden = truth.line === '';
    if (truth.cache) {
      // 缓存基面如实申明（segments 恒空=装配对象不可恢复）；note 全文仍在 ctxMeta.title 悬停可见。
      els.ctxNotice.hidden = false;
      els.ctxNotice.textContent = '基底=缓存 · 发线=缓存(重启残影)：本面 = wire/' + t.sessionID
        + '.json 持久缓存 + durable 转录重建（非本轮内存现读）；segments 恒空——装配分段不可恢复，不假装存在。';
    } else {
      els.ctxNotice.hidden = true;
      els.ctxNotice.textContent = '';
    }
    els.ctxEmpty.hidden = true;
    els.ctxTree.hidden = true;
    els.ctxTree.replaceChildren();
    els.ctxBadge.style.display = t.estimateTokens !== null ? '' : 'none';
    els.ctxBadge.textContent = t.estimateTokens !== null ? '~' + loomFormatCount(t.estimateTokens) + ' tok' : '';
    els.ctxBarFill.style.width = (t.pct === null ? 0 : Math.max(0.4, Math.min(100, t.pct))).toFixed(2) + '%';
    els.ctxMeta.textContent = loomContextHeaderText(t, truth.basisChip);
    els.ctxMeta.title = t.note;
    els.ctxSourceNote.hidden = t.sourceNote === '';
    els.ctxSourceNote.textContent = t.sourceNote;
    els.ctxSourceNote.title = t.sourceNote;
    var sha = t.systemPromptSha256 ? String(t.systemPromptSha256).slice(0, 16) + '…' : '—';
    var pfx = t.prefixHash ? String(t.prefixHash).slice(0, 16) + '…' : '—';
    els.ctxSubMeta.textContent = 'prefixHash ' + pfx + ' · systemPrompt sha256 ' + sha
      + (t.transientExcluded ? ' · transientExcluded: ' + t.transientExcluded : '')
      + (t.capturedAt ? ' · 快照 ' + clockText(t.capturedAt) : '');
    var plain = loomContextPlainView(view);
    if (plain.ok) {
      els.ctxPlain.hidden = false;
      els.ctxPlain.textContent = plain.text; // 整块纯文本，只走 textContent
      els.ctxPlainNote.hidden = false;
      els.ctxPlainNote.textContent = plain.note;
      els.ctxCopyAll.style.display = '';
    } else {
      els.ctxPlain.hidden = true;
      els.ctxPlain.textContent = '';
      els.ctxPlainNote.hidden = true;
      els.ctxPlainNote.textContent = '';
      els.ctxCopyAll.style.display = 'none';
    }
    renderSegmentModules(view);
    renderContextV2Zones(view);
    return true;
  }

  function showContextNotice(text) {
    els.ctxNotice.hidden = false;
    els.ctxNotice.textContent = text;
  }

  // ── W17-F 上下文增量时间线重绘（W18：环形保留，条目改纯文本一行；点击=刷上下文） ──

  function renderContextTimeline() {
    var rows = Array.isArray(state.ctxNotices) ? state.ctxNotices : [];
    els.ctxNoticeTimeline.replaceChildren();
    if (rows.length === 0) {
      els.ctxTimelineHead.hidden = true;
      els.ctxNoticeTimeline.hidden = true;
      els.ctxTimelineBadge.style.display = 'none';
      els.ctxTimelineBadge.textContent = '';
      return;
    }
    els.ctxTimelineHead.hidden = false;
    els.ctxNoticeTimeline.hidden = false;
    els.ctxTimelineBadge.style.display = '';
    els.ctxTimelineBadge.textContent = rows.length + ' 条';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var meta = loomNoticeActionMeta(r.action);
      var line = clockText(r.at) + ' · ' + meta.label + ' · ' + r.relPath
        + ' · ' + (r.bytes === null ? '—' : r.bytes + ' B')
        + ' · 轮 ' + (r.turnIdx === null ? '—' : r.turnIdx);
      var row = el('div', 'ctx-tl-row');
      row.textContent = line;
      row.title = '点击刷新上下文（帧不含正文）';
      row.addEventListener('click', function () { loadContext(); });
      els.ctxNoticeTimeline.appendChild(row);
    }
  }

  // ── W18 模块板块渲染（参数 / provider 载荷惰性抽屉 / 引用清单；全 textContent） ──

  // 惰性抽屉唯一入口：正文节点在首次展开前绝不进 DOM（collapse 默认 + toggle 一次性填充）。
  function lazyFillDetails(card, fill) {
    card.addEventListener('toggle', function () {
      if (card.open !== true) return;
      if (card.dataset.filled === '1') return;
      card.dataset.filled = '1';
      fill();
    });
  }

  // providerPayload 抽屉：默认折叠 + 复制全文 + 计数·时刻；正文严格惰性——首次 toggle
  // 展开前逐字节全文不进 DOM。null → absentReason 逐字转呈。
  function renderPayloadDrawer(wire) {
    var pv = loomWirePayloadAbsentView(wire);
    els.ctxPayload.hidden = true;
    els.ctxPayload.open = false;
    els.ctxPayload.removeAttribute('data-filled');
    els.ctxPayloadBody.replaceChildren();
    els.ctxPayloadHint.textContent = '';
    els.ctxPayloadAbsent.hidden = true;
    els.ctxPayloadAbsent.textContent = '';
    if (!pv.hasWire) return;
    if (pv.present) {
      els.ctxPayload.hidden = false;
      els.ctxPayloadHint.textContent = pv.bytes + ' B · 捕获 ' + (pv.capturedAt ? clockText(pv.capturedAt) : '—');
      lazyFillDetails(els.ctxPayload, function () {
        var pre = el('pre');
        pre.textContent = pv.text; // 逐字节全文，不截断
        els.ctxPayloadBody.appendChild(pre);
      });
      return;
    }
    els.ctxPayloadAbsent.hidden = false;
    els.ctxPayloadAbsent.textContent = pv.reason ? pv.reason : 'providerPayload 缺席：服务端未给出 providerPayloadAbsentReason';
  }

  function hideContextZones() {
    els.ctxV1Compat.hidden = true;
    els.ctxV1Compat.textContent = '';
    hideWireModules();
  }

  function hideWireModules() {
    els.ctxModParams.hidden = true;
    els.ctxModParamsBody.textContent = '';
    els.ctxPayload.hidden = true;
    els.ctxPayload.open = false;
    els.ctxPayload.removeAttribute('data-filled');
    els.ctxPayloadBody.replaceChildren();
    els.ctxPayloadHint.textContent = '';
    els.ctxPayloadAbsent.hidden = true;
    els.ctxPayloadAbsent.textContent = '';
    els.ctxModManifest.hidden = true;
    els.ctxModManifestBody.textContent = '';
  }

  // v2 两键探测在渲染层唯一入口：v1-only/wire-null → 单条纯文本 compat 提示（W18 简化，
  // 原折叠长说明随结构展览下线）；参数/provider 载荷/引用清单三模块按面填充。
  function renderContextV2Zones(view) {
    var v = view && typeof view === 'object' ? view : {};
    var hasWire = 'wire' in v;
    var hasManifest = 'manifest' in v;
    hideWireModules();
    if (!hasWire && !hasManifest) {
      els.ctxV1Compat.hidden = false;
      els.ctxV1Compat.textContent = '来源=装配快照非发线：服务端未提供 wire/manifest 两键（v1-only），'
        + '完整上下文与分段模块按 v1 装配面渲染；服务端补上 v2 两键后本提示自动消失';
      return;
    }
    if (hasWire && (v.wire === null || v.wire === undefined)) {
      els.ctxV1Compat.hidden = false;
      els.ctxV1Compat.textContent = '来源=装配快照非发线：尚无发线捕获（重启即清，首个 LLM 调用后可见）';
    } else if (hasWire) {
      els.ctxV1Compat.hidden = true;
      els.ctxV1Compat.textContent = '';
      var req = v.wire.request && typeof v.wire.request === 'object' ? v.wire.request : {};
      els.ctxModParams.hidden = false;
      els.ctxModParamsBody.textContent = loomCtxParamsPlain(req.params);
      renderPayloadDrawer(v.wire);
    }
    if (hasManifest) {
      var mtext = loomCtxManifestPlain(v.manifest);
      els.ctxModManifest.hidden = mtext === '';
      els.ctxModManifestBody.textContent = mtext;
    }
  }

  function clearContextPanels() {
    state.contextFull = null;
    state.ctxNotices = []; // W17-F 时间线随会话切换清零（帧归属当前订阅流，跨会话不残留）
    renderContextTimeline();
    els.ctxNotice.hidden = true;
    els.ctxNotice.textContent = '';
    paintContext(null);
  }

  // /context/full 优先；404 = 无 live 环回（子会话无内存装配）→ 如实提示并回退旧 /context。
  function loadContext(sessionID) {
    var sid = sessionID || state.activeId;
    if (!sid || !state.token) { clearContextPanels(); return Promise.resolve(); }
    return request('/sessions/' + encodeURIComponent(sid) + '/context/full').then(function (res) {
      if (state.activeId !== sid) return; // 会话已切换：丢弃迟到响应
      if (res.status === 401) { handle401(); return; }
      if (res.status === 404) {
        showContextNotice('无 live 环回：该会话没有 /context/full 快照（子会话无内存装配面），已回退旧 /context 装配快照视图');
        return loadLegacyContext(sid);
      }
      if (!res.ok) { showContextNotice('上下文读取失败：HTTP ' + res.status); return; }
      return res.json().then(function (body) {
        if (state.activeId !== sid) return;
        if (!paintContextFull(body)) showContextNotice('上下文帧为空：/context/full 未给出可渲染字段');
      });
    }).catch(function () { /* 网络故障保留上次画面 */ });
  }

  function loadLegacyContext(sid) {
    return request('/sessions/' + encodeURIComponent(sid) + '/context').then(function (res) {
      if (state.activeId !== sid) return;
      if (res.status === 401) { handle401(); return; }
      if (res.status === 404) { paintContext(null); return; }
      if (!res.ok) return;
      return res.json().then(function (body) {
        if (state.activeId === sid) paintContext(body);
      });
    }).catch(function () { /* 网络故障保留上次画面 */ });
  }

  // ── 事件视图（W16-C：SSE 帧滚动缓冲；类型/时刻/会话归属 + 原始 JSON 展开） ──

  function recordEventFrame(frame) {
    var payload = frame.payload;
    var props = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    var ev = {
      seq: typeof frame.seq === 'number' ? frame.seq : null,
      type: String(payload.type),
      at: Date.now(),
      session: String(props.sessionID || state.activeId || ''),
      known: LOOM_EVENT_NAMES.indexOf(String(payload.type)) >= 0,
      brief: loomEventBrief(String(payload.type), props),
      frame: frame
    };
    state.events.unshift(ev);
    if (state.events.length > EVENT_CAP) state.events.length = EVENT_CAP;
    if (!ev.known) state.unknownEvents += 1;
    refreshEventBadges();
    if (state.view === 'events') scheduleEventsRender();
  }

  function refreshEventBadges() {
    els.eventCount.textContent = state.events.length ? String(state.events.length) : '';
    els.eventUnknown.textContent = state.unknownEvents > 0 ? '未知事件 ' + state.unknownEvents : '';
    els.eventUnknown.style.display = state.unknownEvents > 0 ? '' : 'none';
    els.tabEventsBadge.textContent = state.unknownEvents > 0 ? String(state.unknownEvents) : '';
    els.tabEventsBadge.style.display = state.unknownEvents > 0 ? '' : 'none';
  }

  function eventRowEl(ev) {
    var row = el('details', 'ev-frame' + (ev.known ? '' : ' unknown'));
    var sum = el('summary', 'ev-sum');
    sum.appendChild(textEl('span', 'ev-type', ev.type));
    sum.appendChild(textEl('span', 'ev-at', clockText(ev.at)));
    sum.appendChild(textEl('span', 'ev-seq', ev.seq === null ? '' : '#' + ev.seq));
    sum.appendChild(textEl('span', 'ev-session', ev.session));
    sum.appendChild(textEl('span', 'ev-brief', ev.brief || ''));
    row.appendChild(sum);
    var pre = el('pre', 'ev-json');
    pre.textContent = pretty(ev.frame);
    row.appendChild(pre);
    return row;
  }

  function renderEvents() {
    var filtered = [];
    for (var i = 0; i < state.events.length; i++) {
      var ev = state.events[i];
      if (state.eventHideDelta && ev.type === 'message.part.delta') continue;
      filtered.push(ev);
    }
    els.eventList.replaceChildren();
    for (var j = 0; j < filtered.length; j++) els.eventList.appendChild(eventRowEl(filtered[j]));
    els.eventEmpty.style.display = state.events.length === 0 ? '' : 'none';
    els.eventEmpty.textContent = state.events.length === 0
      ? '等待事件帧。订阅会话后，所有 SSE 帧（含未知类型）都会在此滚动留档；点行展开原始 JSON。'
      : (filtered.length === 0 ? '当前帧全被过滤（消息流式增量帧）——取消勾选「隐藏流式增量帧」可见。' : '');
    refreshEventBadges();
  }

  function scheduleEventsRender() {
    if (state.eventsTimer) return;
    state.eventsTimer = setTimeout(function () {
      state.eventsTimer = null;
      renderEvents();
    }, 120);
  }

  // ── 任务/运行视图（GET /tasks 3s 轮询 + 详情 + cancel 两段确认；/runs 只读） ──

  var TASK_TERMINAL = { done: true, failed: true, partial: true, cancelled: true, 'dead-letter': true };

  function taskIsTerminal(status) {
    return TASK_TERMINAL[String(status || '')] === true;
  }

  function taskField(k, v, tone) {
    var f = el('div', 'tk-field');
    f.appendChild(textEl('span', 'k', k));
    var val = textEl('span', 'v' + (tone ? ' ' + tone : ''), v);
    f.appendChild(val);
    return f;
  }

  function taskCardEl(row) {
    var meta = loomTaskStatusMeta(row.status);
    var src = loomTaskSourceBadge(row); // W23-C 来源标：内核行 in_memory:true=在飞；账本-only 行缺键=历史
    var card = el('div', 'tk-card' + (state.tasksFresh[row.task_id] ? ' fresh' : ''));
    card.dataset.tone = meta.tone;
    card.dataset.task = row.task_id;
    var head = el('div', 'tk-head');
    head.appendChild(textEl('span', 'tk-badge tone-' + meta.tone, meta.label));
    head.appendChild(textEl('span', 'tk-src' + (src.live ? ' live' : ''), src.label));
    head.appendChild(textEl('span', 'tk-id', row.task_id));
    head.appendChild(textEl('span', 'tk-agent', row.agent_type || ''));
    head.appendChild(textEl('span', 'tk-sub', (row.workflow || '') + (row.session_id ? ' · ' + row.session_id : '')));
    var time = textEl('span', 'tk-time', row.dispatched_at ? clockText(row.dispatched_at) : '');
    head.appendChild(time);
    var actions = el('div', 'tk-actions');
    var detailBtn = buttonEl('mini', null, '详情');
    actions.appendChild(detailBtn);
    var cancelBtn = null;
    if (!taskIsTerminal(row.status) && !row.cancel_requested) {
      cancelBtn = buttonEl('mini', null, '取消');
      actions.appendChild(cancelBtn);
    }
    head.appendChild(actions);
    card.appendChild(head);

    var body = el('div', 'tk-body');
    var fields = el('div', 'tk-fields');
    fields.appendChild(taskField('run_id', row.run_id || '—'));
    fields.appendChild(taskField('parent', row.parent_session || '—'));
    fields.appendChild(taskField('dispatched', row.dispatched_at ? new Date(row.dispatched_at).toLocaleString() : '—'));
    fields.appendChild(taskField('terminal', row.terminal_at ? new Date(row.terminal_at).toLocaleString() : '—'));
    if (row.crashed) fields.appendChild(taskField('crashed', '是', 'err'));
    if (row.cancel_requested) fields.appendChild(taskField('cancel_requested', String(row.cancel_requested), 'warn'));
    if (row.error) fields.appendChild(taskField('error', String(row.error), 'err'));
    body.appendChild(fields);
    var detailBox = el('div', 'tk-detail');
    detailBox.hidden = true;
    body.appendChild(detailBox);
    // W24 转录面：有 session_id 的行可展开子会话 context/full 纯文本（惰性 GET，
    // W23-A 保证账本历史/重启后 basis=cache 仍可直读——这是「重启后子转录不可看」痛点的出口）。
    var transcriptBox = null;
    var transcriptBtn = null;
    if (row.session_id) {
      transcriptBtn = buttonEl('mini', null, '转录');
      transcriptBtn.title = '展开子会话 ' + row.session_id + ' 的 context/full 转录（重启后走缓存重建面）';
      actions.appendChild(transcriptBtn);
      transcriptBox = el('div', 'tk-detail');
      transcriptBox.hidden = true;
      body.appendChild(transcriptBox);
      if (state.taskTranscriptOpen[row.task_id]) {
        transcriptBox.hidden = false;
        transcriptBtn.textContent = '收起';
        var openedT = state.taskTranscript[row.task_id];
        if (openedT) paintTaskTranscript(transcriptBox, row.session_id, openedT);
        else loadTaskTranscriptInto(row.task_id, row.session_id, transcriptBox);
      }
      transcriptBtn.addEventListener('click', function () {
        toggleTaskTranscript(row.task_id, row.session_id, transcriptBox, transcriptBtn);
      });
    }
    card.appendChild(body);
    // 重绘保态：轮询重建卡片时恢复用户已展开的详情（否则 3s 一收）
    if (state.taskOpen[row.task_id]) {
      detailBox.hidden = false;
      detailBtn.textContent = '收起';
      var opened = state.taskDetail[row.task_id];
      if (opened) paintTaskDetail(detailBox, opened);
      else loadTaskDetailInto(row.task_id, detailBox);
    }

    head.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.tk-actions')) return;
      toggleTaskDetail(row.task_id, detailBox, detailBtn);
    });
    detailBtn.addEventListener('click', function () { toggleTaskDetail(row.task_id, detailBox, detailBtn); });
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () { askCancelTask(row.task_id, cancelBtn); });
    }
    return card;
  }

  function loadTasks() {
    if (!state.token) return Promise.resolve();
    return request('/tasks').then(function (res) {
      if (res.status === 401) { handle401(); return; }
      if (res.status === 404) { paintTasksNotice('任务面未接线（tasks_not_wired）：本装配没有后台任务账本'); return; }
      if (!res.ok) { paintTasksNotice('任务列表读取失败：HTTP ' + res.status); return; }
      return res.json().then(function (body) {
        var list = body && Array.isArray(body.tasks) ? body.tasks : [];
        loomTaskMerge(state.tasks, list);
        state.tasks = list;
        paintTasksNotice('');
        renderTasks();
      });
    }).catch(function () { paintTasksNotice('任务列表读取失败：服务不可达（3s 后重试）'); });
  }

  function paintTasksNotice(text) {
    els.taskNotice.hidden = !text;
    els.taskNotice.textContent = text || '';
    if (text) {
      els.taskList.replaceChildren();
      els.taskCount.textContent = '';
    }
  }

  function renderTasks() {
    els.taskList.replaceChildren();
    // W24：呈现序=dispatched_at 倒序（服务端合流序是「内核在前、账本时间序」，
    // 面板诉求新在前——排序责任在本页，字段零改动）；超上限「加载更多」切片。
    var ordered = loomTasksNewestFirst(state.tasks);
    var slice = loomListSlice(ordered, state.tasksShown);
    var active = 0;
    for (var i = 0; i < state.tasks.length; i++) {
      if (!taskIsTerminal(state.tasks[i].status)) active += 1;
    }
    for (var j = 0; j < slice.rows.length; j++) els.taskList.appendChild(taskCardEl(slice.rows[j]));
    if (slice.hidden > 0) {
      var more = el('div', 'list-more');
      more.appendChild(loadMoreBtn(slice.hidden, function () {
        state.tasksShown += TASK_LIST_CAP;
        renderTasks();
      }));
      els.taskList.appendChild(more);
    }
    els.taskCount.textContent = state.tasks.length ? state.tasks.length + ' 项' + (active ? ' · 进行 ' + active : '') : '';
    if (state.tasks.length === 0) {
      var empty = el('div', 'tk-empty');
      empty.textContent = '暂无后台任务。主会话通过 task 工具派发子任务后，这里合流显示内核在飞与账本历史（GET /tasks = 在飞 ∪ 账本 kind=sub，重启不丢）。';
      els.taskList.appendChild(empty);
    }
    updateTabBadges();
  }

  function toggleTaskDetail(taskId, box, btn) {
    if (!box.hidden) {
      box.hidden = true;
      btn.textContent = '详情';
      delete state.taskOpen[taskId];
      return;
    }
    box.hidden = false;
    btn.textContent = '收起';
    state.taskOpen[taskId] = true;
    var cached = state.taskDetail[taskId];
    if (cached) { paintTaskDetail(box, cached); return; }
    loadTaskDetailInto(taskId, box);
  }

  function loadTaskDetailInto(taskId, box) {
    box.replaceChildren(textEl('div', 'tk-empty', '读取详情…'));
    request('/tasks/' + encodeURIComponent(taskId)).then(function (res) {
      if (res.status === 401) { handle401(); return; }
      if (!res.ok) {
        box.replaceChildren(textEl('div', 'tk-empty', '详情读取失败：HTTP ' + res.status));
        return;
      }
      return res.json().then(function (body) {
        state.taskDetail[taskId] = body;
        if (!box.hidden && box.parentNode) paintTaskDetail(box, body);
      });
    }).catch(function () {
      box.replaceChildren(textEl('div', 'tk-empty', '详情读取失败：服务不可达'));
    });
  }

  // W24 任务行转录：展开/收起态入 state（3s 重绘保态），正文只走 textContent 整块。
  function toggleTaskTranscript(taskId, sid, box, btn) {
    if (!box.hidden) {
      box.hidden = true;
      btn.textContent = '转录';
      delete state.taskTranscriptOpen[taskId];
      return;
    }
    box.hidden = false;
    btn.textContent = '收起';
    state.taskTranscriptOpen[taskId] = true;
    var cached = state.taskTranscript[taskId];
    if (cached) { paintTaskTranscript(box, sid, cached); return; }
    loadTaskTranscriptInto(taskId, sid, box);
  }

  // 惰性拉取：路径 = loomTaskTranscriptPath（GET /sessions/{sid}/context/full，只读面）。
  // 200 basis=cache = 重启后子会话的持久缓存重建面（W23-A）；404 = 无 loop 且无缓存，如实说。
  function loadTaskTranscriptInto(taskId, sid, box) {
    box.replaceChildren(textEl('div', 'tk-empty', '读取转录…'));
    request(loomTaskTranscriptPath(sid)).then(function (res) {
      if (res.status === 401) { handle401(); return; }
      if (res.status === 404) {
        box.replaceChildren(textEl('div', 'tk-empty',
          '无转录面：会话 ' + sid + ' 既无 live loop 也无 wire/{sid}.json 持久缓存（404 如实）。'));
        return;
      }
      if (!res.ok) {
        box.replaceChildren(textEl('div', 'tk-empty', '转录读取失败：HTTP ' + res.status));
        return;
      }
      return res.json().then(function (body) {
        state.taskTranscript[taskId] = body;
        if (!box.hidden && box.parentNode) paintTaskTranscript(box, sid, body);
      });
    }).catch(function () {
      box.replaceChildren(textEl('div', 'tk-empty', '转录读取失败：服务不可达'));
    });
  }

  // 转录渲染 = 真相芯片一行（基底/发线 live-cache）+ 完整纯文本（按发送顺序装配，
  // 解析失败逐字回退）+ note 口径行。2.5MB+ 正文只在点开时进 DOM（惰性纪律）。
  function paintTaskTranscript(box, sid, view) {
    box.replaceChildren();
    var bits = loomContextTruthBits(view);
    if (bits.line) box.appendChild(textEl('div', 'tk-truth', '转录真相 · ' + bits.line));
    box.appendChild(textEl('div', 'block-label', '子会话 ' + sid + ' · context/full 纯文本（按发送顺序）'));
    var plain = loomContextPlainView(view);
    var pre = el('pre');
    pre.textContent = plain.ok ? plain.text : '（无可渲染消息/装配面：如实缺席）';
    box.appendChild(pre);
    if (plain.ok && plain.note) box.appendChild(textEl('div', 'tk-truth', plain.note));
  }

  function paintTaskDetail(box, detail) {
    box.replaceChildren();
    var fields = el('div', 'tk-fields');
    if (detail.depth !== undefined) fields.appendChild(taskField('depth', String(detail.depth)));
    if (detail.ledger) {
      fields.appendChild(taskField('ledger.expected_at', detail.ledger.expected_at === null ? '—' : new Date(detail.ledger.expected_at).toLocaleString()));
      fields.appendChild(taskField('ledger.actual', detail.ledger.actual ? detail.ledger.actual.status + ' @ ' + new Date(detail.ledger.actual.at).toLocaleString() : '缺口（无 actual 行）'));
    }
    box.appendChild(fields);
    if (detail.task) {
      box.appendChild(textEl('div', 'block-label', '任务描述'));
      var taskPre = el('pre');
      taskPre.textContent = typeof detail.task === 'string' ? detail.task : pretty(detail.task);
      box.appendChild(taskPre);
    }
    if (detail.terminal) {
      box.appendChild(textEl('div', 'block-label', '终局快照'));
      var termPre = el('pre');
      termPre.textContent = pretty(detail.terminal);
      box.appendChild(termPre);
    }
    if (Array.isArray(detail.trace)) {
      box.appendChild(textEl('div', 'block-label', 'trace spans（' + detail.trace.length + '）'));
      var tracePre = el('pre');
      tracePre.textContent = detail.trace.length ? pretty(detail.trace) : '（无当日 trace span）';
      box.appendChild(tracePre);
    }
  }

  function askCancelTask(taskId, btn) {
    var actions = btn.parentNode;
    var confirmBtn = buttonEl('mini', null, '确认取消');
    confirmBtn.classList.add('danger');
    var backBtn = buttonEl('mini', null, '返回');
    var restore = function () {
      if (confirmBtn.parentNode) confirmBtn.parentNode.removeChild(confirmBtn);
      if (backBtn.parentNode) backBtn.parentNode.removeChild(backBtn);
      btn.style.display = '';
    };
    confirmBtn.addEventListener('click', function () {
      restore();
      cancelTask(taskId);
    });
    backBtn.addEventListener('click', restore);
    btn.style.display = 'none';
    actions.appendChild(confirmBtn);
    actions.appendChild(backBtn);
  }

  function cancelTask(taskId) {
    request('/tasks/' + encodeURIComponent(taskId) + '/cancel', {
      method: 'POST',
      body: JSON.stringify({})
    }).then(function (res) {
      if (res.status === 401) { handle401(); return; }
      if (!res.ok) { showStatus('error', '取消任务失败：HTTP ' + res.status, 0); return; }
      return res.json().then(function (body) {
        var accepted = body && body.accepted === true;
        showStatus(accepted ? 'warn' : 'info', accepted ? '已请求取消 ' + taskId : '取消请求未受理：' + taskId, 6000);
        delete state.taskDetail[taskId];
        loadTasks();
      });
    }).catch(function () {
      showStatus('error', '取消任务失败：服务不可达', 0);
    });
  }

  function loadRuns() {
    if (!state.token) return Promise.resolve();
    return request('/runs').then(function (res) {
      if (res.status === 401) { handle401(); return; }
      if (!res.ok) return;
      return res.json().then(function (body) {
        state.runs = body && Array.isArray(body.runs) ? body.runs : [];
        renderRuns();
      });
    }).catch(function () { /* 只读附加面：失败保留上次渲染 */ });
  }

  function renderRuns() {
    els.runList.replaceChildren();
    els.runCount.textContent = state.runs.length ? String(state.runs.length) : '';
    if (state.runs.length === 0) {
      els.runList.appendChild(textEl('div', 'tk-run-row', '（无运行记录）'));
      return;
    }
    for (var i = 0; i < state.runs.length; i++) {
      var run = state.runs[i];
      var row = el('div', 'tk-run-row');
      row.appendChild(textEl('span', 'tk-run-id', run.run_id || ''));
      row.appendChild(textEl('span', 'tk-run-wf', run.workflow || ''));
      row.appendChild(textEl('span', null, run.session_id || ''));
      row.appendChild(textEl('span', 'tk-run-status', (run.status || '') + (run.terminal_at ? ' · ' + clockText(run.terminal_at) : '')));
      els.runList.appendChild(row);
    }
  }

  // ── 事件帧适配（信封 {seq, payload:{type, properties}}，真源 events/project.ts） ──

  function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    var payload = frame.payload;
    if (!payload || typeof payload.type !== 'string') return;
    var props = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    recordEventFrame(frame); // 事件标签的滚动留档（所有派发帧，含未知类型；绘制与分派解耦）
    switch (payload.type) {
      case 'message.part.delta':
        if (props.field === 'text' && typeof props.delta === 'string') {
          appendDelta(String(props.messageID || ''), String(props.partID || ''), props.delta);
        }
        break;
      case 'message.part.updated':
        if (props.part && typeof props.part === 'object') {
          var entry = ensureAssistant(String(props.messageID || props.part.messageID || ''));
          var part = props.part;
          if (part.type === 'tool') {
            upsertToolPart(entry, String(part.id || ''), part);
          } else if (part.type === 'reasoning' || part.type === 'thinking') {
            // 无 text 键 = 流式注册帧（建空块，后续 part.delta 追加）；带 text 键 = 终态快照（整段替换）
            var rHasText = typeof part.text === 'string' || typeof part.reasoning === 'string';
            var rText = typeof part.text === 'string' ? part.text : (typeof part.reasoning === 'string' ? part.reasoning : '');
            upsertReasoningPart(entry, String(part.id || ''), rText, rHasText);
          } else if (part.type === 'text' || part.type === undefined) {
            upsertTextPart(entry, String(part.id || ''), part.text);
          }
          // step-start / step-finish / 其余未知 part：静默容忍
        }
        break;
      case 'message.updated':
        if (props.info && typeof props.info === 'object') attachInfo(String(props.messageID || ''), props.info);
        break;
      case 'session.status':
        // 每次 busy 帧 = 新 run 开始 → 开新 epoch（见 entryKey 注释）
        var stype = props.status && props.status.type ? String(props.status.type) : 'busy';
        if (stype === 'busy') state.epoch += 1;
        setSessionStatus(stype);
        if (state.busy) showStatus('busy', 'loom 正在生成回复…', 0);
        break;
      case 'session.idle':
        setSessionStatus('idle');
        hideStatusIfBusy();
        if (props.convergence && typeof props.convergence === 'object' && props.convergence.status) {
          addEventRow('run', '本轮收束 · ' + String(props.convergence.status));
        }
        refreshStatuses();
        loadContext(); // 每轮结束自动刷新上下文快照（装配在 turn 边界完成）
        refreshCompactions(); // 压缩历史可能在本轮推进：同 key 就地重绘，新增则整页重放
        // 队列事件消失即 loadHistory 是主路径；此处兜底只在 pending 仍在时重拉，
        // loadPending 一旦发现「原有但现为空」会自行补一次 loadHistory。
        if (state.pending.length) loadPending(state.activeId);
        break;
      case 'session.error':
        var message = props.error && props.error.message
          ? String(props.error.message)
          : props.replay_error ? String(props.replay_error) : '未知错误';
        setSessionStatus('error');
        showStatus('error', '会话错误：' + message, 0);
        addEventRow('warn', '会话错误 · ' + message);
        refreshStatuses();
        break;
      case 'session.created':
        var cinfo = props.info && typeof props.info === 'object' ? props.info : null;
        if (cinfo && typeof cinfo.parentID === 'string' && cinfo.parentID && typeof cinfo.id === 'string') {
          registerChild({
            id: cinfo.id,
            name: typeof cinfo.title === 'string' ? cinfo.title : '',
            type: '子会话',
            status: ''
          }, 'created');
        }
        if (cinfo && cinfo.id) loadSessions();
        break;
      case 'session.children':
        if (Array.isArray(props.children)) {
          for (var ci = 0; ci < props.children.length; ci++) registerChild(props.children[ci], 'frame');
        }
        break;
      case 'file.edited':
        if (typeof props.file === 'string' && props.file) addFileRow(props.file);
        break;
      case 'server.connected':
        state.lastBeatAt = Date.now();
        setStreamState('open');
        if (!state.connectedNoted) {
          state.connectedNoted = true;
          addSystemLine('事件流已连接');
        }
        break;
      case 'server.heartbeat':
        state.lastBeatAt = Date.now(); // 心跳只做连接指示灯（tickHeartbeat 判定停滞）
        break;
      case 'run.status':
        var rbits = [];
        if (props.terminal === true) rbits.push('运行结束 · ' + (props.status ? String(props.status) : '终态'));
        else rbits.push('阶段 · ' + (props.stage ? String(props.stage) : '?'));
        if (typeof props.durationMs === 'number') rbits.push(loomFormatDuration(props.durationMs));
        if (props.tokens && typeof props.tokens === 'object') {
          var tk = props.tokens;
          if (typeof tk.input === 'number' || typeof tk.output === 'number') {
            rbits.push('in ' + (tk.input || 0) + ' / out ' + (tk.output || 0));
          }
        }
        if (props.failure) rbits.push(String(props.failure));
        addEventRow('run', rbits.join(' · '));
        // W17-F 运行终态 ⇒ 三区刷新（发线/清单随轮推进更新，用户永不手点）
        if (props.terminal === true) loadContext();
        break;
      case 'delivery.notify':
        var dTitle = props.title ? String(props.title) : '投递通知';
        var dMsg = props.message ? String(props.message) : '';
        var dVariant = props.variant ? String(props.variant) : 'info';
        pushToast(dVariant, dTitle, dMsg);
        addEventRow('notify', dTitle + (dMsg ? ' · ' + dMsg : ''));
        break;
      case 'watchdog.alarm':
        addEventRow('warn', '看门狗告警 · ' + (props.event ? String(props.event) : '未知'));
        break;
      case 'todo.updated':
        // 整表替换语义：帧来了就是全量新表——归一后整体重绘，不做增量合并。
        state.todos = loomNormalizeTodos(props.todos);
        renderTodoPanel();
        break;
      case 'context.notice':
        // W17-F 水位检出即发帧（准入时刻）：进时间线环形 + 立刻刷三区。
        // 帧只有 paths+bytes——正文真源在转录 prelude / 发线面，点击条目也只是刷新。
        state.ctxNotices = loomNoticeTimelinePush(state.ctxNotices, frame);
        renderContextTimeline();
        loadContext();
        break;
      case 'session.compacted':
        // 压缩成功：重拉 history 让 divider/摘要落到时间线。
        if (state.activeId) loadHistory(state.activeId);
        break;
      case 'session.compaction.started':
        showStatus('busy', '会话压缩已开始…', 0);
        break;
      case 'session.compaction.chunk':
        break;
      case 'session.compaction.retry':
        showStatus('busy', '压缩失败，正在重试…', 4000);
        break;
      case 'session.compaction.aborted':
        showStatus('error', '压缩已中止', 5000);
        break;
      case 'session.compaction_failed':
        showStatus('error', (props.error && props.error.message) || 'compaction failed', 6000);
        break;
      case 'session.queue':
        // 待发队列快照：状态徽标就地更新；任何旧键消失说明消息已过 turn 边界落盘，
        // 立刻重拉 history 把持久化消息搬进 #thread，pending 区只留未落盘条目。
        var prevPendingKeys = state.pendingKeys;
        var nextPending = normalizePending(props.pending);
        setPending(nextPending);
        renderPending();
        if (pendingLost(prevPendingKeys, state.pendingKeys) && state.activeId) {
          loadHistory(state.activeId);
        }
        break;
      default:
        // 未知事件的计数与留档都在事件标签（recordEventFrame 先于 switch 记帧）
        refreshEventBadges();
        break; // 未知事件容忍（后端新增族不破页）
    }
  }

  function parseSseBlock(block) {
    var lines = block.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.charAt(0) === ':' || line.length === 0) continue; // 心跳注释帧
      if (line.indexOf('data:') === 0) {
        var json = line.slice(5).trim();
        if (!json) continue;
        try { handleFrame(JSON.parse(json)); } catch (err) { /* 单帧坏损容忍，不拉垮整条流 */ }
      }
    }
  }

  // ── SSE 订阅（fetch-stream：EventSource 无法带 X-Loom-Token） ──

  function closeStream() {
    if (state.streamCtl) {
      try { state.streamCtl.abort(); } catch (err) {}
      state.streamCtl = null;
    }
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  }

  function subscribe(sessionID) {
    closeStream();
    var ctl = new AbortController();
    state.streamCtl = ctl;
    setStreamState('connecting');

    fetch('/events/stream?sessionId=' + encodeURIComponent(sessionID), {
      headers: { 'X-Loom-Token': state.token, 'Accept': 'text/event-stream' },
      signal: ctl.signal
    }).then(function (res) {
      if (res.status === 401) { setStreamState('error'); handle401(); return null; }
      if (!res.ok || !res.body) {
        setStreamState('error');
        showStatus('error', '事件流订阅失败：HTTP ' + res.status, 0);
        scheduleReconnect(sessionID);
        return null;
      }
      setStreamState('open');
      state.reconnectDelay = 1500;
      var wasOpened = state.streamWasOpened;
      state.streamWasOpened = true;
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) { onStreamEnd(sessionID); return; }
          buffer += decoder.decode(chunk.value, { stream: true });
          var idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            var block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            parseSseBlock(block);
          }
          return pump();
        });
      }
      // 断流重连可能错过 session.status(busy) → epoch 不前进，旧 msg_ 序号会把旧 part
      // 串到新消息（例如 read 卡挂到最终纯文本回复）。重连先按 store 重建转录再消费
      // live 帧；初次订阅已由 openSession 的 loadHistory 负责，不能重复重建。
      if (wasOpened) {
        return loadHistory(sessionID).then(function () {
          if (ctl.signal.aborted || state.activeId !== sessionID) return;
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      if (ctl.signal.aborted) return; // 主动切换/关闭：不算断流
      onStreamEnd(sessionID);
    });
  }

  function onStreamEnd(sessionID) {
    if (state.activeId !== sessionID) return;
    setStreamState('error');
    scheduleReconnect(sessionID);
  }

  function scheduleReconnect(sessionID) {
    if (state.activeId !== sessionID) return;
    if (state.reconnectTimer) return;
    setStreamState('retry');
    var delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.8, 8000);
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = null;
      if (state.activeId === sessionID && state.token) subscribe(sessionID);
    }, delay);
  }

  // ── 会话域 API ──

  // W24 「加载更多」按钮（纯文本切片；会话/任务两列表共用同一朴素形态，无既有分页模式时的兜底）
  function loadMoreBtn(hidden, onClick) {
    var btn = buttonEl('mini load-more', null, '加载更多（剩 ' + hidden + '）');
    btn.addEventListener('click', onClick);
    return btn;
  }

  // W24 归档切换钮激活态：选中态走 .mini.on 底色 ramp + aria-pressed，不加彩色描边。
  function paintArchivedToggle() {
    els.archivedToggle.className = 'mini' + (state.showArchived ? ' on' : '');
    els.archivedToggle.setAttribute('aria-pressed', state.showArchived ? 'true' : 'false');
  }

  // W24 会话列表：createdAt 倒序按服务端视图原样渲染（零重排）；标题回落 sid；
  // 行内改名（点标题→input→POST title→拉回流）；行尾归档/还原按钮；超上限「加载更多」切片。
  // 一切变更后 pull-only 重拉 GET /sessions——列表不开任何新 SSE 面（用户冻结纪律，W23-B B.5）。
  function renderSessions() {
    els.sessionList.replaceChildren();
    var rows = loomVisibleSessions(state.sessions, state.showArchived);
    if (rows.length === 0) {
      var msg = !state.token ? '需要 token 后加载会话'
        : state.showArchived ? '暂无归档会话：行尾「归档」的会话都收在这里。'
        : state.sessions.length > 0 ? '全部会话已归档——点左上方「归档」切换查看。'
        : '暂无会话，点上方「新建会话」';
      els.sessionList.appendChild(textEl('li', 'side-empty', msg));
      return;
    }
    var slice = loomListSlice(rows, state.sessionsShown);
    for (var i = 0; i < slice.rows.length; i++) {
      (function (session) {
        var rowView = loomSessionRowView(session);
        var isActive = rowView.id === state.activeId;
        // 活跃会话优先用本地实时状态（busy 帧到 idle 帧之间，列表缓存可能还是旧值）
        var shown = isActive && state.busy ? 'busy' : rowView.status;
        var item = el('li', 'session-item' + (isActive ? ' active' : ''));
        item.tabIndex = 0;
        item.dataset.id = rowView.id;
        item.dataset.status = rowView.status || 'idle';
        item.appendChild(el('span', 'dot'
          + (shown === 'busy' ? ' busy' : shown === 'error' ? ' error' : shown === 'idle' ? ' idle' : '')));
        var name = textEl('span', 'session-id' + (rowView.hasTitle ? ' titled' : ''), rowView.title);
        name.title = (rowView.hasTitle ? rowView.id + ' · ' : '') + '点击重命名（Enter 提交 / Esc 取消）';
        name.addEventListener('click', function (ev) {
          ev.stopPropagation(); // 点标题=改名，不触发整行打开会话
          startSessionRename(item, name, rowView, session);
        });
        item.appendChild(name);
        item.appendChild(textEl('span', 'session-state', shown || ''));
        var act = buttonEl('session-act', null, state.showArchived ? '还原' : '归档');
        act.title = state.showArchived ? '取消归档（回到默认列表）' : '归档（默认列表隐藏，可从「归档」切换找到）';
        act.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setSessionArchived(rowView.id, state.showArchived !== true);
        });
        item.appendChild(act);
        item.addEventListener('click', function () { openSession(rowView.id); });
        item.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openSession(rowView.id); }
        });
        els.sessionList.appendChild(item);
      })(slice.rows[i]);
    }
    if (slice.hidden > 0) {
      var more = el('li', 'list-more');
      more.appendChild(loadMoreBtn(slice.hidden, function () {
        state.sessionsShown += SESSION_LIST_CAP;
        renderSessions();
      }));
      els.sessionList.appendChild(more);
    }
  }

  // 行内改名：就地换入 input（同层替换，不重建行）；Enter/blur 提交、Esc 放弃；
  // 与已存标题逐字相同不发请求（无变更不发写）；提交后走 renameSession 的 pull-only 回流。
  function startSessionRename(item, nameEl, rowView, session) {
    if (item.dataset.renaming === '1') return;
    item.dataset.renaming = '1';
    var input = el('input', 'session-rename');
    input.type = 'text';
    input.value = rowView.hasTitle ? String(session.title) : '';
    input.placeholder = rowView.id;
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    var done = false;
    function finish(commit) {
      if (done) return; // blur 与 Enter 竞态：只认第一次提交
      done = true;
      if (input.parentNode) input.parentNode.removeChild(input);
      nameEl.style.display = '';
      delete item.dataset.renaming;
      if (!commit) return;
      var next = input.value.replace(/^\s+|\s+$/g, '');
      var prev = rowView.hasTitle ? String(session.title) : '';
      if (next === prev) return;
      renameSession(rowView.id, next); // 空串=清除声明，服务端删键回落 sid 显示
    }
    input.addEventListener('blur', function () { finish(true); });
    nameEl.style.display = 'none';
    item.insertBefore(input, nameEl);
    input.focus();
    input.select();
  }

  // POST title（请求规格 = loomTitleRequest 纯函数，与测试同源）；成功后拉回列表。
  function renameSession(sid, title) {
    var spec = loomTitleRequest(sid, title);
    request(spec.path, { method: spec.method, body: spec.body }).then(function (res) {
      if (res.status === 401) { handle401(); return; }
      if (!res.ok) { showStatus('error', '重命名失败：HTTP ' + res.status, 0); return; }
      return loadSessions();
    }).catch(function () {
      showStatus('error', '重命名失败：服务不可达', 0);
    });
  }

  // POST archive/unarchive（幂等端点；archived=false 走 /unarchive）；成功后拉回列表。
  function setSessionArchived(sid, archived) {
    var spec = loomArchiveRequest(sid, archived);
    request(spec.path, { method: spec.method, body: spec.body }).then(function (res) {
      if (res.status === 401) { handle401(); return; }
      if (!res.ok) { showStatus('error', (archived ? '归档' : '取消归档') + '失败：HTTP ' + res.status, 0); return; }
      return loadSessions();
    }).catch(function () {
      showStatus('error', (archived ? '归档' : '取消归档') + '失败：服务不可达', 0);
    });
  }

  function loadSessions() {
    if (!state.token) { renderSessions(); return Promise.resolve(); }
    // W24：查询路径由 loomSessionListPath 统一（true → ?archived=1 只列归档）
    return request(loomSessionListPath(state.showArchived)).then(function (res) {
      if (res.status === 401) { handle401(); return; }
      if (!res.ok) { showStatus('error', '会话列表加载失败：HTTP ' + res.status, 5000); return; }
      return res.json().then(function (body) {
        state.sessions = body && Array.isArray(body.sessions) ? body.sessions : [];
        renderSessions();
      });
    }).catch(function () {
      showStatus('error', '会话列表加载失败：服务不可达', 5000);
    });
  }

  function refreshStatuses() {
    loadSessions().then(function () {
      if (!state.activeId) return;
      return request('/sessions/' + encodeURIComponent(state.activeId) + '/status').then(function (res) {
        if (!res.ok) return;
        return res.json().then(function (view) {
          setSessionStatus(view && view.status ? view.status : 'idle');
          if (view && view.lastError) showStatus('error', '会话错误：' + view.lastError, 0);
        });
      });
    }).catch(function () {});
  }

  function createSession() {
    if (!state.token) {
      showStatus('error', '请先在右上角保存 X-Loom-Token（仅存本标签页）', 6000);
      els.tokenInput.focus();
      return;
    }
    request('/sessions', { method: 'POST' }).then(function (res) {
      if (res.status === 401) { handle401(); return null; }
      if (res.status !== 201) { showStatus('error', '新建会话失败：HTTP ' + res.status, 0); return null; }
      return res.json().then(function (body) {
        return loadSessions().then(function () { openSession(body.sessionID); });
      });
    }).catch(function (err) {
      showStatus('error', '新建会话失败：' + String(err && err.message ? err.message : err), 0);
    });
  }

  function openSession(sessionID) {
    if (!sessionID) return;
    state.activeId = sessionID;
    state.connectedNoted = false;
    state.lastBeatAt = 0;
    paintActiveHeader();
    renderSessions();
    renderChildList();
    state.todos = [];
    renderTodoPanel();
    clearContextPanels();
    loadContext(sessionID);
    closeStream();
    state.streamWasOpened = false;
    clearMessages();
    hideStatus();
    setSessionStatus('idle');
    showEmpty('加载历史…', '');
    loadHistory(sessionID);
    subscribe(sessionID);
  }

  // task 结果文本 → 子会话登记（历史回放与实时帧同名反解）
  function maybeRegisterFromText(text) {
    var found = loomExtractTaskSessions(text);
    for (var i = 0; i < found.length; i++) {
      registerChild({
        id: found[i].sessionID,
        name: found[i].agentType,
        type: found[i].agentType,
        status: found[i].reason
      }, 'task');
    }
  }

  function ingestHistory(messages, compactions) {
    var events = loomCompactionEventList(compactions);
    var placement = loomCompactionPlacement(messages, events);
    if (placement.top.length) {
      var stack = el('div', 'compaction-stack');
      var head = el('div', 'compaction-stack-head');
      head.appendChild(textEl('span', 'compaction-stack-label', '更早的压缩摘要'));
      stack.appendChild(head);
      for (var t = 0; t < placement.top.length; t++) {
        stack.appendChild(createCompactionCard(placement.top[t]));
      }
      if (els.thread.firstChild) els.thread.insertBefore(stack, els.thread.firstChild);
      else els.thread.appendChild(stack);
      state.compactionStack = stack;
    }
    var toolSlots = {};
    for (var i = 0; i < messages.length; i++) {
      var inPage = placement.at[i];
      if (inPage) {
        for (var k = 0; k < inPage.length; k++) els.thread.appendChild(createCompactionCard(inPage[k]));
      }
      var m = messages[i];
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'user') {
        var text = historyText(m.content);
        if (text) addUserMessage(text);
      } else if (m.role === 'assistant') {
        var mid = m.id ? String(m.id) : 'hist_' + i;
        var entry = ensureAssistant(mid);
        var content = Array.isArray(m.content) ? m.content : [];
        for (var j = 0; j < content.length; j++) {
          var block = content[j];
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            var slot = ensurePartEntry(entry, 'hist_' + i + '_' + j);
            var part = { type: 'text', text: block.text, streaming: false, final: true };
            slot.model = part;
            entry.body.appendChild(slot.el);
            paintTextPart(slot, part);
          } else if (block.type === 'thinking') {
            upsertReasoningPart(entry, 'hist_think_' + i + '_' + j, String(block.thinking || ''), true);
          } else if (block.type === 'toolCall') {
            var toolSlot = ensurePartEntry(entry, 'hist_tool_' + (block.id || j));
            var model = {
              type: 'tool', tool: String(block.name || 'unknown'),
              status: 'completed', input: block.arguments, output: ''
            };
            toolSlot.model = model;
            ensureToolElements(toolSlot);
            entry.body.appendChild(toolSlot.el);
            paintToolPart(toolSlot, model);
            if (block.id) toolSlots[String(block.id)] = { slot: toolSlot, model: model };
          }
        }
        if (m.stopReason || m.model) paintInfo(entry, m);
      } else if (m.role === 'toolResult') {
        var struck = m.toolCallId ? toolSlots[String(m.toolCallId)] : null;
        var resultText = historyText(m.content);
        if (struck) {
          struck.model.status = m.isError ? 'error' : 'completed';
          struck.model.output = resultText;
          paintToolPart(struck.slot, struck.model);
        } else if (resultText) {
          addSystemLine('工具结果 · ' + String(m.toolName || 'tool'));
        }
        if (resultText) maybeRegisterFromText(resultText);
      }
    }
    for (var tail = 0; tail < placement.tail.length; tail++) {
      els.thread.appendChild(createCompactionCard(placement.tail[tail]));
    }
  }

  function loadHistory(sessionID) {
    var historyRequest = request('/sessions/' + encodeURIComponent(sessionID) + '/history?limit=100');
    var compactionRequest = fetchCompactions(sessionID);
    // 三路并行发起（pending 不等 history 返回）；Promise.all 保持 W52 的双请求形态不变。
    var pendingRequest = fetchPending(sessionID);
    return Promise.all([historyRequest, compactionRequest]).then(function (pair) {
      var res = pair[0];
      var compactions = pair[1];
      if (res.status === 401) { handle401(); return null; }
      if (!res.ok) { showEmpty('历史加载失败：HTTP ' + res.status, ''); return null; }
      return res.json().then(function (body) {
        if (state.activeId !== sessionID) return pendingRequest;
        return pendingRequest.then(function (pending) {
          if (state.activeId !== sessionID) return;
          clearMessages();
          var messages = body && Array.isArray(body.messages) ? body.messages : [];
          var hasCompactions = loomCompactionEventList(compactions).length > 0;
          if (!messages.length && !hasCompactions) {
            showEmpty('新会话已就绪', '输入消息开始对话；回复与工具输出以 SSE 流式呈现');
          } else {
            hideEmpty();
            ingestHistory(messages, compactions);
            els.messages.scrollTop = els.messages.scrollHeight;
          }
          setPending(pending);
          renderPending();
        });
      });
    }).catch(function () {
      showEmpty('历史加载失败：服务不可达', '');
    });
  }

  function sendMessage() {
    var text = els.composer.value.trim();
    if (!text) return;
    if (!state.token) {
      showStatus('error', '请先在右上角保存 X-Loom-Token（仅存本标签页）', 6000);
      els.tokenInput.focus();
      return;
    }
    if (!state.activeId) {
      showStatus('info', '先新建或从左侧选择一个会话', 4000);
      return;
    }
    // 不做乐观追加：busy 消息受理时不再落盘，待发态由 session.queue / GET /pending 驱动。
    els.composer.value = '';
    autoGrow();
    setSessionStatus('busy');
    showStatus('busy', 'loom 正在生成回复…', 0);
    request('/sessions/' + encodeURIComponent(state.activeId) + '/messages', {
      method: 'POST',
      body: JSON.stringify({ text: text })
    }).then(function (res) {
      if (res.status === 401) {
        handle401();
        els.composer.value = text;
        autoGrow();
        setSessionStatus('idle');
        return;
      }
      if (res.status === 409) {
        els.composer.value = text;
        autoGrow();
        showStatus('warn', '会话忙：当前轮尚未结束，可点「停止」中止', 6000);
        setSessionStatus('busy');
        return;
      }
      if (!res.ok) {
        els.composer.value = text;
        autoGrow();
        showStatus('error', '发送失败：HTTP ' + res.status, 0);
        setSessionStatus('error');
        return;
      }
      loadPending(state.activeId);
    }).catch(function (err) {
      els.composer.value = text;
      autoGrow();
      showStatus('error', '发送失败：' + String(err && err.message ? err.message : err), 0);
      setSessionStatus('error');
    });
  }

  function abortTurn() {
    if (!state.activeId) return;
    request('/sessions/' + encodeURIComponent(state.activeId) + '/abort', { method: 'POST' }).then(function (res) {
      if (res.status === 401) { handle401(); return; }
      if (!res.ok) { showStatus('error', '停止失败：HTTP ' + res.status, 0); return; }
      return res.json().then(function (body) {
        if (body && body.aborted) showStatus('warn', '已中止当前轮（aborted）', 0);
        else showStatus('info', '当前没有进行中的回合', 4000);
      });
    }).catch(function (err) {
      showStatus('error', '停止失败：' + String(err && err.message ? err.message : err), 0);
    });
  }

  function autoGrow() {
    els.composer.style.height = 'auto';
    els.composer.style.height = Math.min(els.composer.scrollHeight, 200) + 'px';
  }

  // ── 启动 / 绑线 ──

  function saveToken() {
    state.token = els.tokenInput.value.trim();
    writeToken(state.token);
    paintTokenState();
    probeHealth().then(function (ok) {
      if (ok) loadSessions();
      else renderSessions();
    });
  }

  function clearToken() {
    state.token = '';
    writeToken('');
    els.tokenInput.value = '';
    paintTokenState();
    setHealth('idle', '未连接');
    closeStream();
    state.sessions = [];
    renderSessions();
    clearMessages();
    clearContextPanels();
    state.tasks = [];
    state.runs = [];
    state.events = [];
    state.taskTranscript = {};
    state.taskTranscriptOpen = {};
    state.showArchived = false;
    state.sessionsShown = SESSION_LIST_CAP;
    state.tasksShown = TASK_LIST_CAP;
    paintArchivedToggle();
    renderTasks();
    renderRuns();
    renderEvents();
    showEmpty('令牌已清除', '重新保存 token 后可继续使用');
  }

  function bindEvents() {
    els.newSession.addEventListener('click', createSession);
    els.refreshSessions.addEventListener('click', loadSessions);
    // W24 归档切换：两态都走服务端过滤面（默认 /sessions 排除归档；?archived=1 只列归档），
    // 切换即重拉并复位切片——列表数据真源永远是 GET，不是本地 mutate（pull-only 纪律）。
    els.archivedToggle.addEventListener('click', function () {
      state.showArchived = !state.showArchived;
      state.sessionsShown = SESSION_LIST_CAP;
      paintArchivedToggle();
      loadSessions();
    });
    els.sendBtn.addEventListener('click', sendMessage);
    els.abortBtn.addEventListener('click', abortTurn);
    els.tokenSave.addEventListener('click', saveToken);
    els.tokenClear.addEventListener('click', clearToken);
    els.tokenInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); saveToken(); }
    });
    els.composer.addEventListener('input', autoGrow);
    els.composer.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendMessage(); }
    });
    for (var v = 0; v < VIEW_NAMES.length; v++) {
      (function (key) {
        els.tabs[key].addEventListener('click', function () { setView(key); });
      })(VIEW_NAMES[v]);
    }
    els.childJump.addEventListener('click', function () { setView('children'); });
    els.childrenRefresh.addEventListener('click', function () { renderChildList(); kickChildrenPoll(); });
    els.subCollapseAll.addEventListener('click', closeAllPanels);
    els.ctxRefresh.addEventListener('click', function () { loadContext(); });
    els.ctxCopyAll.addEventListener('click', function () {
      if (state.contextFull) copyPlainText(loomContextPlainView(state.contextFull).text, els.ctxCopyAll);
    });
    // 载荷复制按钮在 summary 内：拦截默认开合，只复制不 toggle（全文从 wire 现取，无 DOM 中转）
    els.ctxPayloadCopy.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.contextFull) {
        var pv = loomWirePayloadAbsentView(state.contextFull.wire);
        copyPlainText(pv.present ? pv.text : '', els.ctxPayloadCopy);
      }
    });
    els.taskRefresh.addEventListener('click', function () { loadTasks(); loadRuns(); });
    els.eventHideDelta.addEventListener('change', function () {
      state.eventHideDelta = els.eventHideDelta.checked === true;
      renderEvents();
    });
    els.eventClear.addEventListener('click', function () {
      state.events = [];
      renderEvents();
    });
    els.messages.addEventListener('scroll', function () {
      state.atBottom = nearBottom(els.messages, 150);
    });
    window.addEventListener('focus', function () { if (state.token) loadSessions(); });
    setInterval(tickHeartbeat, 4000);
    // 任务面轮询：仅「任务」标签可见（且浏览器标签可见）时发请求，切走即静默
    setInterval(function () {
      if (state.view !== 'tasks') return;
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      loadTasks();
      loadRuns();
    }, TASK_POLL_MS);
  }

  function paintStaticIcons() {
    setIcon($('brandIcon'), 'grid');
    setIcon($('newSessionIcon'), 'plus');
    setIcon($('refreshIcon'), 'refresh');
    setIcon($('childJumpIcon'), 'users');
    setIcon($('tokenIcon'), 'lock');
    setIcon($('emptyIcon'), 'terminal');
    setIcon($('abortIcon'), 'stop');
    setIcon($('sendIcon'), 'send');
    setIcon($('childrenRefreshIcon'), 'refresh');
    setIcon($('ctxRefreshIcon'), 'refresh');
    setIcon($('railEmptyIcon'), 'users');
    setIcon($('tabChatIcon'), 'message');
    setIcon($('tabContextIcon'), 'layers');
    setIcon($('tabChildrenIcon'), 'users');
    setIcon($('tabTasksIcon'), 'list');
    setIcon($('tabEventsIcon'), 'zap');
    setIcon($('ctxPayloadIcon'), 'copy');
    setIcon($('taskRefreshIcon'), 'refresh');
    setIcon($('runIcon'), 'activity');
  }

  function init() {
    paintStaticIcons();
    state.token = readToken();
    if (state.token) els.tokenInput.value = state.token;
    paintTokenState();
    paintActiveHeader();
    paintFooter();
    setStreamState('idle');
    setSessionStatus('idle');
    els.sideFoot.textContent = location.host;
    els.main.className = 'view-chat';
    bindEvents();
    paintArchivedToggle();
    renderSessions();
    renderChildList();
    renderTodoPanel();
    updateTabBadges();
    refreshEventBadges();
    if (state.token) {
      probeHealth().then(function (ok) { if (ok) loadSessions(); });
    }
  }

  init();
})();
</script>
</body>
</html>
`;

function requestPath(req: IncomingMessage): string {
  const raw = req.url ?? "/";
  const path = raw.split("?", 2)[0] ?? "/";
  // trailing slash 归一到 Router 同口径（根路径保持 "/"）
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * 门面页 handler：命中 GET / 或 GET /ui 时直接应答并返回 true；
 * 其余请求（含一切 API）原样放行（返回 false），由调用方继续走 Router 鉴权。
 *
 * 接线约定：调用方必须把它放在 Router handler **之前**（boot.ts），
 * 这是"静态页免 token"的唯一实现点；Router 本体不感知门面页。
 */
export function handleHarnessUiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET") return false;
  if (!HARNESS_UI_PATHS.includes(requestPath(req))) return false;
  const body = HARNESS_UI_HTML;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    // 本地运维面板：禁缓存，改版即刷即见（无指纹需求）
    "Cache-Control": "no-store",
  });
  res.end(body);
  return true;
}
