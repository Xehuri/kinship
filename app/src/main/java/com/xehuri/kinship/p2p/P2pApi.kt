package com.xehuri.kinship.p2p

import com.xehuri.kinship.config.EndpointCandidate
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.network.AppHttpClient
import org.json.JSONObject

/** `GET /api/p2p/status` 的响应。 */
data class P2pStatus(
    val enabled: Boolean,
    val signalConnected: Boolean,
    val room: String,
    val endpoints: Map<String, String>,
    val deviceCount: Int,
    val serverId: String,
    val signalUrl: String? = null,
    val webrtcEnabled: Boolean = false
) {
    /** 后端端点字典转为按优先级排序的候选列表（ipv6 -> frp -> 其他）。 */
    fun endpointCandidates(): List<EndpointCandidate> = endpoints
        .map { (name, url) -> EndpointCandidate(name, url) }
        .sortedBy { it.priority }
}

/** `POST /api/p2p/signal-ticket` 的响应。 */
data class SignalTicket(
    val ticket: String,
    val expiresAtMs: Long
)

/** `POST /api/p2p/enroll` 的响应（Phase 1 仅保留骨架，不在 UI 中使用）。 */
data class P2pEnrollment(
    val deviceId: String,
    val userId: String,
    val deviceToken: String,
    val signalUrl: String,
    val room: String,
    val endpoints: Map<String, String>,
    val signalTicket: String,
    val signalTicketExpiresAtMs: Long
)

/**
 * P2P REST API 最小客户端。
 *
 * 认证复用 [AppHttpClient] 的 Bearer token；`X-Device-Id` 由 [AppHttpClient] 自动注入，
 * 后端对用户 token 的信令票据签发依赖该头。
 */
class P2pApi(
    private val httpClient: AppHttpClient,
    private val baseUrlProvider: () -> String = { ServerConfig.BASE_URL }
) {

    fun statusUrl(): String = "${baseUrlProvider().trimEnd('/')}/api/p2p/status"

    fun signalTicketUrl(): String = "${baseUrlProvider().trimEnd('/')}/api/p2p/signal-ticket"

    fun enrollUrl(): String = "${baseUrlProvider().trimEnd('/')}/api/p2p/enroll"

    suspend fun getStatus(): P2pStatus = parseStatus(httpClient.get(statusUrl()))

    suspend fun requestSignalTicket(): SignalTicket =
        parseSignalTicket(httpClient.post(signalTicketUrl(), "{}"))

    suspend fun enroll(
        pairingCode: String,
        deviceId: String,
        deviceName: String = ServerConfig.effectiveDeviceName,
        platform: String = "android"
    ): P2pEnrollment {
        val body = JSONObject().apply {
            put("pairing_code", pairingCode)
            put("device_id", deviceId)
            put("device_name", deviceName)
            put("platform", platform)
        }.toString()
        return parseEnrollment(httpClient.post(enrollUrl(), body))
    }

    internal fun parseStatus(raw: String): P2pStatus {
        val json = JSONObject(raw)
        return P2pStatus(
            enabled = json.optBoolean("enabled", false),
            signalConnected = json.optBoolean("signal_connected", false),
            room = json.optString("room", ""),
            endpoints = parseEndpoints(json.optJSONObject("endpoints")),
            deviceCount = json.optInt("device_count", 0),
            serverId = json.optString("server_id", ""),
            signalUrl = json.optString("signal_url", "").trim().takeIf { it.isNotEmpty() },
            webrtcEnabled = json.optBoolean("webrtc_enabled", false)
        )
    }

    internal fun parseSignalTicket(raw: String): SignalTicket {
        val json = JSONObject(raw)
        return SignalTicket(
            ticket = json.optString("signal_ticket", ""),
            expiresAtMs = json.optLong("signal_ticket_expires_at", 0L)
        )
    }

    internal fun parseEnrollment(raw: String): P2pEnrollment {
        val json = JSONObject(raw)
        return P2pEnrollment(
            deviceId = json.optString("device_id", ""),
            userId = json.optString("user_id", ""),
            deviceToken = json.optString("device_token", ""),
            signalUrl = json.optString("signal_url", ""),
            room = json.optString("room", ""),
            endpoints = parseEndpoints(json.optJSONObject("endpoints")),
            signalTicket = json.optString("signal_ticket", ""),
            signalTicketExpiresAtMs = json.optLong("signal_ticket_expires_at", 0L)
        )
    }

    private fun parseEndpoints(json: JSONObject?): Map<String, String> {
        if (json == null) return emptyMap()
        val out = LinkedHashMap<String, String>()
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = json.optString(key, "").trim()
            if (value.isNotEmpty()) out[key] = value
        }
        return out
    }
}
