# Frontend Refactor Vue - Learnings

## Task 10: ChatView 顶层组件 + 消息列表

### CSS 类名映射 (index.original.html -> Vue)

| 原始类名 | 用途 | 备注 |
|---------|------|------|
| `#page-chat` | 聊天页面容器 | `display:flex; flex-direction:column; overflow:hidden` |
| `.session-bar` | 会话顶栏 | flex 布局, 包含标题和新建按钮 |
| `.session-current` | 当前会话标题 | font-size:15px, font-weight:700 |
| `.session-arrow` | 下拉箭头 | font-size:11px |
| `.new-session-btn` | 新建会话按钮 | 30px 圆形按钮 |
| `.chat-msgs` | 消息列表容器 | `flex:1; overflow-y:auto` |
| `.chat-date` | 日期分隔 | 居中, font-size:11px |
| `.message` | 消息条目 | flex 布局, gap:10px |
| `.message.ai` / `.message.user` | 角色区分 | user 使用 `flex-direction:row-reverse` |
| `.avatar` | 头像 | 32px 圆形 |
| `.bubble` | 消息气泡 | max-width:80%, border-radius:16px |
| `.typing-indicator` | 打字指示器 | 3个 dot 动画 |
| `.chat-input-bar` | 底部输入栏 | flex-shrink:0, z-index:600 |

### Composable 使用模式

- 使用 `useChatSingleton()` 获取共享会话状态
- 使用 `useStreamingMessageSingleton()` 获取共享流式状态
- 单例模式确保跨组件状态一致

### ChatMessage 类型结构

```typescript
interface ChatMessage {
  info?: { role: MessageRole }  // 优先使用
  role?: MessageRole            // 备选
  timestamp?: string            // ISO 时间戳
  created_at?: string           // 备选时间戳
  content?: string              // 纯文本
  text?: string                 // 备选文本
  parts?: MessagePart[]         // 结构化消息
}
```

### 日期分组逻辑

- 按消息时间戳分组
- 显示: 今天 / 昨天 / YYYY年M月D日 星期X
- 每组前显示 `.chat-date` 分隔

### 页面状态管理

- 使用 `PageState` 组件显示 loading/empty/error
- `v-show` 控制消息列表显示 (避免重新渲染)
- 条件: loadingMessages / 无会话 / 无消息且非流式

## Task 16: Chat page Vitest unit tests

### Test files created
| 文件 | 测试数 | 说明 |
|------|--------|------|
| `tests/unit/utils/markdown.test.ts` | 23 | Markdown 语法渲染测试 |
| `tests/unit/composables/useStreamingMessage.test.ts` | 15 | SSE 流式事件处理测试 |
| `tests/unit/composables/useChat.test.ts` | 20 | 会话 CRUD 和消息发送测试 |
| `tests/unit/components/MessageBubble.test.ts` | 12 | AI/User 角色渲染测试 |
| `tests/unit/components/ChatInput.test.ts` | 12 | 输入绑定/发送/禁用状态测试 |

### RenderMarkdown 已知问题
- `escapeHtml` 在 Markdown 解析前执行，导致 `>` 被转义为 `&gt;`
- 影响: blockquote、Obsidian callouts 语法暂不生效
- 证据: `> 引用文本` 输出 `<p>&gt; 引用文本</p>`

### useStreamingMessage 测试注意点
- `_resolveAssistantReply` 是模块级普通变量 (非 ref/非 reactive)
- `hasPendingReply` computed 依赖此变量，但无响应式追踪，值会被**缓存**
- 因此测试 `hasPendingReply.value` 状态变化不可靠，改用 promise resolve 验证

### 测试 Mock 模式
- `vi.hoisted()` 用于创建 mock 函数，确保在 `vi.mock` 工厂前可用
- API 模块使用 `vi.mock('@/api/session', () => mockObject)` 模式
- 流式单例使用 `vi.mock` 返回 mock 对象，控制 `createPendingPromise` 等

### 测试运行结果
- 82 tests, 5 files, ALL pass
- `npx vue-tsc --noEmit` passes (test files 不在 tsconfig 包含范围内)

### 布局结构

```
#page-chat (flex column)
├── .session-bar (顶栏)
├── PageState (条件显示)
├── .chat-msgs (消息列表, flex:1)
│   ├── .chat-date (日期分隔)
│   ├── .message (消息条目)
│   └── .typing-indicator (流式时显示)
└── .chat-input-bar (底部输入栏)
```

## Task 25: FilesView + FileTree/FileItem

### 创建的文件

| 文件 | 说明 |
|------|------|
| `src/components/files/FileItem.vue` | 递归文件/目录项，自管理展开/折叠和子项加载 |
| `src/components/files/FileTree.vue` | 文件树容器，接收 FileEntry[] 渲染 FileItem 列表 |
| `src/views/FilesView.vue` | 文件浏览页面，面包屑导航+搜索+文件树 |

### FileEntry 类型与 API 差异

实际 `FileEntry` 类型 (src/types/files.ts) 与 spec 有差异：
- **无 `path` 字段**: 需要通过 parentPath + name 拼接
- **无 `children` 字段**: API 是扁平的目录列表，子项由 FileItem 自管理（调用 `fetchDirectory` 加载）
- **`modified_at`**: 对应 spec 的 `modified`

