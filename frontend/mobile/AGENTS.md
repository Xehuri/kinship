# 前端 SPA -- Vue 3 / TypeScript (Android WebView)

## 概览

Kinship 的手机端界面。运行在 Android App 的 WebView 中，提供 AI 聊天、提醒、报告、文件浏览和系统设置功能。全部页面使用 v2 壳层（`components/shell/`），已移除旧 PC/移动端双布局与健康看板。

信息架构：桌面 6 项（对话 / 计划 / 提醒 / 报告 / 文件 / 设置），移动端底部 4 项（对话 / 计划 / 报告 / 设置）；Ctrl+1~6 与桌面顺序一致。计划页插在对话之后、提醒之前（第二项），不改变默认路由 `/chat`。

## 目录结构

```
src/
├── api/               # HTTP 客户端 + 14 个 API 模块
├── components/        # 10 个目录
│   ├── chat/          # 聊天 (ChatThread, AssistantMessage, Composer, MarkdownContent, DiagramPreview, ToolRow, ContextInspector, FocusDrawer 等)
│   ├── common/        # 通用 (LoginOverlay, SetupOverlay, SplashLoading, DetailOverlay, AppIcon)
│   ├── dashboard/     # 仅 GpsMapOverlay（报告页地图）
│   ├── files/         # 文件 (FileTree, FilePreviewPane, PreviewOverlay, ImagePreview, AudioPreview, SearchResultItem)
│   ├── notifications/ # 通知抽屉 (NotificationsDrawer) 与 WS 日志抽屉 (WsLogDrawer)
│   ├── plan/          # 计划只读展示 (CoverageStrip, PlanItemRow, LongTaskList)
│   ├── reports/       # 报告行与健康摘要 (ReportRow, HealthSummaryStrip, VoiceprintSheet, HealthMetricChip)
│   ├── settings/      # 设置分节 (Account/Appearance/Health/Sources/Device/Debug/About)
│   ├── shell/         # v2 壳层 (AppShell, SideNav, MobileNav, PageHeader)
│   └── voiceprint/    # 声纹 (VoiceprintTab)
├── composables/       # 顶层组合式函数 + chat/ + streaming/ (含 queueHandlers/userReconcile)
├── config/            # navV2.ts -- 导航/路由/快捷键的单一事实来源
├── types/             # TypeScript 类型定义 (9 文件)
├── utils/             # 工具函数 (format, markdown, codeFormat, messageNormalize, tokenUsage, voiceprint)
├── data/              # 静态演示数据 (demoMessages.ts - 统一演示对话, 含电路仿真)
├── router/            # hash 模式路由配置 (6 页面 + 404)
├── styles/            # CSS 变量/主题/壳层样式
├── views/             # 6 个页面视图 (Chat/Plan/Reminders/Reports/Files/Settings) + NotFound
├── App.vue            # 根组件 (仅 router-view + 全局覆盖层/抽屉)
└── main.ts            # 入口
```
另有 `public/circuitjs1/`（gitignored，由 `scripts/fetch-circuitjs.mjs` 在 dev/build 前从独立 GPL-2.0 仓库 `Xehuri/kinship-circuitjs` 抓取，随构建进入 dist，供 ```circuitjs 图块 iframe 引用）。

## 约定

- Vue 3 Composition API + `<script setup lang="ts">`，严格 TS 模式
- 无 Pinia/Vuex -- 所有状态由 composables 管理
- Vue Router hash 模式 (`createWebHashHistory`)，路径别名 `@` -> `./src`
- 组件命名: PascalCase，文件与组件名一致
- 组合式函数命名: `useXxx` 驼峰，一个文件一个 composable
- 类型文件按领域拆分 (chat.ts, health.ts, gps.ts ...)，统一从 `types/index.ts` 导出
- API 模块按后端资源拆分: `client.ts`, `backend.ts`, `health.ts`, `healthCloud.ts`, `notifications.ts`, `reminders.ts`, `session.ts`, `files.ts`, `reports.ts`, `sources.ts`, `sse.ts`, `ws.ts`, `ticket.ts`, `downloads.ts`
- 设备标识: `composables/useDeviceId.ts` 提供稳定持久的 `device_id`；`api/client.ts` 对所有 HTTP 请求注入 `X-Device-Id` 头，`api/ws.ts` 在连接 URL 携带 `device_id` + `client=web`（后端据此做 TTS 设备路由）
- CSS 变量全局管理颜色/间距/字体，不写内联样式

## 关键架构

| 决策 | 说明 |
|------|------|
| v2 壳层（唯一布局） | `App.vue` 只渲染 `router-view` 与全局覆盖层；每个页面用 `components/shell/AppShell.vue` 提供侧栏/底部导航与 `PageHeader`；Chat 页提供 `#inspector` 槽：>=1180 为常驻 320px 第三列，768-1179 为可开合右抽屉，<768 走移动浮层。AppShell 页头固定渲染全局通知铃铛（`useNotificationsSingleton().open()`），页面自身不再放通知入口。`ChatView` 由 `<KeepAlive include="ChatView">` 保活。主题模型由 `useTheme` 管理：`light/dark/system` + 四强调色 + 密度/动效；旧 `glacier` 一次性迁移为 `light + indigo`。 |
| 自定义 Markdown 渲染器 | `utils/markdown.ts` 自实现，无第三方 Markdown 库，避免 XSS 且兼容流式渲染。图块支持: `$`/`$$` LaTeX(KaTeX)、` ```svg ` 电路图(经XSS过滤原样注入 + 自动扩展viewBox)、` ```mermaid ` 流程图(运行时渲染)、` ```circuitjs `/` ```circuit ` 电路仿真(CircuitJS1 iframe 内嵌, 查看模式隐藏菜单/侧边栏/只读, 右上角放大按钮进完整可编辑仿真器)。图块点击打开全屏浮窗(`DiagramPreview.vue`): svg 滚轮/双指缩放、拖拽平移、下载PNG, circuitjs 完整 UI 仿真; 含图块消息气泡占满聊天框宽度, 高度限制画面2/3 |
| 未登录演示模式 | `ChatView.vue` 检测登录状态，未登录或 USE_MOCK_DATA 开关开启显示 `data/demoMessages.ts` 统一演示对话(含电路仿真)，登录且开关关闭后自动切换真实会话 |
| 顶部页边距 | 全面屏手机状态栏会压住页面顶部的悬浮控件(如全屏浮窗关闭按钮)，且 Android WebView 下 `env(safe-area-inset-top)` 常为 0，无法纯自动避让，故提供手动调节(设置→外观→顶部页边距)：`useTopInset.ts` 持久化到 localStorage(`top_inset`) 并写 `<html>` 的 `--user-top-inset`，最终值 `--app-top-inset = max(--user-top-inset, env(safe-area-inset-top))` 作用于**各全屏浮层头部**(DiagramPreview / ImagePreview / PreviewOverlay / DetailOverlay / NotificationsDrawer / WsLogDrawer / GpsMapOverlay / 调试面板 / LoginOverlay)。**关键规则：由页面级容器统一负责加 inset，页面内的顶栏/列表容器绝不可再加，否则双重叠加会导致各页面边距效果不一致**；页面内 `position: sticky` 表头(如 `VoiceprintTab`)的 `top` 需与所在页面 padding-top 对齐(`calc(16px + var(--app-top-inset))`)。**仅移动端生效**(PC 由 `base.css` 媒体查询归零)。`main.ts` 在挂载前应用该值以防首屏跳动 |
| PC 采集端下载 | 设置页「设备」组(**仅 PC 显示**，手机 WebView 无 DownloadListener)：`api/downloads.ts` 先取一次性 ticket，再用 `<a download>` 拉 `/api/pc-sensor/download?ticket=`；exe 不入 git(`*.exe`/`dist/` 被 .gitignore 忽略)，服务端需 `desktop/pc-sensor/build.bat` 构建，路径由 `pc_sensor.exe_path` / 环境变量 `PC_SENSOR_EXE_PATH` 覆盖 |
| SSE + WebSocket | 双通道实时连接，`useRealTime` 统一管理自动重连和生命周期。SSE/WS/下载改用一次性连接票据: `ticket.ts` 经 `POST /auth/ws-ticket` 取票(30s TTL, 用后即焚), 禁止缓存长期 token |
| 外部 Token 刷新 | `useApi.ts` 以模块级单例监听 `axeuh-token-refresh`：detail 兼容非空字符串或 `{ token, wasLoggedIn? }`；写入前快照 `wasLoggedIn`，再 `setToken`、写 `localStorage.mobile_token`、置 `isLoggedIn=true`，并经 `onTokenRefresh`/`offTokenRefresh` 通知订阅方。`App.vue` 在 `wasLoggedIn=false` 或登录层可见时关闭 `LoginOverlay` 并重连 SSE/WS；已登录且无登录层时只换 token。`initToken` 消费 URL `?token=` 后 `history.replaceState` 剥离该参数（保留 device_id/hash）。`client.ts` 仅当请求发出时的 token 仍等于当前 token 才在 401 触发 auth-fail。事件由 Windows 桌面壳与 Android `WebTokenBridge` 共同派发；Android bootstrap URL 可携带一次 token，由 SPA 消费后立即剥离，后续刷新只走事件，不写日志 |
| 双通道会话分账 (W44/W45/W46) | 会话列表优先取 `/session/list` 的 `sessions` 键（条目带 `backend:"loom"\|"opencode"`；老后端回退 `local_sessions`/裸数组），会话列表 UI 已移除，`/session/list` 的 sessions 键与模块级 **sid→backend map** 仍保留（用于 currentSessionId、SSE 活跃会话守卫与请求路由）（loadSessions 从带标条目填充；新建会话按 `defaultBackend` 乐观入 map、待列表刷新对账；导出 `getSessionBackend/setSessionBackend`），出线一律按 map 路由——sendMessage body 可选 `backend`（未映射=键不出现）、loadChatHistory/children 有值才拼 `?backend=`（未映射=无查询串=老语义逐字保持）、switchSession body 带 `backend`（W46：engine 直建会话由后端核验收编，不再 404；503=引擎暂不可达可重试）；`defaultBackend` 经 GET `/backend` 种植（成功前每次 loadSessions 重试、GET-only 绝不 POST）；`partHandlers.ts` 守卫收紧：`activeSessionId` 在场时事件帧 sessionID 不等或**缺失即丢弃、不建占位符**；Loom 外部发送的用户消息由 `session.queue` 建立轮次边界，OpenCode 外部用户消息由 `message.updated(role=user)` 对账（真实捕获 194 条 part 帧全部带 sessionID，零误伤面；无 active 时兼容直通不变）；历史消息按 50 条一页、`before` 游标上翻，loom 孤儿 toolResult 壳渲染为独立 AI 气泡 + 工具卡（见注意事项） |
| 设备标识 / TTS 路由 | `useDeviceId.ts`(模块级缓存 + localStorage) 提供稳定设备 UUID：优先读 URL `?device_id=`(App 注入)、否则读 `localStorage['axeuh_device_id']`、否则生成 `web-<uuid>`。`api/client.ts` 对所有请求注入 `X-Device-Id`，`api/ws.ts` 握手携带 `device_id` + `client=web`；后端据此把 TTS 定向回最近发消息的设备 |
| TTS 音量 | `useTtsPlayer.ts` 在 `AudioBufferSourceNode` 与 `destination` 间插入模块级 `GainNode`；音量 0-100 来自 App 注入的 URL `?tts_volume=`(优先) 或 `localStorage['tts_volume']`，并由原生 `MobileActivity.onResume` 经 `window.__axeuhSetTtsVolume(v)` 实时更新；`setTtsVolume`/`getTtsVolume` 已导出 |
| Vite 构建 | `base='/mobile/'` + `target='es2015'`，适配后端 `/mobile/` 路径和 WebView JS 引擎 |

