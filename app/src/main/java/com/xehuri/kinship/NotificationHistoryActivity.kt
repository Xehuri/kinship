package com.xehuri.kinship

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.widget.NotificationStore
import com.xehuri.kinship.widget.NotifyItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * NotificationHistoryActivity - AI 通知全文历史页（App 内查看，不经桌面组件）。
 *
 * 数据源为 [NotificationStore]（全文本地保存最近 50 条，新→旧）；桌面通知卡只呈现
 * 最近 5 条摘要（正文展示侧截 200 字），本页不截断——这是"完整内容"屏，正文整段换行铺开。
 *
 * 入口：通知卡整卡点击 + 设置页「桌面组件 → 通知历史」。exported=false，不进 launcher。
 * 主题从简，沿用 widget 配置页同款 MaterialTheme 包装（应用窗口底色为深色主题）。
 */
class NotificationHistoryActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                // prefs 读取转 IO 线程完成后回主线程渲染（null=尚未加载完成）
                var items by remember { mutableStateOf<List<NotifyItem>?>(null) }
                LaunchedEffect(Unit) {
                    items = withContext(Dispatchers.IO) { NotificationStore.readAll(applicationContext) }
                }
                HistoryScreen(items = items, onBack = { finish() })
            }
        }
    }
}

/** 历史页布局：返回箭头顶栏 + LazyColumn 滚动列表 / 加载与空态灰色提示 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HistoryScreen(items: List<NotifyItem>?, onBack: () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("通知历史") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                }
            )
        }
    ) { paddingValues ->
        when {
            items == null -> HintText("加载中", Modifier.padding(paddingValues).fillMaxSize())
            items.isEmpty() -> HintText("暂无通知记录，AI 推送后自动记录全文", Modifier.padding(paddingValues).fillMaxSize())
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(paddingValues),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            ) {
                items(items) { item ->
                    HistoryRow(item)
                }
            }
        }
    }
}

/**
 * 单条记录：标题(15sp Medium) + 行尾时间 "MM-dd HH:mm"(12sp 灰)，
 * 正文 13sp 整段换行铺开、不设 maxLines——全文展示是本页的存在意义。
 */
@Composable
private fun HistoryRow(item: NotifyItem) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = item.title,
                modifier = Modifier.weight(1f),
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = NotificationStore.formatTime(item.ts, "MM-dd HH:mm"),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f),
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(
            text = item.body,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f),
            // 刻意不设 maxLines：本页为"完整内容"屏，长文由 LazyColumn 滚动承载
        )
    }
    HorizontalDivider(
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
        thickness = 0.5.dp,
    )
}

/** 加载/空态占位：灰色提示，居中显示 */
@Composable
private fun HintText(text: String, modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f),
        )
    }
}
