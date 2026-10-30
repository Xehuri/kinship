# Kinship 健康监测 - Android App

**上次更新**: 2026-10-25
**框架**: Kotlin + Jetpack Compose + Gradle
**Android**: minSdk 26, targetSdk 36, compileSdk 36
**包名**: `com.xehuri.kinship`
**版本**: versionCode 11 / versionName "1.4.2"
**架构**: 分层模块化（网络层 → 状态层 → 采集层 → UI层）

## 概述

Kinship 的 Android 端数据采集 + 远程管理 App。提供 SettingsActivity 配置面板、DataCollectorService 后台数据采集调度、MobileActivity WebView 远程管理、OTA 自更新等功能。

2026-06-23 重构：从单块架构（2956行DataCollectorService + 1925行SettingsActivity）重构为分层模块化架构（5个采集器 + 4个上传/缓存器 + ViewModel模式 + 7个独立Composable）。

2026-09-14 重构：设置页改为混合式信息架构（概览 LazyColumn + NavHost 三子页面：数据采集/通知/健康数据，均共享同一个图作用域 ViewModel）；通知下行由 HTTP 轮询改为 WebSocket 长连接推送，新增通知内容上行（本机通知按 `sbn.key` 去重 + 敏感应用黑名单后上报）；健康数据支持「定时时段 / 间隔」两种上传模式与各数据源独立采集间隔。

2026-09-14 后续提交（eb863854 / 396938be）：调整默认采集间隔（系统状态 1s / 声音分段 60s / 通知上行 10s / 健康 60min）；设置页动画统一为 150ms `FastOutSlowInEasing`；GPS 新增 5 项可配置行为（精度优先级、最小位移、最大精度、主动定位超时、逆地理编码）；通知敏感应用黑名单改为已安装应用多选选择器。

2026-09-16 设置页重整（交互范式 + 音频链路解耦）：
1. **交互范式换成「列表行 + 二级页」**：一级页面只放「名称 + 状态摘要 + 开关 + 箭头」，详细配置全部收进二级页；**彻底去掉展开/折叠**（`ExpandableSettingsCard` / `SettingsSourceCard` 已无调用方）。新增 9 个二级页：`AudioSettingsPage` / `WakeWordSettingsPage` / `GpsSettingsPage` / `SystemStateSettingsPage` / `AccountPage` / `SystemPage` / `BatteryPage` / `SecurityPage` / `AdvancedPage`；原概览页的折叠区（账号、电池、安全、高级）与「系统」分组全部二级页化。
2. **禁用并移除「流式上传」开关**：`audio_stream_enabled` 恒 false，常驻推流（服务端 KWS 路径）弃用。
3. **声音与唤醒彻底解耦**：原「声音」大卡拆成两个**互相独立**的列表行 ——「环境音频」（分段 + 批量上传）与「语音唤醒」（端侧 KWS 按需推流）。
4. **通知两个开关合并为一个**：原「通知感知」(`notification_enabled`) + 「上传通知到后端」(`notify_upload_enabled`) 合并为「读取并上传通知」，由 `setNotificationEnabled()` 同时写两个 prefs；上传间隔与敏感应用过滤保留。原数据采集页的「通知」卡已删除（避免同一开关出现在两处），通知权限引导挂在通知页的开关上。
5. 顺带修掉通知卡展开体误显示 `mediaText`（媒体播放）而非通知文本的 bug。
6. **统一上传入口**：除健康数据与环境音频外，所有感知事件改为「采集器只入队（新增 `PendingUploadQueue.kt`）→ 主循环 `flushPendingUploads()` 统一发 HTTP」，单条失败落 `PerceptionCache`；系统状态（前台应用 / 媒体 / 设备环境）、通知、屏幕事件均不再各自 POST，`notify_upload_interval_ms` 随之失效（键保留）。发送前会落盘快照（`cacheDir/pending_uploads.jsonl`，仅「离线缓存」开启时），服务启动时恢复。
7. **死代码清理 + 命名**：删除 `EventUploader.kt`（无调用方）与 `EventUploaderTest.kt`、`ExpandableSettingsCard` / `SettingsSourceCard`（折叠组件）、`PerceptionCache.flushSuspend`、`SettingsAnim.floatSpec` / `sizeSpec`、`get/setNotifyUploadIntervalMs` 与 `SettingsViewModel.notifyUploadIntervalMs`；设置页「主循环间隔」更名为「**上传与调度间隔**」（组标题「上传与调度」）。

2026-10-25 设置/主题/网络重构：
1. **设置信息架构**：概览改为顶部运行状态卡 + 5 组 20 行（采集与上传 / 连接与账号 / 桌面与历史 / 设备与运行 / 隐私与维护），卡片改 hairline 列表；文案由纯 `SettingsOverviewModel` 派生，`SettingsGroup` 等基础组件移出 Activity。新增 `RunStatusPage` / `CollectionControlPage` / `SoundPage`，退役 `DataCollectionPage` / `SystemPage` / `BatteryPage`。
2. **设计系统**：`KinshipTokens` 对齐 Web `tokens.css`（暖纸/赭石/radius 8-6/4-64 间距/120-180ms），浅色与深色跟随系统；设置页使用 `Theme.KinshipSettings` + `values-night`，CSS 对等测试锁定令牌。
3. **登录态**：新增 `auth/SessionManager` 单一真源；登录页删除重复实现；登录门禁启动成功后直接进入 `MobileActivity`；401 失效同步 UI，不跳转 Activity。
4. **多层网络**：`transport/` 新增 tier 模型/存储/迁移/探测/选择器/运行时/设置控制器；`TierRuntime` 替换旧 `TransportSelector`；旧 prefs 三键迁移后冻结；P2P 仅保留 `TierKind.P2P` + `Peer` 占位，零信令/数据面。

## 版本与技术栈

构建配置见 `app/build.gradle.kts`；依赖版本单一真源在仓库根 `gradle/libs.versions.toml`（注意不在 `app/` 内）。

| 类别 | 版本 |
|------|------|
| Android Gradle Plugin | 8.6.1（2026-10-13 自 8.5.0 升级：glance 1.2.0 的 aar-metadata 要求 AGP ≥8.6.0） |
| Kotlin | 2.0.0 |
| Compose BOM | 2024.12.01 |
| navigation-compose | 2.8.5 |
| core-ktx | 1.13.1 |
| activity-compose | 1.9.3 |
| lifecycle | 2.8.7 |
| OkHttp | 4.12.0 |
| security-crypto | 1.1.0-alpha06 |
| Timber | 5.0.1 |
| Shizuku | 13.1.5 |
| play-services-location | 21.3.0 |
| sherpa-onnx | v1.13.8（JitPack，AAR；端侧 KWS 经 JNI） |
| java-flac-encoder | 0.3.8（Maven Central，纯 Java；FLAC 兜底编码器，LGPL-2.1） |
| Java | 17 |
| JUnit Jupiter | 5.11.4 |
| MockK | 1.13.14 |
| Truth | 1.4.4 |
| Robolectric | 4.14.1 |
| mockwebserver | 4.12.0 |
| kotlinx-coroutines-test | 1.8.1 |

`settings.gradle.kts` 的 `rootProject.name = "Kinship"`。

## 启动流程

```
开机 → BootReceiver
  → 用户打开 App → MainActivity（深色启动图 installSplashScreen）
     → 无 token → SettingsActivity（登录页，extra launchReason=LOGIN_GATE）
     → 有 token → 直接进入 MobileActivity（WebView 手机管理页），不做前置网络检查
     → finish() 自身

SettingsActivity 内：
  → 账号密码登录 → SessionManager 写 token 并广播登录态
  → 登录门禁启动且登录成功 → startActivity(MobileActivity) + finishAffinity()
  → 用户主动从 App 内打开设置并登录 → 留在设置页，不强制跳转
  → 开启"感知数据上传" → 前台启动 DataCollectorService
```

**白屏与认证失效策略（2026-09-14 优化）**：

- **冷启动白屏已消除**：`Theme.AxeuhAssistant` 设深色 `windowBackground` + `core-splashscreen` 启动图（`Theme.AxeuhAssistant.Splash`）+ `MobileActivity` 的 WebView 深色底（`setBackgroundColor`）；前端 FontAwesome 由 cdnjs 外链改为本地打包（`@fortawesome/fontawesome-free`，`main.ts` 引入），去掉 render-blocking 外部依赖。
- **不再前置 `/health` 探测**：旧逻辑在 `MainActivity` 阻塞等待 `/health`（connect 15s/read 30s）后才跳 `MobileActivity`，现改为有 token 直接进 WebView；服务不可用时由 `MobileActivity` 的本地 `error_page.html` 兜底。
- **运行时 401 不跳转**：`AppHttpClient` 的 401 拦截器在自动重登录失败时清除 `auth_token` 并通过 `SessionManager` 广播 `Expired`，设置页立即变为未登录；不触发 Activity 跳转，避免打断用户操作。认证失效仍统一在**下次打开 App 时**由 `MainActivity` 检测到无 token 后路由到登录页。
- **Token 桥（2026-10-25）**：`axeuh_prefs["auth_token"]` 是 WebView 的唯一真源；`WebTokenBridge` 在 `onPageFinished` / `onResume` / `auth_token` 变化时向 SPA 注入 `localStorage.mobile_token` + `axeuh-token-refresh`；`axeuh://retry` 用当前 prefs 重建 URL，`axeuh://ignore` 暂停注入；Token 不写日志、不新增 URL 参数。

