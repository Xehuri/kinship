package com.xehuri.kinship.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.sp
import com.xehuri.kinship.transport.AddressFamily
import com.xehuri.kinship.transport.HttpAddress
import com.xehuri.kinship.transport.HttpTierProbe
import com.xehuri.kinship.transport.ProbeResult
import com.xehuri.kinship.transport.SelectionMode
import com.xehuri.kinship.transport.Tier
import com.xehuri.kinship.transport.TierKind
import com.xehuri.kinship.transport.TierSelector
import com.xehuri.kinship.transport.TierSettingsController
import com.xehuri.kinship.transport.TierStore
import com.xehuri.kinship.transport.TierTarget
import com.xehuri.kinship.transport.TlsPolicy
import com.xehuri.kinship.transport.TransportHint
import com.xehuri.kinship.transport.displayLabel
import com.xehuri.kinship.transport.displaySubtitle
import com.xehuri.kinship.transport.resolvePinnedTierId
import com.xehuri.kinship.transport.sortedTiers
import com.xehuri.kinship.ui.theme.SettingsShape
import com.xehuri.kinship.ui.theme.SettingsSpacing
import kotlinx.coroutines.launch

internal fun tierApplyEnabled(loading: Boolean, readOnly: Boolean): Boolean =
    !loading && !readOnly

/**
 * 网络设置页：按顺序尝试的连接层列表 + 当前连接状态 + 选择模式 + 编辑器。
 *
 * 所有写入都走 [TierSettingsController]，只落 `network_config_v1`，旧
 * `server_url` / `endpoint_candidates` / `transport_mode` 不再由本页写。
 */
