package com.xehuri.kinship.network

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class LegacyTransportSelectorRemovedTest {

    @Test
    fun `legacy transport selector class no longer exists`() {
        var loaded: Throwable? = null
        try {
            Class.forName("com.xehuri.kinship.network.TransportSelector")
        } catch (error: Throwable) {
            loaded = error
        }

        assertThat(loaded).isInstanceOf(ClassNotFoundException::class.java)
    }
}
