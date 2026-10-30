package com.xehuri.kinship.transport

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

data class TierSelectionState(
    val activeTierId: String? = null,
    val mode: SelectionMode = SelectionMode.AUTO_CHAIN,
    val lastProbeAtMs: Long = 0L,
    val failedUntilMs: Map<String, Long> = emptyMap(),
)

class TierSelector(
    private val configProvider: () -> TierConfig,
    private val probe: TierProbe,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val failureCooldownMs: Long = 30_000L,
) {
    private val _state = MutableStateFlow(TierSelectionState())
    val state: StateFlow<TierSelectionState> = _state.asStateFlow()

    private val mutex = Mutex()

    suspend fun selectOnStartup(force: Boolean = false): Tier? = mutex.withLock {
        select(force)
    }

    suspend fun onTransportFailure(tierId: String): Tier? = mutex.withLock {
        val config = configProvider()
        val candidates = candidates(config)
        when (config.selection.mode) {
            SelectionMode.PINNED -> {
                val pinned = candidates.firstOrNull { it.id == config.selection.activeTierId }
                publish(SelectionMode.PINNED, pinned?.id, _state.value.failedUntilMs)
                pinned
            }
            SelectionMode.AUTO_CHAIN -> {
                val failed = _state.value.failedUntilMs + (tierId to clock() + failureCooldownMs)
                publish(SelectionMode.AUTO_CHAIN, null, failed)
                selectAuto(config, candidates, force = true, skipTierId = tierId)
            }
        }
    }

    suspend fun manualReprobe(): Tier? = mutex.withLock {
        _state.value = _state.value.copy(activeTierId = null, failedUntilMs = emptyMap())
        select(force = true)
    }

    fun reset() {
        _state.value = TierSelectionState()
    }

    private suspend fun select(force: Boolean): Tier? {
        val config = configProvider()
        val candidates = candidates(config)
        return when (config.selection.mode) {
            SelectionMode.PINNED -> selectPinned(config, candidates)
            SelectionMode.AUTO_CHAIN -> selectAuto(config, candidates, force)
        }
    }

    private fun candidates(config: TierConfig): List<Tier> =
        config.sortedTiers().filter { it.enabled && it.kind == TierKind.NETWORK_ADDRESS }

    private suspend fun selectPinned(config: TierConfig, candidates: List<Tier>): Tier? {
        val pinned = candidates.firstOrNull { it.id == config.selection.activeTierId }
        if (pinned == null) {
            publish(SelectionMode.PINNED, null, _state.value.failedUntilMs)
            return null
        }
        probe.probe(pinned)
        publish(SelectionMode.PINNED, pinned.id, _state.value.failedUntilMs)
        return pinned
    }

    private suspend fun selectAuto(
        config: TierConfig,
        candidates: List<Tier>,
        force: Boolean,
        skipTierId: String? = null,
    ): Tier? {
        val failed = _state.value.failedUntilMs.toMutableMap()
        if (!force) {
            val activeId = _state.value.activeTierId
            val active = candidates.firstOrNull { it.id == activeId }
            if (active != null && !isCoolingDown(active.id, failed)) {
                if (probe.probe(active) is ProbeResult.Healthy) {
                    publish(SelectionMode.AUTO_CHAIN, active.id, failed)
                    return active
                }
                failed[active.id] = clock() + failureCooldownMs
            }
        }

        for (tier in candidates) {
            if (tier.id == skipTierId) continue
            if (isCoolingDown(tier.id, failed)) continue
            if (probe.probe(tier) is ProbeResult.Healthy) {
                publish(SelectionMode.AUTO_CHAIN, tier.id, failed)
                return tier
            }
            failed[tier.id] = clock() + failureCooldownMs
        }

        publish(SelectionMode.AUTO_CHAIN, null, failed)
        return null
    }

    private fun isCoolingDown(tierId: String, failedUntil: Map<String, Long>): Boolean =
        (failedUntil[tierId] ?: 0L) > clock()

    private fun publish(mode: SelectionMode, activeTierId: String?, failedUntil: Map<String, Long>) {
        _state.value = TierSelectionState(
            activeTierId = activeTierId,
            mode = mode,
            lastProbeAtMs = clock(),
            failedUntilMs = failedUntil.toMap(),
        )
    }
}

object FailoverPolicy {
    @Suppress("UNUSED_PARAMETER")
    fun shouldFailoverOnHttpStatus(code: Int): Boolean = false

    fun isTransportFailure(t: Throwable): Boolean = when (t) {
        is CancellationException -> false
        is IOException -> true
        else -> false
    }
}
