package com.xehuri.kinship.transport

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.CertificatePinner
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

sealed interface ProbeResult {
    data class Healthy(val latencyMs: Long) : ProbeResult
    data class Unreachable(val reason: String) : ProbeResult
    data class TlsError(val reason: String) : ProbeResult
    data class InvalidResponse(val reason: String) : ProbeResult
    data class Skipped(val reason: String) : ProbeResult
}

fun interface TierProbe {
    suspend fun probe(tier: Tier): ProbeResult
}

class HttpTierProbe(
    private val clientFactory: (TlsPolicy) -> OkHttpClient = { buildProbeClient(it) },
    private val dnsFactory: (AddressFamily) -> Dns = { AddressFamilyDns.forFamily(it) },
) : TierProbe {

    override suspend fun probe(tier: Tier): ProbeResult = withContext(Dispatchers.IO) {
        val skipReason = skipReason(tier)
        if (skipReason != null) return@withContext ProbeResult.Skipped(skipReason)

        val address = (tier.target as TierTarget.Network).address
        val url = address.origin.toString() + "/health"
        val client = withPins(
            clientFactory(tier.tls).newBuilder().dns(dnsFactory(tier.family)).build(),
            address.host,
            tier.tls,
        )
        val request = Request.Builder().url(url).get().build()
        val startedAt = System.nanoTime()

        try {
            client.newCall(request).execute().use { response ->
                if (response.code != 200) {
                    return@withContext ProbeResult.Unreachable("HTTP ${response.code}")
                }
                val failure = healthFailure(response.body?.string().orEmpty())
                if (failure != null) {
                    ProbeResult.InvalidResponse(failure)
                } else {
                    ProbeResult.Healthy((System.nanoTime() - startedAt) / 1_000_000)
                }
            }
        } catch (error: SSLException) {
            ProbeResult.TlsError(reason(error))
        } catch (error: SocketTimeoutException) {
            ProbeResult.Unreachable("timeout")
        } catch (error: IOException) {
            ProbeResult.Unreachable(reason(error))
        }
    }

    private fun skipReason(tier: Tier): String? {
        if (!tier.enabled) return "tier disabled"
        if (tier.kind == TierKind.P2P) return "p2p not integrated"
        if (tier.target !is TierTarget.Network) return "no network target"
        val tls = tier.tls
        if (tls is TlsPolicy.Pinned && tls.sha256LeafPins.isEmpty()) return "no pins"
        return null
    }

    private fun withPins(base: OkHttpClient, host: String, policy: TlsPolicy): OkHttpClient {
        if (policy !is TlsPolicy.Pinned) return base
        val pinner = CertificatePinner.Builder().apply {
            for (pin in policy.sha256LeafPins) add(host, normalizePin(pin))
        }.build()
        return base.newBuilder().certificatePinner(pinner).build()
    }

    private fun healthFailure(body: String): String? {
        if (body.isBlank()) return "empty body"
        val json = try {
            JSONObject(body)
        } catch (_: JSONException) {
            return "body is not a json object"
        }
        return if (json.optString("status") == "healthy") null else "status is not healthy"
    }

    companion object {
        fun buildProbeClient(policy: TlsPolicy): OkHttpClient {
            val builder = OkHttpClient.Builder()
                .retryOnConnectionFailure(true)
                .followRedirects(false)
                .followSslRedirects(false)
                .connectTimeout(3_000L, TimeUnit.MILLISECONDS)
                .readTimeout(5_000L, TimeUnit.MILLISECONDS)
                .callTimeout(10_000L, TimeUnit.MILLISECONDS)
            when (policy) {
                is TlsPolicy.System -> Unit
                is TlsPolicy.InsecureDev -> builder.insecureDev()
                // Pins are host-scoped and applied per request in withPins().
                is TlsPolicy.Pinned -> Unit
            }
            return builder.build()
        }

        private fun normalizePin(raw: String): String {
            val trimmed = raw.trim()
            return if (trimmed.startsWith("sha256/")) trimmed else "sha256/$trimmed"
        }

        private fun reason(error: Throwable): String =
            error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName

        private fun OkHttpClient.Builder.insecureDev(): OkHttpClient.Builder {
            val trustManager = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            val sslContext = SSLContext.getInstance("TLS")
            sslContext.init(null, arrayOf<TrustManager>(trustManager), null)
            sslSocketFactory(sslContext.socketFactory, trustManager)
            hostnameVerifier { _, _ -> true }
            return this
        }
    }
}