### 递归组件模式

FileItem 使用 Vue 3 `<script setup>` 递归：
- 导入自身：`import FileItem from './FileItem.vue'`
- 必须显式 `defineOptions({ name: 'FileItem' })` 确保递归解析
- 子 FileItem 的 parentPath = fullPath (parentPath + '/' + name)

### 文件树状态管理

- FilesView 管理 `currentPath` 和 `searchQuery`
- 使用 `useFileBrowserSingleton().loadDirectory(path)` 加载目录
- searchQuery 客户端过滤 `fileEntries`（`Array.filter` by name）
- 面包屑：`currentPath` 按 `/` split，点击 crumb-item 跳转

### 页面状态逻辑

```
isLoading && entries.length == 0 → 'loading'
pageError !== null               → 'error'
!isLoading && filtered.length==0 && !searchQuery → 'empty'
其余                               → null (显示 FileTree)
```

### 验证结果

- `vue-tsc --noEmit` 通过
- `npm run build` 通过（生成 FilesView.css 4.04KB, FilesView.js 7.86KB）
- `npm run test:unit` 155 测试全部通过 (8 files)

## Task 26: SearchBar + SearchResultItem 搜索组件

### 创建的文件

| 文件 | 说明 |
|------|------|
| `src/components/files/SearchBar.vue` | 搜索输入框，带防抖(300ms)和清除按钮 |
| `src/components/files/SearchResultItem.vue` | 搜索结果条目，显示文件名/路径/大小 |

### SearchBar 组件设计

- Props: `modelValue`(v-model), `placeholder`, `debounce`(ms), `loading`
- Events: `update:modelValue`(防抖后), `clear`
- 使用 `setTimeout` 实现防抖，无需第三方依赖
- 清除按钮：仅在有输入时显示，点击清除输入并触发事件
- 搜索图标：左侧 `fa-search`，loading 时显示 `fa-spinner`

### FilesView 集成变化

- 搜索栏替换为 `<SearchBar>` 组件
- 搜索结果区域：条件渲染 `v-if="searchQuery"`
  - loading 状态：显示 `LoadingSpinner`
  - 无结果：显示空状态提示
  - 有结果：渲染 `SearchResultItem` 列表
- 文件树：仅在无搜索时显示 `v-show="!searchQuery && pageState === null"`
- 搜索结果点击：目录导航到该目录，文件触发预览

### CSS 设计规范

- 使用设计系统变量：`--surface`, `--surface2`, `--surface3`, `--text`, `--text2`, `--text3`, `--border`, `--primary`, `--radius-sm`
- 圆角：`--radius-sm` (10px)
- 输入框焦点：`border-color: var(--primary)`
- 清除按钮：圆形，hover 时变 primary 色

### 验证结果

- `vue-tsc --noEmit` 通过
- `npm run build` 通过
- LSP diagnostics 清洁

## Task 31: SettingsView + LoginOverlay Unit Tests

### Test files created
| 文件 | 测试数 | 说明 |
|------|--------|------|
| `tests/unit/components/settings/SettingsView.test.ts` | 17 | 渲染/连接状态/登录状态/退出登录/Debug面板开关 |
| `tests/unit/components/common/LoginOverlay.test.ts` | 32 | 可见性/表单/输入/密码可见/按钮状态/登录成功/失败/加载/关闭/错误清除/验证 |

### 测试 Mock 模式 (组件)

- **SettingsView** 需要 mock 三个模块:
  - `vue-router` (useRouter → push)
  - `@/composables/useApi` (useApi → isLoggedIn, logout, token) + 额外导出 listSessions, fetchCurrentSessionId
  - `@/composables/useRealTime` (useRealTimeSingleton → connectionState, sseConnected, wsConnected)
- **LoginOverlay** 只需要 mock `@/composables/useApi` (useApi → login)
- 使用 `vi.hoisted()` 创建共享 mock 函数，在 `vi.mock` 工厂中使用

### Teleport 处理
- LoginOverlay 使用 `<Teleport to="body">`
- 默认情况下 VTU 将 Teleport 渲染为 `<!--teleport start-->`，内容不在 wrapper 内
- 必须设置 `global: { stubs: { teleport: true } }` 使 Teleport 渲染内容在 wrapper 内部

### 表单提交测试
- 点击 submit 按钮 (`wrapper.find('.login-btn').trigger('click')`) 不会自动触发表单 submit 事件
- 必须直接触发 form 的 submit 事件: `wrapper.find('form').trigger('submit')`
- 按钮禁用状态测试 (`button.disabled`) 仍然使用 button click

### 加载状态测试模式
- 使用 `mockImplementation(() => new Promise(resolve => { resolveLogin = resolve }))` 控制 promise 时机
- 触发 submit 后 `await nextTick()` 等待 Vue 更新 DOM
- 检查加载状态后再 resolve promise 清理

### 测试运行结果
- 308 tests, 14 files, ALL pass
- 新增: SettingsView 17 + LoginOverlay 32 = 49 tests
