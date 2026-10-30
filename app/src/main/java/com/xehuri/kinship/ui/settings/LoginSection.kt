package com.xehuri.kinship.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.transport.displayLabel
import com.xehuri.kinship.transport.displaySubtitle
import kotlinx.coroutines.launch

/**
 * LoginSection -- 账号与登录区域
 *
 * 所有登录状态与动作都来自 [SettingsViewModel]；本文件不做网络请求、不读写 prefs。
 */
@Composable
fun LoginSection(
    viewModel: SettingsViewModel,
    snackbarHostState: SnackbarHostState? = null
) {
    val scope = rememberCoroutineScope()

    val tierConfig by viewModel.tierConfig.collectAsState()
    val activeTier = tierConfig.tiers.firstOrNull { it.id == tierConfig.selection.activeTierId }
    val serverLabel = activeTier?.displayLabel() ?: ServerConfig.BASE_URL
    val serverOrigin = activeTier?.displaySubtitle()?.takeIf { it != serverLabel }
    val isLoggedIn by viewModel.isLoggedIn.collectAsState()
    val loginStatus by viewModel.loginStatus.collectAsState()
    val savedUsername by viewModel.savedUsername.collectAsState()
    val loginError by viewModel.loginError.collectAsState()

    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    var wasLoggedIn by remember { mutableStateOf(isLoggedIn) }
    LaunchedEffect(isLoggedIn) {
        if (isLoggedIn && !wasLoggedIn) {
            snackbarHostState?.showSnackbar("登录成功")
        }
        wasLoggedIn = isLoggedIn
    }

    Column(
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "服务器: ",
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
            )
            Text(
                serverLabel,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium
            )
        }
        if (serverOrigin != null) {
            Text(
                serverOrigin,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
            )
        }
    }

    HorizontalDivider(
        modifier = Modifier.padding(vertical = 2.dp),
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
        thickness = 0.5.dp
    )

    if (!isLoggedIn) {
        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("账号") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next)
        )
        Spacer(Modifier.height(8.dp))

        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("密码") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done
            ),
            keyboardActions = KeyboardActions(
                onDone = {
                    if (username.isNotBlank() && password.isNotBlank()) {
                        viewModel.login(username, password)
                    }
                }
            )
        )
        Spacer(Modifier.height(12.dp))

        Button(
            onClick = { viewModel.login(username, password) },
            modifier = Modifier.fillMaxWidth(),
            enabled = loginStatus != "登录中..."
        ) {
            if (loginStatus == "登录中...") {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary
                )
                Spacer(Modifier.width(8.dp))
            }
            Text("登录")
        }
    } else {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "账号: ",
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
            )
            Text(
                savedUsername,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium
            )
        }
    }

    if (loginError.isNotEmpty()) {
        Spacer(Modifier.height(4.dp))
        Text(
            text = loginError,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.error
        )
    }

    Spacer(Modifier.height(8.dp))
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            "状态: ",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
        )
        Text(
            text = loginStatus,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            color = if (isLoggedIn) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
        )
    }

    if (isLoggedIn) {
        Spacer(Modifier.height(8.dp))
        TextButton(
            onClick = {
                viewModel.logout()
                username = ""
                password = ""
                scope.launch {
                    snackbarHostState?.showSnackbar("已退出登录")
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("退出登录", color = MaterialTheme.colorScheme.error)
        }
    }
}