@Composable
fun NetworkSettingsPage(onBack: () -> Unit) {
    val context = LocalContext.current
    val controller = remember {
        val store = TierStore.shared(context)
        val probe = HttpTierProbe()
        TierSettingsController(
            store = store,
            selector = TierSelector({ store.state.value }, probe),
            probe = probe,
        )
    }
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    val config by controller.config.collectAsState()

    var probeResults by remember { mutableStateOf<Map<String, ProbeResult>>(emptyMap()) }
    var loading by remember { mutableStateOf(false) }
    var editorOpen by remember { mutableStateOf(false) }
    var editingTier by remember { mutableStateOf<Tier?>(null) }

    LaunchedEffect(Unit) { controller.migrate() }

    val showMessage: (String) -> Unit = { message ->
        scope.launch { snackbarHostState.showSnackbar(message) }
    }

    val activeId = config.selection.activeTierId
    val activeTier = config.tiers.firstOrNull { it.id == activeId }
    val readOnly = controller.readOnly
    val hasP2p = config.tiers.any { it.kind == TierKind.P2P }
    val enabledNetworkTiers = config.sortedTiers()
        .filter { it.enabled && it.kind == TierKind.NETWORK_ADDRESS }

    SettingsSubPageScaffold(
        title = "网络",
        onBack = onBack,
        snackbarHostState = snackbarHostState,
    ) {
        if (readOnly) {
            item { TierReadOnlyBanner() }
        }

        item {
            SettingsGroup(title = "当前连接") {
                SettingsInfoItem("当前层", activeTier?.displayLabel() ?: "无可用连接层")
                SettingsInfoItem("地址", activeTier?.displaySubtitle() ?: "未配置")
                SettingsInfoItem(
                    "模式",
                    when (config.selection.mode) {
                        SelectionMode.AUTO_CHAIN -> "自动选择"
                        SelectionMode.PINNED -> "只用指定连接层"
                    }
                )
                Spacer(Modifier.height(SettingsSpacing.sm))
                Button(
                    onClick = {
                        scope.launch {
                            loading = true
                            val result = try {
                                if (!controller.readOnly) {
                                    probeResults = controller.probeAll()
                                }
                                controller.testAndApply()
                            } finally {
                                loading = false
                            }
                            result.fold(
                                onSuccess = { applied ->
                                    snackbarHostState.showSnackbar(
                                        "已应用：${applied.displayLabel()}"
                                    )
                                },
                                onFailure = { error ->
                                    snackbarHostState.showSnackbar(tierErrorMessage(error))
                                },
                            )
                        }
                    },
                    enabled = tierApplyEnabled(loading, readOnly),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (loading) "测试中..." else "测试并应用")
                }
            }
        }

        item {
            SettingsGroup(title = "连接层（按顺序尝试）") {
                val sorted = config.sortedTiers()
                if (sorted.isEmpty()) {
                    Text(
                        text = "还没有连接层，点击下方按钮添加。",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                    )
                } else {
                    sorted.forEachIndexed { index, tier ->
                        if (index > 0) HorizontalDividerCompact()
                        TierRow(
                            tier = tier,
                            probeResult = probeResults[tier.id],
                            editable = !readOnly,
                            canMoveUp = index > 0,
                            canMoveDown = index < sorted.lastIndex,
                            onEnabledChange = { enabled ->
                                controller.setEnabled(tier.id, enabled)
                                    .onFailure { showMessage(tierErrorMessage(it)) }
                            },
                            onMoveUp = {
                                controller.move(tier.id, -1)
                                    .onFailure { showMessage(tierErrorMessage(it)) }
                            },
                            onMoveDown = {
                                controller.move(tier.id, 1)
                                    .onFailure { showMessage(tierErrorMessage(it)) }
                            },
                            onEdit = {
                                editingTier = tier
                                editorOpen = true
                            },
                            onDelete = {
                                controller.delete(tier.id)
                                    .onFailure { showMessage(tierErrorMessage(it)) }
                                probeResults = probeResults - tier.id
                            },
                        )
                    }
                }
                Spacer(Modifier.height(SettingsSpacing.sm))
                Button(
                    onClick = {
                        editingTier = null
                        editorOpen = true
                    },
                    enabled = !readOnly,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("添加连接层")
                }
            }
        }

        item {
            SettingsGroup(title = "选择模式") {
                SettingsRadioList(
                    options = listOf(
                        SettingsRadioOption(
                            value = SelectionMode.AUTO_CHAIN.name,
                            title = "自动选择",
                            subtitle = "按顺序探测，失败自动回退",
                            enabled = !readOnly,
                        ),
                        SettingsRadioOption(
                            value = SelectionMode.PINNED.name,
                            title = "只用指定连接层",
                            subtitle = "不自动回退，指定层不可用时保持失败",
                            enabled = !readOnly,
                        ),
                    ),
                    selectedValue = config.selection.mode.name,
                    onSelect = { value ->
                        when (SelectionMode.valueOf(value)) {
                            SelectionMode.AUTO_CHAIN -> controller.setSelectionMode(
                                SelectionMode.AUTO_CHAIN,
                                null,
                            ).onFailure { showMessage(tierErrorMessage(it)) }

                            SelectionMode.PINNED -> {
                                val targetId = resolvePinnedTierId(
                                    config,
                                    config.selection.activeTierId,
                                )
                                if (targetId == null) {
                                    showMessage("请先添加并启用一个网络连接层。")
                                } else {
                                    controller.setSelectionMode(SelectionMode.PINNED, targetId)
                                        .onFailure { showMessage(tierErrorMessage(it)) }
                                }
                            }
                        }
                    },
                    description = "自动选择会按顺序探测并回退；只用指定连接层时不回退。",
                )
                if (config.selection.mode == SelectionMode.PINNED) {
                    Spacer(Modifier.height(SettingsSpacing.md))
                    if (enabledNetworkTiers.isEmpty()) {
                        Text(
                            text = "请先添加并启用一个网络连接层。",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                        )
                    } else {
                        SettingsRadioList(
                            options = enabledNetworkTiers.map { tier ->
                                SettingsRadioOption(
                                    value = tier.id,
                                    title = tier.displayLabel(),
                                    subtitle = tier.displaySubtitle(),
                                    enabled = !readOnly,
                                )
                            },
                            selectedValue = config.selection.activeTierId,
                            onSelect = { id ->
                                controller.setSelectionMode(SelectionMode.PINNED, id)
                                    .onFailure { showMessage(tierErrorMessage(it)) }
                            },
                        )
                    }
                    if (hasP2p) {
                        Spacer(Modifier.height(SettingsSpacing.xs))
                        Text(
                            text = "P2P 连接层未接入，暂不可选择。",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                        )
                    }
                }
            }
        }
    }

    if (editorOpen) {
        TierEditorDialog(
            initial = editingTier,
            nextOrder = (config.tiers.maxOfOrNull { it.order } ?: -1) + 1,
            onDismiss = { editorOpen = false },
            onSave = { tier -> controller.upsert(tier) },
        )
    }
}

@Composable
private fun TierRow(
    tier: Tier,
    probeResult: ProbeResult?,
    editable: Boolean,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onEnabledChange: (Boolean) -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (tier.kind == TierKind.P2P) 0.55f else 1f)
            .padding(vertical = SettingsSpacing.xs)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = tier.displayLabel(),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    text = tierSubtitle(tier, probeResult),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                )
            }
            Switch(
                checked = tier.enabled,
                onCheckedChange = onEnabledChange,
                enabled = editable,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onMoveUp, enabled = editable && canMoveUp) {
                Text("上移")
            }
            TextButton(onClick = onMoveDown, enabled = editable && canMoveDown) {
                Text("下移")
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onEdit, enabled = editable) {
                Text("编辑")
            }
            TextButton(onClick = onDelete, enabled = editable) {
                Text("删除")
            }
        }
    }
}

