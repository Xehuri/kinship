package com.xehuri.kinship.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import android.os.BatteryManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build

/**
 * ADB 命令接收器 — 通过 ADB shell 触发调试命令，结果输出到 logcat
 *
 * 用法：
 *   adb shell am broadcast -a com.axeuh.health.monitor.CMD --es cmd battery
 *   adb shell am broadcast -a com.axeuh.health.monitor.CMD --es cmd network
 *   adb shell am broadcast -a com.axeuh.health.monitor.CMD --es cmd device
 *
 * 安全：本接收器受签名级权限 com.axeuh.health.monitor.permission.ADB_COMMAND 保护，
 * 仅与 Axeuh 同签名的应用可发送该广播；第三方应用无法伪造调试命令。
 *
 * 结果通过 logcat 查看：
 *   adb logcat -v time -s AxeuhCMD
 */
class AdbCommandReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION = "com.axeuh.health.monitor.CMD"
        const val EXTRA_CMD = "cmd"
        const val TAG = "AxeuhCMD"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val cmd = intent.getStringExtra(EXTRA_CMD) ?: return
        Log.i(TAG, "CMD: $cmd")
        try {
            val result = when (cmd.lowercase()) {
                "battery" -> testBattery(context)
                "network" -> testNetwork(context)
                "device" -> testDevice(context)
                "permissions" -> testPermissions(context)
                "services" -> testServices(context)
                "help" -> getHelp()
                else -> "未知命令: $cmd"
            }
            Log.i(TAG, "RESULT:\n$result")
            // 通过 setResult 返回结果摘要（adb shell 可看到）
            setResult(0, result.take(200), null)
        } catch (e: Exception) {
            Log.e(TAG, "命令执行失败", e)
        }
    }

    private fun testBattery(ctx: Context): String {
        val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return "无法读取电池状态"
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        val status = when (intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "充电中"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "放电中"
            BatteryManager.BATTERY_STATUS_FULL -> "已充满"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "未充电"
            else -> "未知"
        }
        val health = when (intent.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)) {
            BatteryManager.BATTERY_HEALTH_GOOD -> "良好"
            BatteryManager.BATTERY_HEALTH_OVERHEAT -> "过热"
            BatteryManager.BATTERY_HEALTH_DEAD -> "需更换"
            else -> "未知"
        }
        return buildString {
            appendLine("【电池状态】")
            appendLine("  电量: $level/$scale (${(level * 100f / scale).toInt()}%)")
            appendLine("  状态: $status")
            appendLine("  健康: $health")
        }
    }

    private fun testNetwork(ctx: Context): String {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return "无法读取网络状态"
        val network = cm.activeNetwork ?: return "无可用网络"
        val caps = cm.getNetworkCapabilities(network) ?: return "无法获取网络能力"
        return buildString {
            appendLine("【网络状态】")
            appendLine("  WiFi: ${caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)}")
            appendLine("  蜂窝: ${caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)}")
            appendLine("  以太网: ${caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)}")
            appendLine("  Internet: ${caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)}")
            appendLine("  计量网络: ${!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)}")
        }
    }

    private fun testDevice(ctx: Context): String {
        val rom = try {
            val cls = Class.forName("android.os.SystemProperties")
            val get = cls.getMethod("get", String::class.java)
            when {
                (get.invoke(null, "ro.miui.ui.version.name") as? String)?.isNotEmpty() == true -> "MIUI"
                (get.invoke(null, "ro.build.version.hyperos") as? String)?.isNotEmpty() == true -> "HyperOS"
                (get.invoke(null, "ro.build.version.emui") as? String)?.isNotEmpty() == true -> "EMUI"
                (get.invoke(null, "ro.build.version.oneui") as? String)?.isNotEmpty() == true -> "OneUI"
                else -> "${Build.MANUFACTURER} (原生/未知)"
            }
        } catch (_: Exception) { "${Build.MANUFACTURER} (默认)" }
        return buildString {
            appendLine("【设备信息】")
            appendLine("  厂商: ${Build.MANUFACTURER}")
            appendLine("  型号: ${Build.MODEL}")
            appendLine("  系统: Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            appendLine("  ROM: $rom")
        }
    }

    private fun testPermissions(ctx: Context): String {
        val perms = listOf(
            "android.permission.CAMERA" to "相机",
            "android.permission.RECORD_AUDIO" to "麦克风",
            "android.permission.ACCESS_FINE_LOCATION" to "精确定位",
            "android.permission.ACCESS_COARSE_LOCATION" to "粗略定位",
            "android.permission.POST_NOTIFICATIONS" to "通知",
            "android.permission.BLUETOOTH_CONNECT" to "蓝牙",
        )
        return buildString {
            appendLine("【权限状态】")
            perms.forEach { (perm, label) ->
                val granted = try {
                    androidx.core.content.ContextCompat.checkSelfPermission(ctx, perm) ==
                            android.content.pm.PackageManager.PERMISSION_GRANTED
                } catch (_: Exception) { false }
                appendLine("  ${if (granted) "✅" else "❌"} $label")
            }
        }
    }

    private fun testServices(ctx: Context): String {
        val a11y = try {
                android.provider.Settings.Secure.getString(
                ctx.contentResolver,
                "enabled_notification_listeners"
            )?.contains(ctx.packageName) == true
        } catch (_: Exception) { false }

        val nls = try {
            android.provider.Settings.Secure.getString(
                ctx.contentResolver,
                "enabled_notification_listeners"
            )?.contains(ctx.packageName) == true
        } catch (_: Exception) { false }

        return buildString {
            appendLine("【服务状态】")
            appendLine("  无障碍 (A.S.): ${if (a11y) "✅" else "❌"}")
            appendLine("  通知监听 (N.L.S.): ${if (nls) "✅" else "❌"}")
            appendLine("  前台服务: 由 DataCollectorService 维持")
        }
    }

    private fun getHelp(): String {
        return buildString {
            appendLine("【Axeuh ADB 调试命令】")
            appendLine("  adb shell am broadcast -a com.axeuh.health.monitor.CMD --es cmd <命令>")
            appendLine("")
            appendLine("  可用命令:")
            appendLine("    battery     - 电池状态")
            appendLine("    network     - 网络状态")
            appendLine("    device      - 设备信息")
            appendLine("    permissions - 权限状态")
            appendLine("    services    - 后台服务状态")
            appendLine("    help        - 本帮助")
            appendLine("")
            appendLine("  查看结果:")
            appendLine("    adb logcat -v time -s AxeuhCMD")
        }
    }
}
