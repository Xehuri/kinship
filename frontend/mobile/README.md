# Kinship - 手机端 WebView 界面

基于 Vue 3 + Vite + TypeScript 构建的移动端单页应用 (SPA)，运行于 Android WebView 中，为用户提供 Kinship 系统的交互界面。

---

## 项目概述

本项目是 Kinship 健康监测系统的手机端前端界面。原始版本是一个 4198 行的单文件 SPA（`index.original.html`），已完整迁移为模块化的 Vue 3 + Vite + TypeScript 架构。

用户通过 Android App 内的 WebView 加载此界面，实现与后端 AI 服务的交互，包括实时聊天、提醒板、报告查看、文件浏览和系统设置等功能。

全部页面使用 v2 壳层（`components/shell/`）：桌面侧栏 6 项（对话 / 计划 / 提醒 / 报告 / 文件 / 设置），移动端底部 4 项（对话 / 计划 / 报告 / 设置）；Chat 页在 >=1180 额外常驻 320px 右侧上下文栏。健康看板与旧 PC/移动端双布局已移除；健康数据入口保留在报告页健康摘要条与 GPS/声纹区域，以及设置页「健康数据」与「数据源」分组。报告页只展示健康清单/日报/周报/复盘四类；文件与 Markdown 代码块统一使用 `CodeSurface`，Markdown 表格支持横向滚动。

---

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Vue 3 | ^3.5.0 | 前端框架 (Composition API + `<script setup>`) |
| Vite | ^6.3.0 | 构建工具 |
| TypeScript | ~5.7.0 | 类型系统 (strict 模式) |
| Vue Router | ^4.5.0 | 路由 (hash 模式) |
| @phosphor-icons/vue | 2.2.1 | 界面图标 (v2 壳层、聊天、设置) |
| @fontawesome/fontawesome-free | ^6.5.1 | 登录/初始化/详情浮层的遗留图标 (待迁移到 AppIcon) |
| 百度地图 JS API (BMap) | v3.0（外部脚本） | GPS 轨迹地图展示，AK 构建时注入 |
| KaTeX | ^0.18.1 | 数学公式渲染 (Markdown 中 LaTeX) |
| Mermaid | ^11.16.0 | 流程图/时序图渲染 (Markdown ```mermaid 块) |
| DOMPurify | ^3.4.15 | HTML/XSS 过滤 (SVG 图块与 Markdown 输出) |
| lz-string | ^1.5.0 | CircuitJS 电路文本压缩 (```circuitjs 块 `?ctz=` 参数) |
| Vitest | ^3.1.0 | 单元测试框架 |
| Playwright | ^1.52.0 | E2E 测试框架 |
| vue-tsc | ^2.2.0 | Vue TypeScript 类型检查 |
| happy-dom | ^17.0.0 | Vitest DOM 环境 |
| jsdom | ^29.1.1 | 测试 DOM 环境 (备用) |
| @vue/test-utils | ^2.4.0 | 组件单元测试工具 |
| @types/node | ^22.0.0 | Node 类型定义 |

严格模式配置（`tsconfig.app.json`）：
- `strict: true` -- 完整严格模式
- `noUnusedLocals: true` -- 禁止未使用的局部变量
- `noUnusedParameters: true` -- 禁止未使用的参数

---

## 项目结构

