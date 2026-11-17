# P2P DataChannel 协议（实验，当前不可用）

> 状态：实验阶段，不是正式功能，当前不可用。本文仅保留协议草案，不构成可用性承诺；请保持 `p2p.enabled: false`，不要启用或依赖 P2P。
> 原 Phase 2 记录：默认关闭（`p2p.webrtc.enabled=false`）。仅用于音频分段与感知事件，不代理整套 HTTPS API。
> 信令仍走 `wss://signal.example.com/ws`，WebRTC 只用公共 STUN，不做 TURN。

## 0. 当前状态（2026-11-17 按代码核对）

「不可用」指**默认配置与依赖都关闭、且没有生产启用记录**，不是"没有实现"：

- **后端不是占位**：`backend/services/p2p/` 已有 Phase 1（配对码、设备注册表、设备 token、短时信令票据、信令客户端）与 Phase 2（基于 aiortc 的 DataChannel 数据面）实现，`backend/routers/p2p.py` 对外 6 条路由。
- **开关**：`p2p.enabled: false`（模板默认）时 `P2PDisabledGuardMiddleware` 在认证前把整组 `/api/p2p/*` 回 404，连未认证请求也拿不到 401，不暴露路由存在性；`p2p.webrtc.enabled: false` 为第二道闸，且 aiortc 只列在可选的 `backend/requirements-p2p.txt`，未安装时后端照常启动、只保留信令（fail-open）。
- **客户端**：Web 前端（`frontend/mobile/`）没有任何 P2P 代码；Android 侧有 `app/src/main/java/com/xehuri/kinship/p2p/` 客户端实现，并在采集启动时探活（`DataCollectorService.startP2pWebRtc()`），但 `P2pWebRtcPolicy.shouldStart` 要求 `enabled && webrtcEnabled && signalUrl` 三者齐备，且 `TransportMode.FORCE_FRP` 直接跳过——服务端保持默认关闭时它只会读到 404 后退出，不建连。
- **UI**：Android 网络设置页的连接层列表里 P2P 只是 `TierKind.P2P` 占位（恒显示「未接入，后续统一做」），与上面已落地的 `p2p/` 包不是同一条路径；这条占位也不代表可以启用。
- **结论**：在没有专门的启用评审与部署验证前，保持关闭；本文以下内容按当前代码仍成立，但不代表已验收。

## 1. 信令消息

Android（`role=client`）→ 家庭服务器（`device_id=home`）：

```json
{"type":"offer","to":"home","payload":{"type":"offer","sdp":"..."}}
{"type":"ice","to":"home","payload":{"candidate":"...","sdpMid":"0","sdpMLineIndex":0}}
{"type":"bye","to":"home"}
```

家庭服务器 → Android：

```json
{"type":"answer","to":"<device_id>","payload":{"type":"answer","sdp":"..."}}
{"type":"ice","to":"<device_id>","payload":{"candidate":"...","sdpMid":"0","sdpMLineIndex":0}}
{"type":"bye","to":"<device_id>"}
```

信令服务只转发，不落盘 SDP/ICE。

## 2. DataChannel

- label：`axeuh-data`
- 有序可靠传输
- 音频：先发 meta 文本，再发二进制分块
- 服务端处理完成后回 ACK 文本

### 2.1 音频 meta

```json
{
  "type": "audio_meta",
  "message_id": 123456,
  "session_id": "seg-...",
  "seq": 7,
  "start_ms": 1760000000000,
  "client_time": "2026-10-23T21:00:00.000+08:00",
  "format": "wav",
  "size": 123456,
  "chunks": 8
}
```

- `message_id`：uint32，客户端生成，仅用于本次消息与 ACK 关联
- `format`：`wav` | `flac`
- `size`：原始音频字节数
- `chunks`：分块数，必须与实际二进制块数一致

### 2.2 二进制分块

固定 12 字节大端头：

| 偏移 | 类型 | 值 |
|---|---|---|
| 0 | uint8 | magic = 1 |
| 1 | uint8 | kind = 1（音频） |
| 2 | uint16 | reserved = 0 |
| 4 | uint32 | message_id |
| 8 | uint16 | chunk_index（从 0 开始） |
| 10 | uint16 | chunk_count |

头部之后是 payload。单块 payload 最大 16 KiB；单条音频总大小最大 8 MiB；最多 4096 块。

### 2.3 ACK / NACK

```json
{"type":"ack","message_id":123456,"ok":true}
{"type":"ack","message_id":123456,"ok":false,"error":"ingest failed"}
```

客户端在 15 秒内未收到 ACK，或收到 `ok=false`，必须回退到现有 HTTP 上传路径（15 秒是 Android 侧常量 `P2pProtocol.ACK_TIMEOUT_MS`；服务端装配器的超时是配置 `p2p.webrtc.ack_timeout_seconds`，默认 60 秒，两者不是同一个值）。

## 3. 感知事件（可选）

小事件可直接用文本帧：

```json
{"type":"event","event_type":"notify","payload":{"package":"...","ts":"..."},"ts":"21:00:00"}
```

服务端复用 `/api/screen/stt/perception-event` 的写入逻辑；事件体积超过单帧上限时仍走 HTTP。

## 4. 服务端职责

- 校验信令连接对应的 `device_id` 已配对且未撤销
- 每个设备最多一个 WebRTC 会话
- 校验 meta、块数量、块序号、总大小与超时
- 音频块完整后走现有 `routers/perception.py` 的无缝流入口
- 只记录 `type/device_id`，不记录 SDP、ICE、音频或 token
- `webrtc.enabled=false` 时不加载 aiortc，不影响 Phase 1

## 5. 回退顺序

```text
IPv6 直连（HTTP）
  → WebRTC DataChannel（仅音频/感知）
  → frp HTTP
```

IPv6 健康时优先 IPv6；IPv6 不可用时尝试 WebRTC；WebRTC 未就绪、ICE 失败、ACK 超时或 NACK 时回退 frp HTTP。任何情况下都不使用系统 VPN、TUN 或 TURN。

> 这是设计目标，不是当前生效行为：Android 侧除默认 `AUTO_CHAIN` 外还有 `TransportMode.FORCE_FRP`，该模式下 P2P 直接不启动（见 `P2pWebRtcManager.start()` 的首个判断）；且服务端默认关闭时本链路整体不参与。
