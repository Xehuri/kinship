package com.xehuri.kinship.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionManagerTest {

    companion object {
        private const val ORIGIN = "https://example.test"
        private const val TOKEN = "token-123"
        private const val USERNAME = "alice"
        private const val PASSWORD = "secret-123"
    }

    private lateinit var prefs: SharedPreferences
    private lateinit var securePrefs: SharedPreferences
    private lateinit var session: SessionManager

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        prefs = context.getSharedPreferences("test_session_prefs", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        securePrefs = context.getSharedPreferences("test_session_secure", Context.MODE_PRIVATE)
        securePrefs.edit().clear().commit()
        session = SessionManager(prefs, { securePrefs }, { ORIGIN })
    }

    @After
    fun tearDown() {
        session.close()
    }

    @Test
    fun `save persists credentials and exposes authenticated state`() {
        session.save(ORIGIN, TOKEN, USERNAME, PASSWORD)

        assertEquals(SessionState.Authenticated(ORIGIN, USERNAME), session.state.value)
        assertEquals(TOKEN, prefs.getString(SessionManager.KEY_TOKEN, null))
        assertEquals(USERNAME, prefs.getString(SessionManager.KEY_USERNAME, null))
        assertEquals(PASSWORD, securePrefs.getString(SessionManager.KEY_PASSWORD, null))
    }

    @Test
    fun `expire drops token but keeps username and password`() {
        session.save(ORIGIN, TOKEN, USERNAME, PASSWORD)

        session.expire(ORIGIN)

        assertEquals(SessionState.Expired(ORIGIN), session.state.value)
        assertNull(prefs.getString(SessionManager.KEY_TOKEN, null))
        assertEquals(USERNAME, prefs.getString(SessionManager.KEY_USERNAME, null))
        assertEquals(PASSWORD, securePrefs.getString(SessionManager.KEY_PASSWORD, null))
    }

    @Test
    fun `logout clears token username and password`() {
        session.save(ORIGIN, TOKEN, USERNAME, PASSWORD)

        session.logout()

        assertEquals(SessionState.LoggedOut, session.state.value)
        assertNull(prefs.getString(SessionManager.KEY_TOKEN, null))
        assertNull(prefs.getString(SessionManager.KEY_USERNAME, null))
        assertNull(securePrefs.getString(SessionManager.KEY_PASSWORD, null))
    }
}