```
frontend/mobile/
├── src/
│   ├── api/                    # API 客户端层 (14 个模块)
│   │   ├── client.ts           # HTTP 客户端 (原生 fetch 封装, 自动注入 auth, 401 触发登录层)
│   │   ├── backend.ts          # 对话后端热切换 (GET/POST /api/screen/backend)
│   │   ├── health.ts           # 健康数据 API (/api/mobile/dashboard + /api/health/query, 供报告摘要/声纹使用)
│   │   ├── healthCloud.ts      # 小米健康云 API (/api/health/cloud/*, 状态/扫码/同步)
│   │   ├── notifications.ts    # 通知历史 API (/api/notification/history)
│   │   ├── reminders.ts        # 提醒板 API (GET /api/reminders)
│   │   ├── reports.ts          # 报告 API (列表 + Markdown 正文)
│   │   ├── sources.ts          # 数据源健康 API (GET /api/sources/health)
│   │   ├── session.ts          # 会话 API (列表/消息/发送/创建/切换)
│   │   ├── files.ts            # 文件浏览 API
│   │   ├── sse.ts              # SSE 客户端 (/api/screen/events/stream?ticket=)
│   │   ├── ticket.ts           # 一次性连接票据 (POST /auth/ws-ticket, 30s TTL, 用后即焚)
│   │   ├── downloads.ts        # 客户端下载 (PC 采集端 exe, 经一次性票据)
│   │   └── ws.ts               # WebSocket 客户端
│   │
│   ├── components/             # Vue SFC, 按职责分目录
│   │   ├── chat/               # ChatThread / AssistantMessage / Composer / MarkdownContent / DiagramPreview /
│   │   │                       # ToolRow / ContextInspector / FocusDrawer / SkeletonMessages
│   │   ├── common/             # LoginOverlay / SetupOverlay / SplashLoading / DetailOverlay / AppIcon
│   │   ├── dashboard/          # GpsMapOverlay (报告页地图)
│   │   ├── files/              # FileTree / FilePreviewPane / PreviewOverlay / ImagePreview / AudioPreview / SearchResultItem
│   │   ├── notifications/      # NotificationsDrawer / WsLogDrawer
│   │   ├── reports/            # ReportRow / HealthSummaryStrip / HealthMetricChip / VoiceprintSheet
│   │   ├── settings/           # SettingsSection + Account/Appearance/Health/Sources/Device/Debug/About
│   │   ├── shell/              # AppShell / SideNav / MobileNav / PageHeader
│   │   └── voiceprint/         # VoiceprintTab
│   │
│   ├── composables/            # 顶层组合式函数 + chat/ + streaming/
│   │   ├── useApi / useChat / useChatIntegration / useDashboard / useHealthSummary
│   │   ├── useFileBrowser / useGps / useLayout / useMockData / useNotifications
│   │   ├── useRealTime / useReports / useSendMessage / useSetupStatus / useWsLog
│   │   ├── useStreamingMessage / useSubAgents / useTheme / useTopInset / useTtsPlayer / useVoiceprint
│   │   ├── chat/               # historyMerge / historyParsing / sessionList
│   │   └── streaming/          # debug / messageId / partHandlers / pendingReply / placeholder /
│   │                           # sessionHandlers / sseParsing / queueHandlers / userReconcile
│   │
│   ├── config/
│   │   └── navV2.ts            # 导航单一事实来源 (路由/图标/Ctrl+1~6 快捷键)
│   ├── types/                  # 9 个类型文件, 由 index.ts 统一导出
│   │   ├── index.ts / api.ts / chat.ts / health.ts / gps.ts / files.ts / reports.ts / turn.ts / voiceprint.ts
│   ├── router/
│   │   └── index.ts            # 路由配置 (6 个页面 + 404, hash 模式)
│   ├── styles/                 # CSS 变量/主题/壳层样式 (variables, tokens, shell, themes/4 等)
│   ├── utils/                  # format / markdown / messageNormalize / tokenUsage / voiceprint
│   ├── data/
│   │   └── demoMessages.ts     # 统一演示对话 (未登录/调试开关, 含电路仿真案例)
│   ├── views/                  # 6 个页面视图 + NotFound
│   │   ├── ChatView.vue / PlanView.vue / RemindersView.vue / ReportsView.vue / FilesView.vue / SettingsView.vue / NotFoundView.vue
│   ├── App.vue                 # 根组件 (router-view + 登录/初始化覆盖层 + 通知/WS 抽屉 + 快捷键)
│   └── main.ts                 # 入口文件 (挂载 app 和 router)
│
├── e2e/
│   ├── foundation.spec.ts      # 构建产物 /mobile/ + 认证门禁
│   └── visual.spec.ts          # 截图矩阵 (6 surface x 2 主题 x 2 视口)
├── tests/unit/                 # Vitest 测试文件
│   ├── App.test.ts
│   ├── api/                    # files / session / sse / ticket / ws / downloads / backend
│   ├── components/             # 聊天/文件/报告/设置/壳层/通知等组件
│   ├── composables/            # useApi / useChat / useDashboard / useGps / useRealTime / useWsLog 等
│   ├── config/                 # navV2
│   ├── router/                 # router
│   └── utils/                  # format / markdown / messageNormalize
├── public/
│   └── circuitjs1/             # 运行时目录 (gitignored, 由 scripts/fetch-circuitjs.mjs 抓取)
├── dist/                       # 构建产物 (Vite build 输出)
├── index.html                  # Vite 入口 HTML
├── index.original.html         # 原始单文件 SPA (备份, 4198 行)
├── playwright.config.ts        # Playwright 配置
├── vite.config.ts              # Vite 构建配置
├── vitest.config.ts            # Vitest 测试配置
├── tsconfig.json               # TypeScript 项目引用
├── tsconfig.app.json           # TypeScript 应用配置 (strict)
├── tsconfig.node.json          # TypeScript Node 配置
├── env.d.ts                    # 环境类型声明
└── package.json                # 依赖与脚本
```

