package com.xehuri.kinship.transport

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.security.MessageDigest

enum class TierKind { NETWORK_ADDRESS, P2P }

enum class TransportHint { DIRECT, FRP, UNKNOWN }

enum class AddressFamily { AUTO, PREFER_V4, PREFER_V6 }

enum class SelectionMode { AUTO_CHAIN, PINNED }

data class Origin(val scheme: String, val host: String, val port: Int) {
    private val normalizedScheme: String = scheme.lowercase()
    private val normalizedHost: String = host.lowercase().removeSurrounding("[", "]")

    val authority: String =
        if (normalizedHost.contains(':')) "[$normalizedHost]:$port" else "$normalizedHost:$port"

    override fun toString(): String = "$normalizedScheme://$authority"
}

sealed interface TlsPolicy {
    data object System : TlsPolicy
    data class Pinned(val sha256LeafPins: List<String>) : TlsPolicy
    data object InsecureDev : TlsPolicy
}

data class HttpAddress(
    val scheme: String,
    val host: String,
    val port: Int,
    val pathPrefix: String = "/",
) {
    val origin: Origin get() = Origin(scheme, host, port)

    fun resolve(path: String): String {
        val suffix = when {
            path.isBlank() -> pathPrefix
            path.startsWith("/") -> pathPrefix.trimEnd('/') + path
            else -> pathPrefix.trimEnd('/') + "/" + path
        }
        return origin.toString() + suffix
    }

    companion object {
        private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://")

        fun parse(raw: String): Result<HttpAddress> {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return failure("url is blank")

            val scheme = SCHEME.find(trimmed)?.groupValues?.get(1)?.lowercase()
                ?: return failure("missing scheme")
            if (scheme != "http" && scheme != "https") {
                return failure("unsupported scheme: $scheme")
            }
            if (pathPart(trimmed).contains("..")) return failure("path must not contain ..")

            val url = trimmed.toHttpUrlOrNull() ?: return failure("invalid url")
            if (url.username.isNotEmpty() || url.password.isNotEmpty()) {
                return failure("userinfo is not allowed")
            }
            if (url.query != null) return failure("query is not allowed")
            if (url.fragment != null) return failure("fragment is not allowed")

            val host = url.host.removeSurrounding("[", "]").lowercase()
            if (url.scheme == "http" && !isLoopback(host)) {
                return failure("http is allowed only for loopback hosts")
            }

            return Result.success(
                HttpAddress(
                    scheme = url.scheme,
                    host = host,
                    port = url.port,
                    pathPrefix = normalizePrefix(url.encodedPath),
                )
            )
        }

        private fun failure(reason: String): Result<HttpAddress> =
            Result.failure(IllegalArgumentException(reason))

        private fun pathPart(raw: String): String {
            val afterScheme = raw.substringAfter("://", "")
            val slash = afterScheme.indexOf('/')
            if (slash < 0) return ""
            return afterScheme.substring(slash).substringBefore('?').substringBefore('#')
        }

        private fun isLoopback(host: String): Boolean {
            if (host == "localhost" || host == "::1") return true
            val parts = host.split('.')
            if (parts.size != 4 || parts[0] != "127") return false
            return parts.drop(1).all { octet ->
                octet.toIntOrNull()?.let { it in 0..255 } == true
            }
        }

        private fun normalizePrefix(encodedPath: String): String {
            val withLeading = if (encodedPath.startsWith("/")) encodedPath else "/$encodedPath"
            return if (withLeading.endsWith("/")) withLeading else "$withLeading/"
        }
    }
}

sealed interface TierTarget {
    data class Network(val address: HttpAddress) : TierTarget
    data class Peer(val peerId: String) : TierTarget
}

data class Tier(
    val id: String,
    val order: Int,
    val kind: TierKind,
    val transportHint: TransportHint,
    val target: TierTarget,
    val family: AddressFamily = AddressFamily.AUTO,
    val tls: TlsPolicy = TlsPolicy.System,
    val enabled: Boolean = true,
    val label: String,
)

