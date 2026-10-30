package com.xehuri.kinship.p2p

import android.content.Context
import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.config.TransportMode
import com.xehuri.kinship.network.AppHttpClient
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test

class P2pWebRtcManagerTest {

    private val context = mockk<Context>(relaxed = true)
    private val httpClient = mockk<AppHttpClient>(relaxed = true)
    private val api = mockk<P2pApi>(relaxed = true)

    @Before
    fun setUp() {
        ServerConfig.setTransportMode(TransportMode.AUTO)
    }

    @After
    fun tearDown() {
        ServerConfig.setTransportMode(TransportMode.AUTO)
    }

    @Test
    fun `forced frp skips webrtc startup entirely`() = runTest {
        ServerConfig.setTransportMode(TransportMode.FORCE_FRP)
        val manager = P2pWebRtcManager(context, httpClient, api)

        manager.start()

        coVerify(exactly = 0) { api.getStatus() }
        assertThat(manager.isReady).isFalse()
    }

    @Test
    fun `mode switch during status fetch aborts startup`() = runTest {
        var mode = TransportMode.AUTO
        coEvery { api.getStatus() } answers {
            mode = TransportMode.FORCE_FRP
            P2pStatus(
                enabled = true,
                signalConnected = true,
                room = "room-1",
                endpoints = emptyMap(),
                deviceCount = 0,
                serverId = "server-1",
                signalUrl = "wss://signal.example.com/ws",
                webrtcEnabled = true
            )
        }
        val manager = P2pWebRtcManager(
            context,
            httpClient,
            api,
            transportModeProvider = { mode }
        )

        manager.start()

        coVerify(exactly = 1) { api.getStatus() }
        assertThat(manager.isReady).isFalse()
        assertThat(P2pWebRtcManager.instance).isNotSameInstanceAs(manager)
    }

    @Test
    fun `auto mode still queries p2p status`() = runTest {
        coEvery { api.getStatus() } returns P2pStatus(
            enabled = false,
            signalConnected = false,
            room = "",
            endpoints = emptyMap(),
            deviceCount = 0,
            serverId = "",
            signalUrl = null,
            webrtcEnabled = false
        )
        val manager = P2pWebRtcManager(context, httpClient, api)

        manager.start()

        coVerify(exactly = 1) { api.getStatus() }
        assertThat(manager.isReady).isFalse()
    }
}