---

## 架构决策

### Hash 模式路由

Vue Router 使用 `createWebHashHistory()` (hash 模式)：

```typescript
import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/chat', component: () => import('@/views/ChatView.vue'), meta: { shell: 'v2' } },
    { path: '/reminders', component: () => import('@/views/RemindersView.vue'), meta: { shell: 'v2' } },
    { path: '/reports', component: () => import('@/views/ReportsView.vue'), meta: { shell: 'v2' } },
    { path: '/files', component: () => import('@/views/FilesView.vue'), meta: { shell: 'v2' } },
    { path: '/settings', component: () => import('@/views/SettingsView.vue'), meta: { shell: 'v2' } },
    { path: '/:pathMatch(.*)*', component: () => import('@/views/NotFoundView.vue'), meta: { shell: 'v2' } },
  ],
})
```

**原因**：项目部署在后端 FastAPI 服务的 `/mobile/` 路径下，后端有自己的一套路由系统。使用 hash 模式 (URL 格式为 `/#/chat`) 可以避免前端路由与后端路由的冲突，后端只需要 serve `index.html`，前端路由完全由 hash 片段处理。这对于嵌入 Android WebView 的场景尤其重要。导航定义集中在 `src/config/navV2.ts`，路由、桌面侧栏、移动端底栏与 Ctrl+1~6 快捷键均由此派生。

### v2 壳层（唯一布局）

`App.vue` 只渲染 `router-view` 与全局覆盖层/抽屉，不再包含 PC/移动端分支或浮动按钮。每个页面使用 `components/shell/AppShell.vue`：

- 桌面（>=768px）显示左侧栏 6 项；移动端显示底部导航 4 项
- `PageHeader` 固定渲染全局通知铃铛（打开唯一的 `NotificationsDrawer`），页面不再各自实现通知入口
- `ChatView` 由 `<KeepAlive include="ChatView">` 保活，切换页面不丢会话状态
- 主题由 `useTheme` 管理：`<html data-theme>` + 四强调色 + 密度/动效，支持 light / dark / system；旧 glacier 迁移为 light + indigo

### WS 日志与通知抽屉

- `useWsLog.ts` 为模块级单例：App 在 `onMounted` 注册 WS 处理器，`WsLogDrawer.vue` 渲染日志；设置→调试→「WS 日志」打开抽屉。TTS 音频块不入日志，最多保留 200 条。
- `useNotificationsSingleton` 由 AppShell 页头铃铛与提醒页「通知历史」共享，App 只渲染一个 `NotificationsDrawer`。

### 组合式函数替代 Pinia

项目未使用 Pinia 或 Vuex 状态管理库，全部状态管理通过 Vue 3 的 Composition API 组合式函数 (composables) 实现。每个 composable 独立封装一个领域的状态和逻辑：

- **`useChat`** -- 管理聊天消息列表、会话切换、消息历史、Token 用量提取
- **`useStreamingMessage`** -- 处理流式消息的逐 token 渲染（集中式 Store 模式，SSE 直接修改消息 parts）
- **`useSendMessage`** -- 封装消息发送请求与重试逻辑
- **`useSubAgents`** -- 子智能体管理（多级嵌套栈，API + 消息扫描双重数据源）
- **`useDashboard`** -- 健康数据加载与日期导航（报告页摘要与声纹 Tab 使用）
- **`useHealthSummary`** -- 报告页顶部健康摘要条
- **`useGps`** -- 管理 GPS 轨迹数据、百度地图 (BMap) 交互
- **`useFileBrowser`** -- 文件树导航、搜索、面包屑路径
- **`useReports`** -- 报告类别分组、计数与分页
- **`useApi`** -- API 认证状态、token 管理、auth fail 事件
- **`useRealTime`** -- SSE + WebSocket 连接生命周期管理
- **`useChatIntegration`** -- 聊天集成层，协调 SSE 事件到聊天状态的路由
- **`useNotifications`** -- 通知历史抽屉状态（全局单例）
- **`useWsLog`** -- WS 日志缓冲与抽屉状态（全局单例）
- **`useSetupStatus`** -- 后端初始化状态检测 (未初始化时展示 SetupOverlay)
- **`useVoiceprint`** -- 声纹记录标签筛选与展示

