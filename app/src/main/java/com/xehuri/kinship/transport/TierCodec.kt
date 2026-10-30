package com.xehuri.kinship.transport

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

data class DecodedTierConfig(
    val config: TierConfig,
    val readOnly: Boolean,
    val warnings: List<String>,
)

object TierCodec {
    private val ROOT_KEYS = setOf("schemaVersion", "revision", "selection", "tiers")
    private val SELECTION_KEYS = setOf("mode", "activeTierId")
    private val TIER_KEYS = setOf(
        "id", "order", "kind", "transportHint", "enabled", "label",
        "family", "address", "tls", "peer",
    )

    fun decode(raw: String?): DecodedTierConfig {
        if (raw.isNullOrBlank()) {
            return DecodedTierConfig(TierConfig(), false, listOf("no config"))
        }
        val root = runCatching { JSONObject(raw) }.getOrElse { return corrupt(it) }
        return runCatching { decodeRoot(root) }.getOrElse { corrupt(it) }
    }

    fun encode(config: TierConfig, rawForPreservation: String? = null): String {
        val rawRoot = rawForPreservation?.let { runCatching { JSONObject(it) }.getOrNull() }
        val root = JSONObject()
        root.put("schemaVersion", config.schemaVersion)
        root.put("revision", config.revision)
        root.put("selection", encodeSelection(config.selection, rawRoot?.optJSONObject("selection")))
        root.put("tiers", encodeTiers(config, rawRoot?.optJSONArray("tiers")))
        rawRoot?.let { copyUnknown(it, root, ROOT_KEYS) }
        return root.toString()
    }

    private fun decodeRoot(root: JSONObject): DecodedTierConfig {
        val warnings = mutableListOf<String>()
        var readOnly = false
        val version = readVersion(root, warnings)
        if (version > 1) {
            readOnly = true
            warnings += "unsupported schemaVersion $version"
        } else if (version < 1) warnings += "invalid schemaVersion $version; treated as 1"
        val revision = if (root.has("revision") && !root.isNull("revision")) root.optLong("revision", 0L) else 0L
        val config = TierConfig(1, revision, decodeTiers(root, warnings), decodeSelection(root, warnings))
        return DecodedTierConfig(config, readOnly, warnings)
    }

    private fun readVersion(root: JSONObject, warnings: MutableList<String>): Int {
        if (!root.has("schemaVersion") || root.isNull("schemaVersion")) return 1
        val value = root.opt("schemaVersion")
        if (value is Number) return value.toInt()
        warnings += "invalid schemaVersion; treated as 1"
        return 1
    }

    private fun decodeSelection(root: JSONObject, warnings: MutableList<String>): TierSelection {
        if (!root.has("selection") || root.isNull("selection")) return TierSelection()
        val obj = root.optJSONObject("selection")
        if (obj == null) {
            warnings += "selection is not an object"
            return TierSelection()
        }
        val rawMode = obj.opt("mode") as? String
        val mode = when {
            rawMode == null -> SelectionMode.AUTO_CHAIN
            rawMode.equals("AUTO_CHAIN", ignoreCase = true) -> SelectionMode.AUTO_CHAIN
            rawMode.equals("PINNED", ignoreCase = true) -> SelectionMode.PINNED
            else -> {
                warnings += "unknown selection mode $rawMode"
                SelectionMode.AUTO_CHAIN
            }
        }
        val active = (obj.opt("activeTierId") as? String)?.takeIf { it.isNotBlank() }
        return TierSelection(mode, active)
    }

    private fun decodeTiers(root: JSONObject, warnings: MutableList<String>): List<Tier> {
        if (!root.has("tiers") || root.isNull("tiers")) return emptyList()
        val array = root.optJSONArray("tiers") ?: run {
            warnings += "tiers is not an array"
            return emptyList()
        }
        val tiers = mutableListOf<Tier>()
        for (index in 0 until array.length()) {
            val obj = array.optJSONObject(index)
            if (obj == null) {
                warnings += "tier $index: not an object"
                continue
            }
            val tier = runCatching { decodeTier(obj, index, warnings) }.getOrElse {
                warnings += "tier $index: ${reason(it)}"
                null
            }
            if (tier != null) tiers += tier
        }
        return tiers
    }

