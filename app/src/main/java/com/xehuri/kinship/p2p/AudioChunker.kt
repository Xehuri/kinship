package com.xehuri.kinship.p2p

object AudioChunker {
    const val MAX_PAYLOAD_BYTES = 16 * 1024
    const val MAX_TOTAL_BYTES = 8 * 1024 * 1024
    const val MAX_CHUNKS = 4096

    fun chunkCount(totalBytes: Int): Int? {
        if (totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES) return null
        val count = (totalBytes + MAX_PAYLOAD_BYTES - 1) / MAX_PAYLOAD_BYTES
        return count.takeIf { it in 1..MAX_CHUNKS }
    }

    fun buildFrames(messageId: Long, bytes: ByteArray): List<ByteArray>? {
        val count = chunkCount(bytes.size) ?: return null
        val frames = ArrayList<ByteArray>(count)
        for (index in 0 until count) {
            val from = index * MAX_PAYLOAD_BYTES
            val to = minOf(from + MAX_PAYLOAD_BYTES, bytes.size)
            val header = P2pChunkHeader(messageId, index, count).encode()
            val frame = ByteArray(header.size + (to - from))
            header.copyInto(frame)
            bytes.copyInto(
                destination = frame,
                destinationOffset = header.size,
                startIndex = from,
                endIndex = to
            )
            frames += frame
        }
        return frames
    }
}