**原因**：项目规模适中 (6 个页面)，composable 模式比 Pinia 更轻量，避免了额外的依赖。同时 composable 天然支持 tree-shaking，按需引入。

### 自定义 Markdown 渲染器

`src/utils/markdown.ts` 包含一个自实现的 Markdown 解析/渲染器，未使用任何第三方 Markdown 库 (如 marked、markdown-it)，SVG 注入前用 DOMPurify 过滤。

**原因**：
- 减少依赖体积，项目只需要支持 Markdown 子集 (标题、列表、代码块、加粗、链接等)
- 完全控制渲染行为，方便与流式文本渲染 (SSE 逐 token) 集成
- 避免 XSS 风险，渲染器只生成受控的 HTML 结构

**图块渲染能力** (通过代码块语言识别)：

| 语言 | 渲染方式 | 用途 |
|------|---------|------|
| ` ```katex` / `$...$` / `$$...$$` | KaTeX 渲染 | 数学公式 |
| ` ```svg` | 原样注入 SVG (经过 XSS 过滤 + 自动扩展 viewBox) | 电路图/示意图，AI 生成矢量图 |
| ` ```mermaid` | Mermaid 运行时渲染 (MarkdownContent.vue watch) | 流程图/时序图/状态图 |
| ` ```circuitjs` / ` ```circuit` | CircuitJS1 iframe 内嵌仿真器 (LZString 压缩电路经 `?ctz=` 加载) | 可交互电路仿真 |

SVG 图块在 `renderMarkdown` 中通过占位符提取（`escapeHtml` 之前保留原始内容），输出为 `<div class="svg-diagram">`；Mermaid 块输出为 `<div class="mermaid-block">`，由 `MarkdownContent.vue` 在 DOM 挂载后调用 `mermaid.render()` 逐个渲染。CircuitJS 块输出为 `<div class="circuitjs-block" data-ctz="...">`，由 `MarkdownContent.vue` 挂载 iframe（查看模式: `hideMenu=true&hideSidebar=true&editable=false`）+ 右上角放大按钮；电路文本经 `lz-string` 压缩后经 URL 参数传给仿真器；仿真器静态产物由 `scripts/fetch-circuitjs.mjs` 在 dev/build 前从独立 GPL-2.0 仓库 `Xehuri/kinship-circuitjs` 抓取到 `public/circuitjs1/`（gitignored），再随构建进入 dist。

**图块显示与交互**：
- **自动扩展 viewBox** (`markdown.ts` 的 `fitSvgElement`): AI 生成的 SVG 内容常超出 viewBox 范围被裁剪，渲染后遍历子元素计算 bbox 并集自动扩展 viewBox + 同步 aspect-ratio
- **点击全屏浮窗** (`DiagramPreview.vue`): 点击 svg/mermaid 图块打开全屏浮窗，支持滚轮/双指缩放 (0.25~10x)、拖拽平移、双击缩放/重置、Esc 关闭、下载 PNG (2x 高清，深色背景)；点击 circuitjs 放大按钮打开完整 UI 仿真器（可编辑元件参数、切换波形），关闭按钮位于右上角（白底高对比）
- **占满宽度**: 含图块的 AI 消息在聊天流中占满可用宽度，图块高度限制为画面 2/3（66vh），移动端减小 padding 让图更大

**演示模式 (未登录/调试开关)**：`ChatView.vue` 在未登录（`isDemoMode`）或 `USE_MOCK_DATA` 开关开启时显示 `src/data/demoMessages.ts` 中的统一演示对话（覆盖健康概览/SVG 电路图/Mermaid/CircuitJS 仿真/表格/工具卡片/推理块等全部渲染能力），方便调试 UI。登录且开关关闭后自动加载真实会话。

### SSE + WebSocket 双通道实时连接

项目同时维护两条实时通信通道：

- **SSE (Server-Sent Events)** -- 接收 AI 响应流与消息通知，端点 `/api/screen/events/stream?ticket=`；发送消息走 `POST /api/screen/session/message`
- **WebSocket** -- 双向通信，用于文件变更推送、系统状态更新

由于 EventSource / WebSocket / 下载链接无法携带 `Authorization` 头，连接认证改用一次性 ticket：`api/ticket.ts` 经 `POST /auth/ws-ticket` 获取随机、30 秒过期、用后即焚的票据，每次建立连接（含重连）都需重新获取。

连接由 `useRealTime` composable 统一管理，包括：
- 自动重连 (token 过期后登录成功自动恢复)
- 连接状态追踪 (`connectedSSE`、`connectedWS`)
- 优雅断开 (`disconnect()`)

### 顶部页边距调节 (全面屏状态栏避让)

Android WebView 下 `env(safe-area-inset-top)` 常为 0 (缺少 `viewport-fit=cover` 或系统未上报)，导致全面屏手机的状态栏压住页面顶部的悬浮控件 (例如全屏预览右上角的关闭按钮)。因此在设置页「外观」组提供手动调节：

- `composables/useTopInset.ts` (模块级单例，与 `useTheme` 同构)：持久化到 `localStorage('top_inset')`，写入 `<html>` 的 `--user-top-inset`，范围 0-80px / 步长 4px
- CSS：`--app-top-inset = max(--user-top-inset, env(safe-area-inset-top, 0px))` (不支持 `max()` 的旧 WebView 退回用户值)
- 应用点：各**全屏浮层**头部/关闭按钮 (DiagramPreview / ImagePreview / PreviewOverlay / DetailOverlay / NotificationsDrawer / WsLogDrawer / GpsMapOverlay / 调试面板 / LoginOverlay)
- **关键规则**：由页面级容器统一负责加 inset，页面内的顶栏/列表容器 **不可重复加** —— 双重叠加会导致"同一个数值在各页面位移不同"
- 页面内 `position: sticky` 表头（如 `VoiceprintTab`）的 `top` 需与所在页面 padding-top 对齐：`calc(16px + var(--app-top-inset))`
- **仅移动端生效**：`base.css` 在 `min-width: 768px` 下把 `--app-top-inset` 强制归零 (PC 无遮挡问题)
- `main.ts` 在挂载前应用该值，避免首屏渲染出旧位置后跳动

### PC 采集端下载

设置页「设备」组提供 Windows PC 状态采集器 Kinship Sensor（产物 `Kinship-PCSensor.exe`）的下载入口 (仅 PC 端显示，手机 WebView 未实现 `DownloadListener`)：

- 前端 `api/downloads.ts`：`fetchPcSensorInfo()` 查询文件信息 (大小)，`downloadPcSensor()` 先取一次性 ticket，再用 `<a download>` 触发浏览器原生下载
- 后端 `routers/pc_sensor_download.py`：`GET /api/pc-sensor/info` + `GET /api/pc-sensor/download`；后者在 `QUERY_CREDENTIAL_PATH_PREFIXES` 白名单内，接受 `?ticket=` (浏览器无法携带 Authorization 头)
- exe 不在 git 中 (`*.exe` / `dist/` 被 .gitignore 忽略)，服务端需先运行 `desktop/pc-sensor/build.bat`；路径可用 `pc_sensor.exe_path` 或环境变量 `PC_SENSOR_EXE_PATH` 覆盖

---

## 页面路由

| 路径 | 视图 | 功能 |
|------|------|------|
| `/#/chat` | ChatView | AI 对话 (流式输出、工具调用、会话管理、上传/TTS) |
| `/#/plan` | PlanView | 当日只读计划 (状态/版本/复盘时间、7 检查点覆盖、计划条目、到期长期任务；重排走对话) |
| `/#/reminders` | RemindersView | AI 写下的只读提醒板 |
| `/#/reports` | ReportsView | AI 报告列表、健康摘要条、地图与声纹 |
| `/#/files` | FilesView | 手机文件浏览 (目录树、搜索、文件预览) |
| `/#/settings` | SettingsView | 系统设置 (账户/外观/健康/数据源/设备/调试/关于) |
| 其他 | NotFoundView | 404 兜底，回到对话 |

