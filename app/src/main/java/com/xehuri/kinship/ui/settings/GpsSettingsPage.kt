package com.xehuri.kinship.ui.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * 位置 GPS 设置页（数据采集 → 位置 GPS）。
 *
 * 采集开关与定位权限引导在上一级「数据采集」页的列表行上；本页只放参数。
 */
@Composable
fun GpsSettingsPage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit
) {
    val gpsIntervalMs by viewModel.gpsIntervalMs.collectAsState()
    val gpsAccuracyPriority by viewModel.gpsAccuracyPriority.collectAsState()
    val gpsMinDisplacementM by viewModel.gpsMinDisplacementM.collectAsState()
    val gpsMaxAccuracyM by viewModel.gpsMaxAccuracyM.collectAsState()
    val gpsFixTimeoutMs by viewModel.gpsFixTimeoutMs.collectAsState()
    val gpsReverseGeocode by viewModel.gpsReverseGeocode.collectAsState()

    SettingsSubPageScaffold(title = "位置 GPS", onBack = onBack) {
        item {
            SettingsGroup(title = "采集") {
                SettingsIntervalPicker(
                    label = "GPS 采集间隔",
                    intervalMs = gpsIntervalMs,
                    presetsMs = listOf(60_000L, 300_000L, 600_000L),
                    onIntervalChange = { viewModel.setGpsIntervalMs(it) }
                )
                Spacer(Modifier.height(12.dp))
                SettingsChoicePicker(
                    label = "定位精度优先级",
                    description = "决定各定位来源的优先顺序",
                    options = listOf(
                        "high" to "高精度",
                        "balanced" to "均衡",
                        "low_power" to "低功耗"
                    ),
                    selectedValue = gpsAccuracyPriority,
                    onSelect = { viewModel.setGpsAccuracyPriority(it) }
                )
            }
        }

        item {
            SettingsGroup(title = "过滤") {
                SettingsNumberPicker(
                    label = "最小位移",
                    description = "移动不足该距离时不更新位置，0 表示不过滤",
                    value = gpsMinDisplacementM,
                    presets = listOf(0L, 10L, 50L, 100L),
                    unit = "米",
                    onValueChange = { viewModel.setGpsMinDisplacementM(it) }
                )
                Spacer(Modifier.height(12.dp))
                SettingsNumberPicker(
                    label = "最大可接受精度",
                    description = "精度差于该值的定位会被丢弃，0 表示不过滤",
                    value = gpsMaxAccuracyM,
                    presets = listOf(0L, 30L, 50L, 100L),
                    unit = "米",
                    onValueChange = { viewModel.setGpsMaxAccuracyM(it) }
                )
                Spacer(Modifier.height(12.dp))
                SettingsNumberPicker(
                    label = "主动定位超时",
                    description = "开启后主动请求一次新鲜定位，最多等待该时长，超时回退缓存；0 表示关闭",
                    // 存储单位为毫秒，界面按秒展示更易读
                    value = gpsFixTimeoutMs / 1000L,
                    presets = listOf(0L, 5L, 15L, 30L),
                    unit = "秒",
                    onValueChange = { viewModel.setGpsFixTimeoutMs(it * 1000L) }
                )
            }
        }

        item {
            SettingsGroup(title = "地址解析") {
                SettingsSwitchItem(
                    label = "解析为地址",
                    description = "把坐标解析为可读地址，随感知事件一并上报（需要网络与地图服务）",
                    checked = gpsReverseGeocode,
                    onCheckedChange = { viewModel.setGpsReverseGeocode(it) }
                )
            }
        }
    }
}