## 目录结构

```
app/
├── src/main/
│   ├── java/com/xehuri/kinship/
│   │   ├── MainActivity.kt              # 启动入口：token→MobileActivity/登录（181行；不再前置 /health）
│   │   ├── SettingsActivity.kt          # 设置页 Activity（LazyColumn 概览 + NavHost 二级页）
│   │   ├── MobileActivity.kt            # WebView 手机管理页面
│   │   ├── web/WebTokenBridge.kt        # 原生 auth_token -> WebView 注入桥（localStorage + axeuh-token-refresh）
│   │   ├── network/                     # 统一网络层
│   │   │   ├── AppHttpClient.kt         # OkHttp 封装：get/post/postMultipart/download
│   │   │   ├── AudioStreamClient.kt     # 音频上行 WS（/ws/audio-stream，PCM 推流 + 唤醒事件回调 onWakeEvent + kws_test_result 回调；IPv4 优先 DNS）
│   │   │   └── NotificationStreamClient.kt  # 通知下行 WS 长连接（/ws + client=native&device_id=<uuid>，30s 心跳 + 3s→30s 退避重连）
│   │   ├── auth/
│   │   │   └── SessionManager.kt        # 登录会话单一真源（token/用户名/密码 + StateFlow）
│   │   ├── config/                      # 服务器配置管理
│   │   │   └── ServerConfig.kt          # 服务器 URL 内存镜像 + legacy 端点/模式（迁移后只读）
│   │   ├── logging/
│   │   │   └── AxeuhTimberTree.kt       # Timber 树：日志写入 LogCache
│   │   ├── util/
│   │   │   ├── DeviceId.kt              # 设备唯一标识（SharedPreferences 持久化 UUID，供 WS 握手下发）
│   │   │   ├── HintTonePlayer.kt        # 唤醒提示音（SoundPool 播放 res/raw/start.mp3 | end.mp3，音量可配）
│   │   │   └── RomDetector.kt           # ROM 品牌检测与适配引导
│   │   ├── wakeword/                    # 端侧唤醒（KWS）
│   │   │   └── LocalKwsEngine.kt        # sherpa-onnx KeywordSpotter 封装（JNI；累积推理、自定义词表、失败不抛异常）
│   │   ├── service/                     # 系统服务
│   │   │   ├── DataCollectorService.kt  # 采集调度器（委托给 Collector + 健康定时调度；全 App 唯一常驻前台服务，兼保活）
│   │   │   ├── AccessibilityService.kt  # 输入内容感知（无障碍服务）
│   │   │   ├── NotificationListenerService.kt  # 通知监听（sbn.key 去重后转发上行）
│   │   │   ├── state/                   # 状态管理层
│   │   │   │   └── SensorStateHolder.kt # 统一 StateFlow 状态持有（18个状态；`SensorStateHolder.shared` 为进程内共享单例）
│   │   │   ├── collectors/              # 数据采集器
│   │   │   │   ├── BaseCollector.kt     # 抽象采集器基类
│   │   │   │   ├── SystemStateCollector.kt   # WiFi/蓝牙/屏幕/前台应用/媒体
│   │   │   │   ├── NotificationCollector.kt  # 通知计数轮询 + 内容上行（复用 PerceptionCache）
│   │   │   │   ├── GpsCollector.kt           # GPS 定位（独立间隔默认5min + 5 项可配置行为）
│   │   │   │   ├── HealthDataCollector.kt    # 手环健康数据（独立间隔 / 定时时段）
│   │   │   │   ├── AudioCollector.kt         # 录音 + 固定分段（audio_segment_ms）+ checkpoint + 批量上传（含端侧唤醒按需推流）
│   │   │   │   └── AudioSegmentPolicy.kt     # 纯策略：固定分段边界（audio_segment_ms 封段）/ 批量上传调度 / 前滚重叠 / PcmRing / 说话统计（SegmentSpeechTracker）
│   │   │   └── uploader/                # 数据上传 / 缓存
│   │   │       ├── PcmCheckpointWriter.kt # 分段 PCM 崩溃安全落盘
│   │   │       ├── FlacFinalizer.kt      # FLAC 编码器（MediaCodec 首选 + java-flac-encoder 兜底 + STREAMINFO patch）
│   │   │       ├── HealthBatchUploader.kt    # 健康数据批量同步
│   │   │       ├── AudioUploader.kt     # 音频 multipart 上传（按格式动态 filename/MIME）
│   │   │       ├── PerceptionCache.kt   # 感知事件离线缓存与重放
│   │   │       ├── PcmCheckpointWriter.kt    # 分段 PCM 崩溃安全落盘（周期 flush + 按格式 finalize 到 upload_cache）
│   │   │       └── CheckpointRecovery.kt     # 孤儿 .part 恢复（按 sidecar format 重建 wav/flac）+ 缓存清理策略（LRU/TTL/字节上限）
│   │   ├── transport/                   # 连接层 tier（网络地址 / P2P 占位）
│   │   │   ├── TierModels.kt            # Tier/HttpAddress/Origin/TLS/选择模式
│   │   │   ├── TierCodec.kt             # network_config_v1 JSON 编解码（保留未知字段）
│   │   │   ├── TierStore.kt             # 持久化/迁移/只读保护
│   │   │   ├── TierProbe.kt             # /health 探测（裸客户端，P2P Skipped）
│   │   │   ├── TierSelector.kt          # AUTO_CHAIN/PINNED、冷却、仅传输错误切层
│   │   │   ├── TierRuntime.kt           # 引导迁移/失败重选/5 分钟兜底
│   │   │   └── TierSettingsController.kt # 设置页增删改/排序/测试并应用
│   │   ├── ota/                         # OTA 自更新
│   │   │   ├── UpdateInfo.kt
│   │   │   ├── UpdateSource.kt          # 本地/远程更新源
│   │   │   ├── ApkDownloader.kt         # APK 下载器（通过 AppHttpClient）
│   │   │   ├── ApkVerifier.kt           # 安装前哈希 / 签名校验
│   │   │   └── ApkInstaller.kt          # 系统安装器（ACTION_VIEW + FileProvider）
│   │   ├── ui/
│   │   │   ├── VoiceprintPanel.kt       # 声纹注册面板
│   │   │   ├── LogEntry.kt / LogCache.kt # 日志基础设施
│   │   │   ├── settings/                # 设置页模块化组件
│   │   │   │   ├── SettingsViewModel.kt # ViewModel（80+ 个 StateFlow 状态，含加密 prefs 注入缝）
│   │   │   │   ├── LoginSection.kt      # 登录区 Composable（只调 ViewModel，无网络/prefs 代码）
│   │   │   │   ├── LoginNavigationPolicy.kt # 登录门禁成功后的跳转策略
│   │   │   │   ├── SettingsOverviewModel.kt # 状态卡 + 概览 5 组/20 行与动态摘要纯模型
│   │   │   │   ├── SettingsPrimitives.kt    # 分组/区块/分隔线等基础组件
│   │   │   │   ├── CollectionControlPage.kt # 二级页：采集总控（上传/离线缓存总开关 + 上传与调度间隔；数据源行在概览）
│   │   │   │   ├── RunStatusPage.kt         # 运行状态页（状态卡进入：服务/网络/权限摘要）
│   │   │   │   ├── SoundPage.kt             # 二级页：声音与播报（提示音 / TTS 音量）
│   │   │   │   ├── AudioSettingsPage.kt     # 二级页：环境音频（分段时长 / 上传频率 / 上传格式 WAV|FLAC）
│   │   │   │   ├── WakeWordSettingsPage.kt  # 二级页：语音唤醒（唤醒状态 + 识别参数；音量在 SoundPage）
│   │   │   │   ├── GpsSettingsPage.kt       # 二级页：位置 GPS（间隔 + 5 项行为）
│   │   │   │   ├── SystemStateSettingsPage.kt # 二级页：系统状态（4 子开关 + 间隔 + 权限引导）
│   │   │   │   ├── NotificationPage.kt      # 二级页：通知（单个总开关 + 通知检查间隔 notify_ms + 敏感应用黑名单）
│   │   │   │   ├── HealthDataPage.kt        # 二级页：健康数据（上传模式/定时时段/间隔 + DB 路径）
│   │   │   │   ├── AccountPage.kt           # 二级页：账号与登录
│   │   │   │   ├── DevicePage.kt            # 二级页：设备信息与名称（设备 ID / 名称保存）
│   │   │   │   ├── BackgroundPage.kt        # 二级页：后台运行与权限（电池优化/权限检查/厂商限制）
│   │   │   │   ├── PermissionChecklist.kt   # 权限检查清单（运行状态页与后台运行页共用）
│   │   │   │   ├── SecurityPage.kt          # 二级页：安全（SSL 证书）
│   │   │   │   ├── AdvancedPage.kt          # 二级页：高级（OTA + 服务日志）
│   │   │   │   ├── NetworkSettingsPage.kt   # 二级页：连接层列表/编辑器/选择模式
│   │   │   │   ├── WidgetsSettingsPage.kt   # 二级页：桌面组件
│   │   │   │   ├── SettingsComponents.kt    # 复用组件（子页脚手架 / SettingsRow 列表行 / 各类选择器 / VAD 电平条 / KWS 面板）
│   │   │   │   ├── SettingsPermissionUtils.kt # 权限与开关状态检查工具
│   │   │   │   ├── VoiceprintSection.kt     # 声纹管理列表行（独立 Dialog）
│   │   │   │   ├── AdvancedSection.kt       # 高级区内容（OTA + 服务日志）
│   │   │   │   ├── SecuritySection.kt   # 安全设置 Composable（SSL 证书验证）
│   │   │   │   ├── OtaSection.kt        # OTA更新 Composable
│   │   │   │   ├── PermissionDialogs.kt # 权限引导弹窗
│   │   │   │   └── SensitiveAppPicker.kt # 敏感应用多选选择器（搜索/图标/复选）
│   │   │   ├── web/
│   │   │   │   └── WebViewReloadPolicy.kt # 切层后返回主界面时重载 WebView 的判定
│   │   │   └── theme/
│   │   │       ├── KinshipTokens.kt     # Kinship 颜色/间距/圆角/动效/字号 + 明暗 ColorScheme
│   │   │       └── SettingsTheme.kt     # AxeuhSettingsTheme（跟随系统）+ SettingsAnim
│   │   └── receiver/
│   │       ├── BootReceiver.kt          # 开机自启
│   │       └── AdbCommandReceiver.kt    # ADB 命令广播
│   ├── assets/kws/                      # 端侧 KWS 模型与词表（5 个文件，约 5.45MB；keywords.txt 缺失会导致原生层退出进程）
│   ├── res/
│   └── AndroidManifest.xml
├── src/test/                            # 单元测试（68 个文件，JUnit4 + MockK + Truth + Robolectric）
├── src/androidTest/                     # 仪器测试（AxeuhAcceptanceTest.kt）
├── build/
├── docs/
│   └── band_data_collection_guide.md    # 手环数据采集指南
└── AGENTS.md                            # 本文件
```

