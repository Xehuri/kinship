# Windows 桌面端 (desktop)

Electron 网页套壳 + 内置 PC 采集端。功能与构建细节见 `README.md`，本文件只给 agent 的工作约束。

## 技术栈

- Electron 45 + TypeScript
- 主进程用 `tsc` 编译；preload 用 `tsc` 类型检查、`esbuild` 打包为 CJS
- renderer 用 Vue 3 + Vite，测试用 Vitest
- 打包用 electron-builder 26，目标 NSIS / portable / zip

## 入口与结构

| 路径 | 职责 |
| ---- | ---- |
| `src/main/main.ts` | 应用入口、单实例锁、`userData`、协议注册 |
| `src/main/desktop-app.ts` | 启动编排、托盘、关闭到托盘、退出清理 |
| `src/main/app-controller.ts` | 配置、服务器地址、证书预检、窗口生命周期 |
| `src/main/ipc/handlers.ts` | IPC 注册与发送方校验 |
| `src/main/lib/*` | 采集端监管、配置、TLS、端口、日志、窗口状态 |
| `src/main/windows/*` | 主窗口、设置视图（单窗口覆盖层）、采集端面板 |
| `src/main/shell/*` | `axeuh://` 协议、导航、权限、托盘、退出、Token 注入脚本 |
| `src/preload/preload.ts` | 设置视图 preload，暴露 `window.axeuh` |
| `src/renderer/*` | 本地 setup / settings / error Vue 应用 |
| `scripts/*` | stage / verify / no-secrets / icon |
| `e2e/*` | Playwright 用例 |

## 命令

```bash
npm run typecheck
npm run build
npm run test:unit
xvfb-run -a npm run test:e2e
npm run stage:pc-sensor
node scripts/verify-pc-sensor-runtime.mjs
node scripts/check-no-secrets.mjs
npm run dist:win
```

## 边界

- 只改 `desktop/`。不修改 backend、frontend、app。
- PC 采集端源码在仓库 `desktop/pc-sensor/`；`resources/pc-sensor/` 是 stage 产物，不手改。
- 不重复父级 `AGENTS.md` 的通用规则，只写桌面端特有约束。

## 硬规则

- 单窗口：只能有一个 `BrowserWindow`（远程 SPA 的 `webContents`）；设置页是同一窗口内的 `WebContentsView` 覆盖层，不得再创建独立设置窗口。打开/返回设置只显隐视图。
- 远程主窗口绝对不能挂 preload，必须保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；preload 只允许挂在本地设置视图。
- 主窗口主题同步由注入的只读观察器经 console 标记回传，不挂 preload；不要恢复默认应用菜单。
- IPC 只允许设置视图调用，发送方校验不能放宽到主窗口或其他 webContents。
- 网络层：`desktop-config.json` schemaVersion=3 的 `network.layers` 是唯一真源，`server`/`transport` 由活动层派生。启动时按顺序探测 direct/frp 层（GET `/health`），选第一个健康层并同步同一 origin 给 SPA 与 PC 采集端；主窗口加载失败只对剩余层重试一次。P2P 仅类型占位，保存返回 `P2P_NOT_AVAILABLE`。旧 `NETWORK_CONFIG_GET/SAVE` 仅兼容 transport 表单。契约见 `docs/network-layer-ipc.md`。
- 设置页 UI：setup 与 settings 共用 `NetworkLayersEditor`，网络保存后才允许进入 PC 采集端步骤；启动开关走 `WINDOW_PREFS_SAVE` 立即保存；日志面板走 `LOGS_STREAM_START/STOP` + `LOG_EVENT` 实时追加，关闭即停止；P2P 只显示“未接入”占位，不进入保存列表。
- `axeuh://open-settings` 由 Android 与桌面端分别处理：桌面端主窗口必须在导航策略之前拦截，不得导航到该 scheme，也不得当作外部链接打开；桌面端在同一窗口内显示设置视图。
- Token 桥：PC 采集端是 SPA 的认证代理。桌面端以 Bearer `agent_token` 调 `GET /pc-sensor/auth-token` 取后端 Token 快照，经 `executeJavaScript` 写 `localStorage.mobile_token` 并派发 `CustomEvent('axeuh-token-refresh', { detail: token })`；只在 Token 变化时注入。桌面端 Token 不得进入 URL 查询串/hash，不得写日志；Android bootstrap URL 除外（SPA 消费后立即剥离），并应通过 `WebTokenBridge` 在 `onPageFinished`、`onResume` 与 `auth_token` 变化时派发同一事件（字符串 detail），桌面端行为不变。
- TLS 信任必须绑定主机与叶子证书 SHA-256，只放行 `ERR_CERT_AUTHORITY_INVALID`；主机名、有效期、链解析错误不得绕过。
- 密码明文不落盘，采集端只用 DPAPI 密文或后端访问令牌。
- PC 采集端 `backend_token` 仍是现有明文落盘设计；优先账号密码 + DPAPI；公开导出前复核 `desktop/pc-sensor/dist` 与示例域名。
- 不得分发 `desktop/pc-sensor/dist/Axeuh-PCSensor.exe`（旧）与 `desktop/pc-sensor/dist/Kinship-PCSensor.exe`（新），二者都会内嵌本机配置。
- 结束进程只按 PID，禁止 `pkill` / `killall`。
- PC 采集端只使用内置 runtime（`resources/pc-sensor/runtime`），不依赖系统 Python。
- staged 运行时的 `python311._pth` 必须包含 `..\app`，否则采集端源码不可导入。
- `resources/pc-sensor/`、`dist/`、`release/`、`.cache/` 不入库。
- 报“缺少内置 PC 采集端运行时”先查杀毒隔离、便携版解压完整性与 `%TEMP%\AxeuhHealthDesktop`；配置已先落盘，修复运行时后重启即可。
- 提交时只 `git add` 明确路径，禁止 `git add -A`。
- 重置所有参数只允许从设置视图发起，必须二次确认（第二步输入 `重置`），且不得删除运行日志。

## 验证

```bash
npm run typecheck
npm run test:unit
xvfb-run -a npm run test:e2e
node scripts/verify-pc-sensor-runtime.mjs
node scripts/check-no-secrets.mjs
```

改了打包或窗口安全配置时，还要跑 `node scripts/verify-win-artifacts.mjs` 检查 `release/` 三件套。
