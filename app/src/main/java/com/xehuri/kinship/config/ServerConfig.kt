package com.xehuri.kinship.config

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一个可探测的服务器端点候选。
 *
 * [priority] 越小越优先。`ipv6` / `frp` 是后端的标准端点名，其他自定义名称同样支持。
 */
data class EndpointCandidate(
    val name: String,
    val url: String,
    val priority: Int = priorityFor(name)
) {
    companion object {
        const val NAME_IPV6 = "ipv6"
        const val NAME_FRP = "frp"

        /** 标准端点优先级：ipv6 优先，其次 frp，其余自定义端点最后。 */
        fun priorityFor(name: String): Int = when (name.trim().lowercase()) {
            NAME_IPV6 -> 0
            NAME_FRP -> 1
            else -> 2
        }
    }
}

/** 当前所选端点的类型（由端点名推导，未知名称视为自定义）。 */
enum class EndpointType {
    IPV6,
    FRP,
    CUSTOM;

    companion object {
        fun fromName(name: String): EndpointType = when (name.trim().lowercase()) {
            EndpointCandidate.NAME_IPV6 -> IPV6
            EndpointCandidate.NAME_FRP -> FRP
            else -> CUSTOM
        }
    }
}

/**
 * 传输模式。
 *
 * - [AUTO]：按候选优先级自动探测（ipv6 -> frp -> 其他），即旧行为。
 * - [FORCE_FRP]：只使用 frp 端点并跳过 WebRTC；用于 UDP 被封、IPv6 不可达的 Wi-Fi。
 */
enum class TransportMode {
    AUTO,
    FORCE_FRP;

    companion object {
        /** 解析持久化值；未知值（含空值）回退 [AUTO]，避免旧配置崩溃。 */
        fun fromStored(raw: String?): TransportMode =
            values().firstOrNull { it.name.equals(raw?.trim(), ignoreCase = true) } ?: AUTO
    }
}

object ServerConfig {
    private const val PREFS_NAME = "axeuh_prefs"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_ENDPOINT_CANDIDATES = "endpoint_candidates"
    private const val KEY_TRANSPORT_MODE = "transport_mode"
    private const val KEY_TIER_CONFIG = "network_config_v1"
    /** 默认服务器地址；端口 8768 同时承载 HTTP 与 HTTPS，由 ssl.enabled 决定协议。 */
    private const val DEFAULT_SERVER_URL = "http://localhost:8768"

    /** 未设置候选列表时的当前服务器地址（向后兼容旧版行为）。 */
    var BASE_URL: String = DEFAULT_SERVER_URL
        private set

    /** 持久化的端点候选（原始顺序；按优先级选路时使用 [orderedEndpointCandidates]）。 */
    var endpointCandidates: List<EndpointCandidate> = emptyList()
        private set

    /** 按优先级稳定排序后的候选列表（ipv6 -> frp -> 其他）。 */
    val orderedEndpointCandidates: List<EndpointCandidate>
        get() = endpointCandidates.sortedBy { it.priority }

    /** 当前传输模式；默认 [TransportMode.AUTO]，由 [setTransportMode] 持久化。 */
    var transportMode: TransportMode = TransportMode.AUTO
        private set

    @Volatile
    private var prefs: SharedPreferences? = null

    @Volatile
    private var activeEndpointTypeOverride: EndpointType? = null

    @Volatile
    private var activePreferIpv4Override: Boolean? = null

    /** 未设置自定义名时恒为系统原始设备名（Build.MODEL 为静态字段，object 初始化即可安全读取） */
    var DEVICE_NAME: String = Build.MODEL ?: ""
        private set
    var HAS_CUSTOM_DEVICE_NAME: Boolean = false
        private set

    /**
     * 上传数据时使用的设备名（恒有值，恒随 payload 上报）：
     * - 用户设置过自定义名 → 自定义名；
     * - 未设置 → 系统原始设备名（Build.MODEL）。
     */
    val effectiveDeviceName: String
        get() = DEVICE_NAME

    fun init(context: Context) {
        val p = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs = p
        BASE_URL = p.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        endpointCandidates = parseEndpointCandidates(p.getString(KEY_ENDPOINT_CANDIDATES, null))
        transportMode = TransportMode.fromStored(p.getString(KEY_TRANSPORT_MODE, null))
        val saved = p.getString("device_name", null)
        if (saved != null) {
            DEVICE_NAME = saved
            HAS_CUSTOM_DEVICE_NAME = true
        } else {
            DEVICE_NAME = Build.MODEL ?: ""
            HAS_CUSTOM_DEVICE_NAME = false
        }
    }

    /** 仅更新内存中的当前地址（旧调用点保留）。持久化请使用 [selectBaseUrl]。 */
    fun update(url: String) {
        BASE_URL = url
    }

    /**
     * 选择当前服务器地址；`network_config_v1` 存在时只改内存，不再写 `server_url`。
     *
     * 探测器选中端点后调用；设置页保存地址后也可调用（与旧 `update` 行为兼容）。
     */
    fun selectBaseUrl(url: String) {
        val normalized = url.trim()
        if (normalized.isEmpty()) return
        BASE_URL = normalized
        if (legacyWritesAllowed()) {
            prefs?.edit()?.putString(KEY_SERVER_URL, normalized)?.apply()
        }
    }

