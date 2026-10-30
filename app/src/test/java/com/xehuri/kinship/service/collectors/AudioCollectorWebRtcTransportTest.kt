package com.xehuri.kinship.service.collectors

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.config.EndpointCandidate
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.config.TransportMode
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.p2p.P2pWebRtcManager
import com.xehuri.kinship.service.state.SensorStateHolder
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AudioCollectorWebRtcTransportTest {

    private lateinit var context: Context
    private lateinit var prefs: SharedPreferences
    private val stateHolder = mockk<SensorStateHolder>(relaxed = true)
    private val httpClient = mockk<AppHttpClient>(relaxed = true)

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        prefs = context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        context.getSharedPreferences("data_collector", Context.MODE_PRIVATE)
            .edit().clear().commit()
        ServerConfig.init(context)
    }

    @After
    fun tearDown() {
        ServerConfig.setTransportMode(TransportMode.AUTO)
        ServerConfig.updateEndpointCandidates(emptyList())
        ServerConfig.selectBaseUrl("https://localhost:8767")
        prefs.edit().clear().commit()
        ServerConfig.init(context)
    }

    @Test
    fun `forced frp skips cached webrtc send while auto still uses it`() {
        val frp = EndpointCandidate("frp", "https://frp.example.com:8768")
        ServerConfig.updateEndpointCandidates(listOf(frp))
        ServerConfig.selectBaseUrl(frp.url)
        ServerConfig.setTransportMode(TransportMode.AUTO)
        val manager = mockk<P2pWebRtcManager>(relaxed = true)
        every { manager.isReady } returns true
        coEvery { manager.sendAudio(any(), any()) } returns true
        val audioFile = File.createTempFile("cached-audio", ".wav")
        audioFile.writeBytes(ByteArray(64))
        try {
            val collector = AudioCollector(context, stateHolder, httpClient)
            val cached = JSONObject().apply {
                put("start_ms", 1_700_000_000_000L)
                put("session_id", "session")
                put("seq", 1)
                put("client_time", "2026-10-24T10:00:00.000+08:00")
                put("format", "wav")
            }

            assertThat(collector.trySendCachedViaWebRtc(cached, audioFile, manager)).isTrue()

            ServerConfig.setTransportMode(TransportMode.FORCE_FRP)
            assertThat(collector.trySendCachedViaWebRtc(cached, audioFile, manager)).isFalse()
            coVerify(exactly = 1) { manager.sendAudio(any(), any()) }
        } finally {
            audioFile.delete()
        }
    }
}
