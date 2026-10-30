package com.xehuri.kinship.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.ui.LogCache

/**
 * 「高级」折叠卡片内容：系统更新（OTA）+ 服务日志。
 *
 * 该内容会被放进二级页的 SettingsGroup，本身不能再包含同方向滚动容器。
 * 服务日志因此不做内部滚动，仅截取最近若干条，由整页滚动承载。
 */
@Composable
fun AdvancedSection(viewModel: SettingsViewModel) {
    OtaSection(viewModel)
    HorizontalDividerCompact()
    Spacer(Modifier.height(8.dp))
    ServiceLogSection()
}

/** 服务日志展示（不嵌套滚动，最多显示最近 40 条） */
@Composable
private fun ServiceLogSection() {
    val context = LocalContext.current
    val logEntries by LogCache.logFlow.collectAsState()
    val dateFormat = remember {
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
    }
    val logText = remember(logEntries) {
        logEntries.takeLast(40).joinToString("\n") { entry ->
            "${dateFormat.format(java.util.Date(entry.epochMs))} ${entry.tag}: ${entry.message}"
        }
    }

    Text(
        text = "服务日志",
        fontSize = 15.sp,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
    )
    Spacer(Modifier.height(4.dp))
    if (logText.isNotEmpty()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End
        ) {
            TextButton(onClick = {
                try {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("log", logText))
                } catch (_: Exception) { }
            }) {
                Text("复制日志", fontSize = 12.sp)
            }
        }
        androidx.compose.foundation.text.selection.SelectionContainer {
            Text(
                text = logText,
                fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                lineHeight = 13.sp
            )
        }
    } else {
        Text(
            text = "暂无日志（采集服务可能未运行）",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
        )
    }
}
