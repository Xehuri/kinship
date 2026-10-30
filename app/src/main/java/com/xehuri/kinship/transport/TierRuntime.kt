package com.xehuri.kinship.transport

import com.xehuri.kinship.config.EndpointType
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.network.AppHttpClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import timber.log.Timber

class TierRuntime(
    private val store: TierStore,
    private val selector: TierSelector,
    private val scope: CoroutineScope,
    private val applyUrl: (String) -> Unit = { ServerConfig.update(it) },
    private val applyProfile: (EndpointType?, Boolean?) -> Unit = { t, p ->
        ServerConfig.applyActiveTierProfile(t, p)
    },
    private val persistActive: (String) -> Unit = { id ->
        store.updateSelection { selection -> selection.copy(activeTierId = id) }
    },
) {
    private val transportFailureHandler: (String) -> Unit = { origin ->
        notifyTransportFailure(origin)
    }

    @Volatile
    private var closed = false

    private val mutex = Mutex()

    val state: StateFlow<TierSelectionState>
        get() = selector.state

    init {
        AppHttpClient.onTransportFailure = transportFailureHandler
    }

    suspend fun bootstrap(): Tier? = mutex.withLock {
        store.migrateIfNeeded()
        val winner = selector.selectOnStartup(force = false)
        apply(winner)
        winner
    }

    suspend fun refresh(force: Boolean): Tier? = mutex.withLock {
        store.load()
        val winner = if (force) selector.manualReprobe() else selector.selectOnStartup(force = false)
        apply(winner)
        winner
    }

    fun notifyTransportFailure(origin: String) {
        if (closed) return
        scope.launch {
            mutex.withLock {
                if (closed) return@withLock
                store.load()
                val tier = store.state.value.tiers.firstOrNull { candidate ->
                    val candidateOrigin = originOf(candidate) ?: return@firstOrNull false
                    sameOrigin(candidateOrigin, origin)
                } ?: return@withLock
                val winner = selector.onTransportFailure(tier.id)
                apply(winner)
            }
        }
    }

    fun close() {
        closed = true
        if (AppHttpClient.onTransportFailure === transportFailureHandler) {
            AppHttpClient.onTransportFailure = null
        }
        TierRuntimeHolder.clear(this)
    }

    private fun apply(tier: Tier?) {
        if (tier == null) return
        val address = (tier.target as? TierTarget.Network)?.address ?: return
        applyUrl(address.origin.toString())

        val type = when {
            tier.transportHint == TransportHint.FRP -> EndpointType.FRP
            tier.transportHint == TransportHint.DIRECT && tier.family == AddressFamily.PREFER_V6 ->
                EndpointType.IPV6
            else -> EndpointType.CUSTOM
        }
        val preferIpv4 = when (tier.family) {
            AddressFamily.PREFER_V4 -> true
            AddressFamily.PREFER_V6 -> false
            AddressFamily.AUTO -> null
        }
        applyProfile(type, preferIpv4)
        if (store.load().tiers.none { it.id == tier.id }) {
            Timber.w("active tier %s was deleted before persistence", tier.id)
            return
        }
        runCatching { persistActive(tier.id) }.onFailure { error ->
            Timber.w(error, "failed to persist active tier %s; reloading config", tier.id)
            store.load()
        }
    }

    private fun originOf(tier: Tier): String? =
        (tier.target as? TierTarget.Network)?.address?.origin?.toString()

    private fun sameOrigin(left: String, right: String): Boolean =
        normalizeOrigin(left) == normalizeOrigin(right)

    private fun normalizeOrigin(raw: String): String {
        val trimmed = raw.trim().lowercase()
        val scheme = if ("://" in trimmed) trimmed.substringBefore("://") else ""
        val authority = trimmed.substringAfter("://", trimmed).substringBefore('/')
        return "$scheme://${authority.replace("[", "").replace("]", "")}"
    }
}

object TierRuntimeHolder {
    @Volatile
    private var runtime: TierRuntime? = null

    fun install(runtime: TierRuntime) {
        this.runtime = runtime
    }

    fun get(): TierRuntime? = runtime

    fun clear(runtime: TierRuntime) {
        if (this.runtime === runtime) this.runtime = null
    }
}
