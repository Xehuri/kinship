package com.xehuri.kinship.ui.settings

import android.os.Build
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.util.DeviceId

/**
 * 设备信息与名称（概览 → 二级页）。
 *
 * 只保留本机标识与用户可编辑的设备名称；服务器地址在「网络」、立即同步在概览行，
 * 不再重复出现在本页。
 */
@Composable
fun DevicePage(
    viewModel: SettingsViewModel,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val deviceNameState by viewModel.deviceName.collectAsState()
    val deviceId = remember(context) { DeviceId.get(context) }

    SettingsSubPageScaffold(title = "设备信息与名称", onBack = onBack) {
        item {
            SettingsGroup(title = "设备信息") {
                SettingsInfoItem("品牌", Build.BRAND)
                SettingsInfoItem("型号", Build.MODEL)
                SettingsInfoItem("Android 版本", Build.VERSION.RELEASE)
                Spacer(Modifier.height(8.dp))
                Column(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = "设备 ID",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                    )
                    Spacer(Modifier.height(2.dp))
                    SelectionContainer {
                        Text(
                            text = deviceId,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "用于后端区分设备来源，长按可选择复制。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
            }
        }

        item {
            SettingsGroup(title = "设备名称") {
                var localDeviceName by remember { mutableStateOf(deviceNameState) }
                OutlinedTextField(
                    value = localDeviceName,
                    onValueChange = { localDeviceName = it },
                    label = { Text("设备名称") },
                    placeholder = { Text(Build.MODEL) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(
                        onDone = { viewModel.saveDeviceName(localDeviceName) }
                    )
                )
                Spacer(Modifier.height(4.dp))
                Button(
                    onClick = { viewModel.saveDeviceName(localDeviceName) },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("保存设备名称")
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "上报数据时一并携带",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
            }
        }
    }
}
