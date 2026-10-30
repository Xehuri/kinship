package com.xehuri.kinship.p2p

import com.google.common.truth.Truth.assertThat
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class P2pProtocolTest {

    @Test
    fun `audio meta serializes protocol fields`() {
        val meta = AudioMeta(
            messageId = 4_000_000_000L,
            sessionId = "session-1",
            seq = 7,
            startMs = 1_760_000_000_000L,
            clientTime = "2026-10-23T21:00:00.000+08:00",
            format = "wav",
            size = 20_000,
            chunks = 2
        )

        val json = JSONObject(meta.toJson())

        assertThat(json.getString("type")).isEqualTo("audio_meta")
        assertThat(json.getLong("message_id")).isEqualTo(4_000_000_000L)
        assertThat(json.getString("session_id")).isEqualTo("session-1")
        assertThat(json.getInt("seq")).isEqualTo(7)
        assertThat(json.getLong("start_ms")).isEqualTo(1_760_000_000_000L)
        assertThat(json.getString("client_time")).isEqualTo("2026-10-23T21:00:00.000+08:00")
        assertThat(json.getString("format")).isEqualTo("wav")
        assertThat(json.getInt("size")).isEqualTo(20_000)
        assertThat(json.getInt("chunks")).isEqualTo(2)
    }

    @Test
    fun `audio meta factory normalizes format and computes chunks`() {
        val meta = AudioMeta.forAudio(
            sessionId = "session-1",
            seq = 1,
            startMs = 1L,
            clientTime = "t",
            format = "FLAC",
            size = AudioChunker.MAX_PAYLOAD_BYTES + 1,
            messageId = 42L
        )

        assertThat(meta).isNotNull()
        assertThat(meta!!.format).isEqualTo("flac")
        assertThat(meta.chunks).isEqualTo(2)
        assertThat(meta.messageId).isEqualTo(42L)
    }

    @Test
    fun `audio meta factory rejects invalid format and oversize`() {
        assertThat(
            AudioMeta.forAudio("s", 0, 1L, "t", "mp3", 100, 1L)
        ).isNull()
        assertThat(
            AudioMeta.forAudio("s", 0, 1L, "t", "wav", AudioChunker.MAX_TOTAL_BYTES + 1, 1L)
        ).isNull()
        assertThat(
            AudioMeta.forAudio("s", 0, 1L, "t", "wav", 100, P2pProtocol.UINT32_MAX + 1)
        ).isNull()
    }

    @Test
    fun `audio meta factory rejects non positive start timestamps`() {
        assertThat(
            AudioMeta.forAudio("s", 0, 0L, "t", "wav", 100, 1L)
        ).isNull()
        assertThat(
            AudioMeta.forAudio("s", 0, -1L, "t", "flac", 100, 1L)
        ).isNull()
        assertThat(
            AudioMeta.forAudio("s", 0, 1L, "t", "wav", 100, 1L)
        ).isNotNull()
    }

    @Test
    fun `ack parsing returns ok result`() {
        val ack = parseP2pAck("""{"type":"ack","message_id":123,"ok":true}""")

        assertThat(ack).isEqualTo(P2pAck(123L, true, null))
    }

    @Test
    fun `ack parsing returns failure with error`() {
        val ack = parseP2pAck("""{"type":"ack","message_id":123,"ok":false,"error":"ingest failed"}""")

        assertThat(ack).isEqualTo(P2pAck(123L, false, "ingest failed"))
    }

    @Test
    fun `ack parsing rejects non ack and malformed payloads`() {
        assertThat(parseP2pAck("""{"type":"event","message_id":1,"ok":true}""")).isNull()
        assertThat(parseP2pAck("""{"type":"ack","ok":true}""")).isNull()
        assertThat(parseP2pAck("""{"type":"ack","message_id":-1,"ok":true}""")).isNull()
        assertThat(parseP2pAck("not-json")).isNull()
    }

    @Test
    fun `message ids stay in uint32 range`() {
        repeat(100) {
            assertThat(P2pMessageIds.next()).isIn(0..P2pProtocol.UINT32_MAX)
        }
    }
}