桌面侧栏 6 项（对话 / 计划 / 提醒 / 报告 / 文件 / 设置），移动端底部 4 项（对话 / 计划 / 报告 / 设置），共享 `config/navV2.ts` 配置；计划页插在对话之后、提醒之前（桌面第二项；移动端对话之后），默认路由仍为 `/chat`；`/dashboard` 已移除并落入 404。

---

## 构建与部署

### 开发

```bash
# 启动开发服务器, 应用地址 http://localhost:5173/mobile/
# (base 为 /mobile/, dev 端口 5173, proxy 转发到后端 HTTPS 127.0.0.1:8768)
npm run dev
```

`dev` / `build` / `build:e2e` / `build:atomic` 会先运行 `scripts/fetch-circuitjs.mjs`：若 `public/circuitjs1/circuitjs.html` 已存在且未指定 `CIRCUITJS_LOCAL_DIR` 则跳过；指定 `CIRCUITJS_LOCAL_DIR` 时从本地 checkout 复制，用 `MANIFEST.sha256` 校验每个文件，并解析 `circuitjs1.nocache.js` 的 GWT strong name 确认所有 `*.cache.js` 载荷齐全；否则从 `Xehuri/kinship-circuitjs` 的 `v0.1.1` tag 浅克隆。也可单独运行 `npm run fetch:circuitjs`。

