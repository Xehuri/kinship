package com.xehuri.kinship.transport

import android.content.Context
import android.content.SharedPreferences
import androidx.annotation.VisibleForTesting
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID

data class MigrationResult(
    val migrated: Boolean,
    val config: TierConfig,
    val warnings: List<String>,
)

/**
 * SharedPreferences-backed store for the tier configuration.
 *
 * Reads never throw; corrupt or newer-schema payloads make the store read-only
 * so a later save cannot clobber data this build does not understand. Legacy
 * keys (server_url / endpoint_candidates / transport_mode) are only read and
 * are never deleted or rewritten.
 */
class TierStore(private val prefs: SharedPreferences) {
    private val _state = MutableStateFlow(TierConfig())
    val state: StateFlow<TierConfig> = _state.asStateFlow()
    private var raw: String?
    private var readOnlyFlag: Boolean

    val readOnly: Boolean get() = readOnlyFlag

    private data class Stored(val raw: String?, val decoded: DecodedTierConfig)

    init {
        val stored = readStored()
        raw = stored.raw
        readOnlyFlag = stored.decoded.readOnly
        _state.value = stored.decoded.config
    }

    @Synchronized
    fun load(): TierConfig {
        val stored = readStored()
        raw = stored.raw
        readOnlyFlag = stored.decoded.readOnly
        _state.value = stored.decoded.config
        return stored.decoded.config
    }

    @Synchronized
    fun save(config: TierConfig) {
        if (readOnlyFlag) throw IllegalArgumentException("tier config is read-only")
        val errors = config.validate()
        if (errors.isNotEmpty()) throw IllegalArgumentException(errors.joinToString("; "))
        val next = config.copy(revision = config.revision + 1)
        val encoded = TierCodec.encode(next, raw)
        prefs.edit().putString(KEY_CONFIG, encoded).apply()
        raw = encoded
        _state.value = next
    }

    @Synchronized
    fun update(transform: (TierConfig) -> TierConfig) {
        save(transform(state.value))
    }

    /**
     * 只合并 selection 的写入：先在同步块内重读 prefs 的最新配置，再在其上应用 selection
     * 变换，绝不覆盖其他实例写入的连接层列表。只读、校验失败时抛 [IllegalArgumentException]。
     */
    @Synchronized
    fun updateSelection(transform: (TierSelection) -> TierSelection): TierConfig {
        val stored = readStored()
        raw = stored.raw
        readOnlyFlag = stored.decoded.readOnly
        _state.value = stored.decoded.config
        if (readOnlyFlag) throw IllegalArgumentException("tier config is read-only")
        val current = stored.decoded.config
        val next = current.copy(
            revision = current.revision + 1,
            selection = transform(current.selection),
        )
        val errors = next.validate()
        if (errors.isNotEmpty()) throw IllegalArgumentException(errors.joinToString("; "))
        val encoded = TierCodec.encode(next, raw)
        prefs.edit().putString(KEY_CONFIG, encoded).apply()
        raw = encoded
        _state.value = next
        return next
    }

    @Synchronized
    fun migrateIfNeeded(): MigrationResult = migrateIfNeeded { it.validate() }

    @VisibleForTesting
    @Synchronized
    internal fun migrateIfNeeded(validator: (TierConfig) -> List<String>): MigrationResult {
        if (prefs.contains(KEY_CONFIG)) {
            val stored = readStored()
            raw = stored.raw
            readOnlyFlag = stored.decoded.readOnly
            _state.value = stored.decoded.config
            return MigrationResult(false, stored.decoded.config, stored.decoded.warnings)
        }
        val warnings = mutableListOf<String>()
        val config = buildLegacyConfig(warnings)
        val errors = validator(config)
        if (errors.isNotEmpty()) {
            errors.forEach { warnings += "migration produced invalid config: $it" }
            raw = prefs.getString(KEY_CONFIG, null)
            readOnlyFlag = false
            _state.value = config
            return MigrationResult(false, config, warnings)
        }
        val encoded = TierCodec.encode(config)
        prefs.edit().putString(KEY_CONFIG, encoded).apply()
        raw = encoded
        readOnlyFlag = false
        _state.value = config
        return MigrationResult(true, config, warnings)
    }

    fun close() {
        // No listeners are registered; kept for lifecycle symmetry.
    }

    private fun readStored(): Stored {
        val present = prefs.contains(KEY_CONFIG)
        val value = try {
            prefs.getString(KEY_CONFIG, null)
        } catch (_: ClassCastException) {
            null
        }
        val decoded = if (present && value == null) {
            DecodedTierConfig(TierConfig(), true, listOf("stored config is unreadable"))
        } else {
            TierCodec.decode(value)
        }
        return Stored(value, decoded)
    }

    private data class LegacyCandidate(val name: String, val url: String, val priority: Int)

