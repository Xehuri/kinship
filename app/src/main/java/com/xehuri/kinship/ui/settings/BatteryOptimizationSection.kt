package com.xehuri.kinship.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.util.RomDetector
import kotlinx.coroutines.delay

/**
 * 电池优化引导内容（不含卡片外壳） -- 温和方式请求忽略电池优化，并叠加 ROM 厂商自启动引导。
 *
 * - 按钮跳转 [Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS]（打开系统设置列表，
 *   无需 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 危险权限）；
 * - 保留 [RomDetector] 厂商引导（小米/OPPO/Vivo/华为/荣耀等的后台冻结与自启动限制），
 *   二者叠加、缺一不可。
 *
 * 由「后台运行与权限」页嵌入 [SettingsGroup] 使用。
 */
@Composable
fun BatteryOptimizationContent() {
    val context = LocalContext.current
    var ignoring by remember { mutableStateOf(isIgnoringBatteryOptimizations(context)) }

    // 从系统设置页返回后刷新状态
    val settingsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        ignoring = isIgnoringBatteryOptimizations(context)
    }

    // 系统内直接切换时也能及时刷新（与传感器预览保持一致的轮询风格）
    LaunchedEffect(Unit) {
        while (true) {
            ignoring = isIgnoringBatteryOptimizations(context)
            delay(1500)
        }
    }

    // 厂商引导在组合期内固定，避免每帧反射查询系统属性
    val rom = remember { RomDetector.detect() }

    Text(
            if (ignoring) "已忽略电池优化，后台采集更稳定" else "未忽略电池优化，系统可能在后台冻结采集",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
        )
        Spacer(Modifier.height(6.dp))
        Button(
            onClick = {
                // 温和方式：仅打开系统电池优化设置列表，由用户自行选择
                val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                try {
                    settingsLauncher.launch(intent)
                } catch (_: Exception) {
                    // 个别 ROM 无此设置页，回退到本应用详情页
                    try {
                        settingsLauncher.launch(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                data = Uri.parse("package:${context.packageName}")
                            }
                        )
                    } catch (_: Exception) { }
                }
            },
            enabled = !ignoring,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(if (ignoring) "已忽略电池优化" else "去忽略电池优化")
        }

        Spacer(Modifier.height(10.dp))
        val romLabel = buildString {
            append(rom.manufacturer)
            rom.romVersion?.let { append(" / ").append(it) }
        }
        Text(
            "厂商后台限制说明（$romLabel）",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
        )
        Spacer(Modifier.height(4.dp))
        Text(
            rom.restrictionsDescription.trim(),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
        )

        Spacer(Modifier.height(8.dp))
        Text(
            "厂商电池优化设置指引",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
        )
        Spacer(Modifier.height(4.dp))
        Text(
            rom.batteryOptimizationGuide.trim(),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
        )
}

/** 当前应用是否已被忽略电池优化 */
private fun isIgnoringBatteryOptimizations(context: Context): Boolean {
    return try {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        pm.isIgnoringBatteryOptimizations(context.packageName)
    } catch (_: Exception) {
        false
    }
}
