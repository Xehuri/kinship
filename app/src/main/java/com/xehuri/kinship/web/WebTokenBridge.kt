package com.xehuri.kinship.web

import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject

/**
 * 原生 token 到 WebView 的单向桥。
 *
 * 原生侧 401 自动重登后会把新 token 写回 axeuh_prefs；本桥监听该写入并立即把
 * token 注入当前 SPA（localStorage + axeuh-token-refresh 事件），免去重启页面。
 * 不做 last-injected 去重：重复注入幂等，且 SPA 登出后也能在下次注入时恢复。
 */
class WebTokenBridge(
    private val prefs: SharedPreferences,
    private val webViewProvider: () -> WebView?,
    private val shouldInject: () -> Boolean = { true },
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) : SharedPreferences.OnSharedPreferenceChangeListener {

    private var started = false

    /** 停止代际：stop() 递增后，已 post 但未执行的注入全部作废。 */
    private var generation = 0

    /** 幂等注册 prefs 监听。 */
    fun start() {
        if (started) return
        started = true
        prefs.registerOnSharedPreferenceChangeListener(this)
    }

    /** 幂等注销 prefs 监听，并丢弃任何挂起的注入。 */
    fun stop() {
        generation++
        if (!started) return
        started = false
        prefs.unregisterOnSharedPreferenceChangeListener(this)
    }

    override fun onSharedPreferenceChanged(sharedPreferences: SharedPreferences?, key: String?) {
        if (key != KEY_AUTH_TOKEN) return
        injectNow()
    }

    /** 在当前主线程回环上注入 token；空 token 或 shouldInject() 为 false 时跳过。 */
    fun injectNow() {
        val expectedGeneration = generation
        mainHandler.post {
            if (generation != expectedGeneration) return@post
            if (!shouldInject()) return@post
            val token = prefs.getString(KEY_AUTH_TOKEN, "").orEmpty()
            if (token.isEmpty()) return@post
            val webView = webViewProvider() ?: return@post
            try {
                webView.evaluateJavascript(buildTokenInjectionScript(token), null)
            } catch (_: Exception) {
                // WebView 已销毁：忽略，等下次页面加载或回到前台再注入
            }
        }
    }

    companion object {
        const val TOKEN_REFRESH_EVENT = "axeuh-token-refresh"
        const val KEY_AUTH_TOKEN = "auth_token"

        /** 生成注入脚本：写入 localStorage，并携带字符串 detail 派发刷新事件。 */
        fun buildTokenInjectionScript(token: String): String {
            val quoted = JSONObject.quote(token)
            return "(function() {" +
                "try { window.localStorage.setItem('mobile_token', $quoted); } catch (e) {}" +
                "window.dispatchEvent(new CustomEvent('$TOKEN_REFRESH_EVENT', { detail: $quoted }));" +
                "})();"
        }
    }
}
