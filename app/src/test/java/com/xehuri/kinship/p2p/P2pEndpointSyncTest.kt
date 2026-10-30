package com.xehuri.kinship.p2p

import com.xehuri.kinship.config.EndpointCandidate
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import org.junit.Test
import java.io.IOException

class P2pEndpointSyncTest {

    private fun status(
        enabled: Boolean = true,
        endpoints: Map<String, String> = mapOf(
            "frp" to "https://frp.example.com:8768",
            "ipv6" to "https://[240e::1]:8443"
        )
    ): P2pStatus = P2pStatus(
        enabled = enabled,
        signalConnected = true,
        room = "room-1",
        endpoints = endpoints,
        deviceCount = 1,
        serverId = "home"
    )

    @Test
    fun `apply updates candidates when status is enabled`() {
        val updates = mutableListOf<List<EndpointCandidate>>()

        val applied = P2pEndpointSync.apply(status()) { updates.add(it) }

        assertThat(applied).isTrue()
        assertThat(updates).hasSize(1)
        assertThat(updates.single().map { it.name }).containsExactly("ipv6", "frp").inOrder()
    }

    @Test
    fun `apply keeps legacy behavior when p2p is disabled`() {
        var updated = false

        val applied = P2pEndpointSync.apply(status(enabled = false)) { updated = true }

        assertThat(applied).isFalse()
        assertThat(updated).isFalse()
    }

    @Test
    fun `apply keeps legacy behavior when endpoints are empty`() {
        var updated = false

        val applied = P2pEndpointSync.apply(status(endpoints = emptyMap())) { updated = true }

        assertThat(applied).isFalse()
        assertThat(updated).isFalse()
    }

    @Test
    fun `refresh applies candidates from status provider`() = runBlocking {
        val updates = mutableListOf<List<EndpointCandidate>>()

        val refreshed = P2pEndpointSync.refresh({ status() }) { updates.add(it) }

        assertThat(refreshed).isTrue()
        assertThat(updates.single().map { it.url }).containsExactly(
            "https://[240e::1]:8443",
            "https://frp.example.com:8768"
        ).inOrder()
    }

    @Test
    fun `refresh swallows status errors and preserves legacy behavior`() = runBlocking {
        var updated = false

        val refreshed = P2pEndpointSync.refresh({ throw IOException("404") }) { updated = true }

        assertThat(refreshed).isFalse()
        assertThat(updated).isFalse()
    }
}