> **发布前置**：`Xehuri/kinship-circuitjs` 目前只在本地，尚未推送远端。在 `v0.1.1` tag 发布前，默认克隆路径必然失败；离线构建请设置 `CIRCUITJS_LOCAL_DIR=/path/to/kinship-circuitjs`。抓取脚本会明确报错，不会伪造下载成功。

### 构建

```bash
# 类型检查 + 构建 (输出到 dist/)
npm run build

# 生产原子构建 (输出到 dist-<时间戳>, 不覆盖 dist/)
npm run build:atomic

# 校验最新 dist-<时间戳> 的 index.html 引用与资产完整性
npm run verify:dist

# 仅类型检查, 不构建
npm run typecheck

# 预览 dist/ 构建产物
npm run preview
```

构建配置 (`vite.config.ts`)：
- `base: '/mobile/'` -- 适配后端 `/mobile/` 路径部署
- `target: 'es2015'` -- 兼容 Android WebView 的 JS 引擎
- `outDir: 'dist'` -- 构建输出目录
- `@` 路径别名指向 `./src`
- `VITE_BAIDU_MAP_AK` 在构建/开发时从仓库根目录的 `config.yaml`（键 `baidu_map_ak`）读取并注入，不依赖 `.env` 文件

### 部署

1. `npm run build:atomic` 构建到 `dist-<时间戳>`
2. `npm run verify:dist` 校验 index.html 引用与资产完整性
3. 备份旧 `dist/`（如 `cp -a dist dist-backup-<时间戳>`），把旧目录改名为 `dist-old-<时间戳>`，把新目录改名为 `dist`
4. 静态产物按请求读取，仅前端变更无需重启后端；后端代码/路由变更仍需重启
5. Android WebView 加载 URL: `https://<host>:<port>/mobile/`

当前生产部署（2026-10-25 20:06 CST）：`https://health.example.com/mobile/`（IPv4）与同域名 `:8443`（IPv6）；产物 `assets/index-ClJhwC_O.js` / `assets/index-MFa6qXpn.css`，设置路由 `SettingsView-BnO4yrGQ.js` / `SettingsView-Bx6sYfGe.css`；旧产物备份 `frontend/mobile/dist-backup-20261025-200603`。部署记录见 [../../docs/frontend-settings-redesign-2026-10-25.md](../../docs/frontend-settings-redesign-2026-10-25.md)。

> **注意**：每次更新前端代码后需重新构建并原子替换 `dist/`，否则 Android App 加载的仍是旧构建产物。仅前端变更无需重启后端；后端代码或路由变更仍需重启。

---

## 测试

### 单元测试 (Vitest)

```bash
npm run test:unit
```