## 架构设计

### 分层依赖

```
连接层 (TierStore/TierSelector/TierRuntime) → ServerConfig.BASE_URL（内存镜像）
认证层 (SessionManager) → UI / AppHttpClient
网络层 (AppHttpClient) ← 采集器/上传器 ← DataCollectorService(调度器)
状态层 (SensorStateHolder) ← 采集器 → 上传器 → 网络层
UI层 (SettingsViewModel) ← SensorStateHolder + AppHttpClient + SessionManager
```

### DataCollectorService（采集调度器）

以前台 Service 运行，不再直接采集数据，而是启动/停止各 Collector。除音频外各采集器的间隔均从 SharedPreferences 实时读取，设置页改动即时生效：

```
DataCollectorService
├── CollectorManager
│   ├── SystemStateCollector → 系统状态间隔：前台应用/媒体/WiFi/蓝牙/屏幕
│   ├── NotificationCollector → 通知间隔：计数轮询 + 内容入队（发送时机由主循环统一决定）
│   ├── GpsCollector → GPS 间隔：GPS定位
│   ├── HealthDataCollector → 健康间隔：手环心率/步数/压力/血氧
│   └── AudioCollector → 连续循环：PCM→（按 audio_upload_format 编码 WAV/FLAC）→分段上传（按 audio_segment_ms 固定切段，默认 60s；端侧唤醒命中时另按需推流）
├── 主循环（loop_ms，默认30s）：**统一上传心跳**（除健康数据与环境音频外的全部感知事件）
│                               + 触发Gadgetbridge同步 + 电量读取 + 启停采集器 + 权限复核 + 健康定时调度
│                               + applyToggle 启停采集器 + 健康数据定时时段调度
└── NotificationStreamClient：通知下行 WS 长连接（随服务起停，替代旧轮询）
```

| 传感器 | 采集器 | 实现方式 | 间隔 |
|--------|--------|---------|------|
| 音频 | AudioCollector | AudioRecord（VOICE_RECOGNITION 音源，不降级）+ 固定分段（audio_segment_ms）+ 上传格式双档（audio_upload_format: wav/flac） | 连续 |
| 前台应用 | SystemStateCollector | UsageStatsManager | 系统状态间隔（默认1s） |
| 媒体播放 | SystemStateCollector | MediaSessionManager | 系统状态间隔（默认1s） |
| WiFi/网络 | SystemStateCollector | WifiManager + ConnectivityManager | 系统状态间隔（默认1s） |
| 蓝牙 | SystemStateCollector | BluetoothManager | 系统状态间隔（默认1s） |
| 屏幕状态 | SystemStateCollector | PowerManager | 系统状态间隔（默认1s） |
| 通知 | NotificationCollector | NotificationListenerService（计数轮询；内容按 sbn.key 去重后限流上行） | 通知间隔（默认5s） |
| GPS | GpsCollector | LocationManager | GPS间隔（默认5min） |
| 健康 | HealthDataCollector | Gadgetbridge DB (SQLite) | 健康间隔（默认60min；定时时段模式另计） |
| 输入内容 | AccessibilityService | 无障碍服务 | 5s |

### 数据流

```
采集器 → SensorStateHolder.updateXxx() → UI层 collectAsState()
采集器 → PendingUploadQueue（入队，只缓存不发）→ 主循环 flushPendingUploads() → POST /api/screen/stt/perception-event
AudioCollector → AudioUploader → OkHttp Multipart → /api/screen/stt/voice-session-multipart
HealthDataCollector → HealthBatchUploader → AppHttpClient.post() → /api/health/sync
NotificationCollector → 入队 (type="notify") → 主循环统一上传 → 后端去重/脱敏存储（通知上行）
NotificationStreamClient ← /ws 长连接 ← 后端 component_manager 推送（通知下行）
```

### 设备名称注入数据流

```
Settings UI → 输入设备名称
  ↓ SharedPreferences("device_name")
  ↓ ServerConfig.DEVICE_NAME / HAS_CUSTOM_DEVICE_NAME

所有感知事件发送入口（仅 HAS_CUSTOM_DEVICE_NAME=true 时注入 payload）:
  DataCollectorService.enqueueEvent()（旧名 pushEvent）→ 屏幕/传感器/系统状态事件统一入队
  SystemStateCollector.sendEvent()                  → 前台App/媒体/设备环境事件（内部转 enqueueEvent）
  HealthDataCollector.uploadToBackend()             → 健康数据（独立链路）

> `EventUploader.kt` 已于 2026-09-16 删除（无任何调用方）。

后端存储:
  /api/screen/stt/perception-event → perception.jsonl 携带 device_name
  /api/health/sync                 → health.json 携带 device_name
```

### 设备标识 (DeviceId)

`util/DeviceId.kt` 在 `SharedPreferences("axeuh_prefs")` 中持久化一个随机 UUID（键 `device_uuid`），生成一次后不再变化，供两处共享同一设备标识：

```
NotificationStreamClient → /ws?token=...&client=native&device_id=<uuid>   （通知下行 WS）
MobileActivity          → /mobile/?token=...&device_id=<uuid>&client=web  （WebView 加载 SPA）
```

后端据此实现 TTS 设备路由（哪台设备发消息，语音回复就回哪台）。WebView 侧该 query 参数由 `frontend/mobile/src/composables/useDeviceId.ts` 读取并持久化。

### 音量设置与 TTS 音量桥接

`data_collector` prefs 中有两个音量键（0-100），均在设置页「声音与播报」页（`SoundPage`）以滑块 + 「试听」按钮呈现：

| 键 | 默认 | 含义 | 消费方 |
|----|------|------|--------|
| `hint_tone_volume` | 90 | 唤醒/录制结束**提示音**音量 | `AudioCollector` 播放前读取并传给 `HintTonePlayer`（即时生效） |
| `tts_volume` | 100 | **TTS 语音**音量 | 前端网页播放器（GainNode）+ App 本地试听（MediaPlayer） |

提示音来自内置资源 `res/raw/start.mp3`（唤醒确认）与 `res/raw/end.mp3`（录制结束），由 `HintTonePlayer` 用 `SoundPool` 播放，非 TTS 中文语音。