    private fun buildLegacyConfig(warnings: MutableList<String>): TierConfig {
        val tiers = mutableListOf<Tier>()
        val tierUrls = mutableListOf<Pair<String, String>>()
        val usedLabels = mutableSetOf<String>()
        readCandidates(warnings).forEachIndexed { index, candidate ->
            val address = HttpAddress.parse(candidate.url).getOrElse { error ->
                warnings += "endpoint candidate ${candidate.name.ifBlank { candidate.url }}: ${error.message ?: "invalid url"}"
                return@forEachIndexed
            }
            val id = UUID.randomUUID().toString()
            tiers += Tier(
                id = id,
                order = index,
                kind = TierKind.NETWORK_ADDRESS,
                transportHint = hintFor(candidate.name),
                target = TierTarget.Network(address),
                family = familyFor(candidate.name),
                tls = TlsPolicy.System,
                enabled = true,
                label = uniqueLabel(candidate.name.ifBlank { humanNetworkLabel(address) }, usedLabels),
            )
            tierUrls += id to candidate.url
        }

        val serverUrl = prefs.getString(KEY_SERVER_URL, null)?.trim().orEmpty()
        var activeTierId: String? = null
        if (serverUrl.isNotEmpty()) {
            val normalized = serverUrl.trimEnd('/')
            val match = tierUrls.firstOrNull { it.second.trimEnd('/') == normalized }
            activeTierId = if (match != null) {
                match.first
            } else {
                val address = HttpAddress.parse(serverUrl).getOrNull()
                if (address == null) {
                    warnings += "server_url is invalid: $serverUrl"
                    null
                } else {
                    val id = UUID.randomUUID().toString()
                    for (i in tiers.indices) tiers[i] = tiers[i].copy(order = tiers[i].order + 1)
                    tiers.add(
                        0,
                        Tier(
                            id = id,
                            order = 0,
                            kind = TierKind.NETWORK_ADDRESS,
                            transportHint = TransportHint.UNKNOWN,
                            target = TierTarget.Network(address),
                            family = AddressFamily.AUTO,
                            tls = TlsPolicy.System,
                            enabled = true,
                            label = uniqueLabel("当前服务器", usedLabels),
                        ),
                    )
                    id
                }
            }
        }

        val mode = prefs.getString(KEY_TRANSPORT_MODE, null)?.trim()
        val selection = if (mode.equals("FORCE_FRP", ignoreCase = true)) {
            val frp = tiers.firstOrNull { it.enabled && it.transportHint == TransportHint.FRP }
            if (frp == null) {
                warnings += "FORCE_FRP has no FRP tier"
                TierSelection(SelectionMode.AUTO_CHAIN, activeTierId)
            } else {
                TierSelection(SelectionMode.PINNED, frp.id)
            }
        } else {
            TierSelection(SelectionMode.AUTO_CHAIN, activeTierId)
        }
        return TierConfig(schemaVersion = 1, revision = 0, tiers = tiers, selection = selection)
    }

    private fun uniqueLabel(base: String, used: MutableSet<String>): String {
        if (used.add(base.lowercase(Locale.ROOT))) return base
        var suffix = 2
        while (true) {
            val candidate = "$base（$suffix）"
            if (used.add(candidate.lowercase(Locale.ROOT))) return candidate
            suffix++
        }
    }

    private fun readCandidates(warnings: MutableList<String>): List<LegacyCandidate> {
        val content = try {
            prefs.getString(KEY_ENDPOINT_CANDIDATES, null)
        } catch (_: ClassCastException) {
            null
        }
        if (content.isNullOrBlank()) return emptyList()
        val array = try {
            val trimmed = content.trim()
            if (trimmed.startsWith("{")) {
                JSONObject(trimmed).optJSONArray("candidates")
            } else {
                JSONArray(trimmed)
            }
        } catch (error: Exception) {
            warnings += "endpoint_candidates is invalid: ${error.message ?: "parse failure"}"
            null
        }
        if (array == null) {
            warnings += "endpoint_candidates has no candidates array"
            return emptyList()
        }
        val parsed = mutableListOf<LegacyCandidate>()
        for (index in 0 until array.length()) {
            when (val item = array.opt(index)) {
                is JSONObject -> {
                    val url = (item.opt("url") as? String)?.trim().orEmpty()
                    if (url.isEmpty()) {
                        warnings += "endpoint candidate $index: missing url"
                        continue
                    }
                    val name = (item.opt("name") as? String)?.trim().orEmpty()
                    val priority = (item.opt("priority") as? Number)?.toInt() ?: defaultPriority(name)
                    parsed += LegacyCandidate(name, url, priority)
                }
                is String -> {
                    val url = item.trim()
                    if (url.isNotEmpty()) parsed += LegacyCandidate(url, url, defaultPriority(url))
                }
                else -> warnings += "endpoint candidate $index is not an object"
            }
        }
        return parsed.withIndex()
            .sortedWith(compareBy({ it.value.priority }, { it.index }))
            .map { it.value }
            .distinctBy { it.url }
    }

    private fun defaultPriority(name: String): Int = when (name.trim().lowercase(Locale.ROOT)) {
        "ipv6" -> 0
        "frp" -> 1
        else -> 2
    }

    private fun hintFor(name: String): TransportHint = when (name.trim().lowercase(Locale.ROOT)) {
        "ipv6" -> TransportHint.DIRECT
        "frp" -> TransportHint.FRP
        else -> TransportHint.UNKNOWN
    }

    private fun familyFor(name: String): AddressFamily = when (name.trim().lowercase(Locale.ROOT)) {
        "ipv6" -> AddressFamily.PREFER_V6
        "frp" -> AddressFamily.PREFER_V4
        else -> AddressFamily.AUTO
    }

    companion object {
        const val PREFS_NAME = "axeuh_prefs"
        const val KEY_CONFIG = "network_config_v1"
        const val KEY_SERVER_URL = "server_url"
        const val KEY_ENDPOINT_CANDIDATES = "endpoint_candidates"
        const val KEY_TRANSPORT_MODE = "transport_mode"

        @Volatile
        private var sharedInstance: TierStore? = null
        private val sharedLock = Any()

        fun shared(context: Context): TierStore {
            sharedInstance?.let { return it }
            return synchronized(sharedLock) {
                sharedInstance ?: TierStore(
                    context.applicationContext.getSharedPreferences(
                        PREFS_NAME,
                        Context.MODE_PRIVATE,
                    )
                ).also { sharedInstance = it }
            }
        }

        @VisibleForTesting
        fun resetSharedForTest() {
            synchronized(sharedLock) { sharedInstance = null }
        }
    }
}
