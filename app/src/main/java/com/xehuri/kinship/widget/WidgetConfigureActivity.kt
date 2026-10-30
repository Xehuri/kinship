package com.xehuri.kinship.widget

import android.appwidget.AppWidgetManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * WidgetConfigureActivity - configureActivity 形态 demo（桌面组件 demo 第二波）
 *
 * 由 res/xml/health_summary_widget.xml 的 android:configure 声明绑定：从 launcher 组件列表
 * 首次拖出聚合卡时，宿主带 EXTRA_APPWIDGET_ID 启动本页。两条责任约定（crash-audit.md 修复 2）：
 * 1. 本页**只写档位、绝不触发渲染**——configure 先于绑定启动，绑定前对全部实例主动
 *    广播式更新要么空转（新实例 id 尚未被枚举），要么在尺寸未就绪窗口拉起首会话
 *    （首会话死锁扳机）；首渲染一律由宿主 RESULT_OK 后绑定触发的 onUpdate 负责。
 *    （旧"配置页保存后主动首刷"责任页设定已随修复 2 废除，绝不依赖也绝不抢 onUpdate。）
 * 2. requestPinGlanceAppWidget 钉选路径**绕过** configureActivity，经设置页钉进来的
 *    聚合卡不会经过本页，档位沿用 prefs 现值（缺省 full）。
 *
 * exported=false 说明：见交付报告风险项——launcher 跨进程启动配置页在部分宿主可能被
 * exported 检查拒绝（官方配置指南样例为 exported=true + APPWIDGET_CONFIGURE filter）；
 * 本 demo 遵规格先走 false，真机若配置页不弹则按样例放开，功能语义不变。
 *
 * 本 Activity 独立在 widget 包内，不进主导航、不动 MainActivity/SettingsActivity。
 */
class WidgetConfigureActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 宿主经 EXTRA_APPWIDGET_ID 告知在为哪个 widget 实例配置；无效 id 直接取消（不写任何状态）
        val appWidgetId = intent?.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        // 预置取消结果：用户返回键/划掉即取消建卡（widget 实例由宿主回收），保存成功时再覆盖为 OK
        setResult(RESULT_CANCELED)

        setContent {
            MaterialTheme {
                ConfigureScreen(
                    initialMode = WidgetSnapshot.readSummaryMode(this),
                    onPick = ::applyMode,
                )
            }
        }
    }

    /**
     * 保存档位 -> 写 widget_snapshot["summary_mode"] -> RESULT_OK 交还宿主。
     * 本页零渲染责任：首渲染由宿主绑定后的 onUpdate 驱动（crash-audit.md 修复 2，
     * 绑定前的全实例主动更新是聚合卡首会话死锁的唯一入口，已整体移除）。
     */
    private fun applyMode(mode: String) {
        WidgetSnapshot.writeSummaryMode(this, mode)
        setResult(RESULT_OK)
        finish()
    }
}

/** 两档单选：点选即应用并关闭（demo 从简，无独立确认按钮） */
@Composable
private fun ConfigureScreen(initialMode: String, onPick: (String) -> Unit) {
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxWidth().padding(20.dp)) {
            Text(
                text = "健康聚合卡配置",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "选择桌面卡片显示内容，点选即生效",
                modifier = Modifier.padding(top = 4.dp, bottom = 12.dp),
                style = MaterialTheme.typography.bodyMedium,
            )
            ModeOption(
                label = "心率 + 步数",
                selected = initialMode == WidgetSnapshot.MODE_FULL,
                onPick = { onPick(WidgetSnapshot.MODE_FULL) },
            )
            ModeOption(
                label = "仅心率",
                selected = initialMode == WidgetSnapshot.MODE_HR_ONLY,
                onPick = { onPick(WidgetSnapshot.MODE_HR_ONLY) },
            )
        }
    }
}

@Composable
private fun ModeOption(label: String, selected: Boolean, onPick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onPick).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onPick)
        Text(text = label, modifier = Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodyLarge)
    }
}