@Composable
private fun TierReadOnlyBanner() {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(SettingsShape.card),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
        ),
    ) {
        Text(
            text = TIER_READ_ONLY_MESSAGE,
            modifier = Modifier.padding(SettingsSpacing.lg),
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSecondaryContainer,
        )
    }
}

private fun tierSubtitle(tier: Tier, probeResult: ProbeResult?): String {
    val base = tier.displaySubtitle()
    val p2p = if (tier.kind == TierKind.P2P) " · 未接入，后续统一做" else ""
    val probeText = probeResult?.let { " · " + probeSummary(it) }.orEmpty()
    return base + p2p + probeText
}

private fun probeSummary(result: ProbeResult): String = when (result) {
    is ProbeResult.Healthy -> "健康 ${result.latencyMs}ms"
    is ProbeResult.Unreachable -> "不可达：${result.reason}"
    is ProbeResult.TlsError -> "TLS 错误：${result.reason}"
    is ProbeResult.InvalidResponse -> "响应异常：${result.reason}"
    is ProbeResult.Skipped -> "跳过：${result.reason}"
}

private enum class TlsChoice { SYSTEM, PINNED, INSECURE }

@Composable
private fun TierEditorDialog(
    initial: Tier?,
    nextOrder: Int,
    onDismiss: () -> Unit,
    onSave: (Tier) -> Result<Unit>,
) {
    val initialAddress = (initial?.target as? TierTarget.Network)?.address
    var label by remember(initial) { mutableStateOf(initial?.label.orEmpty()) }
    var kind by remember(initial) { mutableStateOf(initial?.kind ?: TierKind.NETWORK_ADDRESS) }
    var scheme by remember(initial) { mutableStateOf(initialAddress?.scheme ?: "https") }
    var host by remember(initial) { mutableStateOf(initialAddress?.host.orEmpty()) }
    var port by remember(initial) { mutableStateOf((initialAddress?.port ?: 8768).toString()) }
    var pathPrefix by remember(initial) { mutableStateOf(initialAddress?.pathPrefix ?: "/") }
    var family by remember(initial) { mutableStateOf(initial?.family ?: AddressFamily.AUTO) }
    var tlsChoice by remember(initial) {
        mutableStateOf(
            when (initial?.tls) {
                is TlsPolicy.Pinned -> TlsChoice.PINNED
                is TlsPolicy.InsecureDev -> TlsChoice.INSECURE
                else -> TlsChoice.SYSTEM
            }
        )
    }
    var pinsText by remember(initial) {
        mutableStateOf(
            (initial?.tls as? TlsPolicy.Pinned)?.sha256LeafPins?.joinToString("\n").orEmpty()
        )
    }
    var transportHint by remember(initial) {
        mutableStateOf(initial?.transportHint ?: TransportHint.UNKNOWN)
    }
    var peerId by remember(initial) {
        mutableStateOf((initial?.target as? TierTarget.Peer)?.peerId.orEmpty())
    }
    var error by remember(initial) { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "添加连接层" else "编辑连接层") },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(SettingsSpacing.sm))
                SettingsChoicePicker(
                    label = "类型",
                    options = listOf(
                        TierKind.NETWORK_ADDRESS.name to "网络地址",
                        TierKind.P2P.name to "P2P",
                    ),
                    selectedValue = kind.name,
                    onSelect = { value ->
                        kind = TierKind.valueOf(value)
                        error = null
                    },
                )
                Spacer(Modifier.height(SettingsSpacing.sm))
                when (kind) {
                    TierKind.NETWORK_ADDRESS -> NetworkTierFields(
                        scheme = scheme,
                        onSchemeChange = { scheme = it },
                        host = host,
                        onHostChange = { host = it },
                        port = port,
                        onPortChange = { port = it.filter(Char::isDigit) },
                        pathPrefix = pathPrefix,
                        onPathPrefixChange = { pathPrefix = it },
                        family = family,
                        onFamilyChange = { family = it },
                        tlsChoice = tlsChoice,
                        onTlsChoiceChange = { tlsChoice = it },
                        pinsText = pinsText,
                        onPinsTextChange = { pinsText = it },
                        transportHint = transportHint,
                        onTransportHintChange = { transportHint = it },
                    )
                    TierKind.P2P -> {
                        OutlinedTextField(
                            value = peerId,
                            onValueChange = { peerId = it },
                            label = { Text("对端 ID") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(SettingsSpacing.xs))
                        Text(
                            text = "P2P 未接入，后续统一做",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                        )
                    }
                }
                error?.let { message ->
                    Spacer(Modifier.height(SettingsSpacing.sm))
                    Text(
                        text = message,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val resolvedTarget: Result<TierTarget>
                    if (kind == TierKind.NETWORK_ADDRESS) {
                        val parsed = HttpAddress.parse(
                            "$scheme://${host.trim()}:${port.trim()}$pathPrefix"
                        )
                        val address = parsed.getOrNull()
                        resolvedTarget = if (address != null) {
                            Result.success(TierTarget.Network(address))
                        } else {
                            Result.failure(
                                parsed.exceptionOrNull() ?: IllegalArgumentException("地址无效")
                            )
                        }
                    } else {
                        resolvedTarget = Result.success(TierTarget.Peer(peerId.trim()))
                    }
                    resolvedTarget.fold(
                        onSuccess = { target ->
                            val tls = when (tlsChoice) {
                                TlsChoice.SYSTEM -> TlsPolicy.System
                                TlsChoice.PINNED -> TlsPolicy.Pinned(splitPins(pinsText))
                                TlsChoice.INSECURE -> TlsPolicy.InsecureDev
                            }
                            val tier = buildTierForSave(
                                initial = initial,
                                nextOrder = nextOrder,
                                label = label,
                                kind = kind,
                                target = target,
                                family = family,
                                tls = tls,
                                transportHint = transportHint,
                            )
                            onSave(tier).fold(
                                onSuccess = { onDismiss() },
                                onFailure = { error = tierErrorMessage(it) },
                            )
                        },
                        onFailure = { error = tierErrorMessage(it) },
                    )
                }
            ) {
                Text("保存")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消")
            }
        },
    )
}

