# 手环数据采集指南

通过 **Gadgetbridge** 获取小米手环 9 Pro 的实时健康数据。

## 数据流

```
手环 9 Pro ──BLE──→ Gadgetbridge(手机)
                       │ (Intent: TRIGGER_EXPORT)
                  导出 SQLite DB
                       │
                ┌──────┴──────┐
                │             │
            Kinship     PC 脚本
         (后台Service)   (Python)
```

## Gadgetbridge 自动导出设置

首次使用按以下步骤操作：

### 步骤 1：打开自动导出

```
打开 Gadgetbridge App
  → 设置（右上角齿轮图标）
  → 自动化
  → 自动导出数据库 → 开启
  → 设置导出位置（建议保持默认）
  → 导出间隔 → 一小时（不改也没事，App 会主动触发）
  → 点击「立即运行自动导出」
```

此时 Gadgetbridge 会立刻导出一份数据库文件到指定位置。

### 步骤 2：在 Kinship 中验证

```
打开 Kinship
  → 进入设置页（登录后可见）
  → 数据采集区 → 手环数据库路径
  → 点击「选择数据库文件」
  → 找到 Gadgetbridge 导出的 .db 文件
  → 选中后回到设置页
```

如果路径显示正确，下方健康数据状态区域即可读到心率/步数/血氧等数据。

### 步骤 3：开启蓝牙 Intent API

```
Gadgetbridge 设置 → 开发者选项
  → 意图接口 → 蓝牙 Intent API → 开启
  → 允许数据库导出 → 开启
  → 数据库导出时广播 → 开启
```

开启后，Kinship 的后台 Service 可通过发送广播主动触发 Gadgetbridge 导出数据库，实现自动定时采集。

### 完整设置流程总结

```
Gadgetbridge 设置
  1. 设置 → 自动化 → 自动导出数据库 → 开启（间隔一小时）
  2. 立即运行一次自动导出
  3. Kinship → 选择数据库文件 → 验证数据可读
  4. Gadgetbridge 开发者选项 → 意图接口 → 开启所需开关
```

## 获取 Auth Key

连接小米手环 9 Pro 需要 Auth Key（32 位十六进制字符串，如 `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`）。

### 从日志提取（推荐）

1. 手机安装小米运动健康 App（Mi Fitness）并正常连接手环使用
2. 用文件管理器（推荐 MT 文件管理器）打开日志目录：
   `/sdcard/Android/data/com.mi.health/files/log/`
3. 找到 **`Transfer.device.log`** 文件（可能有多份，选最新的）
4. 用文本查看器打开，搜索 **`token`** 关键词
5. 能找到两种 token：
   - **小米账号 token**：长度较长，通常是账号登录相关
   - **手环 Auth Key**：32 位十六进制字符串（纯 0-9 a-f）
6. 两种都试试，Auth Key 通常在 Gadgetbridge 配对时使用

> 文本查看器推荐使用 **MT 文件管理器**，自带文本搜索功能，方便查看大文件。

### 通过心率广播（需固件 v1.3.153+）

手环上设置 → 心率广播 → 开启，然后手机通过 Web Bluetooth 浏览器直接读取。
无需 Auth Key，但只支持实时心率，不支持步数/压力/血氧。

### Gadgetbridge 自动检测

如果 Gadgetbridge 已成功配对，App 会直接读取其导出的数据库，大部分情况下无需手动配置 Auth Key。

## 数据库结构

Gadgetbridge 导出的 SQLite 数据库路径：`/storage/emulated/0/Gadgetbridge.db`

### 核心表

| 表名 | 内容 | 关键字段 |
|------|------|---------|
| `XIAOMI_ACTIVITY_SAMPLE` | 逐分钟健康数据 | `TIMESTAMP`, `HEART_RATE`, `STEPS`, `STRESS`, `SPO2` |
| `XIAOMI_DAILY_SUMMARY_SAMPLE` | 每日摘要 | `HR_RESTING`, `HR_MAX`, `HR_MIN`, `HR_AVG` |
| `DEVICE` | 设备信息 | `NAME`, `MODEL`, `IDENTIFIER` |
| `BATTERY_LEVEL` | 电池记录 | `TIMESTAMP`, `LEVEL` |

### 查询示例

```sql
-- 获取最新一条心率数据
SELECT TIMESTAMP, HEART_RATE
FROM XIAOMI_ACTIVITY_SAMPLE
WHERE HEART_RATE > 0
ORDER BY TIMESTAMP DESC
LIMIT 1;

-- 获取最近一小时的所有数据
SELECT TIMESTAMP, HEART_RATE, STEPS, STRESS, SPO2
FROM XIAOMI_ACTIVITY_SAMPLE
WHERE TIMESTAMP > (strftime('%s','now') - 3600)
ORDER BY TIMESTAMP;

-- 获取每日平均心率
SELECT strftime('%Y-%m-%d', datetime(TIMESTAMP, 'unixepoch')) as DAY,
       AVG(HEART_RATE) as AVG_HR
FROM XIAOMI_ACTIVITY_SAMPLE
WHERE HEART_RATE > 0
GROUP BY DAY
ORDER BY DAY DESC;
```

## 定时采集

Kinship 会定时查询 Gadgetbridge 导出的数据库，采集间隔可在设置页调整。

关键说明：

- **导出间隔**：Gadgetbridge 默认最小导出间隔为 **1 小时**（源码 `PeriodicExporter.java` 中定义为 `interval * 60 * 60 * 1000`）
- **缩短间隔**：如需更频繁采集，需要修改 Gadgetbridge 源码将单位改为分钟（`interval * 60 * 1000`）
- **触发导出**：App 通过发送 `TRIGGER_EXPORT` 广播来强制 Gadgetbridge 立即导出

### 相关 Intent Action

```kotlin
// 触发导出
val TRIGGER_EXPORT = "nodomain.freeyourgadget.gadgetbridge.command.TRIGGER_EXPORT"

// 导出成功回调
val EXPORT_SUCCESS = "nodomain.freeyourgadget.gadgetbridge.action.DATABASE_EXPORT_SUCCESS"

// 导出失败回调
val EXPORT_FAIL = "nodomain.freeyourgadget.gadgetbridge.action.DATABASE_EXPORT_FAIL"
```

## 重要：避免两个 App 抢手环连接

连接 Gadgetbridge 后，**必须禁止小米运动健康后台运行**，否则两个 App 会互相抢手环连接，
导致 Gadgetbridge 频繁断连。

### 禁止步骤

```
手机设置 → 应用 → 应用管理 → 小米运动健康（Mi Fitness）
  → 自启动 → 关闭
  → 后台权限 → 禁止后台运行
  → 获取设备列表 → 禁止（阻止 App 自动连接手环）
```

做完后，只有 Gadgetbridge 会连接手环，数据采集稳定。

## 注意事项

1. Gadgetbridge 的 IntentApiReceiver 动态注册于 DeviceCommunicationService 中，即使组件未公开导出，ADB 仍可正常发送 Intent
2. BLE 直连方式（绕过 Gadgetbridge）需要完整 Xiaomi Protobuf 认证握手，工程量大，不推荐
3. 心率广播模式仅支持实时心率，不支持步数/压力/血氧等数据
