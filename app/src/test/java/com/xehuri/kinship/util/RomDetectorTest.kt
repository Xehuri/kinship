package com.xehuri.kinship.util

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

/**
 * RomDetector 鍗曞厓娴嬭瘯
 *
 * 楠岃瘉姣忎釜 ROM 鍝佺墝鐨勬娴嬮€昏緫鍜屽睘鎬у€笺€? * 涓嶄緷璧?Android 妗嗘灦锛堥€氳繃鍙傛暟娉ㄥ叆妯℃嫙绯荤粺灞炴€э級锛? * 涓嶄娇鐢?Robolectric锛岀函 JUnit 5銆? */
class RomDetectorTest {

    // ========================================================================
    // 灏忕背 鈥?MIUI / HyperOS
    // ========================================================================

    @Test
    fun `detect Xiaomi with MIUI version`() {
        val prop: (String) -> String? = { name ->
            when (name) {
                "ro.miui.ui.version.name" -> "V14"
                "ro.build.version.hyperos" -> ""
                else -> null
            }
        }
        val rom = RomDetector.detect(manufacturer = "Xiaomi", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Xiaomi::class.java)
        rom as RomInfo.Xiaomi
        assertThat(rom.manufacturer).isEqualTo("Xiaomi")
        assertThat(rom.romVersion).isEqualTo("MIUI V14")
        assertThat(rom.voiceInteractionSupported).isFalse()
        assertThat(rom.restrictionsDescription).contains("VoiceInteractionService")
        assertThat(rom.batteryOptimizationGuide).contains("鐪佺數绛栫暐")
    }

    @Test
    fun `detect Xiaomi with HyperOS version`() {
        val prop: (String) -> String? = { name ->
            when (name) {
                "ro.miui.ui.version.name" -> "V15"
                "ro.build.version.hyperos" -> "1.0"
                else -> null
            }
        }
        val rom = RomDetector.detect(manufacturer = "Xiaomi", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Xiaomi::class.java)
        rom as RomInfo.Xiaomi
        assertThat(rom.romVersion).isEqualTo("HyperOS 1.0")
        // HyperOS 楠岃瘉瓒呴摼鎺ラ鏍兼彁绀哄寘鍚?HyperOS 鍏抽敭瀛?        assertThat(rom.restrictionsDescription).contains("HyperOS")
        assertThat(rom.batteryOptimizationGuide).contains("HyperOS")
    }

    @Test
    fun `detect Xiaomi with lowercase manufacturer`() {
        val prop: (String) -> String? = { null }
        val rom = RomDetector.detect(manufacturer = "xiaomi", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Xiaomi::class.java)
        (rom as RomInfo.Xiaomi).let {
            assertThat(it.romVersion).isNull()
            assertThat(it.voiceInteractionSupported).isFalse()
        }
    }

    // ========================================================================
    // OPPO 鈥?ColorOS
    // ========================================================================

    @Test
    fun `detect Oppo with opporom property`() {
        val prop: (String) -> String? = { name ->
            if (name == "ro.build.version.opporom") "ColorOS 14.0" else null
        }
        val rom = RomDetector.detect(manufacturer = "OPPO", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Oppo::class.java)
        rom as RomInfo.Oppo
        assertThat(rom.manufacturer).isEqualTo("OPPO")
        assertThat(rom.romVersion).isEqualTo("ColorOS 14.0")
        assertThat(rom.voiceInteractionSupported).isTrue()
        assertThat(rom.restrictionsDescription).contains("ColorOS")
        assertThat(rom.batteryOptimizationGuide).contains("鍚庡彴鍐荤粨")
    }

    @Test
    fun `detect Oppo with coloros property`() {
        val prop: (String) -> String? = { name ->
            if (name == "ro.build.version.coloros") "13.0" else null
        }
        val rom = RomDetector.detect(manufacturer = "OPPO", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Oppo::class.java)
        (rom as RomInfo.Oppo).let {
            assertThat(it.romVersion).isEqualTo("13.0")
        }
    }

    // ========================================================================
    // Vivo 鈥?OriginOS
    // ========================================================================

