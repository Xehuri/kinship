# Android WebView Token 桥（2026-10-25）

> 状态：已实现并部署生产（2026-10-25 13:49 CST 原子替换前端；APK 需手动安装）。
>
> 目标：App 内 WebView 复用原生后台采集进程持有的后端 token；原生 401 自动重登后网页自动续期，不再反复要求手动登录。

## 背景

App 内同时存在两条认证路径：

- 原生采集/上传走 `AppHttpClient`，401 时用已保存的账号密码自动重登，并把新 token 写回 `axeuh_prefs["auth_token"]`。
- WebView 内 SPA 原先只在启动时通过 URL 拿到一次性 token 快照，存入 `localStorage.mobile_token` 后不再更新。

原生 token 续期后，SPA 仍持旧 token，下一次请求 401 就弹出 `LoginOverlay`，用户被迫反复登录。桌面端已用「PC 采集端作认证代理 + `axeuh-token-refresh` 事件」解决同一问题；本次把同一契约补到 Android。

## 方案

App 内正常路径下，原生 `axeuh_prefs["auth_token"]` 是 WebView 的唯一真源；独立浏览器或用户在 SPA 手动登录时，仍走各自的 token，不强制共享。

### 数据流

```text
AppHttpClient 401
  -> tryReAuth() 用已存账号密码重登
  -> 新 token 写回 axeuh_prefs["auth_token"]
  -> WebTokenBridge 监听到 auth_token 变化
  -> 主线程 WebView.evaluateJavascript
  -> localStorage.mobile_token + CustomEvent('axeuh-token-refresh', { detail: token })
  -> useApi 更新模块 token / localStorage / isLoggedIn
  -> onTokenRefresh 通知 App.vue
  -> 关闭 LoginOverlay + 重连 SSE/WS
```

### Android

- `app/src/main/java/com/xehuri/kinship/web/WebTokenBridge.kt`
  - 监听 `axeuh_prefs["auth_token"]`，忽略其它键。
  - `onPageFinished`、`onResume`、token 变化时注入；注入固定切到主线程。
  - 空 token 不注入；`stop()` 递增代际号，丢弃已 post 但未执行的注入。
  - 脚本先写 `localStorage.mobile_token`，再派发 `axeuh-token-refresh`；token 用 `JSONObject.quote` 转义，不写日志。
- `app/src/main/java/com/xehuri/kinship/MobileActivity.kt`
  - 启动 URL 从 prefs 读取 token，不再使用 `MainActivity` intent 里的旧快照。
  - `axeuh://retry` 用当前 prefs 重建 URL；`axeuh://ignore` 暂停注入，直到 retry。
  - 错误页/非 SPA 页面不注入；`onDestroy` 注销监听。

### SPA

- `frontend/mobile/src/composables/useApi.ts`
  - 监听 `axeuh-token-refresh`，兼容桌面字符串 detail 与 `{ token, wasLoggedIn? }`。
  - 写入前快照 `wasLoggedIn`，再更新 token/localStorage/isLoggedIn，并通过 `onTokenRefresh`/`offTokenRefresh` 通知订阅方。
  - `initToken` 消费 URL `?token=` 后立即 `history.replaceState` 剥离该参数，保留 `device_id` 与 hash。
- `frontend/mobile/src/App.vue`
  - `wasLoggedIn=false` 或登录层可见时，关闭 `LoginOverlay` 并重连 SSE/WS；已登录且无登录层时只换 token。
  - 401 回调在「已未登录且登录层已显示」时直接返回，避免并发 401 重复登出。
- `frontend/mobile/src/api/client.ts`
  - 六个请求封装都捕获请求发出时的 token；401 仅在当前 token 仍等于该 token 时才触发 auth-fail。
  - token 在途轮换/清空时忽略过期 401，不自动重试（POST 非幂等）。

## 安全边界

- App 内 WebView 与原生共用同一个用户 token。SPA 本来就在 `localStorage` 持有同权限 token，共享不构成权限提升；XSS 可窃取的凭证等级不变。
- 首次加载的 bootstrap URL 仍携带一次 token（既有设计）；SPA 消费后立即从地址栏剥离，不新增 URL 参数。
- token 不写日志；`WebTokenBridge` 只在内存中读取 prefs 并注入。
- 空 token 不注入；`axeuh://ignore` 期间不注入，尊重用户“暂时忽略”的选择。
- 监听器在 `onDestroy` 注销；注入均在主线程执行。

## 验证