    /**
     * 覆盖端点候选；`network_config_v1` 存在时只改内存，不再写 `endpoint_candidates`。
     *
     * 不改动当前 `BASE_URL`：没有候选时旧行为完全不变；有候选时由 tier 选择器
     * 探测后应用（不写旧 `server_url`）。
     */
    fun updateEndpointCandidates(candidates: List<EndpointCandidate>) {
        val cleaned = candidates
            .mapNotNull { candidate ->
                val name = candidate.name.trim()
                val url = candidate.url.trim()
                if (url.isEmpty()) null
                else EndpointCandidate(
                    name = name.ifEmpty { url },
                    url = url,
                    priority = candidate.priority
                )
            }
            .distinctBy { it.url }
        endpointCandidates = cleaned
        if (legacyWritesAllowed()) {
            prefs?.edit()
                ?.putString(KEY_ENDPOINT_CANDIDATES, encodeEndpointCandidates(cleaned))
                ?.apply()
        }
    }

    /** 当前 [BASE_URL] 对应的候选；未命中（含无候选）返回 null。 */
    fun selectedEndpointCandidate(): EndpointCandidate? {
        val current = BASE_URL.trimEnd('/')
        return endpointCandidates.firstOrNull { it.url.trimEnd('/') == current }
    }

    /** 当前端点类型；无候选或未命中时为 null。 */
    val selectedEndpointType: EndpointType?
        get() = activeEndpointTypeOverride ?: selectedEndpointCandidate()?.let {
            EndpointType.fromName(it.name)
        }

    /**
     * 音频 WS 是否应优先 IPv4。
     *
     * - `ipv6` 端点：false（使用系统 DNS 顺序 / IPv6 优先）
     * - `frp` 端点：true
     * - 自定义端点：按 URL 是否为 IPv6 字面量判断
     * - 无候选（旧行为）：IPv6 字面量除外，默认仍 IPv4 优先，避免双栈域名建连卡 15s
     */
    val selectedEndpointPreferIpv4: Boolean
        get() = activePreferIpv4Override ?: legacySelectedEndpointPreferIpv4

    private val legacySelectedEndpointPreferIpv4: Boolean
        get() = when (selectedEndpointType) {
            EndpointType.IPV6 -> false
            EndpointType.FRP -> true
            EndpointType.CUSTOM -> !hasIpv6LiteralHost(BASE_URL)
            null -> !hasIpv6LiteralHost(BASE_URL)
        }

    fun updateDeviceName(name: String) {
        DEVICE_NAME = name
        HAS_CUSTOM_DEVICE_NAME = true
    }

    /** 设置传输模式；`network_config_v1` 存在时只改内存，不再写 `transport_mode`。 */
    fun setTransportMode(mode: TransportMode) {
        transportMode = mode
        if (legacyWritesAllowed()) {
            prefs?.edit()?.putString(KEY_TRANSPORT_MODE, mode.name)?.apply()
        }
    }

    fun applyActiveTierProfile(type: EndpointType?, preferIpv4: Boolean?) {
        activeEndpointTypeOverride = type
        activePreferIpv4Override = preferIpv4
    }

    fun resetActiveTierProfile() {
        activeEndpointTypeOverride = null
        activePreferIpv4Override = null
    }

    private fun legacyWritesAllowed(): Boolean = prefs?.contains(KEY_TIER_CONFIG) != true

    // ==================== 序列化 ====================

    internal fun encodeEndpointCandidates(candidates: List<EndpointCandidate>): String {
        val array = JSONArray()
        candidates.forEach { candidate ->
            array.put(
                JSONObject().apply {
                    put("name", candidate.name)
                    put("url", candidate.url)
                    put("priority", candidate.priority)
                }
            )
        }
        return array.toString()
    }

    internal fun parseEndpointCandidates(raw: String?): List<EndpointCandidate> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            val trimmed = raw.trim()
            val array = if (trimmed.startsWith("{")) {
                JSONObject(trimmed).optJSONArray("candidates") ?: JSONArray()
            } else {
                JSONArray(trimmed)
            }
            buildList {
                for (i in 0 until array.length()) {
                    when (val item = array.opt(i)) {
                        is JSONObject -> {
                            val url = item.optString("url", "").trim()
                            if (url.isEmpty()) continue
                            val name = item.optString("name", "").trim().ifEmpty { url }
                            add(
                                EndpointCandidate(
                                    name = name,
                                    url = url,
                                    priority = item.optInt("priority", EndpointCandidate.priorityFor(name))
                                )
                            )
                        }
                        is String -> {
                            val url = item.trim()
                            if (url.isEmpty()) continue
                            add(EndpointCandidate(url, url))
                        }
                    }
                }
            }.distinctBy { it.url }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** URL 主机是否为 IPv6 字面量（带方括号）；不触发 DNS 解析。 */
    internal fun hasIpv6LiteralHost(url: String): Boolean {
        val authority = url.trim()
            .substringAfter("://", "")
            .substringBefore('/')
            .substringAfterLast('@')
        return authority.startsWith("[")
    }
}
