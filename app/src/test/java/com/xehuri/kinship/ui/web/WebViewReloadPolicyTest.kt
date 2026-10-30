package com.xehuri.kinship.ui.web

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewReloadPolicyTest {

    @Test
    fun `same base url does not reload`() {
        assertFalse(
            WebViewReloadPolicy.shouldReload(
                "https://health.example:8768",
                "https://health.example:8768",
            )
        )
    }

    @Test
    fun `trailing slash difference does not reload`() {
        assertFalse(
            WebViewReloadPolicy.shouldReload(
                "https://health.example:8768/",
                "https://health.example:8768",
            )
        )
    }

    @Test
    fun `different base url reloads`() {
        assertTrue(
            WebViewReloadPolicy.shouldReload(
                "https://health.example:8768",
                "https://frp.health.example:8768",
            )
        )
    }

    @Test
    fun `blank base url does not reload`() {
        assertFalse(WebViewReloadPolicy.shouldReload("", "https://health.example:8768"))
        assertFalse(WebViewReloadPolicy.shouldReload("https://health.example:8768", "  "))
        assertFalse(WebViewReloadPolicy.shouldReload("", ""))
    }
}