- 前端定向：`client.test.ts`、`useApi.tokenRefresh.test.ts`、`useApi.initToken.test.ts`、`App.test.ts`，4 文件 / 32 用例通过。
- 前端全量：90 文件 / 965 用例通过；`typecheck`、`build:atomic`、`verify:dist` 通过。
- Android 定向：`WebTokenBridgeTest` 7/7、`MobileActivityTokenBridgeTest` 8/8。
- Android 全量：442 tests，2 failed，15 skipped；2 个失败均在未改动的 `NotificationCollectorTest`，属 2026-09-16 统一上传改造后的陈旧断言，与本次改动无关。
- 浏览器真实面 QA：9/9 检查通过（无 token 时登录层可见；注入有效 token 后关闭；URL token 写入 localStorage 并剥离；已登录刷新不弹层）。
- 生产验证：`/mobile/` 引用新资产；新 JS 含 `axeuh-token-refresh` 与 `wasLoggedIn`；旧 JS 404；`/health` 正常；`axeuh-health` MainPID 未变（未重启后端）。
- 独立 reviewer 结论：APPROVE WITH NOTES，无阻塞项。

## 生产部署与回滚

| 项 | 值 |
| --- | --- |
| 前端产物 | `assets/index-JEWFxoJ0.js` / `assets/index-MFa6qXpn.css` |
| 前端备份 | `frontend/mobile/dist-backup-20261025-134930` |
| 旧目录 | `frontend/mobile/dist-old-20261025-134930` |
| APK | `app/build/outputs/apk/debug/app-debug.apk`，58,523,188 bytes，sha256 `1a8f082aa6204ad7199ff01385f6516a77edc24aacdef8efb6ab5c2564dbe935` |
| APK 签名 | `CN=Android Debug`（debug keystore） |

前端回滚：

```bash
cd frontend/mobile
mv dist dist-failed-20261025-134930
mv dist-old-20261025-134930 dist
```

APK 安装注意：

- debug APK 若覆盖到 release 签名的旧版，会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`；需先卸载旧版（会清空 App 数据，之后重新配置服务器并登录），或提供同签名的 release APK。
- 安装后刷新网页；已打开的页面可能仍运行旧 JS。
- 前端与 APK 必须一起上线；旧前端不包含 URL token 剥离与登录层自动恢复逻辑。

## 已知限制

1. Web 端主动登出只清 SPA token，不清原生 prefs；后续注入会把 WebView 重新登录。原生为准是当前设计选择。
2. Web 改密产生的新 token 不会写回原生 prefs；原生下次注入可能覆盖。Web 改密后需在 App 内重新登录一次，以刷新原生 token 缓存。
3. `history.replaceState(null, ...)` 会清掉 Vue Router 的 history state；hash 与 device_id 已验证保留，滚动/后退状态影响低。
4. 已登录时的 token 轮换不主动重连 SSE/WS，依赖现有 ticket-on-reconnect；断线恢复需观察。
5. 全量 Android 仍有 2 个既有失败（`NotificationCollectorTest`），建议单独立项更新。

## 相关文件

- `app/src/main/java/com/xehuri/kinship/web/WebTokenBridge.kt`
- `app/src/main/java/com/xehuri/kinship/MobileActivity.kt`
- `frontend/mobile/src/composables/useApi.ts`
- `frontend/mobile/src/App.vue`
- `frontend/mobile/src/api/client.ts`
- 测试：`app/src/test/java/com/xehuri/kinship/web/WebTokenBridgeTest.kt`、`app/src/test/java/com/xehuri/kinship/MobileActivityTokenBridgeTest.kt`、`frontend/mobile/tests/unit/api/client.test.ts`、`frontend/mobile/tests/unit/composables/useApi.tokenRefresh.test.ts`、`frontend/mobile/tests/unit/composables/useApi.initToken.test.ts`、`frontend/mobile/tests/unit/App.test.ts`
- 约束：`app/AGENTS.md`、`frontend/mobile/AGENTS.md`、`desktop/AGENTS.md`、`desktop/README.md`

## 提交

- `957bc69f` fix(frontend): 忽略 token 轮换后的过期 401
- `9eecfb86` feat(frontend): 原生 token 刷新时恢复登录态与实时连接
- `792e5fd7` feat(android): 向 WebView 注入权威 auth_token
- `275c89a2` docs: 同步 WebView token 桥接说明
- `9375f939` docs: 澄清 Android bootstrap URL token 例外
