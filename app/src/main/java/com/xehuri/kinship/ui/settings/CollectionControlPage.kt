package com.xehuri.kinship.ui.settings

import android.content.Intent
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.service.DataCollectorService

/**
 * 采集总控页。
 *
 * 只保留全局性的采集控制：
 * - 总开关（感知数据上传 / 离线缓存）
 * - 上传与调度间隔
 *
 * 各数据源开关与二级配置入口（含通知）已上移到概览页的「采集与上传」分组，
 * 本页不再重复渲染数据源行，也不提供跨页入口。
 */
@Composable
fun CollectionControlPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val context = LocalContext.current
    val uploadEnabled by viewModel.uploadEnabled.collectAsState()
    val cacheEnabled by viewModel.cacheEnabled.collectAsState()
    val collectionInterval by viewModel.collectionInterval.collectAsState()

    SettingsSubPageScaffold(title = "采集总控", onBack = onBack) {
        item {
            SettingsGroup(title = "总开关") {
                SettingsSwitchItem(
                    label = "感知数据上传",
                    description = "总开关，关闭后停止整个采集服务",
                    checked = uploadEnabled,
                    onCheckedChange = { enabled ->
                        viewModel.toggleSensor("upload", enabled)
                        if (enabled) {
                            ensureServiceRunning(context, true)
                            DataCollectorService.triggerCycle(context)
                        } else {
                            context.stopService(Intent(context, DataCollectorService::class.java))
                        }
                    }
                )
                HorizontalDividerCompact()
                SettingsSwitchItem(
                    label = "离线缓存",
                    description = "关闭后上传失败不再缓存数据，并清空已有缓存",
                    checked = cacheEnabled,
                    onCheckedChange = { viewModel.toggleSensor("cache", it) }
                )
            }
        }

        item {
            SettingsGroup(title = "上传与调度") {
                Text(
                    text = "主循环是统一的「上传心跳」（默认 30 秒一轮）：除健康数据与环境音频外，" +
                        "所有感知事件（GPS / 电量 / 前台应用 / 媒体 / 通知 / 设备环境 / 屏幕）都先入队，" +
                        "到这里一并上传；同时负责启停采集器、权限复核与健康数据的定时时段调度。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                )
                Spacer(Modifier.height(8.dp))
                SettingsIntervalPicker(
                    label = "上传与调度间隔",
                    intervalMs = collectionInterval.toLong(),
                    presetsMs = listOf(15_000L, 30_000L, 60_000L),
                    onIntervalChange = { viewModel.setCollectionInterval(it.toInt()) }
                )
            }
        }
    }
}