    private fun decodeTier(obj: JSONObject, index: Int, warnings: MutableList<String>): Tier? {
        val id = (obj.opt("id") as? String)?.trim()
        if (id.isNullOrEmpty()) { warnings += "tier $index: missing id"; return null }
        val kind = when ((obj.opt("kind") as? String)?.uppercase(Locale.ROOT)) {
            "NETWORK_ADDRESS" -> TierKind.NETWORK_ADDRESS
            "P2P" -> TierKind.P2P
            else -> { warnings += "tier $id: unknown kind ${obj.opt("kind") ?: "missing"}"; return null }
        }
        val target = when (kind) {
            TierKind.NETWORK_ADDRESS -> {
                val address = decodeAddress(obj.optJSONObject("address"))
                if (address == null) { warnings += "tier $id: invalid address"; return null }
                TierTarget.Network(address)
            }
            TierKind.P2P -> {
                val peerId = (obj.optJSONObject("peer")?.opt("peerId") as? String)?.trim()
                if (peerId.isNullOrEmpty()) { warnings += "tier $id: invalid peer"; return null }
                TierTarget.Peer(peerId)
            }
        }
        return Tier(
            id = id,
            order = obj.optInt("order", index),
            kind = kind,
            transportHint = parseEnum(obj.opt("transportHint"), TransportHint.UNKNOWN, "transportHint", id, warnings),
            target = target,
            family = parseEnum(obj.opt("family"), AddressFamily.AUTO, "family", id, warnings),
            tls = decodeTls(obj.optJSONObject("tls"), id, warnings),
            enabled = if (obj.has("enabled")) obj.optBoolean("enabled", true) else true,
            label = decodeLabel(obj.opt("label") as? String, id, target),
        )
    }

    private fun decodeLabel(rawLabel: String?, id: String, target: TierTarget): String {
        if (rawLabel == null || rawLabel.isBlank()) return tierFallbackLabel(target)
        if (rawLabel.trim().equals(id, ignoreCase = true)) return tierFallbackLabel(target)
        return rawLabel
    }

    private fun decodeAddress(obj: JSONObject?): HttpAddress? {
        if (obj == null) return null
        val scheme = (obj.opt("scheme") as? String)?.trim()?.lowercase(Locale.ROOT).orEmpty()
        val host = (obj.opt("host") as? String)?.trim()?.removeSurrounding("[", "]")?.lowercase(Locale.ROOT).orEmpty()
        val port = obj.optInt("port", 0)
        if (scheme != "http" && scheme != "https") return null
        if (host.isEmpty() || port !in 1..65535) return null
        val path = (obj.opt("pathPrefix") as? String).orEmpty().ifBlank { "/" }
        return HttpAddress(scheme, host, port, normalizePath(path))
    }

    private fun normalizePath(raw: String): String {
        val leading = if (raw.startsWith("/")) raw else "/$raw"
        return if (leading.endsWith("/")) leading else "$leading/"
    }

    private fun decodeTls(obj: JSONObject?, id: String, warnings: MutableList<String>): TlsPolicy {
        if (obj == null) return TlsPolicy.System
        val rawMode = obj.opt("mode") as? String ?: return TlsPolicy.System
        return when (rawMode.uppercase(Locale.ROOT)) {
            "SYSTEM" -> TlsPolicy.System
            "PINNED" -> TlsPolicy.Pinned(readPins(obj))
            "INSECURE_DEV" -> TlsPolicy.InsecureDev
            else -> { warnings += "tier $id: unknown tls mode $rawMode"; TlsPolicy.System }
        }
    }

