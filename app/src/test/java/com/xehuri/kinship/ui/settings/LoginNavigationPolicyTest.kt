package com.xehuri.kinship.ui.settings

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoginNavigationPolicyTest {

    @Test
    fun `login gate opens main app after unauthenticated to authenticated`() {
        assertTrue(
            LoginNavigationPolicy.shouldOpenMainApp(
                SettingsLaunchReason.LOGIN_GATE,
                wasAuthenticated = false,
                isAuthenticated = true
            )
        )
    }

    @Test
    fun `login gate keeps user in settings when already authenticated`() {
        assertFalse(
            LoginNavigationPolicy.shouldOpenMainApp(
                SettingsLaunchReason.LOGIN_GATE,
                wasAuthenticated = true,
                isAuthenticated = true
            )
        )
    }

    @Test
    fun `manual launch never opens main app after login`() {
        assertFalse(
            LoginNavigationPolicy.shouldOpenMainApp(
                SettingsLaunchReason.MANUAL,
                wasAuthenticated = false,
                isAuthenticated = true
            )
        )
    }

    @Test
    fun `login gate does not open main app when authentication is lost`() {
        assertFalse(
            LoginNavigationPolicy.shouldOpenMainApp(
                SettingsLaunchReason.LOGIN_GATE,
                wasAuthenticated = true,
                isAuthenticated = false
            )
        )
    }
}
