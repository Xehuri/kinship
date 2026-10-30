package com.xehuri.kinship.transport

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow

/**
 * 设置页的连接层编辑入口：所有写操作都经 [TierStore.save] 校验后落盘。
 *
 * 只改 `network_config_v1`；旧 `server_url` / `endpoint_candidates` / `transport_mode`
 * 一概不写，保证迁移后的旧字段保持冻结。
 */
class TierSettingsController(
    private val store: TierStore,
    private val selector: TierSelector,
    private val probe: TierProbe = HttpTierProbe(),
) {
    val config: StateFlow<TierConfig> = store.state
    val selection: StateFlow<TierSelectionState> = selector.state

    /** 配置来自更高版本时只读：设置页必须禁用编辑但保留列表展示。 */
    val readOnly: Boolean get() = store.readOnly

    suspend fun migrate() {
        store.migrateIfNeeded()
    }

    /**
     * 按 id 替换已有连接层，否则追加到末尾（order = 当前最大值 + 1）。
     */
    fun upsert(tier: Tier): Result<Unit> = persist {
        val current = config.value
        val index = current.tiers.indexOfFirst { it.id == tier.id }
        val tiers = if (index >= 0) {
            current.tiers.toMutableList().also { it[index] = tier }
        } else {
            val nextOrder = (current.tiers.maxOfOrNull { it.order } ?: -1) + 1
            current.tiers + tier.copy(order = nextOrder)
        }
        store.save(
            current.copy(
                tiers = tiers,
                selection = reconcileSelection(tiers, current.selection),
            )
        )
    }

    fun delete(id: String): Result<Unit> = persist {
        val current = config.value
        val remaining = current.tiers.filterNot { it.id == id }
        val selection = current.selection
        val nextSelection = if (selection.activeTierId == id) {
            if (selection.mode == SelectionMode.PINNED) {
                TierSelection(SelectionMode.AUTO_CHAIN, null)
            } else {
                selection.copy(activeTierId = null)
            }
        } else {
            selection
        }
        store.save(current.copy(tiers = remaining, selection = nextSelection))
    }

    /**
     * 与排序后的相邻连接层交换位置，并把 order 重排为 0..n-1。
     * 越界（已在首/尾）时保持原状且不写入。
     */
    fun move(id: String, delta: Int): Result<Unit> = persist {
        val current = config.value
        val sorted = current.sortedTiers().toMutableList()
        val index = sorted.indexOfFirst { it.id == id }
        if (index < 0) return@persist
        val target = index + delta
        if (target !in sorted.indices) return@persist
        val swapped = sorted[index]
        sorted[index] = sorted[target]
        sorted[target] = swapped
        val reordered = sorted.mapIndexed { position, tier -> tier.copy(order = position) }
        store.save(current.copy(tiers = reordered))
    }

    fun setEnabled(id: String, enabled: Boolean): Result<Unit> = persist {
        val current = config.value
        val tiers = current.tiers.map { if (it.id == id) it.copy(enabled = enabled) else it }
        var selection = current.selection
        if (!enabled && selection.mode == SelectionMode.PINNED && selection.activeTierId == id) {
            selection = TierSelection(SelectionMode.AUTO_CHAIN, null)
        }
        store.save(current.copy(tiers = tiers, selection = selection))
    }

    /**
     * PINNED 必须指向一个已存在且启用的网络地址层；AUTO_CHAIN 只保留可用的请求 id，
     * 请求 id 不可用时沿用当前可用的 active id，两者都不可用则清空。
     */
    fun setSelectionMode(mode: SelectionMode, activeTierId: String?): Result<Unit> = persist {
        val current = config.value
        val next = when (mode) {
            SelectionMode.PINNED -> {
                val tier = current.tiers.firstOrNull {
                    it.id == activeTierId && it.enabled && it.kind == TierKind.NETWORK_ADDRESS
                } ?: throw IllegalArgumentException("pinned tier not found")
                TierSelection(SelectionMode.PINNED, tier.id)
            }
            SelectionMode.AUTO_CHAIN -> {
                val requested = activeTierId?.takeIf { isSelectable(current.tiers, it) }
                val currentActive = current.selection.activeTierId
                    ?.takeIf { isSelectable(current.tiers, it) }
                TierSelection(SelectionMode.AUTO_CHAIN, requested ?: currentActive)
            }
        }
        store.save(current.copy(selection = next))
    }

    /** 并发探测每个连接层，结果保持配置顺序；P2P 由 [HttpTierProbe] 直接返回 Skipped。 */
    suspend fun probeAll(): Map<String, ProbeResult> {
        val tiers = config.value.tiers
        val results = coroutineScope {
            tiers.map { tier -> async { tier.id to probe.probe(tier) } }.awaitAll()
        }
        return results.toMap(LinkedHashMap())
    }

    /**
     * 强制重探并应用：生产运行时优先复用常驻实例，否则创建临时运行时并在结束后关闭。
     *
     * 只读配置在任何探测/写入前直接失败；每次重读后都复查只读状态，
     * 避免更高版本 schema 变化时误报“已应用”。
     */
    suspend fun testAndApply(): Result<Tier> {
        store.load()
        if (store.readOnly) return readOnlyFailure()
        val runtime = TierRuntimeHolder.get()
        if (runtime != null) {
            try {
                runtime.refresh(force = true)
            } finally {
                store.load()
            }
            return appliedResult()
        }
        val temporary = TierRuntime(
            store = store,
            selector = selector,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )
        return try {
            temporary.refresh(force = true)
            store.load()
            appliedResult()
        } finally {
            temporary.close()
        }
    }

    private fun appliedResult(): Result<Tier> {
        if (store.readOnly) return readOnlyFailure()
        val tier = activeTier()
            ?: return Result.failure(IllegalStateException("no available tier"))
        return Result.success(tier)
    }

    private fun readOnlyFailure(): Result<Tier> =
        Result.failure(IllegalArgumentException("tier config is read-only"))

    fun activeTier(): Tier? {
        store.load()
        val current = config.value
        val id = current.selection.activeTierId
        return current.tiers.firstOrNull { it.id == id }
    }

    private fun isSelectable(tiers: List<Tier>, id: String?): Boolean =
        id != null && tiers.any {
            it.id == id && it.enabled && it.kind == TierKind.NETWORK_ADDRESS
        }

    /**
     * 连接层变更后的选择校正：PINNED 指向不可用层时退回 AUTO_CHAIN 且不留悬挂 id；
     * AUTO_CHAIN 的 active id 失效时清空（不自动改选，避免静默切换）。
     */
    private fun reconcileSelection(tiers: List<Tier>, selection: TierSelection): TierSelection =
        when (selection.mode) {
            SelectionMode.PINNED -> if (isSelectable(tiers, selection.activeTierId)) {
                selection
            } else {
                TierSelection(SelectionMode.AUTO_CHAIN, null)
            }
            SelectionMode.AUTO_CHAIN -> if (
                selection.activeTierId == null || isSelectable(tiers, selection.activeTierId)
            ) {
                selection
            } else {
                selection.copy(activeTierId = null)
            }
        }

    private inline fun persist(block: () -> Unit): Result<Unit> = try {
        block()
        Result.success(Unit)
    } catch (error: IllegalArgumentException) {
        Result.failure(error)
    }
}