TTS 音频由后端合成、在 WebView 内的网页播放器（Web Audio）播放，App 原生不播放 TTS，故 `tts_volume` 需桥接到网页：

```
设置页滑块 → data_collector prefs["tts_volume"]（0-100）
   ├─ MobileActivity URL 追加 ?tts_volume=<v>                       （首屏兜底）
   └─ MobileActivity.onResume → evaluateJavascript(
        "window.__axeuhSetTtsVolume(<v>)")                          （从设置页返回时实时同步）
        └─ 前端 useTtsPlayer 全局钩子 → GainNode.gain.value = v/100
```

网页端 localStorage 亦缓存 `tts_volume`（URL 参数优先）。「试听」按钮走 App 本地路径：`POST /api/screen/tts/synthesize` 取 base64 WAV，用 MediaPlayer 以同一音量播放；无 MiMo Key 时返回错误文案并展示。

## SettingsActivity（设置页）

混合式信息架构：概览页为 `LazyColumn`（纯列表行），经 `NavHost` 导航到各子页面，全程共享同一个图作用域 `SettingsViewModel`。

**交互约定（2026-09-16 重整）**：一级页面只放「列表行：名称 + 摘要 + 开关 + 箭头」，详细配置一律收进二级页；**全设置模块不再使用展开/折叠卡片**（`ExpandableSettingsCard` / `SettingsSourceCard` 已删除）。

概览页：顶部运行状态卡（点击进 `RunStatusPage`）+ 5 组 20 行列表。行内开关可直接操作，行点击进二级页：

| 分组 | 列表行（目标页 / 动作） |
|------|------|
| 采集与上传 | 采集总控（`CollectionControlPage`）· 通知（`NotificationPage`）· 健康与手环（`HealthDataPage`）· 环境音频（`AudioSettingsPage`）· 语音唤醒（`WakeWordSettingsPage`）· 位置（`GpsSettingsPage`）· 系统状态（`SystemStateSettingsPage`）· 输入内容（行内开关）· 电量与充电（行内开关） |
| 连接与账号 | 账号与登录（`AccountPage`）· 网络（`NetworkSettingsPage`）· 立即同步（行内动作） |
| 桌面与历史 | 桌面组件（`WidgetsSettingsPage`）· 通知历史（`NotificationHistoryActivity`） |
| 设备与运行 | 设备信息与名称（`DevicePage`）· 后台运行与权限（`BackgroundPage`）· 声音与播报（`SoundPage`） |
| 隐私与维护 | 声纹管理（Dialog）· 安全与证书（`SecurityPage`）· 更新与诊断（`AdvancedPage`） |

子页面与支撑组件：

| 模块 | 文件 | 功能 |
|------|------|------|
| **SettingsViewModel** | `ui/settings/SettingsViewModel.kt` | 70+ 个 StateFlow 状态管理（含 `installedApps` 已安装应用缓存、端侧唤醒/KWS 测试状态）；`securePrefsProvider` 注入缝（测试绕过 AndroidKeyStore） |
| **CollectionControlPage** | `ui/settings/CollectionControlPage.kt` | 二级页：感知数据上传 / 离线缓存总开关 +「上传与调度间隔」。数据源开关与二级配置入口（含通知）在概览「采集与上传」分组，本页不重复渲染，也不提供跨页入口 |
| **AudioSettingsPage / WakeWordSettingsPage** | `ui/settings/AudioSettingsPage.kt` / `WakeWordSettingsPage.kt` | 音频两条链路的二级配置页：前者 = 分段时长 + 上传频率 + 上传格式（WAV/FLAC 两档 ChoicePicker + 流量提醒）；后者 = 唤醒状态面板 + 识别参数（`KwsSettingsPanel(showMasterSwitch = false)`，总开关已提到列表行）；提示音/TTS 音量与「试听」已移至 `SoundPage` |
| **GpsSettingsPage / SystemStateSettingsPage** | `ui/settings/GpsSettingsPage.kt` / `SystemStateSettingsPage.kt` | GPS 参数（间隔 / 精度优先级 / 最小位移 / 最大精度 / 定位超时 / 逆地理编码）与系统状态 4 子开关 + 间隔；使用情况访问 / 定位 / 蓝牙的权限引导在后一页 |
| **NotificationPage** | `ui/settings/NotificationPage.kt` | **单个**总开关（合并原「通知感知」+「上传通知到后端」，`setNotificationEnabled()` 同时写两个 prefs）+ 通知检查间隔（`notify_ms`，与主循环上传间隔解耦）+ 敏感应用黑名单（已安装应用多选选择器，保留手动包名输入） |
| **AccountPage / BackgroundPage / DevicePage / SoundPage / SecurityPage / AdvancedPage** | `ui/settings/` | 概览行对应的二级页：登录、后台运行与权限（电池优化 / 权限检查）、设备信息与名称、声音与播报、SSL、高级（OTA + 日志）。除 BackgroundPage 外均为 `SettingsSubPageScaffold` + `SettingsGroup` 的薄包装 |
| **RunStatusPage / RunStatusModel / RunStatusCard** | `ui/settings/RunStatusPage.kt` / `RunStatusModel.kt` / `RunStatusCard.kt` | 运行状态页与纯模型：服务运行、网络摘要、权限矩阵与顶部状态卡；`BackgroundPage` 复用同一权限清单 |
| **NetworkSettingsPage** | `ui/settings/NetworkSettingsPage.kt` | 网络二级页：连接层列表（增删改 / 启停 / 上下移）、选择模式（AUTO_CHAIN / PINNED）、测试并应用；P2P 层可保存但恒显示“未接入，后续统一做”；所有写入只落 `network_config_v1` |
| **SensitiveAppPicker** | `ui/settings/SensitiveAppPicker.kt` | 全屏选择 Dialog：搜索 + 应用图标/名称/包名 + 多选复选，选中项回写为逗号分隔包名 |
| **HealthDataPage** | `ui/settings/HealthDataPage.kt` | 上传模式（定时时段/间隔）、时段列表或间隔、Gadgetbridge 数据库路径 |
| **WidgetsSettingsPage** | `ui/settings/WidgetsSettingsPage.kt` | 桌面组件二级页（概览「桌面与历史」分组行）：`widgets_enabled` 总开关（关闭=桌面卡片渲染停用占位+健康快照停更，系统通知与通知历史仍记录；写侧历史在 `NotificationStore` 恒写，卡直更/快照受门控）+ 四卡钉选（`GlanceAppWidgetManager.requestPinGlanceAppWidget`，launcher 可拒且无回执，内联状态文本回显）+ 卡片背景（PickVisualMedia 选图，降采样副本存私有目录）+ 卡片昼夜配色（预置色板 / 自定义 hex / 可读性遮罩）+ 机制说明（无通知历史入口行；历史是概览同组独立行 `NotificationHistoryActivity`，全文本地保存最近 50 条）。原桌面组件演示页已删除 |
| **SettingsComponents** | `ui/settings/SettingsComponents.kt` | 子页脚手架、**一级列表行 `SettingsRow`**、间隔/时段/开关/音量/数字/单选选择器、VAD 电平条、KWS 面板；`ExpandableSettingsCard` / `SettingsSourceCard` 已删除（见 L282） |
| **SettingsPermissionUtils** | `ui/settings/SettingsPermissionUtils.kt` | 权限与开关状态检查工具（含 `hasLocationPermission`） |
| **VoiceprintSection** | `ui/settings/VoiceprintSection.kt` | 声纹管理一级列表行（点击弹出管理 Dialog） |
| **AdvancedSection** | `ui/settings/AdvancedSection.kt` | 高级区内容（OTA + 服务日志） |
| **SecuritySection / OtaSection / LoginSection / PermissionDialogs** | `ui/settings/` | 安全设置、OTA、登录区、通知监听权限引导（其余权限引导由页面本地弹窗处理） |

**设置生效时机（2026-09-16 排查结论）**：全部设置项**改动即时生效**，无需重启 App 或重启采集：

- 各采集器间隔（GPS / 系统状态 / 健康 / 通知 / 主循环 `loop_ms`）均在循环内每轮读 prefs；
- 环境音频的分段时长（`audio_segment_ms`）改为**每段开始时重读**（原先只在进入采集循环时读一次，改完要重启采集才生效）；上传格式（`audio_upload_format`，2026-09-23）同样**每段开始时重读**，改完下一段生效；
- 端侧唤醒识别参数（灵敏度 / 判定阈值 / 唤醒词 / 推理间隔）改动时由 `AudioCollector.requestKwsReload()` 置标记，采集线程在下次推理前用新参数**重建引擎**（`KWS_RELOAD_MIN_GAP_MS = 2000` 节流，避免拖动滑块时连续重建造成录音卡顿）；
- 音量（提示音 / TTS）、上传频率、通知开关与间隔、GPS 行为项、SSL 验证、服务器地址均在调用点即时读取或重建；
- 传输模式（2026-10-24）：强制 FRP 立即选择 frp 端点并停止 WebRTC；切回 AUTO 后如需恢复 WebRTC，需重启采集服务/App（当前实现不自动重建 manager）；
- **统一上传（2026-09-16）**：除健康数据与环境音频外，所有感知事件由采集器入队（`PendingUploadQueue`）、主循环统一发出 —— 所以「上传与调度间隔」（原「主循环间隔」）同时决定这些数据的**上报延迟**（默认最多 30 秒）；通知的 `notify_upload_interval_ms` 已废弃。主循环发送前会把本轮快照落盘（`cacheDir/pending_uploads.jsonl`，**仅「离线缓存」开关开启时**），服务启动时恢复，避免发送途中进程被杀丢数据。