- 框架: Vitest 3 + happy-dom (DOM 环境)
- 配置: `vitest.config.ts` (与 Vite 共享别名配置)
- 数量: 91 个测试文件 / 973 个用例
- 覆盖范围:
  - API: files、session、sse、ticket、ws、downloads、backend
  - 组件: 聊天 (ChatThread、AssistantMessage、Composer、MarkdownContent、DiagramPreview、ToolRow、ContextInspector、ConfirmDialog、MeterBar、FocusDrawer)、壳层 (AppShell)、通知 (NotificationsDrawer、WsLogDrawer)、设置 (SettingsView、SettingsDebug、Appearance/Account/Sources)、报告 (ReportRow、HealthSummaryStrip、VoiceprintSheet)、地图 (GpsMapOverlay)
  - 组合式函数: useApi、useChat、useDashboard、useFileBrowser、useGps、useNotifications、useRealTime、useReports、useSetupStatus、useStreamingMessage、useSubAgents、useTheme、useWsLog
  - 其他: config (navV2)、router、utils (format、markdown、messageNormalize)

### E2E 测试 (Playwright)

```bash
npm run test:e2e
npm run build:e2e && npx playwright test e2e/foundation.spec.ts --reporter=line --workers=1
npm run qa:shots -- --only plan
npm run qa:shots:check -- <dir> 4
```

- 框架: Playwright 1.52
- 配置: `playwright.config.ts` (仅 Chromium，使用 Playwright 自带 Chromium，不使用系统 `chrome` channel；`build:e2e` 输出 `dist-e2e/`，gitignored)
- 覆盖范围:
  - `foundation.spec.ts`: 构建产物经 `/mobile/` 提供服务并受登录门禁保护
  - `visual.spec.ts`: 6 个 surface x 2 主题 x 2 视口截图矩阵，共 24 张 (`--only` / `--out` 或 `VISUAL_ONLY` / `VISUAL_OUT` 过滤，`qa:shots:check` 校验 24 张)

---

## 常见问题排查

### 401 认证错误

页面自动弹出 LoginOverlay 登录覆盖层。如果看到登录界面：

1. 输入用户名和密码登录
2. 登录成功后覆盖层关闭，实时连接自动重连 (SSE + WS)
3. 在 Android App 内，原生 401 重登后会把新 token 注入 WebView，登录层可能闪现后自动关闭；若持续停留，确认已安装包含 WebTokenBridge 的新 APK，并杀掉 App 重开
4. 独立浏览器没有原生注入，仍按原逻辑要求重新登录；如果反复弹出，检查后端服务是否正常运行

### 静态资源不更新

修改代码后页面未生效：
1. 运行 `npm run build:atomic` 重新构建，校验后原子替换 `dist/`
2. 确认 `dist/` 目录中文件时间戳已更新
3. 如果仍不生效，尝试在 Android App 中清空 WebView 缓存

### 后端重启后的操作

后端服务重启通常不会使 token 失效（token 持久化在 `backend/config/auth.json`）；若 token 已过期，Android App 会通过原生重登自动续期，独立浏览器需重新登录。可通过以下端点重启后端：

```bash
POST /api/screen/restart
Authorization: Bearer <token>
```

---

## 迁移状态

原始版本为单文件 SPA（`index.original.html`，4198 行），已完整迁移至模块化的 Vue 3 + Vite + TypeScript 架构。迁移覆盖：

- [x] 组件拆分 -- 9 个组件目录，共 58 个 Vue SFC
- [x] 类型系统 -- 9 个类型文件，`index.ts` 统一导出
- [x] 组合式函数 -- 26 个顶层 composables (+ chat/streaming 子模块) 管理状态和逻辑
- [x] API 层 -- 14 个 API 模块封装后端接口
- [x] 样式模块化 -- 12 个全局样式文件 (8 个顶层 + 4 套主题) 按职责分离
- [x] 配置集中 -- `config/navV2.ts` 作为导航/路由/快捷键单一事实来源
- [x] v2-only 壳层 -- 旧双布局、看板、旧导航与浮动按钮已删除
- [x] 测试覆盖 -- 91 个单元测试文件 / 973 个用例 + 全量 49 个 Playwright 场景
- [x] 构建脚本 -- Vite 构建 + vue-tsc 类型检查 (`build:atomic` 输出 dist-<时间戳>；`build:e2e` 输出 dist-e2e)
- [x] 原始文件保留 -- `index.original.html` 作为备份

---

## 许可证

本项目采用 Apache-2.0，详见 [LICENSE](LICENSE)。

CircuitJS1 采用 GPL-2.0，已迁至独立仓库 `Xehuri/kinship-circuitjs`，由 `scripts/fetch-circuitjs.mjs` 在 dev/build 前抓取，不在本仓库公开树中分发。第三方声明见仓库根目录 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。