    @Test
    fun `detect Vivo with originOs version`() {
        val prop: (String) -> String? = { name ->
            if (name == "ro.vivo.os.version") "OriginOS 4" else null
        }
        val rom = RomDetector.detect(manufacturer = "vivo", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Vivo::class.java)
        rom as RomInfo.Vivo
        assertThat(rom.manufacturer).isEqualTo("vivo")
        assertThat(rom.romVersion).isEqualTo("OriginOS 4")
        assertThat(rom.voiceInteractionSupported).isTrue()
        assertThat(rom.restrictionsDescription).contains("OriginOS")
    }

    @Test
    fun `detect Vivo with vivoRom property`() {
        val prop: (String) -> String? = { name ->
            if (name == "ro.vivo.rom.version") "3.0" else null
        }
        val rom = RomDetector.detect(manufacturer = "vivo", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Vivo::class.java)
        (rom as RomInfo.Vivo).let {
            assertThat(it.romVersion).isEqualTo("3.0")
        }
    }

    // ========================================================================
    // 涓夋槦 鈥?OneUI
    // ========================================================================

    @Test
    fun `detect Samsung with OneUI version`() {
        val prop: (String) -> String? = { name ->
            if (name == "ro.build.version.oneui") "6.0" else null
        }
        val rom = RomDetector.detect(manufacturer = "samsung", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Samsung::class.java)
        rom as RomInfo.Samsung
        assertThat(rom.manufacturer).isEqualTo("Samsung")
        assertThat(rom.romVersion).isEqualTo("OneUI 6.0")
        assertThat(rom.voiceInteractionSupported).isTrue()
        assertThat(rom.restrictionsDescription).contains("OneUI")
        assertThat(rom.batteryOptimizationGuide).contains("鑷€傚簲鐢垫睜")
    }

    // ========================================================================
    // 鍗庝负 鈥?EMUI
    // ========================================================================

    @Test
    fun `detect Huawei with EMUI version`() {
        val prop: (String) -> String? = { name ->
            if (name == "ro.build.version.emui") "12.0.0" else null
        }
        val rom = RomDetector.detect(manufacturer = "HUAWEI", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Huawei::class.java)
        rom as RomInfo.Huawei
        assertThat(rom.manufacturer).isEqualTo("HUAWEI")
        assertThat(rom.romVersion).isEqualTo("EMUI 12.0.0")
        assertThat(rom.voiceInteractionSupported).isFalse()
        assertThat(rom.restrictionsDescription).contains("Celia")
        assertThat(rom.batteryOptimizationGuide).contains("鎵嬫満绠″")
    }

    // ========================================================================
    // 鑽ｈ€€ 鈥?MagicOS
    // ========================================================================

    @Test
    fun `detect Honor with MagicOS version`() {
        val prop: (String) -> String? = { name ->
            when (name) {
                "ro.build.version.magic" -> "8.0"
                "ro.build.version.emui" -> ""
                else -> null
            }
        }
        val rom = RomDetector.detect(manufacturer = "Honor", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Honor::class.java)
        rom as RomInfo.Honor
        assertThat(rom.manufacturer).isEqualTo("Honor")
        assertThat(rom.romVersion).isEqualTo("MagicOS 8.0")
        assertThat(rom.voiceInteractionSupported).isFalse()
        assertThat(rom.restrictionsDescription).contains("MagicOS")
        assertThat(rom.batteryOptimizationGuide).contains("鎵嬫満绠″")
    }

    @Test
    fun `detect Honor with EMUI fallback`() {
        val prop: (String) -> String? = { name ->
            if (name == "ro.build.version.emui") "13.0" else null
        }
        val rom = RomDetector.detect(manufacturer = "Honor", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Honor::class.java)
        (rom as RomInfo.Honor).let {
            assertThat(it.romVersion).isEqualTo("EMUI 13.0")
        }
    }

    // ========================================================================
    // Google / 鍘熺敓
    // ========================================================================

    @Test
    fun `detect Google Pixel`() {
        val prop: (String) -> String? = { null }
        val rom = RomDetector.detect(manufacturer = "Google", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Google::class.java)
        rom as RomInfo.Google
        assertThat(rom.manufacturer).isEqualTo("Google")
        assertThat(rom.voiceInteractionSupported).isTrue()
        assertThat(rom.restrictionsDescription).contains("鍘熺敓 Android")
    }

    // ========================================================================
    // 鏈煡鍘傚晢
    // ========================================================================