每个传感器开关点开启时自动检查对应权限，未授权弹窗引导。主题由 `ui/theme/KinshipTokens.kt` 提供浅色/深色方案（跟随系统），`AxeuhSettingsTheme` 只做接线；`SettingsActivity` 使用 `Theme.KinshipSettings` + `values-night` 的暖纸/暖炭窗口背景。子页转场使用 `SettingsAnim`（`DURATION_MS = 180`，`FastOutSlowInEasing`，仅剩 `slideSpec`）。

## 键模块说明

### AppHttpClient（网络层）
- OkHttp 封装，HTTPS 证书验证由 `axeuh_prefs["ssl_verify"]` 控制（缺省 true = 系统 CA 校验；显式 false 才 trust-all，仅用于自签名/IP 直连）
- 传输失败回调：仅 `IOException` 触发 `onTransportFailure(origin)`；HTTP 401/4xx/5xx 不触发
- `res/xml/network_security_config.xml` 允许 HTTP 明文流量
- Token 自动注入（从 SharedPreferences 读取）
- 服务器 URL 取 `ServerConfig.BASE_URL`（tier 运行时写入的内存镜像），不直接读 tier 存储
- 密码存储使用 EncryptedSharedPreferences（AES256-GCM 加密）
- 方法：`get()` / `post()` / `postMultipart()` / `download()` (Flow)
- 超时：connect 15s / read 30s

### ServerConfig（配置管理）
- `object ServerConfig` 全局单例
- `DEFAULT_SERVER_URL = "https://localhost:8767"`（未保存自定义 URL 时的默认值）
- `init(context)` 从 SharedPreferences 读取已保存的服务器 URL 和设备名称
- `DEVICE_NAME` 默认为 `Build.MODEL`，用户自定义时 `HAS_CUSTOM_DEVICE_NAME=true`
- `update(url)` 仅更新内存 `BASE_URL`（tier 运行时使用；不写 prefs）
- `updateDeviceName(name)` 在设置页保存设备名称时同步更新
- `BASE_URL` 是运行时内存镜像；`selectBaseUrl()` / `setTransportMode()` / `updateEndpointCandidates()` 在 `network_config_v1` 存在后只改内存，不再写 legacy 三键
- `selectedEndpointType` / `selectedEndpointPreferIpv4` 优先使用 `applyActiveTierProfile()` 写入的 tier override，否则回退旧端点候选推导
- 所有采集器/上传器通过 `ServerConfig.BASE_URL` / `ServerConfig.DEVICE_NAME` 获取，无需各自读取 Prefs

### 连接层（transport/）
- `network_config_v1`（`axeuh_prefs`）是连接层唯一真源；旧 `server_url` / `endpoint_candidates` / `transport_mode` 迁移后只读。
- `TierStore`：编解码/迁移/只读保护；迁移按候选 priority，`server_url` 不匹配置顶，`FORCE_FRP → PINNED + 首个 FRP`，无地址不伪造 localhost。
- `TierSelector`：AUTO_CHAIN 活跃优先 + 30s 冷却；PINNED 永不自动切；P2P 恒 `Skipped`；仅 `IOException` 触发换层。
- `TierRuntime`：`DataCollectorService` 启动时 `bootstrap()`，每 5 分钟 `refresh(force=false)`；`AppHttpClient.onTransportFailure(origin)` 触发一次强制重选；apply 只写内存。
- `TierSettingsController`：网络设置页写入口，只落 `network_config_v1`。
- `TierProbe`：按 `tier.family` 选择 IPv4/IPv6 优先 DNS（AUTO 保持系统顺序）；允许路由回退（retry=true），connect 3s / read 5s / call 10s；`probeAll` 并发探测且保持配置顺序。
- P2P 仅 `TierKind.P2P` + `TierTarget.Peer` 类型化占位；无信令/数据面/发现，后续统一做。

### SensorStateHolder（状态层）
- 纯 Kotlin + Coroutines，无 Android 依赖
- 18 个 StateFlow 状态；每个有 `updateXxx()` / `snapshotXxx()` 方法，并暴露只读 `val xxx: StateFlow` 供 UI 直接 collect
- 状态：vadStatus, currentDbLevel, debugStateJson, lastSensorText, lastResponseText, lastGps, lastGpsAddress, lastMediaText, lastHeartRate, lastSteps, lastStress, lastSpo2, lastNotificationCount, micStatus, kwsStatus, kwsHitCount, kwsLastHit, kwsCloudTestResult
- `SensorStateHolder.shared` 为进程内共享单例（采集端与设置页必须读写同一实例，否则 UI 只读到初值）

### BaseCollector（采集器基类）
```kotlin
abstract class BaseCollector(
    protected val context: Context,
    protected val stateHolder: SensorStateHolder,
    protected val httpClient: AppHttpClient
) {
    abstract fun start()
    abstract fun stop()
    open val isEnabled: Boolean get() = false
}
```

### 缓存机制

| 缓存 | 目录 | 文件 | 触发条件 |
|------|------|------|----------|
| 音频上传失败 | `upload_cache/` | `{ts}.json` + `{ts}.wav` 或 `{ts}.flac` | AudioCollector.sendCapturedAudio 上传失败 |
| 健康数据失败 | `health_upload_cache/` | `{ts}.json` | HealthBatchUploader 3次重试后（重放路径传 `cacheOnFailure=false`，失败保留原文件、不写重复副本） |
| 感知事件失败 | `perception_cache/` | `{ts}_{type}.json` | PerceptionCache：pushEvent/sendEvent/通知上行 上传失败 |

设置页"离线缓存"开关控制所有缓存写入，关闭时立即清空已有缓存。

`HealthBatchUploader` 的服务器地址取自 `ServerConfig.BASE_URL`（不再读 `prefs["server_url"]`）。

### AudioCollector（音频采集关键细节）

| 项目 | 说明 |
|------|------|
| 音源策略 | 仅 `VOICE_RECOGNITION`（绕过蓝牙 MIC），不降级到 `CAMCORDER`/`MIC` |
| 启动验证 | 后台线程中连续读 10 帧（300ms），任一帧非零则通过；全零则释放 1s 后重试 |
| 全零兜底 | 录音完成后检测 WAV 体是否全零，跳过无意义上传 |
| 电平/统计 | App 端**不含 VAD 端点切段**：分段恒按 `audio_segment_ms` 固定封段；`SegmentSpeechTracker` 仅累计说话/静音时长（分段日志 `说话 xxxx ms`）并刷新 UI 的 VAD 展示状态。`RMS_THRESHOLD=8.0`（≈ −72.3 dBFS）仍用于流式 VAD 展示状态、离线碎片静音切分与 UI 电平阈值线；`SILENCE_MS=1500` 仅用于 UI 状态与流式分片边界 |
| 前滚重叠 | **每次切段**（含硬上限切段）都把上一段尾部 `OVERLAP_MS=500ms` 作为下一段开头（`PcmRing`），避免首字被切掉；重叠不计入时间轴 |
| 重试策略 | 指数退避 1s→2s→4s→...→30s 封顶 |
| 缓存 | 分段先经 `PcmCheckpointWriter` 落 `upload_cache/{startMs}-{seq}.wav|.flac` + `.json`（按 `audio_upload_format` 编码），上传失败保留条目下轮重试 |

**MIUI 注意事项**:
- `VOICE_RECOGNITION` 在 MIUI 上 `startRecording()` 可能成功但麦克风未实际激活（返回全零 PCM）
- 必须声明 `foregroundServiceType="microphone"` 并在 `startForeground()` 显式传入类型
- 第 1 帧数据可能全零，是硬件延迟而非未激活，要多帧判断
- MIUI 无"始终允许"麦克风权限选项，前台服务 + 正确类型声明是唯一的后台录音途径

