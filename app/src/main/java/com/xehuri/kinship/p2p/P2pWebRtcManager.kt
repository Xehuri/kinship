package com.xehuri.kinship.p2p

import android.content.Context
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.config.TransportMode
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.util.DeviceId
import kotlinx.coroutines.CancellationException
import timber.log.Timber

class P2pWebRtcManager(
    context: Context,
    private val httpClient: AppHttpClient,
    private val api: P2pApi = P2pApi(httpClient),
    private val transportModeProvider: () -> TransportMode = { ServerConfig.transportMode }
) {

    companion object {
        @Volatile
        var instance: P2pWebRtcManager? = null
            private set
    }

    private val appContext = context.applicationContext

    @Volatile
    private var started = false

    @Volatile
    private var stopped = false

    private val lifecycleLock = Any()

    @Volatile
    private var signaling: SignalingClient? = null

    @Volatile
    private var transport: WebRtcTransport? = null

    val isReady: Boolean
        get() = transport?.state?.value == WebRtcState.READY

    suspend fun start() {
        if (transportModeProvider() == TransportMode.FORCE_FRP) return
        if (started || stopped) return
        started = true

        val status = try {
            api.getStatus()
        } catch (e: CancellationException) {
            started = false
            throw e
        } catch (e: Exception) {
            Timber.w("P2P 状态读取失败: ${e.javaClass.simpleName}")
            return
        }
        if (transportModeProvider() == TransportMode.FORCE_FRP) return
        if (!P2pWebRtcPolicy.shouldStart(status) || stopped) return

        val signalUrl = status.signalUrl?.trim().orEmpty()
        val room = status.room.trim()
        val serverId = status.serverId.trim()
        if (signalUrl.isEmpty() || room.isEmpty() || serverId.isEmpty()) return

        if (stopped) return

        try {
            val deviceId = DeviceId.get(appContext)
            val signalClient = SignalingClient(
                httpClient = httpClient,
                signalUrl = signalUrl,
                room = room,
                deviceId = deviceId,
                ticket = "",
                ticketProvider = { api.requestSignalTicket() }
            )
            val webRtc = WebRtcTransport(appContext, signalClient, serverId)
            signalClient.onSignalMessage = { text -> webRtc.handleSignalMessage(text) }
            signalClient.onRegistered = { webRtc.start() }
            signalClient.onTicketExpired = { webRtc.markFailed() }
            synchronized(lifecycleLock) {
                if (stopped || transportModeProvider() == TransportMode.FORCE_FRP) return
                signaling = signalClient
                transport = webRtc
                instance = this
            }
            signalClient.start()
            if (stopped) {
                signalClient.close()
                webRtc.close()
                return
            }
            if (signalClient.state.value == SignalingClient.State.REGISTERED) {
                webRtc.start()
            }
        } catch (e: Exception) {
            Timber.w("WebRTC 初始化失败: ${e.javaClass.simpleName}")
            stop()
        }
    }

    suspend fun sendAudio(meta: AudioMeta, bytes: ByteArray): Boolean {
        val current = transport ?: return false
        if (current.state.value != WebRtcState.READY) return false
        return current.sendAudio(meta, bytes)
    }

    fun stop() {
        started = false
        synchronized(lifecycleLock) {
            stopped = true
            try { signaling?.close() } catch (_: Exception) {}
            signaling = null
            try { transport?.close() } catch (_: Exception) {}
            transport = null
            if (instance === this) instance = null
        }
    }
}
