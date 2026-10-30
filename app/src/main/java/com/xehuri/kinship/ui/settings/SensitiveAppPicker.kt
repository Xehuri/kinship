package com.xehuri.kinship.ui.settings

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/**
 * 敏感应用选择器（全屏对话框）：列出已安装应用，支持搜索与多选。
 *
 * - 预选 = 当前黑名单中的包名；
 * - 确认 = 把选中集合交给调用方回写（拼成逗号分隔字符串，保持既有存储格式不变）；
 * - 应用标签/图标由 [SettingsViewModel] 在 IO 线程解析并缓存，本组件只负责渲染。
 *
 * 手动按包名添加仍作为次级入口保留在调用页面，用于枚举不到的应用兜底。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SensitiveAppPickerDialog(
    apps: List<InstalledAppItem>,
    loading: Boolean,
    preselected: Set<String>,
    onRequestLoad: () -> Unit,
    onDismiss: () -> Unit,
    onConfirm: (Set<String>) -> Unit
) {
    var query by remember { mutableStateOf("") }
    var selected by remember(preselected) { mutableStateOf(preselected) }

    // 打开时按需加载已安装应用（已缓存则直接复用，不重复枚举）
    LaunchedEffect(Unit) { onRequestLoad() }

    val filtered = remember(apps, query) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) {
            apps
        } else {
            apps.filter {
                it.label.lowercase().contains(q) || it.packageName.lowercase().contains(q)
            }
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background
        ) {
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = { Text("选择敏感应用") },
                        navigationIcon = {
                            IconButton(onClick = onDismiss) {
                                Icon(Icons.Filled.Close, contentDescription = "取消")
                            }
                        },
                        actions = {
                            TextButton(onClick = { onConfirm(selected) }) {
                                Text("完成（${selected.size}）")
                            }
                        }
                    )
                }
            ) { paddingValues ->
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues)
                ) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        label = { Text("搜索应用") },
                        leadingIcon = {
                            Icon(Icons.Filled.Search, contentDescription = null)
                        },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                    when {
                        loading -> Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }

                        filtered.isEmpty() -> Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = if (apps.isEmpty()) "未读取到已安装应用" else "未找到匹配的应用",
                                fontSize = 13.sp,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                            )
                        }

                        else -> LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(bottom = 16.dp)
                        ) {
                            items(filtered, key = { it.packageName }) { app ->
                                InstalledAppRow(
                                    app = app,
                                    checked = app.packageName in selected,
                                    onCheckedChange = { checked ->
                                        selected = if (checked) {
                                            selected + app.packageName
                                        } else {
                                            selected - app.packageName
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 单个已安装应用行：图标 + 名称 + 包名 + 复选框，整行可点击切换。 */
@Composable
private fun InstalledAppRow(
    app: InstalledAppItem,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onCheckedChange(!checked) }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (app.icon != null) {
            Image(
                bitmap = app.icon,
                contentDescription = null,
                modifier = Modifier.size(36.dp)
            )
        } else {
            // 无图标时用等尺寸占位，保持各行高度一致
            Box(modifier = Modifier.size(36.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = app.label,
                fontSize = 15.sp,
                maxLines = 1
            )
            Text(
                text = app.packageName,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                maxLines = 1
            )
        }
        Checkbox(
            checked = checked,
            onCheckedChange = { onCheckedChange(it) }
        )
    }
}
