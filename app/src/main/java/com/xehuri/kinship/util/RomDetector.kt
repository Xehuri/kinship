package com.xehuri.kinship.util

import android.os.Build

/**
 * RomDetector — ROM 品牌检测与适配信息
 *
 * 通过 Build.MANUFACTURER 和系统属性反射检测当前设备 ROM 品牌/版本，
 * 返回对应 [RomInfo] 以提供厂商特定的限制说明和设置引导。
 *
 * 支持的 ROM 品牌:
 * - 小米 (MIUI / HyperOS)
 * - OPPO (ColorOS)
 * - Vivo (OriginOS)
 * - 三星 (OneUI)
 * - 华为 (EMUI)
 * - 荣耀 (MagicOS)
 * - Google / 原生 (Stock Android)
 * - 其他 (Unknown)
 *
 * 使用方式:
 * ```kotlin
 * val rom = RomDetector.detect()
 * // rom.restrictionsDescription, rom.batteryOptimizationGuide, etc.
 * ```
 */
object RomDetector {

    /**
     * 检测当前设备 ROM 信息
     *
     * @param manufacturer 设备制造商，默认 [Build.MANUFACTURER]
     * @param systemPropertyProvider 系统属性查询函数，默认反射调用
     * @return [RomInfo] 密封类实例
     */
    fun detect(
        manufacturer: String = Build.MANUFACTURER,
        systemPropertyProvider: (String) -> String? = ::reflectSystemProperty
    ): RomInfo {
        return when (manufacturer.lowercase()) {
            "xiaomi" -> detectXiaomi(systemPropertyProvider)
            "oppo" -> detectOppo(systemPropertyProvider)
            "vivo" -> detectVivo(systemPropertyProvider)
            "samsung" -> detectSamsung(systemPropertyProvider)
            "huawei" -> detectHuawei(systemPropertyProvider)
            "honor" -> detectHonor(systemPropertyProvider)
            "google" -> RomInfo.Google(
                manufacturer = manufacturer,
                romVersion = "Android ${Build.VERSION.RELEASE}"
            )
            else -> RomInfo.Unknown(manufacturer = manufacturer)
        }
    }

    // ========================================================================
    // 内部检测实现
    // ========================================================================

    private fun detectXiaomi(prop: (String) -> String?): RomInfo.Xiaomi {
        // HyperOS: ro.miui.ui.version.name 仍然存在，结合 HyperOS 特征检测
        val hyperOs = prop("ro.build.version.hyperos")
        val miuiVer = prop("ro.miui.ui.version.name")

        val romVersion = when {
            hyperOs != null && hyperOs.isNotBlank() ->
                "HyperOS $hyperOs"
            miuiVer != null && miuiVer.isNotBlank() ->
                "MIUI $miuiVer"
            else -> null
        }

        return RomInfo.Xiaomi(
            manufacturer = "Xiaomi",
            romVersion = romVersion
        )
    }

    private fun detectOppo(prop: (String) -> String?): RomInfo.Oppo {
        val oppoRom = prop("ro.build.version.opporom")
        val colorOs = prop("ro.build.version.coloros")
        val romVersion = oppoRom ?: colorOs

        return RomInfo.Oppo(
            manufacturer = "OPPO",
            romVersion = romVersion?.takeIf { it.isNotBlank() }
        )
    }

    private fun detectVivo(prop: (String) -> String?): RomInfo.Vivo {
        val originOs = prop("ro.vivo.os.version")
        val vivoRom = prop("ro.vivo.rom.version")
        val romVersion = originOs ?: vivoRom

        return RomInfo.Vivo(
            manufacturer = "vivo",
            romVersion = romVersion?.takeIf { it.isNotBlank() }
        )
    }

    private fun detectSamsung(prop: (String) -> String?): RomInfo.Samsung {
        val oneUi = prop("ro.build.version.oneui")
        val romVersion = oneUi?.let { "OneUI $it" }

        return RomInfo.Samsung(
            manufacturer = "Samsung",
            romVersion = romVersion?.takeIf { it.isNotBlank() }
        )
    }

    private fun detectHuawei(prop: (String) -> String?): RomInfo.Huawei {
        val emui = prop("ro.build.version.emui")
        val romVersion = emui?.let { "EMUI $it" }

        return RomInfo.Huawei(
            manufacturer = "HUAWEI",
            romVersion = romVersion?.takeIf { it.isNotBlank() }
        )
    }

    private fun detectHonor(prop: (String) -> String?): RomInfo.Honor {
        // 荣耀可能有各自的 MagicOS 属性，也可能遗留 EMUI
        val magicOs = prop("ro.build.version.magic")
        val emui = prop("ro.build.version.emui")
        val romVersion = when {
            magicOs != null && magicOs.isNotBlank() -> "MagicOS $magicOs"
            emui != null && emui.isNotBlank() -> "EMUI $emui"
            else -> null
        }

        return RomInfo.Honor(
            manufacturer = "Honor",
            romVersion = romVersion
        )
    }

