package com.xehuri.kinship.transport

/**
 * 解析 PINNED 模式该钉住哪个连接层。
 *
 * 优先返回 [preferredId]（仅当它是已启用的 NETWORK_ADDRESS 层），否则按
 * [sortedTiers] 顺序取第一个已启用的 NETWORK_ADDRESS 层；一个都没有时返回 null。
 * 注意 sortedTiers 已按 order/id 排序，P2P 层永远不参与。
 */
fun resolvePinnedTierId(config: TierConfig, preferredId: String?): String? {
    val pinnable = config.sortedTiers().filter { it.enabled && it.kind == TierKind.NETWORK_ADDRESS }
    val preferred = preferredId?.let { id -> pinnable.firstOrNull { it.id == id } }
    return preferred?.id ?: pinnable.firstOrNull()?.id
}

/** 当前配置是否至少有一个可钉住的已启用网络层。 */
fun hasPinnableTier(config: TierConfig): Boolean =
    config.tiers.any { it.enabled && it.kind == TierKind.NETWORK_ADDRESS }
