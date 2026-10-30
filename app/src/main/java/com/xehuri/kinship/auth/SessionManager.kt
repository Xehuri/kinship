package com.xehuri.kinship.auth

import android.content.SharedPreferences
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.network.AppHttpClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface SessionState {
    data object LoggedOut : SessionState
    data object Authenticating : SessionState
    data class Authenticated(val origin: String, val username: String) : SessionState
    data class Expired(val origin: String) : SessionState
}

/**
 * 登录会话的唯一真源。
 *
 * token/username 落在明文 prefs（[KEY_TOKEN] / [KEY_USERNAME]），密码落在注入的加密 prefs
 * （[KEY_PASSWORD]）；本类只做读写与状态广播，不创建 EncryptedSharedPreferences、不发网络请求。
 *
 * 外部写入（例如 AppHttpClient.tryReAuth）会经 SharedPreferences 监听器反映到 [state]；
 * 401 且重登录失败时，AppHttpClient 的全局回调会驱动 [expire]。
 */
class SessionManager(
    private val prefs: SharedPreferences,
    private val securePrefsProvider: () -> SharedPreferences,
    private val originProvider: () -> String = { ServerConfig.BASE_URL }
) {
    companion object {
        const val KEY_TOKEN = "auth_token"
        const val KEY_USERNAME = "auth_username"
        const val KEY_PASSWORD = "auth_password"
    }

    private val _state = MutableStateFlow<SessionState>(SessionState.LoggedOut)
    val state: StateFlow<SessionState> = _state.asStateFlow()

    /** 最近一次失效来源；仅进程内保留，进程重启后无 token 即视为 LoggedOut。 */
    private var lastExpiredOrigin: String? = null

    private val unauthorizedHandler: () -> Unit = { expire(originProvider()) }

    private val preferenceListener =
        SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == KEY_TOKEN || key == KEY_USERNAME) {
                _state.value = load()
            }
        }

    init {
        _state.value = load()
        prefs.registerOnSharedPreferenceChangeListener(preferenceListener)
        AppHttpClient.onGlobalUnauthorized = unauthorizedHandler
    }

    fun load(): SessionState {
        val token = prefs.getString(KEY_TOKEN, null)
        return when {
            !token.isNullOrBlank() -> SessionState.Authenticated(
                origin = originProvider(),
                username = prefs.getString(KEY_USERNAME, null) ?: ""
            )
            lastExpiredOrigin != null -> SessionState.Expired(lastExpiredOrigin!!)
            else -> SessionState.LoggedOut
        }
    }

    fun save(origin: String, token: String, username: String, password: String?) {
        lastExpiredOrigin = null
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_USERNAME, username)
            .apply()
        if (password != null) {
            securePrefsProvider().edit()
                .putString(KEY_PASSWORD, password)
                .apply()
        }
        _state.value = load()
    }

    fun expire(origin: String) {
        lastExpiredOrigin = origin
        prefs.edit().remove(KEY_TOKEN).apply()
        _state.value = SessionState.Expired(origin)
    }

    fun logout() {
        lastExpiredOrigin = null
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_USERNAME)
            .apply()
        securePrefsProvider().edit()
            .remove(KEY_PASSWORD)
            .apply()
        _state.value = SessionState.LoggedOut
    }

    fun close() {
        prefs.unregisterOnSharedPreferenceChangeListener(preferenceListener)
        if (AppHttpClient.onGlobalUnauthorized === unauthorizedHandler) {
            AppHttpClient.onGlobalUnauthorized = null
        }
    }
}