**前台服务类型（2026-09-15 变更，重要）**:
- FGS 类型由 `dataSync|microphone` 改为 `microphone|specialUse`（manifest 同步）。原因：Android 15（targetSdk 35+）起 `dataSync` 受 6h/24h 前台配额限制，配额耗尽后系统停止服务并以 `RemoteServiceException` 崩溃进程 —— 即「累计约 6 小时后后台录音中断」的根因。`microphone` 与 `specialUse` 均无时长上限（`specialUse` 需在 `<service>` 内声明 `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE">`）。
- 运行时按 `RECORD_AUDIO` 动态选型：已授权 → `microphone`；未授权 → `specialUse`（未授权声明 `microphone` 会在 ColorOS 抛 `SecurityException`）。另已实现 `onTimeout()` 防御，超时时主动 `stopSelf()` 而非被系统崩溃。
- 副作用：**开机自启在 Android 14+ 已不可行** —— `BOOT_COMPLETED` 启动前台服务有类型白名单（`location|connectedDevice|remoteMessaging|health|systemExempted|specialUse`），`microphone`（及 targetSdk 36 下的 `dataSync`）均不在其中，`BootReceiver` 会抛 `ForegroundServiceStartNotAllowedException` 并被静默吞掉。恢复采集只能靠用户可见操作（打开 App，或点「录音已中断」通知）。

### 音频分段与上传频率解耦（2026-09-15）

分段时长、上传频率、上传格式是三个**相互独立**的维度，分别由 `data_collector` prefs 控制：

| 键 | 默认 | 作用 |
|----|------|------|
| `audio_segment_ms` | 60000 | **固定分段时长**（默认 60s）：App 端按此**固定切段**，不做语义切分（App 端不含 VAD 端点逻辑，语义连续性由后端无缝流负责） |
| `audio_upload_batch_ms` | 600000 | **批量上传间隔**（10 分钟）；只决定"多久发一次" |
| `audio_upload_format` | wav | **上传音质双档**（2026-09-23）：`wav`=原始 PCM+44 字节头；`flac`=无损压缩（约省 46% 流量：WAV 2.76 GB/天 vs FLAC 1.50 GB/天，N=100 实验验证 Δsim=0/零翻转）。**每段开始时现读**（`DataCollectorService.getUploadFormat`，非法值回退 wav），改完下一段生效、无需重启；编码经 `FlacFinalizer`（见下），**失败自动降级 WAV 绝不丢数据** |
| `audio_stream_enabled` | ~~true~~ → **恒 false（已废弃）** | 常驻流式推流（服务端 KWS 路径）已于 2026-09-16 弃用：`isAudioStreamEnabled()` 固定返回 false，设置页不再暴露该开关。回退需改代码 |
| `local_kws_enabled` | false | 端侧唤醒（KWS）开关；详细参数见「端侧唤醒（LocalKwsEngine）」 |

- 纯策略在 `service/collectors/AudioSegmentPolicy.kt`（`isBatchUploadDue` / `overlapTail` / `nextSegmentStartMs`，无 Android 依赖）；`SegmentSpeechTracker` 只累计说话/静音时长供 UI 状态与分段日志，**不做端点判定**；`PcmRing` 为定长环形缓冲。
- 上传触发条件（任一）：距上次调度达到 `audio_upload_batch_ms`；待上传累计达到 `PENDING_UPLOAD_THRESHOLD_MS=30min`；停止/中断/划后台立即上传（`triggerUpload=true`，且即使本次未认领到进行中分段也会补传既有缓存条目，见下条）。
- 两种采集模式（`AudioCollector`，互不影响）：**环境音频**按 `audio_segment_ms` 固定分段 + 批量 multipart 上传（`audio_upload_batch_ms`）；**语音唤醒**（`local_kws_enabled=true`）在录音线程跑端侧 KWS，命中后按需推流。常驻流式（`audio_stream_enabled`）已于 2026-09-16 废弃（恒 false），不再有"两开关组合成三种模式"的耦合。

> **App / 后端分工（勿混谈）**：**App 端**只负责固定分段（`audio_segment_ms`，默认 60s）+ 按格式编码（`audio_upload_format`，wav|flac）+ 崩溃安全 checkpoint + 批量上传（`audio_upload_batch_ms`）（+ 端侧唤醒按需推流），**不含 VAD 端点逻辑、不做语义切分**；**后端**负责无缝流拼接（magic 嗅探统一解码 PCM，水位/去重/切分全格式无关）与落盘编排，而流内静音端点切分与音频层合并后的 VAD/ASR 等**计算全部委托独立音频内核**（kernel/，外层零算法；见根 `AGENTS.md` 与 `backend/AGENTS.md`），chunk 按上传格式封装落盘。

### FLAC 编码链（FlacFinalizer，2026-09-23）

`service/uploader/FlacFinalizer.kt` 实现 `FlacEncoder` 函数式接口（可注入缝，单测注入假编码器），`encode(pcm, sampleRate): ByteArray?`：

- **路径 1 MediaCodec**（首选）：`createEncoderByType("audio/flac")` + `KEY_PCM_ENCODING=ENCODING_PCM_16BIT`；CSD 头双来源（`BUFFER_FLAG_CODEC_CONFIG` buffer 或 outputFormat `csd-0`，厂商标行差异都接受）；60s 段 <1s；**无 FLAC 编码器的 ROM 属正常降级路径**（CDD 仅 Android 12+ 麦克风设备强制，非全设备保证），create/configure 抛异常即转路径 2。
- **路径 2 java-flac-encoder**（兜底）：`com.github.axet:java-flac-encoder:0.3.8`——**Maven Central 直接依赖，勿配 JitPack**（`axet/java-flac-encoder` GitHub 仓库不存在，JitPack 404）；包 `net.sourceforge.javaflacencoder`，只用 `FLACEncoder`/`StreamConfiguration`/`FLACFileOutputStream`（纯 java.io），**勿用 `FLACFileWriter`/`FLAC_FileEncoder`/`AudioStreamEncoder`**（依赖 javax.sound，Android 无此类，class-load 即炸）；`FLACFileOutputStream` 可 seek，`encodeSamples(..., end=true)` 时库自动回写 STREAMINFO。
- **STREAMINFO patch**：`patchTotalSamples()` 纯函数写 36-bit total-samples（file offset 21 起 5 字节），前置校验 fLaC 魔数 + 首块必须是 STREAMINFO（len 34），不满足**原样返回**（未 patch 仍是合法 FLAC，时长未知=0，接受此降级——崩溃在编码收尾前只损失时长字段不损失音频）。
- **双路都失败返回 null** → 调用方（`PcmCheckpointWriter.tryEncodeFlac` / `AudioCollector.saveFragmentToCache`）**当场降级写 WAV，数据绝不丢**。
- **许可**：LGPL-2.1，源码 `https://github.com/amplexus/java-flac-encoder`；APK 分发需随附许可声明（`packaging.resources.excludes` 已排除 META-INF/LGPL2.1 冲突文件）。

### 崩溃安全 checkpoint 与恢复（2026-09-15）

```
filesDir/audio_checkpoint/pending/<sessionId>/<segStartMs>.json   # sidecar 元数据（先写）
filesDir/audio_checkpoint/pending/<sessionId>/<segStartMs>.part   # 原始 s16le PCM（追加）
```

- `service/uploader/PcmCheckpointWriter.kt`：采集线程逐帧 `append`（checkpoint 恒存裸 PCM，编码只在 finalize 时做），每 `DEFAULT_FLUSH_INTERVAL_MS=10s` 周期 `flush+fsync`（进程被杀最多丢一个 flush 周期）；`finalizeSegment()` 按 `uploadFormat` 编码——WAV 补 44 字节头 / FLAC 经注入的 `FlacEncoder`（生产 `FlacFinalizer`，编码失败自动降级 WAV）——原子落地到 `cacheDir/upload_cache/{segStartMs}-{seq}.wav|.flac` + `.json`（JSON 含 `format` 字段，字段与离线碎片缓存一致，`uploadCachedData()` 直接重放）；`abort()` 丢弃。
- **崩溃恢复**：`DataCollectorService.onCreate` → `CollectorManager.recoverAudioCheckpoints()` → `AudioCollector.recoverCheckpointsAndUpload()` → `service/uploader/CheckpointRecovery.recover()` 把残留 `.part` 按 sidecar `format` 编码转成对应后缀的 `upload_cache` 条目并触发补传（flac 编码失败同样降级 wav）；空文件 / 损坏 sidecar / 无法确定起始时间一律清理且不抛异常。
- **生命周期收尾**：`stop()`（含关闭「环境音频」开关）与 `onTaskRemoved`（从最近任务列表划掉）都会结束进行中分段并 `finalize` 到 `upload_cache`，不丢已录内容；`closeCurrentSegment()` 原子认领，重复调用幂等。
- **清理策略**：`CheckpointCleanup`（LRU + TTL 7 天 + 500MB 上限），**未上传成功的条目永不淘汰**。
- **中断立即补传（2026-09-15）**：中断路径（`stop()` / 关采集开关 / `onTaskRemoved` / `onDestroy` / 录音异常）调用 `closeCurrentSegment(toCache=true, triggerUpload=true)` 时，**即使本次未认领到进行中分段**也照常触发补传，把此前正常切段（`forceUpload=false`）留下的 `upload_cache` 条目一并发出——停止后不会再有任何批次调度，否则会滞留到下次启动。`triggerCacheUpload()` 在已有补传线程 in-flight 时不并发起第二个线程，改为标记「再跑一轮」（`cacheUploadRerunRequested`），当前轮结束后立即补跑，保证新落盘条目不丢、同一条不重复上传。**进程被杀**路径不变，仍靠 checkpoint 落盘 + 下次启动 `CheckpointRecovery` 恢复。

