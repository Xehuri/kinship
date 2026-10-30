package com.xehuri.kinship.p2p

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import timber.log.Timber
import java.nio.ByteBuffer

// allow: SIZE_OK — 原生 PeerConnection/DataChannel 生命周期与发送状态机同文件。

enum class WebRtcState {
    IDLE,
    CONNECTING,
    CONNECTED,
    READY,
    FAILED,
    CLOSED
}

// allow: SIZE_OK — native PeerConnection/DataChannel adapter; observers share transport state
/**
 * WebRTC DataChannel 音频旁路。PeerConnection/DataChannel 依赖原生库，JVM 单测无法覆盖；
 * 纯协议层由 [P2pProtocol] / [AudioChunker] 的单测验证，端到端能力需真机验证。
 */
class WebRtcTransport(
    context: Context,
    private val signaling: SignalingClient,
    private val targetId: String
) {

    private val appContext = context.applicationContext

    private val _state = MutableStateFlow(WebRtcState.IDLE)
    val state: StateFlow<WebRtcState> = _state.asStateFlow()

    private val sendMutex = Mutex()
    private val pendingRemoteIce = mutableListOf<IceCandidate>()

    @Volatile
    private var remoteDescriptionSet = false

    @Volatile
    private var peerConnection: PeerConnection? = null

    @Volatile
    private var dataChannel: DataChannel? = null

    @Volatile
    private var pendingAck: PendingAck? = null

    @Volatile
    private var closing = false

    private data class PendingAck(
        val messageId: Long,
        val deferred: CompletableDeferred<P2pAck>
    )

    @Synchronized
    fun start() {
        if (closing || _state.value != WebRtcState.IDLE) return
        _state.value = WebRtcState.CONNECTING
        try {
            val factory = PeerConnectionFactoryHolder.get(appContext)
            val configuration = PeerConnection.RTCConfiguration(
                listOf(
                    PeerConnection.IceServer.builder("stun:stun.l.google.com:19302")
                        .createIceServer()
                )
            ).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
                iceTransportsType = PeerConnection.IceTransportsType.ALL
                continualGatheringPolicy =
                    PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            }
            val connection = factory.createPeerConnection(configuration, peerConnectionObserver)
            if (connection == null) {
                fail()
                return
            }
            peerConnection = connection
            val channel = connection.createDataChannel(
                P2pProtocol.DATA_CHANNEL_LABEL,
                DataChannel.Init().apply { ordered = true }
            )
            if (channel == null) {
                fail()
                return
            }
            dataChannel = channel
            channel.registerObserver(dataChannelObserver)
            connection.createOffer(offerObserver, MediaConstraints())
        } catch (e: Exception) {
            Timber.w("WebRTC 启动失败: ${e.javaClass.simpleName}")
            fail()
        } catch (e: LinkageError) {
            Timber.w("WebRTC 原生库不可用: ${e.javaClass.simpleName}")
            fail()
        }
    }

    fun handleSignalMessage(text: String) {
        val json = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        when (json.optString("type", "")) {
            "bye" -> fail()
            "answer" -> json.optJSONObject("payload")?.let(::handleAnswer)
            "ice" -> json.optJSONObject("payload")?.let(::handleRemoteIce)
        }
    }

    fun markFailed() = fail()

    fun sendEvent(eventType: String, payload: JSONObject = JSONObject()): Boolean {
        if (_state.value != WebRtcState.READY) return false
        val message = JSONObject().apply {
            put("type", "event")
            put("event_type", eventType)
            put("payload", payload)
        }
        return sendText(message.toString())
    }

    suspend fun sendAudio(meta: AudioMeta, bytes: ByteArray): Boolean = sendMutex.withLock {
        if (_state.value != WebRtcState.READY) return@withLock false
        if (meta.size != bytes.size) return@withLock false
        if (meta.chunks != AudioChunker.chunkCount(bytes.size)) return@withLock false
        val frames = AudioChunker.buildFrames(meta.messageId, bytes) ?: return@withLock false

        val deferred = CompletableDeferred<P2pAck>()
        val pending = PendingAck(meta.messageId, deferred)
        pendingAck = pending
        try {
            if (!sendText(meta.toJson())) return@withLock false
            for (frame in frames) {
                if (!sendBinary(frame)) return@withLock false
            }
            val ack = withTimeoutOrNull(P2pProtocol.ACK_TIMEOUT_MS) { deferred.await() }
            ack != null && ack.ok
        } finally {
            if (pendingAck === pending) pendingAck = null
        }
    }

    @Synchronized
    fun close() {
        closing = true
        abortPendingAck()
        releaseResources()
        _state.value = WebRtcState.CLOSED
    }

    private fun fail() {
        if (closing) return
        closing = true
        abortPendingAck()
        releaseResources()
        _state.value = WebRtcState.FAILED
    }

    private fun abortPendingAck() {
        val pending = pendingAck
        pendingAck = null
        pending?.deferred?.complete(P2pAck(pending.messageId, false, "transport closed"))
    }

    private fun releaseResources() {
        val channel = dataChannel
        dataChannel = null
        try { channel?.unregisterObserver() } catch (_: Exception) {}
        try { channel?.close() } catch (_: Exception) {}
        try { channel?.dispose() } catch (_: Exception) {}

        val connection = peerConnection
        peerConnection = null
        try { connection?.close() } catch (_: Exception) {}
        try { connection?.dispose() } catch (_: Exception) {}
    }

    private fun handleAnswer(payload: JSONObject) {
        val sdp = payload.optString("sdp", "")
        if (sdp.isEmpty()) return
        val connection = peerConnection ?: return
        val description = SessionDescription(SessionDescription.Type.ANSWER, sdp)
        connection.setRemoteDescription(object : SdpAdapter() {
            override fun onSetSuccess() {
                remoteDescriptionSet = true
                if (_state.value == WebRtcState.CONNECTING) {
                    _state.value = WebRtcState.CONNECTED
                }
                drainRemoteIce()
            }

            override fun onSetFailure(error: String?) {
                fail()
            }
        }, description)
    }

    private fun handleRemoteIce(payload: JSONObject) {
        val sdp = payload.optString("candidate", "")
        if (sdp.isEmpty()) return
        val candidate = IceCandidate(
            payload.optString("sdpMid", ""),
            payload.optInt("sdpMLineIndex", 0),
            sdp
        )
        if (!remoteDescriptionSet) {
            synchronized(pendingRemoteIce) { pendingRemoteIce += candidate }
            return
        }
        peerConnection?.addIceCandidate(candidate)
    }

    private fun drainRemoteIce() {
        val candidates = synchronized(pendingRemoteIce) {
            val copy = pendingRemoteIce.toList()
            pendingRemoteIce.clear()
            copy
        }
        val connection = peerConnection ?: return
        candidates.forEach { connection.addIceCandidate(it) }
    }

    private fun sendText(text: String): Boolean = try {
        dataChannel?.send(
            DataChannel.Buffer(
                ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)),
                false
            )
        ) == true
    } catch (_: Exception) {
        false
    }

    private fun sendBinary(bytes: ByteArray): Boolean = try {
        dataChannel?.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), true)) == true
    } catch (_: Exception) {
        false
    }

    private val dataChannelObserver = object : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) {}

        override fun onStateChange() {
            when (dataChannel?.state()) {
                DataChannel.State.OPEN -> if (!closing) _state.value = WebRtcState.READY
                DataChannel.State.CONNECTING -> {}
                DataChannel.State.CLOSING,
                DataChannel.State.CLOSED -> if (!closing) fail()
                null -> {}
            }
        }

        override fun onMessage(buffer: DataChannel.Buffer) {
            if (buffer.binary) return
            val bytes = ByteArray(buffer.data.remaining())
            buffer.data.get(bytes)
            val ack = parseP2pAck(String(bytes, Charsets.UTF_8)) ?: return
            val pending = pendingAck
            if (pending != null && pending.messageId == ack.messageId) {
                pending.deferred.complete(ack)
            }
        }
    }

    private val offerObserver = object : SdpAdapter() {
        override fun onCreateSuccess(sdp: SessionDescription?) {
            if (sdp == null) {
                fail()
                return
            }
            val connection = peerConnection
            if (connection == null) {
                fail()
                return
            }
            connection.setLocalDescription(object : SdpAdapter() {
                override fun onSetSuccess() {
                    val payload = JSONObject().apply {
                        put("type", "offer")
                        put("sdp", sdp.description)
                    }
                    if (!signaling.sendSignal("offer", targetId, payload)) fail()
                }

                override fun onSetFailure(error: String?) {
                    fail()
                }
            }, sdp)
        }

        override fun onCreateFailure(error: String?) {
            fail()
        }
    }

    private val peerConnectionObserver = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            if (state == PeerConnection.IceConnectionState.FAILED) fail()
        }

        override fun onIceConnectionReceivingChange(receiving: Boolean) {}

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}

        override fun onIceCandidate(candidate: IceCandidate?) {
            if (candidate == null) return
            val payload = JSONObject().apply {
                put("candidate", candidate.sdp)
                put("sdpMid", candidate.sdpMid ?: "")
                put("sdpMLineIndex", candidate.sdpMLineIndex)
            }
            signaling.sendSignal("ice", targetId, payload)
        }

        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>?) {}

        override fun onAddStream(stream: MediaStream?) {}

        override fun onRemoveStream(stream: MediaStream?) {}

        override fun onDataChannel(channel: DataChannel?) {}

        override fun onRenegotiationNeeded() {}

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
            when (newState) {
                PeerConnection.PeerConnectionState.FAILED -> fail()
                PeerConnection.PeerConnectionState.CLOSED -> if (!closing) fail()
                else -> {}
            }
        }
    }

    private abstract class SdpAdapter : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) {}
        override fun onSetFailure(error: String?) {}
    }
}

private object PeerConnectionFactoryHolder {
    @Volatile
    private var factory: PeerConnectionFactory? = null

    @Synchronized
    fun get(context: Context): PeerConnectionFactory {
        factory?.let { return it }
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions()
        )
        return PeerConnectionFactory.builder()
            .setOptions(PeerConnectionFactory.Options())
            .createPeerConnectionFactory()
            .also { factory = it }
    }
}
