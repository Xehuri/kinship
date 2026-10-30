# 网络层与桌面行为 IPC 契约

本文件面向设置页/首次启动页的实现者。类型真源是 `src/shared/types.ts`，通道真源是 `src/shared/ipc.ts`，preload 暴露为 `window.axeuh`。设置页是唯一允许调用这些通道的 webContents。

## 数据模型

`DesktopConfig.schemaVersion` 为 3，新增 `network` 字段：

```ts
interface NetworkLayer {
  id: string
  type: 'direct' | 'frp' | 'p2p'
  name: string
  address: string
  enabled: boolean
  tlsMode: 'system' | 'pinned' | 'insecure'
  fingerprint256?: string
  caPemPath?: string
}

interface NetworkConfig {
  layers: NetworkLayer[]
  activeLayerId?: string
}
```

- `address` 只允许 origin（协议、主机、端口），https；仅 localhost 允许 http。域名、IPv4、IPv6 字面量都可以。
- `layers` 顺序就是探测顺序，第一个健康的 direct/frp 层同时成为 SPA origin 与 PC 采集端 `server_url`。
- `server` 与 `transport` 字段保留，但由活动层派生，不要直接编辑。
- P2P 类型只占位。保存任何 P2P 层都会被拒绝，错误码 `P2P_NOT_AVAILABLE`，文案「P2P 传输尚未接入，后续统一做」。
- `pinned` 必须提供 64 位十六进制 SHA-256 指纹；`caPemPath` 只允许主进程管理的 CA bundle 路径，外部路径会被清空。UI 可省略 `caPemPath`：先调用 `axeuh:cert:trust` 写入共享 CA bundle，指纹从返回的 `CertInfo` 取得；PC 采集端会对 pinned 层自动使用该 bundle。
- `insecure` 只在活动层主机上跳过证书错误，不会全局关闭 Chromium 验证。

## 通道

| 通道 | 入参 | 返回 |
| ---- | ---- | ---- |
| `axeuh:network:layers:get` | 无 | `NetworkStateView` |
| `axeuh:network:layers:save` | `NetworkConfig` | `NetworkApplyResult` |
| `axeuh:network:probe` | 无 | `NetworkApplyResult` |
| `axeuh:network:layer:select` | `layerId: string` | `NetworkApplyResult` |
| `axeuh:window:prefs:get` | 无 | `WindowPreferences` |
| `axeuh:window:prefs:save` | `WindowPreferences` | `WindowPreferences` |
| `axeuh:logs:stream:start` | `{ lines?: number; sources?: ('desktop'\|'sensor')[] }` | `void` |
| `axeuh:logs:stream:stop` | 无 | `void` |

旧的 `axeuh:network:config:get/save` 继续存在，只用于兼容现有设置页的 transport 表单；新 UI 使用 layers 通道。

`NetworkApplyResult` 包含 `config`、`statuses`、`activeLayerId`、`activeAddress`、`activeTlsMode`、`sensorSynced`、可选的 `sensorError`。探测全失败时 IPC 仍返回 `ok: true`，但结果带 `error` 与 `code`（`NO_HEALTHY_LAYER` 等）；调用方应展示状态列表，不要加载不可用 origin。

每个 `statuses[]` 项带 `state`：`healthy`、`unhealthy`、`skipped`、`untested`，以及可选的 `latencyMs`、`checkedAt`、`error`、`code`。

## 启动顺序

1. 加载配置；若没有任何层且没有旧服务器地址，打开 setup。
2. 按顺序探测 direct/frp 层，选第一个健康层并写入 `activeLayerId`。
3. 把同一 origin 同步给 PC 采集端，并按活动层的 TLS 模式更新 `ssl_verify`/`ssl_ca_file`。
4. 等待采集端提供后端 Token。拿到 Token 后加载远程 SPA；超时或采集端不可用时打开本地 settings，不加载远程 origin。
5. 主窗口加载失败时，按剩余层顺序再试一次；同一层一次启动周期内只尝试一次，全部失败后显示错误页。

`AXEUH_START_ROUTE` 存在时跳过探测与 Token 门禁，保留测试/运维入口。

## 日志流

订阅后主进程先为每个来源发一条 `type: 'snapshot'` 的 `axeuh:logs:stream:event`，随后发 `append`；文件截断、轮转或从缺失恢复时发 `reset`。事件含 `source`、`path`、`lines`，可带 `error` 或 `reset: true`（表示已达到单次行数上限、部分行被丢弃）。

日志路径固定为桌面日志与 PC 采集端日志，接口不接受任意路径。订阅只绑定发起调用的设置页 webContents；停止、窗口销毁或应用退出时自动清理 watcher。

## 关闭窗口行为

`minimizeToTray` 默认 `true`：关闭主窗口只隐藏，托盘继续运行桌面端与 PC 采集端。设为 `false` 时关闭会销毁主窗口，但托盘存在时应用仍不退出；从托盘或托盘菜单再次打开会重建主窗口。托盘不可用的环境下关闭窗口等同于退出。
