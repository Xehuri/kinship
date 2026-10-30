package com.xehuri.kinship.p2p

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicLong

object P2pProtocol {
    const val DATA_CHANNEL_LABEL = "axeuh-data"
    const val ACK_TIMEOUT_MS = 15_000L
    const val FORMAT_WAV = "wav"
    const val FORMAT_FLAC = "flac"

    const val UINT32_MAX = 0xFFFF_FFFFL
}

data class AudioMeta(
    val messageId: Long,
    val sessionId: String,
    val seq: Int,
    val startMs: Long,
    val clientTime: String,
    val format: String,
    val size: Int,
    val chunks: Int
) {
    fun toJson(): String = JSONObject().apply {
        put("type", "audio_meta")
        put("message_id", messageId)
        put("session_id", sessionId)
        put("seq", seq)
        put("start_ms", startMs)
        put("client_time", clientTime)
        put("format", format)
        put("size", size)
        put("chunks", chunks)
    }.toString()

    companion object {
        fun forAudio(
            sessionId: String,
            seq: Int,
            startMs: Long,
            clientTime: String,
            format: String,
            size: Int,
            messageId: Long = P2pMessageIds.next()
        ): AudioMeta? {
            if (startMs <= 0L) return null
            val normalizedFormat = format.trim().lowercase()
            if (normalizedFormat != P2pProtocol.FORMAT_WAV &&
                normalizedFormat != P2pProtocol.FORMAT_FLAC
            ) {
                return null
            }
            if (messageId !in 0..P2pProtocol.UINT32_MAX) return null
            val chunks = AudioChunker.chunkCount(size) ?: return null
            return AudioMeta(
                messageId = messageId,
                sessionId = sessionId,
                seq = seq,
                startMs = startMs,
                clientTime = clientTime,
                format = normalizedFormat,
                size = size,
                chunks = chunks
            )
        }
    }
}

data class P2pChunkHeader(
    val messageId: Long,
    val chunkIndex: Int,
    val chunkCount: Int
) {
    fun encode(): ByteArray {
        require(messageId in 0..P2pProtocol.UINT32_MAX) { "message_id out of uint32 range" }
        require(chunkCount in 1..AudioChunker.MAX_CHUNKS) { "chunk_count out of range" }
        require(chunkIndex in 0 until chunkCount) { "chunk_index out of range" }
        return ByteBuffer.allocate(HEADER_SIZE).order(ByteOrder.BIG_ENDIAN).apply {
            put(MAGIC)
            put(KIND_AUDIO)
            putShort(0)
            putInt(messageId.toInt())
            putShort(chunkIndex.toShort())
            putShort(chunkCount.toShort())
        }.array()
    }

    companion object {
        const val MAGIC: Byte = 1
        const val KIND_AUDIO: Byte = 1
        const val HEADER_SIZE = 12

        fun decode(bytes: ByteArray): P2pChunkHeader? {
            if (bytes.size < HEADER_SIZE) return null
            val buffer = ByteBuffer.wrap(bytes, 0, HEADER_SIZE).order(ByteOrder.BIG_ENDIAN)
            val magic = buffer.get().toInt() and 0xFF
            val kind = buffer.get().toInt() and 0xFF
            val reserved = buffer.short.toInt() and 0xFFFF
            val messageId = buffer.int.toLong() and P2pProtocol.UINT32_MAX
            val chunkIndex = buffer.short.toInt() and 0xFFFF
            val chunkCount = buffer.short.toInt() and 0xFFFF
            if (magic != MAGIC.toInt() || kind != KIND_AUDIO.toInt() || reserved != 0) return null
            if (chunkCount !in 1..AudioChunker.MAX_CHUNKS) return null
            if (chunkIndex >= chunkCount) return null
            return P2pChunkHeader(messageId, chunkIndex, chunkCount)
        }
    }
}

data class P2pAck(
    val messageId: Long,
    val ok: Boolean,
    val error: String?
)

fun parseP2pAck(text: String): P2pAck? {
    val json = try {
        JSONObject(text)
    } catch (_: Exception) {
        return null
    }
    if (json.optString("type", "") != "ack") return null
    if (!json.has("message_id")) return null
    val messageId = json.optLong("message_id", -1L)
    if (messageId !in 0..P2pProtocol.UINT32_MAX) return null
    return P2pAck(
        messageId = messageId,
        ok = json.optBoolean("ok", false),
        error = json.optString("error", "").takeIf { it.isNotEmpty() }
    )
}

object P2pMessageIds {
    private val counter = AtomicLong(System.currentTimeMillis() and P2pProtocol.UINT32_MAX)

    fun next(): Long = counter.incrementAndGet() and P2pProtocol.UINT32_MAX
}