data class TierSelection(
    val mode: SelectionMode = SelectionMode.AUTO_CHAIN,
    val activeTierId: String? = null,
)

data class TierConfig(
    val schemaVersion: Int = 1,
    val revision: Long = 0,
    val tiers: List<Tier> = emptyList(),
    val selection: TierSelection = TierSelection(),
)

fun originFingerprint(origin: Origin): String {
    val digest = MessageDigest.getInstance("SHA-256")
        .digest(origin.toString().toByteArray(Charsets.UTF_8))
    return buildString(digest.size * 2) {
        for (byte in digest) {
            val value = byte.toInt() and 0xff
            append(HEX_CHARS[value ushr 4])
            append(HEX_CHARS[value and 0x0f])
        }
    }
}

private const val HEX_CHARS = "0123456789abcdef"

private const val P2P_FALLBACK_LABEL = "P2P 对端（未接入）"
private const val PEER_FALLBACK_SUBTITLE = "未配置对端"

fun humanNetworkLabel(address: HttpAddress): String = address.origin.authority

fun tierFallbackLabel(target: TierTarget): String = when (target) {
    is TierTarget.Network -> humanNetworkLabel(target.address)
    is TierTarget.Peer -> P2P_FALLBACK_LABEL
}

fun Tier.displayLabel(): String {
    val configured = label.trim()
    return if (configured.isNotEmpty() && !configured.equals(id, ignoreCase = true)) {
        configured
    } else {
        tierFallbackLabel(target)
    }
}

fun Tier.displaySubtitle(): String = when (val target = target) {
    is TierTarget.Network -> target.address.origin.toString()
    is TierTarget.Peer -> target.peerId.trim().ifBlank { PEER_FALLBACK_SUBTITLE }
}

fun Tier.validate(): List<String> {
    val errors = mutableListOf<String>()
    if (id.isBlank()) errors += "tier id is blank"
    if (label.isBlank()) errors += "tier label is blank"
    if (order < 0) errors += "tier order must be >= 0"

    when (kind) {
        TierKind.NETWORK_ADDRESS -> if (target !is TierTarget.Network) {
            errors += "network tier requires a network target"
        }
        TierKind.P2P -> when (target) {
            is TierTarget.Peer -> if (target.peerId.isBlank()) errors += "peer id is blank"
            is TierTarget.Network -> errors += "p2p tier requires a peer target"
        }
    }

    if (tls is TlsPolicy.Pinned && tls.sha256LeafPins.isEmpty()) {
        errors += "pinned tls requires at least one pin"
    }
    return errors
}

fun TierConfig.validate(): List<String> {
    val errors = mutableListOf<String>()
    if (schemaVersion < 1) errors += "schemaVersion must be >= 1"

    val seenIds = mutableSetOf<String>()
    for (tier in tiers) {
        if (!seenIds.add(tier.id)) errors += "duplicate tier id: ${tier.id}"
    }

    val activeTierId = selection.activeTierId
    val activeTier = activeTierId?.let { id -> tiers.firstOrNull { it.id == id } }
    when (selection.mode) {
        SelectionMode.PINNED -> when {
            activeTierId == null -> errors += "pinned selection requires an active tier"
            activeTier == null ->
                errors += "selection references unknown tier: $activeTierId"
            !activeTier.enabled ->
                errors += "pinned selection requires an enabled tier: $activeTierId"
            activeTier.kind != TierKind.NETWORK_ADDRESS ->
                errors += "pinned selection requires a network address tier: $activeTierId"
        }
        SelectionMode.AUTO_CHAIN -> if (activeTierId != null && tiers.none { it.id == activeTierId }) {
            errors += "selection references unknown tier: $activeTierId"
        }
    }

    for (tier in tiers) {
        tier.validate().forEach { errors += "${tier.id}: $it" }
    }
    return errors
}

fun TierConfig.sortedTiers(): List<Tier> = tiers.sortedWith(compareBy({ it.order }, { it.id }))