    // ========================================================================
    // 系统属性反射
    // ========================================================================

    /**
     * 通过反射调用 android.os.SystemProperties.get(name, default)
     * 无需额外权限，仅运行时反射。
     */
    private fun reflectSystemProperty(name: String): String? {
        return try {
            val clazz = Class.forName("android.os.SystemProperties")
            val method = clazz.getMethod("get", String::class.java, String::class.java)
            val result = method.invoke(null, name, "") as String
            result.ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }
}

// ========================================================================
// RomInfo 密封类
// ========================================================================

/**
 * ROM 信息密封类 — 每个变体携带品牌特定的限制与引导
 *
 * 属性:
 * - [manufacturer] — 原始 Build.MANUFACTURER
 * - [romVersion] — 识别的 ROM 版本 (如 "HyperOS 1.0", "MIUI 14", "OneUI 6.0")
 * - [restrictionsDescription] — 已知限制描述 (中文)
 * - [batteryOptimizationGuide] — 电池优化设置引导 (中文)
 * - [voiceInteractionSupported] — VoiceInteractionService 是否可用
 */
sealed class RomInfo {

    /** 原始设备制造商 */
    abstract val manufacturer: String

    /** ROM 版本号，可为 null */
    abstract val romVersion: String?

    /** 已知限制的中文描述 */
    abstract val restrictionsDescription: String

    /** 电池优化设置中文引导 */
    abstract val batteryOptimizationGuide: String

    /** VoiceInteractionService 是否被厂商锁定 */
    abstract val voiceInteractionSupported: Boolean

    // ------------------------------------------------------------------
    // 小米 — MIUI / HyperOS
    // ------------------------------------------------------------------

    data class Xiaomi(
        override val manufacturer: String,
        override val romVersion: String?
    ) : RomInfo() {

        override val restrictionsDescription: String
            get() = buildString {
                appendLine("- VoiceInteractionService 被 XiaoAi 锁定，需降级使用 AssistActivity")
                appendLine("- 后台进程会被 MIUI 智能省电策略杀死")
                appendLine("- 无障碍服务默认隐藏，需在「更多已下载的服务」中开启")
                appendLine("- 通知监听可能被限制，需手动授权")
                if (romVersion?.startsWith("HyperOS") == true) {
                    appendLine("- HyperOS 对非商店应用安装限制更严格")
                }
            }

        override val batteryOptimizationGuide: String
            get() = buildString {
                appendLine("1. 设置 > 应用 > 应用管理 > 找到本应用 > 省电策略 > 选择「无限制」")
                appendLine("2. 在多任务界面锁定本应用 (下拉卡片出现锁图标)")
                appendLine("3. 设置 > 应用 > 权限管理 > 自启动 > 开启本应用")
                if (romVersion?.startsWith("HyperOS") == true) {
                    appendLine("4. 设置 > 电池 > 电池健康 > 智能充电保护 > 按需关闭")
                }
            }

        override val voiceInteractionSupported: Boolean = false
    }

    // ------------------------------------------------------------------
    // OPPO — ColorOS
    // ------------------------------------------------------------------

    data class Oppo(
        override val manufacturer: String,
        override val romVersion: String?
    ) : RomInfo() {

        override val restrictionsDescription: String
            get() = buildString {
                appendLine("- ColorOS 后台冻结策略会阻止应用后台运行")
                appendLine("- 通知监听服务需要加入「允许通知读取」白名单")
                appendLine("- 悬浮窗权限默认关闭")
                appendLine("- 自动启动管理默认拦截第三方应用自启")
            }

        override val batteryOptimizationGuide: String
            get() = buildString {
                appendLine("1. 设置 > 电池 > 耗电保护 > 找到本应用 > 关闭「后台冻结」和「深度休眠」")
                appendLine("2. 设置 > 应用管理 > 自启动管理 > 开启本应用")
                appendLine("3. 设置 > 通知与状态栏 > 通知管理 > 找到本应用 > 开启所有通知类别")
                appendLine("4. 多任务界面下拉锁定本应用")
            }

        override val voiceInteractionSupported: Boolean = true
    }

    // ------------------------------------------------------------------
    // Vivo — OriginOS
    // ------------------------------------------------------------------

    data class Vivo(
        override val manufacturer: String,
        override val romVersion: String?
    ) : RomInfo() {

        override val restrictionsDescription: String
            get() = buildString {
                appendLine("- OriginOS 智能服务控制可能杀死后台进程")
                appendLine("- 悬浮窗权限默认关闭")
                appendLine("- 后台弹出界面权限需手动授予")
                appendLine("- 通知监听服务需要单独授权")
            }

        override val batteryOptimizationGuide: String
            get() = buildString {
                appendLine("1. 设置 > 电池 > 后台耗电管理 > 找到本应用 > 选择「允许后台运行」")
                appendLine("2. 设置 > 应用与权限 > 自启动管理 > 开启本应用")
                appendLine("3. 设置 > 通知与状态栏 > 应用通知管理 > 找到本应用 > 开启所有通知")
                appendLine("4. 设置 > 快捷与辅助 > 无障碍 > 本应用相关开关")
            }

        override val voiceInteractionSupported: Boolean = true
    }

