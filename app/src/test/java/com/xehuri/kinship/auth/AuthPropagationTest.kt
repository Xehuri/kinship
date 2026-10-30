package com.xehuri.kinship.auth

import android.content.Context
import android.content.SharedPreferences
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.state.SensorStateHolder
import com.xehuri.kinship.ui.settings.SettingsViewModel
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AuthPropagationTest {

    private lateinit var context: Context
    private lateinit var httpClient: AppHttpClient
    private lateinit var sensorStateHolder: SensorStateHolder
    private lateinit var testSecurePrefs: SharedPreferences
    private lateinit var viewModel: SettingsViewModel

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
            .edit().clear().commit()

        testSecurePrefs = context.getSharedPreferences("test_secure_prefs_auth", Context.MODE_PRIVATE)
        testSecurePrefs.edit().clear().commit()

        httpClient = mockk(relaxed = true)
        sensorStateHolder = SensorStateHolder()
        viewModel = newViewModel()
    }

    private fun newViewModel(): SettingsViewModel = SettingsViewModel(
        context,
        httpClient,
        sensorStateHolder,
        securePrefsProvider = { testSecurePrefs }
    )

    @Test
    fun `token written outside the view model propagates to isLoggedIn`() {
        assertFalse("isLoggedIn should start false", viewModel.isLoggedIn.value)

        context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
            .edit()
            .putString("auth_token", "red_token")
            .putString("auth_username", "red_user")
            .commit()

        Shadows.shadowOf(Looper.getMainLooper()).idle()

        assertTrue(
            "isLoggedIn should pick up a token written directly by LoginSection",
            viewModel.isLoggedIn.value
        )
        assertEquals("red_user", viewModel.savedUsername.value)
        assertEquals("已连接", viewModel.loginStatus.value)
    }

    @Test
    fun `401 with no stored password clears the view model login state`() {
        context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
            .edit()
            .putString("auth_token", "red_token")
            .putString("auth_username", "red_user")
            .commit()
        testSecurePrefs.edit().remove("auth_password").commit()

        viewModel = newViewModel()
        assertTrue(
            "pre-seeded token should mark the view model logged in",
            viewModel.isLoggedIn.value
        )

        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(401).setBody("Unauthorized"))
            AppHttpClient.resetAuthFailureFlag()
            val realClient = AppHttpClient(context)
            runBlocking {
                runCatching { realClient.get(server.url("/probe").toString()) }
            }
        } finally {
            server.shutdown()
        }

        Shadows.shadowOf(Looper.getMainLooper()).idle()

        assertFalse(
            "a 401 must clear the view model login state",
            viewModel.isLoggedIn.value
        )
    }
}