    @Test
    fun `detect unknown manufacturer`() {
        val prop: (String) -> String? = { null }
        val rom = RomDetector.detect(manufacturer = "OnePlus", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Unknown::class.java)
        rom as RomInfo.Unknown
        assertThat(rom.manufacturer).isEqualTo("OnePlus")
        assertThat(rom.romVersion).isNull()
        assertThat(rom.voiceInteractionSupported).isTrue()
        assertThat(rom.restrictionsDescription).contains("OnePlus")
    }

    @Test
    fun `detect unknown manufacturer with weird casing`() {
        val prop: (String) -> String? = { null }
        val rom = RomDetector.detect(manufacturer = "LENOVO", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Unknown::class.java)
        (rom as RomInfo.Unknown).let {
            assertThat(it.manufacturer).isEqualTo("LENOVO")
        }
    }

    // ========================================================================
    // 杈圭晫鎯呭喌 鈥?绌?绌虹櫧灞炴€?    // ========================================================================

    @Test
    fun `empty system properties produce null version`() {
        val prop: (String) -> String? = { "" }
        val rom = RomDetector.detect(manufacturer = "Xiaomi", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Xiaomi::class.java)
        (rom as RomInfo.Xiaomi).let {
            assertThat(it.romVersion).isNull()
        }
    }

    @Test
    fun `blank system properties produce null version`() {
        val prop: (String) -> String? = { "   " }
        val rom = RomDetector.detect(manufacturer = "samsung", systemPropertyProvider = prop)

        assertThat(rom).isInstanceOf(RomInfo.Samsung::class.java)
        (rom as RomInfo.Samsung).let {
            assertThat(it.romVersion).isNull()
        }
    }

    @Test
    fun `all null properties produce no version`() {
        val manufacturers = listOf("Xiaomi", "OPPO", "vivo", "samsung", "HUAWEI", "Honor")
        val prop: (String) -> String? = { null }

        for (mfr in manufacturers) {
            val rom = RomDetector.detect(manufacturer = mfr, systemPropertyProvider = prop)
            assertThat(rom.romVersion).isNull()
        }
    }

    // ========================================================================
    // RomInfo 灞炴€у畬鏁存€?    // ========================================================================

    @Test
    fun `all RomInfo variants have non-empty restrictions and battery guide`() {
        val prop: (String) -> String? = { null }

        val testCases = listOf(
            RomDetector.detect("Xiaomi", prop),
            RomDetector.detect("OPPO", prop),
            RomDetector.detect("vivo", prop),
            RomDetector.detect("samsung", prop),
            RomDetector.detect("HUAWEI", prop),
            RomDetector.detect("Honor", prop),
            RomDetector.detect("Google", prop),
            RomDetector.detect("UnknownBrand", prop)
        )

        for (rom in testCases) {
            assertThat(rom.restrictionsDescription)
                .isNotEmpty()
            assertThat(rom.batteryOptimizationGuide)
                .isNotEmpty()
        }
    }

    @Test
    fun `Xiaomi Huawei Honor have voiceInteraction disabled`() {
        val prop: (String) -> String? = { null }

        assertThat(
            (RomDetector.detect("Xiaomi", prop) as RomInfo.Xiaomi).voiceInteractionSupported
        ).isFalse()

        assertThat(
            (RomDetector.detect("HUAWEI", prop) as RomInfo.Huawei).voiceInteractionSupported
        ).isFalse()

        assertThat(
            (RomDetector.detect("Honor", prop) as RomInfo.Honor).voiceInteractionSupported
        ).isFalse()
    }

    @Test
    fun `Oppo Vivo Samsung Google Unknown have voiceInteraction enabled`() {
        val prop: (String) -> String? = { null }

        assertThat(
            (RomDetector.detect("OPPO", prop) as RomInfo.Oppo).voiceInteractionSupported
        ).isTrue()

        assertThat(
            (RomDetector.detect("vivo", prop) as RomInfo.Vivo).voiceInteractionSupported
        ).isTrue()

        assertThat(
            (RomDetector.detect("samsung", prop) as RomInfo.Samsung).voiceInteractionSupported
        ).isTrue()

        assertThat(
            (RomDetector.detect("Google", prop) as RomInfo.Google).voiceInteractionSupported
        ).isTrue()

        assertThat(
            (RomDetector.detect("Other", prop) as RomInfo.Unknown).voiceInteractionSupported
        ).isTrue()
    }
}