### 端侧唤醒（LocalKwsEngine，2026-09-15）

`wakeword/LocalKwsEngine.kt` 封装 sherpa-onnx `KeywordSpotter`（经 JNI），模型与词表来自 `assets/kws/`（与服务端 `ai/data/wake_word/` 同源）。**非线程安全**，必须在录音线程串行调用；模型缺失/加载失败时 `initialize()` 返回 false 并保持不可用，绝不抛异常影响采集链路（`keywords.txt` 缺失会导致原生层直接退出进程，故必须随 assets 打包）。

| 构造参数（`LocalKwsEngine.Config`） | 默认 | 说明 |
| ----------------------------------- | ---- | ---- |
| `keywordsScore` | `1.8` | 唤醒词加权分（越大越难触发）；与服务端 `audio.wake_word.keywords_score` 对齐 |
| `keywordsThreshold` | `0.25` | 判定阈值；与服务端 `keywords_threshold` 对齐 |
| `customKeywords` | `""` | 自定义词表（已编码 token，多行）；空串沿用 assets 内置 `keywords.txt` |
| `intervalMs` | `100` | 推理间隔（ms，范围 100-1000）：`accept()` 内部**累积**样本，凑满一个间隔才跑一次模型（**累积而非跳帧**，保证送入模型的音频连续） |

Prefs（`data_collector`）与设置页对应：`local_kws_enabled`（开关，默认 false）、`kws_score`、`kws_threshold`、`kws_interval_ms`（界面提供 100/200/300ms）、`kws_keywords`（自定义词表 token，逗号/换行分隔输入后由服务端编码）、`kws_cloud_test_enabled`（云端测试模式）。设置页「语音唤醒」卡内的「唤醒词测试」面板展示状态 / 累计命中 / 最近命中 / 云端测试结果。

**端侧命中按需推流（`AudioCollector.startWakeStream`）**：

- 常驻预滚环形缓冲保留最近 `PRE_ROLL_MS = 2000` 毫秒；命中后取出预滚、按其实时长回推会话起始墙钟，`audio_start` 置 `localHit = true` 并携带实际命中词 `localHitKeyword`（多词表下服务端据此精确回显）。
- 建连期间继续读帧暂存（避免握手期丢指令）；`WAKE_CONNECT_TIMEOUT_MS = 30000` 内未就绪则把预滚/暂存帧转离线碎片缓存并结束本轮。
- 连接就绪后先发预滚再发暂存帧，之后按 100ms 帧持续上行，直到服务端 `wake/end`；`WAKE_CONFIRM_TIMEOUT_MS = 5000`（自连接就绪起算，不含建连耗时）内未收到 `wake/start` 则主动结束；`WAKE_STREAM_MAX_MS = 120000` 为 end 丢失时的兜底。
- 结束仅 `stopStream()`（不 `close()`），保留客户端实例与调度线程供下次唤醒复用。

**云端测试模式**：开启 `kws_cloud_test_enabled` 后 `audio_start` 带 `test: true`，服务端不投递 AI、不落盘唤醒音频，经同一 WS 回推 `kws_test_result`（含 `vp_scores` 滑窗分数序列、时长、ASR 文本、参数快照），由 `AudioStreamClient.onKwsTestResult` 交给设置页展示。

### 音频链路修复项（2026-09-15）

- **提示音电平归一化**：`res/raw/start.mp3` / `end.mp3` 原峰值约 −16 / −18 dBFS，现归一化到约 −1 dBFS（实测 −1.01 / −1.00 dBFS，响度约 6 倍）。因 `SoundPool` 的 `play()` gain 上限为 1.0，无法在播放侧放大，**只能改源文件**。
- **音频流 WS 建连 IPv4 优先**：`AudioStreamClient` 用自定义 `Dns`（`preferIpv4First`）把解析结果中的 IPv4 排到最前。背景：`example.com` 是双栈但 IPv6 入口不可达，OkHttp 4.12 无 Happy Eyeballs，会先连 IPv6 等满 `connectTimeout`（15s）才回退，导致建连稳定卡 15~16s。
- **`SensorStateHolder` 共享单例**：`SensorStateHolder.shared`（`by lazy`）。历史上 `DataCollectorService` 与设置页各 `new` 一个实例，导致设置页传感器预览（含 dB 电平）恒为初值；本类仍是普通类，单测可独立构造。
- **非流式上传补 `client_time`（毫秒精度）**：离线碎片 `upload_cache` 的 `client_time` 取分段**真实起始时间**并用 `yyyy-MM-dd'T'HH:mm:ss.SSSXXX`（原 `recordingStartMs` 只赋值一次，兼容分段模式下所有分段同名互相覆盖；秒级精度会因截断让后端跨段裁剪多裁真实音频）。补传时额外回传 `start_wall_ms` 表单字段，后端 `_resolve_start` 优先采用它。
- **服务端进门阈值**（App 侧无需改）：`audio.wake_word.entry_score_cohort_ready` / `entry_score_no_cohort` 生产于 2026-09-15 由 0.75 / 0.5 调为 **0.7 / 0.45**；`audio_config.py` 的代码兜底仍为 0.75 / 0.5。

### GpsCollector（GPS 采集关键细节）

采集间隔由 `gps_interval_ms`（默认 300000ms = 5min）控制；此外有 5 项可配置行为，全部由 `GpsCollector` 消费：

| key | 默认 | 单位 | 作用 |
|-----|------|------|------|
| `gps_accuracy_priority` | `"balanced"` | high / balanced / low_power | 决定 `providerOrder()` 的 provider 尝试顺序（high：GPS→PASSIVE→NETWORK；low_power：NETWORK→PASSIVE→GPS；balanced：PASSIVE→GPS→NETWORK） |
| `gps_min_displacement_m` | 0 | m（0=不过滤） | 与上次采纳位置直线距离不足该值时跳过本轮更新 |
| `gps_max_accuracy_m` | 0 | m（0=不过滤） | 精度差于该阈值的定位被丢弃 |
| `gps_fix_timeout_ms` | 0 | ms（0=关闭） | >0 时主动请求一次新鲜定位：`LocationManagerCompat.getCurrentLocation` + `withTimeoutOrNull`，`CancellationSignal` 随采集器停止取消；超时/失败/被过滤时回退缓存 provider 循环 |
| `gps_reverse_geocode` | false | bool | 把定位解析为可读地址 |

逆地理编码（`resolveAddress()`，`GpsCollector.kt:351-367`）：先判 `Geocoder.isPresent()`；API 33+ 用异步 `GeocodeListener` 重载，33 以下在 `Dispatchers.IO` 上阻塞调用 `getFromLocation`；整体包一层 `withTimeoutOrNull(3000)`，任何失败都降级为 null；地址由 `formatAddress()` 截断至 120 字符。

**坐标串格式与地址上报（兼容性要点）**：地址不拼进既有的 `"lat,lon,acc"` GPS 字符串（地址里的逗号会破坏 `split(",")` 解析），而是以独立 payload key `gps_address` 上报（仅非空时携带），与未改动的 `gps` / `gps_accuracy` 并存；状态侧对应独立字段 `_lastGpsAddress`（`updateLastGpsAddress` / `snapshotLastGpsAddress`）。后端 `routers/mobile.py`（`if entry.get("gps"):`）与 AI 分析（读 `entry["gps"]`）会忽略未知 key，旧解析器不受影响。

### 通知下行（NotificationStreamClient）

| 项目 | 说明 |
|------|------|
| 通道 | `wss://{host}/ws?token={auth_token}&client=native&device_id={uuid}`（复用后端 `/ws` 主注册表） |
| 触发 | `DataCollectorService` 随服务启动 `startNotificationStream()`，`onDestroy` 关闭 |
| 消息 | 收到 `{"type":"notification","data":{id,title,content,ts}}` → `showSystemNotification()` 弹系统通知 |
| 心跳 | 30s 应用层 `{"type":"ping"}`（收到 `connected` 回执后才启动） |
| 重连 | 指数退避 3s → 6s → ... → 30s 封顶；`close()` 后不再重连 |
| SSL | 复用 `AppHttpClient` 的 OkHttp 与 SSL 策略，仅关闭读超时（长连接） |

旧的通知 HTTP 轮询（`/api/notification/poll`）已从 App 端移除；该端点亦已从后端删除（P0-U4），**WS 为唯一接收路径**。

### 通知上行（NotificationCollector）

