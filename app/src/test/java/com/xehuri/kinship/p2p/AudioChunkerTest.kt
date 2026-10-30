package com.xehuri.kinship.p2p

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class AudioChunkerTest {

    @Test
    fun `header round trips uint32 message id and indexes`() {
        val header = P2pChunkHeader(messageId = 0xFEDCBA98L, chunkIndex = 2, chunkCount = 5)

        val encoded = header.encode()

        assertThat(encoded.size).isEqualTo(P2pChunkHeader.HEADER_SIZE)
        assertThat(encoded[0].toInt()).isEqualTo(1)
        assertThat(encoded[1].toInt()).isEqualTo(1)
        assertThat(encoded[2].toInt()).isEqualTo(0)
        assertThat(encoded[3].toInt()).isEqualTo(0)
        assertThat(encoded.copyOfRange(4, 8).map { it.toInt() and 0xFF })
            .containsExactly(0xFE, 0xDC, 0xBA, 0x98).inOrder()
        assertThat(encoded.copyOfRange(8, 10).map { it.toInt() and 0xFF })
            .containsExactly(0, 2).inOrder()
        assertThat(encoded.copyOfRange(10, 12).map { it.toInt() and 0xFF })
            .containsExactly(0, 5).inOrder()
        assertThat(P2pChunkHeader.decode(encoded)).isEqualTo(header)
    }

    @Test
    fun `frames split on sixteen kibibyte boundaries`() {
        val bytes = ByteArray(AudioChunker.MAX_PAYLOAD_BYTES + 1) { (it % 251).toByte() }

        val frames = AudioChunker.buildFrames(messageId = 7L, bytes = bytes)

        assertThat(frames).isNotNull()
        val built = frames!!
        assertThat(built).hasSize(2)
        assertThat(built[0].size).isEqualTo(P2pChunkHeader.HEADER_SIZE + AudioChunker.MAX_PAYLOAD_BYTES)
        assertThat(built[1].size).isEqualTo(P2pChunkHeader.HEADER_SIZE + 1)

        val firstHeader = P2pChunkHeader.decode(built[0])
        val secondHeader = P2pChunkHeader.decode(built[1])
        assertThat(firstHeader).isEqualTo(P2pChunkHeader(7L, 0, 2))
        assertThat(secondHeader).isEqualTo(P2pChunkHeader(7L, 1, 2))
        assertThat(built[0].copyOfRange(12, 16).map { it.toInt() })
            .isEqualTo(bytes.copyOfRange(0, 4).map { it.toInt() })
        assertThat(built[1].copyOfRange(12, 13).map { it.toInt() })
            .isEqualTo(
                bytes.copyOfRange(AudioChunker.MAX_PAYLOAD_BYTES, AudioChunker.MAX_PAYLOAD_BYTES + 1)
                    .map { it.toInt() }
            )
    }

    @Test
    fun `chunk count covers exact boundary and maximum size`() {
        assertThat(AudioChunker.chunkCount(AudioChunker.MAX_PAYLOAD_BYTES)).isEqualTo(1)
        assertThat(AudioChunker.chunkCount(AudioChunker.MAX_PAYLOAD_BYTES + 1)).isEqualTo(2)
        assertThat(AudioChunker.chunkCount(AudioChunker.MAX_TOTAL_BYTES)).isEqualTo(512)
    }

    @Test
    fun `chunk count rejects empty and oversized payloads`() {
        assertThat(AudioChunker.chunkCount(0)).isNull()
        assertThat(AudioChunker.chunkCount(-1)).isNull()
        assertThat(AudioChunker.chunkCount(AudioChunker.MAX_TOTAL_BYTES + 1)).isNull()
        assertThat(AudioChunker.buildFrames(1L, ByteArray(AudioChunker.MAX_TOTAL_BYTES + 1))).isNull()
    }

    @Test
    fun `header decode rejects invalid frames`() {
        val valid = P2pChunkHeader(1L, 0, 1).encode()

        assertThat(P2pChunkHeader.decode(valid.copyOfRange(0, 11))).isNull()
        assertThat(P2pChunkHeader.decode(valid.copyOf().also { it[0] = 2 })).isNull()
        assertThat(P2pChunkHeader.decode(valid.copyOf().also { it[2] = 1 })).isNull()
        assertThat(P2pChunkHeader.decode(valid.copyOf().also { it[8] = 1 })).isNull()
    }
}