    private fun readPins(obj: JSONObject): List<String> {
        val array = obj.optJSONArray("pins") ?: return emptyList()
        return (0 until array.length()).mapNotNull { array.opt(it) as? String }
    }

    private inline fun <reified T : Enum<T>> parseEnum(
        raw: Any?,
        fallback: T,
        field: String,
        id: String,
        warnings: MutableList<String>,
    ): T {
        if (raw !is String) return fallback
        return enumValues<T>().firstOrNull { it.name.equals(raw, ignoreCase = true) }
            ?: fallback.also { warnings += "tier $id: unknown $field $raw" }
    }

    private fun encodeSelection(selection: TierSelection, raw: JSONObject?): JSONObject {
        val obj = JSONObject()
        obj.put("mode", selection.mode.name)
        obj.put("activeTierId", selection.activeTierId ?: JSONObject.NULL)
        raw?.let { copyUnknown(it, obj, SELECTION_KEYS) }
        return obj
    }

    private fun encodeTiers(config: TierConfig, rawTiers: JSONArray?): JSONArray {
        val configIds = config.tiers.mapTo(mutableSetOf()) { it.id }
        val rawById = mutableMapOf<String, JSONObject>()
        val rawUnknown = mutableListOf<JSONObject>()
        if (rawTiers != null) {
            for (index in 0 until rawTiers.length()) {
                val obj = rawTiers.optJSONObject(index) ?: continue
                val id = (obj.opt("id") as? String)?.takeIf { it.isNotBlank() }
                if (id != null && !rawById.containsKey(id)) rawById[id] = obj
                val kind = (obj.opt("kind") as? String)?.uppercase(Locale.ROOT)
                val knownKind = kind == "NETWORK_ADDRESS" || kind == "P2P"
                if (!knownKind && (id == null || id !in configIds)) rawUnknown += obj
            }
        }
        val result = JSONArray()
        config.sortedTiers().forEach { tier -> result.put(encodeTier(tier, rawById[tier.id])) }
        rawUnknown.forEach { result.put(it) }
        return result
    }

    private fun encodeTier(tier: Tier, raw: JSONObject?): JSONObject {
        val obj = JSONObject()
        obj.put("id", tier.id)
        obj.put("order", tier.order)
        obj.put("kind", tier.kind.name)
        obj.put("transportHint", tier.transportHint.name)
        obj.put("enabled", tier.enabled)
        obj.put("label", tier.label)
        obj.put("family", tier.family.name)
        when (val target = tier.target) {
            is TierTarget.Network -> obj.put("address", encodeAddress(target.address))
            is TierTarget.Peer -> obj.put("peer", JSONObject().put("peerId", target.peerId))
        }
        obj.put("tls", encodeTls(tier.tls))
        raw?.let { copyUnknown(it, obj, TIER_KEYS) }
        return obj
    }

    private fun encodeAddress(address: HttpAddress): JSONObject = JSONObject()
        .put("scheme", address.scheme)
        .put("host", address.host)
        .put("port", address.port)
        .put("pathPrefix", address.pathPrefix)

    private fun encodeTls(tls: TlsPolicy): JSONObject {
        val mode = when (tls) {
            TlsPolicy.System -> "SYSTEM"
            TlsPolicy.InsecureDev -> "INSECURE_DEV"
            is TlsPolicy.Pinned -> "PINNED"
        }
        val pins = JSONArray()
        if (tls is TlsPolicy.Pinned) tls.sha256LeafPins.forEach { pins.put(it) }
        return JSONObject().put("mode", mode).put("pins", pins)
    }

    private fun copyUnknown(from: JSONObject, to: JSONObject, known: Set<String>) {
        for (key in from.keys()) {
            if (key !in known && !to.has(key)) to.put(key, from.opt(key))
        }
    }

    private fun corrupt(error: Throwable) = DecodedTierConfig(
        TierConfig(), true, listOf("invalid config JSON: ${reason(error)}")
    )

    private fun reason(error: Throwable): String = error.message ?: error.javaClass.simpleName
}