## 命令

以下在 `frontend/mobile/` 目录下执行：

```bash
npm run dev           # 开发服务器 (http://localhost:5173/mobile/, proxy 到后端 HTTPS 127.0.0.1:8768)
npm run build         # vue-tsc 类型检查 + Vite 构建 -> dist/
npm run build:atomic  # 构建到 dist-<时间戳>，供生产原子替换（不直接覆盖 dist/）
npm run verify:dist   # 校验 index.html 引用与资产完整性
npm run build:e2e     # 同上, 输出到 dist-e2e/ (仅 E2E/截图验证, 不动生产 dist)
npm run preview       # 预览 dist/ 构建产物
npm run typecheck     # 仅类型检查，不构建
npm run test:unit     # Vitest 单元测试 (happy-dom)
npm run test:e2e      # Playwright E2E 测试 (chromium)
npm run qa:shots -- --only plan   # 视觉截图矩阵 (6 surface x 2 主题 x 2 视口, --only 过滤)
npm run qa:shots:check -- <dir> 24
```

## 注意事项

- `npm run build` 后产物在 `dist/`，后端自动从 `frontend/mobile/dist/` 提供静态文件服务
- 生产部署：`npm run build:atomic` 构建到 `dist-<时间戳>`，`npm run verify:dist` 校验后备份旧 `dist/` 并原子替换。仅前端变更无需重启后端，后端代码/路由变更仍需重启。2026-10-25 20:06 生产产物 `assets/index-ClJhwC_O.js` / `assets/index-MFa6qXpn.css`（设置路由 `SettingsView-BnO4yrGQ.js` / `SettingsView-Bx6sYfGe.css`），旧产物备份 `dist-backup-20261025-200603`，详见 [../../docs/frontend-settings-redesign-2026-10-25.md](../../docs/frontend-settings-redesign-2026-10-25.md)
- Android WebView 访问 URL: `https://<host>:<port>/mobile/`
- 每次修改前端代码后必须 `npm run build`，否则 App 加载的是旧构建产物
- 原始单文件 SPA (4198 行) 保留在 `index.original.html` 作为备份
- 所有调试连接用 HTTPS，不要降级到 HTTP
- 本目录是主前端目录；另有 `frontend/preview/` 与 `frontend/vaudit/`（原 `../refactor/` 测试沙箱已于 2026-09-10 合并删除）；开发直接改 `src/`，`npm run dev` 起带 proxy 的本地开发服务器
- **FontAwesome 残留**：`@fortawesome/fontawesome-free` 仍被 `LoginOverlay` / `SetupOverlay` / `DetailOverlay` 的 `fa-` 类使用；这三处迁移到 AppIcon 前不得移除依赖。其余新 UI 只用 `@phosphor-icons/vue`。
- **WS 日志**：`useWsLog.ts` 是模块级单例，App 注册 WS 处理器，设置→调试→「WS 日志」打开 `WsLogDrawer`；不再有浮动按钮。TTS 音频块不写入日志。
- 设置页不再提供「Web 对话通道」开关；默认通道仍由后端 `web_backend.json` 决定，`useChat` 只 GET 种植、绝不 POST；已有会话按 sid→backend map 路由；SSE 恒 loom+opencode 双流多路复用，帧归属按 `payload.properties.backend` 判别；子智能体返父走 `switchSession(parent.sessionId)`
- **报告与代码面**：`/api/mobile/reports` 只返回 health/daily/weekly/review 四类；报告页按类别分组，不渲染标签 chip。文件与 Markdown fence 共用 `components/code/CodeSurface.vue`（行号、横向滚动、JSON 美化），Markdown 表格用 `.table-scroll` 横滚。
- **文件树状态**：选中文件必须用 `FileTreeRow.path`；目录导航成功后才写 `currentPath`，失败保留旧树并内联重试；`FileTree` 只在无行时显示骨架。
- **历史分页**：首屏 `loadChatHistory` 不带 `limit`（后端默认 `limit=50`），响应 `next_cursor` 存入 `nextCursor`；`loadMoreHistory` 以它为 `before` 拉更早一页，`prependChatMessages` 前插并按 id 去重（加载更早页不显示骨架屏，见 `useChat.ts`）
- **孤儿 toolResult 渲染**：loom 页级转换留下的独立 `role="toolResult"` 壳由 `useTurnViews`/`turnAdapter` 归入 AI 轮次，在 `ChatThread` 中按原始时间点渲染为独立 AI 气泡 + 工具行。它必须出现在原始时间点：13:04 的 read 卡不能被并到 13:12 的最终纯文本回复下面