    // ------------------------------------------------------------------
    // 三星 — OneUI
    // ------------------------------------------------------------------

    data class Samsung(
        override val manufacturer: String,
        override val romVersion: String?
    ) : RomInfo() {

        override val restrictionsDescription: String
            get() = buildString {
                appendLine("- OneUI 无障碍服务需要二次确认（弹出额外对话框）")
                appendLine("- 自适应电池策略会深度休眠不常用的应用")
                appendLine("- 自动优化功能可能在夜间清理后台进程")
                appendLine("- 通知监听服务需要进入「通知访问」单独开启")
            }

        override val batteryOptimizationGuide: String
            get() = buildString {
                appendLine("1. 设置 > 电池和设备维护 > 电池 > 后台使用限制 > 找到本应用 > 选择「无限制」")
                appendLine("2. 设置 > 应用程序 > 找到本应用 > 电池 > 选择「不受限制」")
                appendLine("3. 多任务界面点击应用图标 > 锁定此应用")
                appendLine("4. 设置 > 锁定屏幕和安全 > 安全文件夹（如需额外保护）")
            }

        override val voiceInteractionSupported: Boolean = true
    }

    // ------------------------------------------------------------------
    // 华为 — EMUI
    // ------------------------------------------------------------------

    data class Huawei(
        override val manufacturer: String,
        override val romVersion: String?
    ) : RomInfo() {

        override val restrictionsDescription: String
            get() = buildString {
                appendLine("- VoiceInteractionService 被 Celia 锁定，需使用 AssistActivity")
                appendLine("- 华为后台管理非常激进，强杀非白名单应用")
                appendLine("- 通知管理需手动授予「通知读取权限」")
                appendLine("- 应用启动管理默认自动，需改为手动管理")
            }

        override val batteryOptimizationGuide: String
            get() = buildString {
                appendLine("1. 手机管家 > 应用启动管理 > 找到本应用 > 关闭「自动管理」")
                appendLine("   然后手动开启「允许自启动」「允许关联启动」「允许后台活动」")
                appendLine("2. 设置 > 电池 > 更多电池设置 > 关闭「智能省电」")
                appendLine("3. 设置 > 应用 > 应用管理 > 找到本应用 > 电池 > 选择「无限制」")
            }

        override val voiceInteractionSupported: Boolean = false
    }

    // ------------------------------------------------------------------
    // 荣耀 — MagicOS (EMUI 脱胎)
    // ------------------------------------------------------------------

    data class Honor(
        override val manufacturer: String,
        override val romVersion: String?
    ) : RomInfo() {

        override val restrictionsDescription: String
            get() = buildString {
                appendLine("- VoiceInteractionService 可能被锁定（继承华为策略）")
                appendLine("- MagicOS 后台管理策略继承自 EMUI，较为严格")
                appendLine("- 通知监听需要手动授权")
                appendLine("- 悬浮窗权限默认关闭")
            }

        override val batteryOptimizationGuide: String
            get() = buildString {
                appendLine("1. 手机管家 > 应用启动管理 > 找到本应用 > 关闭「自动管理」")
                appendLine("   然后开启「允许自启动」「允许后台活动」")
                appendLine("2. 设置 > 电池 > 更多设置 > 关闭「智能省电模式」")
                appendLine("3. 设置 > 应用 > 应用管理 > 找到本应用 > 耗电详情 > 选择「无限制」")
            }

        override val voiceInteractionSupported: Boolean = false
    }

    // ------------------------------------------------------------------
    // Google / 原生 Android
    // ------------------------------------------------------------------

    data class Google(
        override val manufacturer: String,
        override val romVersion: String?
    ) : RomInfo() {

        override val restrictionsDescription: String =
            "原生 Android 无厂商特定限制。标准 Android 权限模型即可。"

        override val batteryOptimizationGuide: String
            get() = buildString {
                appendLine("1. 设置 > 应用 > 找到本应用 > 电池 > 选择「无限制」")
                appendLine("2. 如遇后台被杀，可在开发者选项中关闭「不保留活动」")
            }

        override val voiceInteractionSupported: Boolean = true
    }

    // ------------------------------------------------------------------
    // 未知厂商
    // ------------------------------------------------------------------

    data class Unknown(
        override val manufacturer: String
    ) : RomInfo() {

        override val romVersion: String? = null

        override val restrictionsDescription: String =
            "无法识别 ROM 品牌（制造商: $manufacturer）。建议参照通用 Android 设置指南。如果遇到后台进程被杀，请检查系统电池优化设置。"

        override val batteryOptimizationGuide: String =
            "1. 设置 > 应用 > 找到本应用 > 电池 > 选择「无限制」\n" +
                    "2. 检查系统自带的安全/手机管家类应用，添加本应用到受保护列表"

        override val voiceInteractionSupported: Boolean = true
    }
}
