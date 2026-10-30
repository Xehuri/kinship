package com.xehuri.kinship.ui.settings

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * 安全设置面板
 *
 * 提供 SSL 证书验证开关：
 * - 缺省开启：使用系统默认验证，需要服务器证书由公共 CA 签发（如 Let's Encrypt）
 * - 显式关闭：信任所有证书、跳过主机名校验，兼容自签名证书 / IP 直连，存在中间人风险
 *
 * 从开启切到关闭时会先弹出确认对话框，开启验证则立即生效。
 *
 * @param viewModel SettingsViewModel，提供 sslVerify 状态和 setSslVerify 方法
 */
@Composable
fun SecuritySection(viewModel: SettingsViewModel) {
    SettingsGroup(title = "安全") {
        SecurityContent(viewModel = viewModel)
    }
}

/**
 * 安全设置内容（不含卡片外壳），供概览页的可折叠卡片复用。
 */
@Composable
fun SecurityContent(viewModel: SettingsViewModel) {
    val sslVerify by viewModel.sslVerify.collectAsState()

    // 关闭证书验证前的二次确认
    var showDisableConfirm by remember { mutableStateOf(false) }

    SettingsSwitchItem(
        label = "验证 SSL 证书",
        description = "开启后校验服务器证书（推荐，需连接 https://example.com:8768）；" +
                "关闭则接受任意证书，仅用于自签名证书/IP 直连，存在中间人风险",
        checked = sslVerify,
        onCheckedChange = { enabled ->
            if (enabled) {
                // 开启验证：立即生效
                viewModel.setSslVerify(true)
            } else {
                // 关闭验证：先弹确认，确认后再应用
                showDisableConfirm = true
            }
        }
    )

    if (showDisableConfirm) {
        AlertDialog(
            onDismissRequest = { showDisableConfirm = false },
            title = { Text("关闭证书验证？") },
            text = {
                Text(
                    "关闭后将不再校验服务器证书，任何证书都会被接受，存在中间人攻击风险。" +
                            "仅在连接自签名证书或 IP 直连时使用。"
                )
            },
            confirmButton = {
                Button(onClick = {
                    showDisableConfirm = false
                    viewModel.setSslVerify(false)
                }) { Text("仍要关闭") }
            },
            dismissButton = {
                TextButton(onClick = { showDisableConfirm = false }) { Text("取消") }
            }
        )
    }
}
