package com.xehuri.kinship.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.ui.theme.KinshipRadius
import com.xehuri.kinship.ui.theme.KinshipSpacing

/**
 * 设置分组卡片 -- 标题 + 内容
 */
@Composable
fun SettingsGroup(
    title: String,
    content: @Composable ColumnScope.() -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)
        )
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = title,
                fontSize = 17.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary
            )
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

/**
 * 概览页分组标题：小号、弱化、与分组内容左对齐。
 */
@Composable
fun SettingsSectionHeader(title: String) {
    Text(
        text = title,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(
            start = KinshipSpacing.x1,
            top = KinshipSpacing.x5,
            bottom = KinshipSpacing.x2
        )
    )
}

/**
 * 分组内发丝分隔线：左侧让出内容内边距，不贯穿分组边缘。
 */
@Composable
fun SettingsSectionDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(start = KinshipSpacing.x4),
        color = MaterialTheme.colorScheme.outlineVariant,
        thickness = 0.5.dp
    )
}

/**
 * 概览页分组：标题 + 表面色圆角容器，行之间用 [SettingsSectionDivider] 分隔。
 */
@Composable
fun SettingsSection(
    title: String,
    content: @Composable ColumnScope.() -> Unit
) {
    SettingsSectionHeader(title)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KinshipRadius.card))
            .background(MaterialTheme.colorScheme.surface)
    ) {
        content()
    }
}

/**
 * 设置开关项 -- 带 Switch 的配置行
 */
@Composable
fun SettingsSwitchItem(
    label: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                fontSize = 15.sp,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(Modifier.height(1.dp))
            Text(
                text = description,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f)
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors()
        )
    }
}

/**
 * 分组内紧凑分隔线
 */
@Composable
fun HorizontalDividerCompact() {
    HorizontalDivider(
        modifier = Modifier.padding(vertical = 2.dp),
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
        thickness = 0.5.dp
    )
}

/**
 * 设置键值信息项
 */
@Composable
fun SettingsInfoItem(key: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            key,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
        )
        Text(
            value,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium
        )
    }
}
