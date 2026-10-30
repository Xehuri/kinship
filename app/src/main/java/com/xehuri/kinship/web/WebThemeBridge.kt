package com.xehuri.kinship.web

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import com.xehuri.kinship.ui.web.MobileChromeSpec

/**
 * SPA 主题到原生窗口 chrome 的单向桥。
 *
 * SPA 主题选择器只改 `<html data-theme>`，不会重新加载页面；[observerScript]
 * 在页面内安装 MutationObserver，把初始值与每次变化经 [INTERFACE_NAME] 回传，
 * 让状态栏/导航栏/WebView 底色立即跟随。只接受受信 URL 的回调。
 */
class WebThemeBridge(
    private val isTrustedUrl: () -> Boolean,
    private val onTheme: (MobileChromeSpec.WebTheme) -> Unit,
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) {

    /** 停止代际：stop() 递增后，已 post 但未执行的主题变更全部作废。 */
    @Volatile
    private var generation = 0

    /** 丢弃挂起回调；Activity 销毁时调用。 */
    fun stop() {
        generation++
    }

    /** 供 WebView 调用的入口；非法来源/主题静默忽略，合法主题回投主线程。 */
    @JavascriptInterface
    fun onThemeChanged(raw: String?) {
        val theme = MobileChromeSpec.fromDatasetTheme(raw) ?: return
        val expectedGeneration = generation
        mainHandler.post {
            if (generation != expectedGeneration) return@post
            // 来源校验读 WebView.url，只能在主线程执行；不合法的回调在此丢弃。
            if (!isTrustedUrl()) return@post
            onTheme(theme)
        }
    }

    /** 页面内观察器：幂等安装、先报当前主题、仅监听 data-theme 属性变化。 */
    fun observerScript(): String = """
        (function() {
            try {
                if (window.__axeuhThemeObserver) return;
                var bridge = window.$INTERFACE_NAME;
                if (!bridge || typeof bridge.onThemeChanged !== 'function') return;
                var root = document.documentElement;
                var send = function() {
                    try { window.$INTERFACE_NAME.onThemeChanged(root.dataset.theme || ''); } catch (e) {}
                };
                send();
                var observer = new MutationObserver(function(records) {
                    for (var i = 0; i < records.length; i++) {
                        if (records[i].attributeName === 'data-theme') { send(); return; }
                    }
                });
                observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
                window.__axeuhThemeObserver = observer;
            } catch (e) {}
        })();
    """.trimIndent()

    companion object {
        const val INTERFACE_NAME = "AxeuhTheme"
    }
}