@Composable
private fun NetworkTierFields(
    scheme: String,
    onSchemeChange: (String) -> Unit,
    host: String,
    onHostChange: (String) -> Unit,
    port: String,
    onPortChange: (String) -> Unit,
    pathPrefix: String,
    onPathPrefixChange: (String) -> Unit,
    family: AddressFamily,
    onFamilyChange: (AddressFamily) -> Unit,
    tlsChoice: TlsChoice,
    onTlsChoiceChange: (TlsChoice) -> Unit,
    pinsText: String,
    onPinsTextChange: (String) -> Unit,
    transportHint: TransportHint,
    onTransportHintChange: (TransportHint) -> Unit,
) {
    SettingsChoicePicker(
        label = "协议",
        options = listOf("https" to "https", "http" to "http"),
        selectedValue = scheme,
        onSelect = onSchemeChange,
    )
    Spacer(Modifier.height(SettingsSpacing.sm))
    OutlinedTextField(
        value = host,
        onValueChange = onHostChange,
        label = { Text("主机") },
        placeholder = { Text("example.com") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(SettingsSpacing.sm))
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = port,
            onValueChange = onPortChange,
            label = { Text("端口") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Number,
                imeAction = ImeAction.Next,
            ),
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(SettingsSpacing.sm))
        OutlinedTextField(
            value = pathPrefix,
            onValueChange = onPathPrefixChange,
            label = { Text("路径前缀") },
            singleLine = true,
            modifier = Modifier.weight(1f),
        )
    }
    Spacer(Modifier.height(SettingsSpacing.sm))
    SettingsChoicePicker(
        label = "地址族",
        options = listOf(
            AddressFamily.AUTO.name to "自动",
            AddressFamily.PREFER_V4.name to "IPv4 优先",
            AddressFamily.PREFER_V6.name to "IPv6 优先",
        ),
        selectedValue = family.name,
        onSelect = { value -> onFamilyChange(AddressFamily.valueOf(value)) },
    )
    Spacer(Modifier.height(SettingsSpacing.sm))
    SettingsChoicePicker(
        label = "TLS",
        options = listOf(
            TlsChoice.SYSTEM.name to "系统",
            TlsChoice.PINNED.name to "固定指纹",
            TlsChoice.INSECURE.name to "开发不校验",
        ),
        selectedValue = tlsChoice.name,
        onSelect = { value -> onTlsChoiceChange(TlsChoice.valueOf(value)) },
    )
    if (tlsChoice == TlsChoice.PINNED) {
        Spacer(Modifier.height(SettingsSpacing.sm))
        OutlinedTextField(
            value = pinsText,
            onValueChange = onPinsTextChange,
            label = { Text("SHA-256 指纹（每行一个）") },
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )
    }
    Spacer(Modifier.height(SettingsSpacing.sm))
    SettingsChoicePicker(
        label = "连接类型",
        options = listOf(
            TransportHint.DIRECT.name to "直连",
            TransportHint.FRP.name to "FRP",
            TransportHint.UNKNOWN.name to "未知",
        ),
        selectedValue = transportHint.name,
        onSelect = { value -> onTransportHintChange(TransportHint.valueOf(value)) },
    )
}

private fun splitPins(raw: String): List<String> =
    raw.split('\n', ',', ' ', '\t')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