- `NotificationListenerService` 在 `onNotificationPosted` 内按 `sbn.key` 做内容指纹去重（有界 LRU，64 条），命中后经 `entryListener` 转发给 `NotificationCollector`。
- 上行受双重开关约束：`notification_enabled`（采集）与 `notify_upload_enabled`（上行，默认关闭）同时开启才发送。
- 命中 `notify_sensitive_apps`（包名黑名单，逗号/换行/分号分隔，由设置页「敏感应用选择器」从已安装应用多选中生成，同时保留手动包名输入）的通知只上报 `{package, ts, redacted:true}`，不携带标题/正文。
- 敏感应用列表用 `PackageManager.getInstalledApplications(0)` 在 `Dispatchers.IO` 上枚举（标签取 `getApplicationLabel`，图标取 `loadIcon().toBitmap().asImageBitmap()`，结果缓存在 `installedApps` StateFlow）；`AndroidManifest.xml` 声明 `QUERY_ALL_PACKAGES`（`tools:ignore="QueryAllPackagesPermission"`），因原有 `<queries>` 仅暴露启动器应用、而通知来源含非启动器/系统应用。存储格式不变（逗号分隔包名，按 `[,\n;]` 解析），`NotificationCollector` 无需迁移。
- 编译期无来源限制；运行期由 `PendingUploadQueue` 统一入队，**发送时机由主循环（`loop_ms`，默认 30s）统一决定**，`notify_upload_interval_ms` 自 2026-09-16 起不再参与限流（键保留以兼容旧配置）；失败由主循环落 `PerceptionCache`，下轮统一重放。

### 健康数据上传调度

| 模式 | 值 | 行为 |
|------|----|------|
| 间隔 | `health_upload_mode="interval"`（默认） | `HealthDataCollector` 自身循环按 `health_interval_ms`（默认 60min）采集 |
| 定时时段 | `health_upload_mode="schedule"` | 主循环每轮调用 `checkHealthSchedule()`，解析 `health_schedule_times`（HH:mm 列表，逗号/换行/分号分隔），判断是否有目标时刻落在 `(last_health_run_ts, now]` 窗口内；命中则触发一次采集并重新锚定 |

含时钟回拨兜底（锚点落在未来则重置并立即执行一次）。各数据源另有独立间隔：`gps_interval_ms`、`system_state_interval_ms`、`notify_ms`、`audio_segment_ms`、`loop_ms`。

### 桌面组件系列要点（2026-10-13）

- AI 通知卡 LazyColumn 卡内滚动（Glance 无可见滚动条 chrome=平台限制；条目上限 5→10，正文仍 take200/maxLines2、全文进历史页）；两卡左右边距统一单层 12dp、竖向节奏 8dp、头部权重统一 Column 包裹（HyperOS 结构消毒）；卡片背景图=设置页「组件」→「卡片背景」组 PickVisualMedia 选图、降采样≤512px 落 filesDir/widget_backgrounds/、独立 prefs widget_background_store、渲染层 Image 垫底+自持圆角+可读性遮罩、坏图自愈/失败静默回退纯色；提醒同步改独立 5s 子节拍（Mutex 单飞+updated_at|text 指纹判重才重绘，WidgetSyncWorker 15min 兜底不变）；通知回填去 isEmpty 门=每进程启动增量尾部拉取≤50（push id 去重，停机错过的通知可回补）

#### 2026-10-13 R2（v1.4.2 / versionCode 11）

- 首帧守卫命中改发加载骨架 `WidgetLoadingPlaceholder`（四卡同站点；根除 Glance 1.2.0 首会话死锁——未 provideContent 的 return 会 IgnoreResult 并永久卡 uiReady，crash-audit.md 证据链）
- 配置页停止绑定前 `updateAll`（首刷责任交还 launcher onUpdate）
- 通知卡+聚合卡 provider `resizeMode=horizontal|vertical`（无 minResize*，下限对齐 4x2）
- 卡片配色 `WidgetColorStore`（prefs `widget_color_store`：两卡 bg/text 昼夜 Int 对 + scrim 布尔，缺省=内置调色板/遮罩开；值型 ColorProvider 配对序列化 API31+ 宿主自动换、≤30 靠翻转重发；禁 ColorProvider 子类）
- 设置页「组件 → 卡片颜色」组（默认/8 预置/自定义 #RRGGBB，校验单源 `normalizeHex`）
- `DataCollectorService` 注册 `ACTION_CONFIGURATION_CHANGED` 运行时 receiver（`RECEIVER_NOT_EXPORTED`；夜键差分→updateAll 已启用卡）+ `onConfigurationChanged` 并行保险
- 后端通知 id epoch-秒单调（跨重启全局唯一，Int32 至 2038）+ 客户端 `NotificationStore` 去重键 `(id,ts)` + WS connected 触发 pullTail（60s 纯函数门控，幂等）

## OTA 自更新

```
OtaSection → SettingsViewModel.checkUpdate()
  → GET /api/ota/info?token=（现行检查端点；/api/ota/check 已随后端 P0-U4 下线）
  → status=="active" → 显示版本号/changelog 与文件大小，置下载 URL = /api/ota/download?token=
  → SettingsViewModel.downloadUpdate()
  → ApkDownloader 下载 → otaProgress 更新
  → ApkVerifier 校验哈希/签名
  → ApkInstaller 安装（系统安装器 FileProvider）
  → 用户点击安装
```

> **现行链路实况（核对 `SettingsViewModel.kt:1124-1160`）**：主源码里 `checkUpdate()` 直连后端 `GET /api/ota/info?token=`，返回 `{status:active|no_apk, apkFile, fileSize, lastModified}`；命中即拼 `downloadUrl=/api/ota/download?token=`，随后 ApkDownloader/Verifier/Installer 落地。旧文档画的 `/api/ota/check?current_version=N` 属历史方案（后端已删）。`ota/UpdateSource.kt` 的 `LocalUpdateSource`（读 `assets/update.json`）是 Phase 1 mock 抽象，主源码零调用、仅 `UpdateSourceTest` 覆盖，非现行接收路径；`assets/update.json` 的 `downloadUrl` 也仍指 `/api/ota/download`。

认证：使用登录 Bearer Token（与 API 认证相同），通过 Authorization 头或查询参数 `?token=` 传入。

## 测试

- 单元测试：`app/src/test/`，68 个文件，技术栈 JUnit4 + MockK + Truth + Robolectric（未启用 `useJUnitPlatform()`，新测试须用 `org.junit.Test` 才会被执行），覆盖网络层 / 采集器 / 上传器 / 状态层 / 设置页 / 登录态 / 连接层 / 主题令牌 / OTA / 日志 / 工具类
  - 新增覆盖（2026-10-25）：登录态传播与会话存储、登录导航策略、tier 模型/编解码/迁移/探测/选择器/运行时/设置控制器、Kinship 令牌 CSS 对等、概览 IA、WebView 重载策略
  - `NotificationListenerServiceTest` 整个类被 `@Ignore("Pre-existing: StatusBarNotification constructor API 34+")` 跳过；`ota/OtaFullFlowTest.kt` 被 `@Disabled`（仅有占位测试）
- 仪器测试：`app/src/androidTest/java/com/xehuri/kinship/AxeuhAcceptanceTest.kt`
- 运行命令见下方"构建与安装"

## 构建与安装

所有 Gradle 命令必须从仓库根目录执行（`app/` 内没有 gradlew）：

> 构建需能访问 JitPack（端侧 KWS 依赖 `com.github.k2-fsa.sherpa-onnx:v1.13.8` 未发布到 Maven Central，`settings.gradle.kts` 增加了 JitPack 仓库）。`app/build.gradle.kts` 用 `abiFilters += "arm64-v8a"` 收窄原生库，并 `jniLibs.excludes` 排除未使用的 `libsherpa-onnx-c-api.so` / `libsherpa-onnx-cxx-api.so`（JNI 只依赖 `libsherpa-onnx-jni.so` + `libonnxruntime.so`，可省约 4.9MB）。

```bash
# 编译 Debug APK
./gradlew :app:assembleDebug

# 运行单元测试
./gradlew :app:testDebugUnitTest

# 运行仪器测试（需连接设备）
./gradlew :app:connectedDebugAndroidTest

# 安装到设备
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 激活无障碍服务
adb shell settings put secure enabled_accessibility_services \
  com.xehuri.kinship/.service.AxeuhAccessibilityService

# 激活通知监听
adb shell settings put secure enabled_notification_listeners \
  com.xehuri.kinship/.service.NotificationListenerService
```

## 调试命令

```bash
# 直接打开设置页
adb shell am start -n com.xehuri.kinship/.SettingsActivity

# 查看 DataCollectorService 日志
adb logcat -s DataCollector

# 查看采集服务运行状态
adb shell dumpsys activity services com.xehuri.kinship | findstr DataCollectorService

# 检查蓝牙权限
adb shell dumpsys package com.xehuri.kinship | findstr BLUETOOTH_CONNECT
```

## 相关文档

- `app/docs/band_data_collection_guide.md` - 手环数据采集指南
