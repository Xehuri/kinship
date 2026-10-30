package com.xehuri.kinship.ui.settings

import com.google.common.truth.Truth.assertThat
import java.io.File
import org.junit.Test

/**
 * 健康采集开关单源静态守卫（读取主源码文本，非 Compose 行为测试）。
 *
 * Compose UI 测试基建尚未建立，这里用 JVM 单测锁定契约：
 * - 开关只在概览行内（SettingsActivity 的 OverviewSwitchKey.HEALTH）写入；
 * - 健康数据二级页只保留上传模式 / 数据库配置，不再重复开关；
 * - 概览模型只暴露一个 HEALTH 开关。
 */
class HealthSwitchSingleSourceTest {

    @Test
    fun `health data page has no master switch call site`() {
        val source = readSource(HEALTH_PAGE)

        assertThat(occurrences(source, "toggleSensor(\"health\"")).isEqualTo(0)
    }

    @Test
    fun `settings activity has exactly one health toggle call site`() {
        val source = readSource(SETTINGS_ACTIVITY)

        assertThat(occurrences(source, "toggleSensor(\"health\"")).isEqualTo(1)
    }

    @Test
    fun `overview model exposes exactly one health switch key`() {
        val source = readSource(OVERVIEW_MODEL)

        assertThat(occurrences(source, "OverviewSwitchKey.HEALTH")).isEqualTo(1)
    }

    private fun occurrences(source: String, needle: String): Int =
        source.split(needle).size - 1

    private fun readSource(relativePath: String): String {
        val candidates = listOf(
            File(relativePath),
            File("../$relativePath"),
            File("app/$relativePath"),
        )
        val file = candidates.firstOrNull { it.isFile }
        return file?.readText()
            ?: throw AssertionError(
                "找不到 $relativePath，已尝试：" +
                    candidates.joinToString { it.absolutePath } +
                    "（user.dir=${File(".").absolutePath}）"
            )
    }

    private companion object {
        const val HEALTH_PAGE =
            "src/main/java/com/xehuri/kinship/ui/settings/HealthDataPage.kt"
        const val SETTINGS_ACTIVITY =
            "src/main/java/com/xehuri/kinship/SettingsActivity.kt"
        const val OVERVIEW_MODEL =
            "src/main/java/com/xehuri/kinship/ui/settings/SettingsOverviewModel.kt"
    }
}
