package com.xehuri.kinship

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.webkit.ValueCallback
import android.net.http.SslError
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.ui.web.MobileChromeSpec
import com.xehuri.kinship.ui.web.WebViewReloadPolicy
import com.xehuri.kinship.web.WebThemeBridge
import com.xehuri.kinship.web.WebTokenBridge

/**
 * 手机端 WebView Activity — 全屏托管前端移动网页
 *
 * 布局：
 *   - WebView 填充整个屏幕，无原生底部导航
 *   - 底部导航由前端 HTML/CSS 在 WebView 内实现
 *
 * 导航逻辑：
 *   - 所有 5 个 tab（聊天/看板/文件/报告/设置）由前端 switchTab() 管理
 *   - 设置 tab 显示引导页，点击"打开系统设置"按钮触发 axeuh://open-settings
 *   - scheme 由 WebViewClient.shouldOverrideUrlLoading 拦截
 *   - 加载失败时显示本地资产错误页面
 */
class MobileActivity : ComponentActivity() {

    private var webViewRef: WebView? = null
    private var webViewDestroyed = false
    private var uploadMessage: ValueCallback<Array<Uri>>? = null
    private var baseUrl: String = ""

    /** token 以 prefs 为唯一真源（原生 401 重登会原地续期） */
    private val prefs by lazy { getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE) }

    /** 主页面是否已加载完成（决定 onResume 时能否安全推送 TTS 音量） */
    private var pageLoaded = false

    /** SPA 页面是否已加载完成（决定 token 注入时机，错误页不注入） */
    private var spaPageLoaded = false

    /** 用户点「暂时忽略」后暂停 token 注入，直到 axeuh://retry */
    private var tokenInjectionSuppressed = false

    internal lateinit var tokenBridge: WebTokenBridge
    internal lateinit var themeBridge: WebThemeBridge

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (uploadMessage != null) {
            val uris = if (result.resultCode == RESULT_OK && result.data != null) {
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            } else {
                null
            }
            uploadMessage?.onReceiveValue(uris)
            uploadMessage = null
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 先铺窗口 chrome 再 setContentView：避免系统栏按父主题（深色）短暂闪黑
        applyWindowChrome(MobileChromeSpec.resolve(isNightMode(), Build.VERSION.SDK_INT))

        // 返回键：WebView 可后退则后退，否则退出
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = webViewRef
                if (wv != null && wv.canGoBack()) {
                    wv.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        // token 不读 intent extra：prefs 是唯一真源，原生重登续期后 WebView 立即跟进
        baseUrl = intent.getStringExtra("baseUrl") ?: com.xehuri.kinship.config.ServerConfig.BASE_URL

        themeBridge = WebThemeBridge(
            isTrustedUrl = { webViewRef?.url?.startsWith(baseUrl) == true },
            onTheme = { applyWebTheme(it) },
        )

        val webView = WebView(this).apply {
            webViewRef = this
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )

            // 与窗口同色：WebView 首次绘制前默认白底，先铺暖纸/暖炭避免加载期黑边
            setBackgroundColor(ContextCompat.getColor(this@MobileActivity, R.color.kinship_web_bg))

            // WebView 配置
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                loadWithOverviewMode = true
                useWideViewPort = true
                setSupportZoom(true)
                allowFileAccess = true
                allowContentAccess = true
            }
            addJavascriptInterface(themeBridge, WebThemeBridge.INTERFACE_NAME)

            // Scheme 拦截 + 错误处理
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val requestUrl = request.url.toString()
                    when {
                        requestUrl.startsWith("axeuh://open-settings") -> {
                            startActivity(Intent(this@MobileActivity, SettingsActivity::class.java))
                            return true
                        }
                        requestUrl.startsWith("axeuh://open-debug") -> {
                            startActivity(Intent(this@MobileActivity, MainActivity::class.java).apply {
                                putExtra("showDebugPanel", true)
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            })
                            return true
                        }
                        requestUrl.startsWith("axeuh://retry") -> {
                            tokenInjectionSuppressed = false
                            view.loadUrl(buildMainUrl())
                            return true
                        }
                        requestUrl.startsWith("axeuh://ignore") -> {
                            // 暂时忽略：不带 token 加载 SPA，由前端 LoginOverlay 处理；
                            // 同时暂停注入，避免原生 token 覆盖用户的选择
                            tokenInjectionSuppressed = true
                            view.loadUrl(
                                "$baseUrl/mobile/?device_id=${com.xehuri.kinship.util.DeviceId.get(this@MobileActivity)}&client=web"
                            )
                            return true
                        }
                    }
                    return false
                }

                // 新导航开始：SPA 尚未就绪，暂停 token 注入直到 onPageFinished
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    spaPageLoaded = false
                }

                // 页面加载完成：标记就绪后同步一次 TTS 音量，并注入当前 token
                override fun onPageFinished(view: WebView, url: String?) {
                    super.onPageFinished(view, url)
                    pageLoaded = true
                    spaPageLoaded = url?.startsWith(baseUrl) == true
                    pushTtsVolume()
                    tokenBridge.injectNow()
                    if (spaPageLoaded) {
                        syncChromeFromWebTheme(view)
                        injectThemeObserver(view)
                    }
                }

                // 主页面加载失败 → 显示本地错误页面
                override fun onReceivedError(
                    view: WebView,
                    errorCode: Int,
                    description: String,
                    failingUrl: String?
                ) {
                    if (failingUrl?.startsWith(baseUrl) == true) {
                        val errorAsset = "file:///android_asset/error_page.html?code=$errorCode&msg=${Uri.encode(description)}"
                        view.loadUrl(errorAsset)
                    }
                }

                // HTTP 非200 → 显示本地错误页面
                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    errorResponse: WebResourceResponse
                ) {
                    val code = errorResponse.statusCode
                    val reqUrl = request.url.toString()
                    // 401 由前端 SPA 的 LoginOverlay 处理（含"暂时忽略"按钮），不替换页面
                    if (code == 401) return
                    // 其他错误（5xx等）才显示本地错误页
                    if ((code < 200 || code >= 300) && reqUrl.startsWith(baseUrl)) {
                        view.loadUrl("file:///android_asset/error_page.html?code=$code")
                    }
                }
            }

            // 文件上传支持（WebChromeClient 处理 <input type="file">）
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    uploadMessage = filePathCallback
                    val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                    fileChooserLauncher.launch(Intent.createChooser(intent, "选择文件"))
                    return true
                }
            }

            tokenBridge = WebTokenBridge(
                prefs = prefs,
                webViewProvider = { webViewRef },
                shouldInject = { !tokenInjectionSuppressed && spaPageLoaded },
            )
            tokenBridge.start()

            loadUrl(buildMainUrl())
        }

        setContentView(webView)
    }

    /** 系统是否夜间模式（MobileActivity 未拦截 uiMode，切换夜间会重建 Activity）。 */
    private fun isNightMode(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    /** 应用窗口/系统栏颜色、图标明暗、刘海与导航栏对比度设置。 */
    @Suppress("DEPRECATION")
    private fun applyWindowChrome(chrome: MobileChromeSpec.Chrome) {
        window.statusBarColor = chrome.statusBarArgb
        window.navigationBarColor = chrome.navigationBarArgb
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = chrome.lightStatusBars
            isAppearanceLightNavigationBars = chrome.lightNavigationBars
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = chrome.navigationBarContrastEnforced
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val cutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            } else {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = cutoutMode }
        }
    }

    /**
     * 读取 SPA 的实际主题并同步 chrome：网页内明暗选择可能与系统值不同。
     * 仅在 SPA 页面触发，本地错误页保持系统主题的初始值。
     */
    private fun syncChromeFromWebTheme(view: WebView) {
        try {
            view.evaluateJavascript(
                "(function(){try{return document.documentElement.dataset.theme||''}catch(e){return ''}})()"
            ) { raw ->
                val theme = MobileChromeSpec.fromDatasetTheme(raw) ?: return@evaluateJavascript
                applyWebTheme(theme)
            }
        } catch (_: Exception) {
            // WebView 已销毁：保留系统主题的初始 chrome
        }
    }

    /** 安装页面内 MutationObserver；与一次性读取不同，之后主题切换无需重载页面。 */
    private fun injectThemeObserver(view: WebView) {
        if (webViewDestroyed) return
        try {
            view.evaluateJavascript(themeBridge.observerScript(), null)
        } catch (_: Exception) {
            // WebView 已销毁：保留系统主题的初始 chrome
        }
    }

    private fun applyWebTheme(theme: MobileChromeSpec.WebTheme) {
        if (webViewDestroyed || isDestroyed) return
        val chrome = MobileChromeSpec.resolve(theme, Build.VERSION.SDK_INT)
        applyWindowChrome(chrome)
        webViewRef?.setBackgroundColor(chrome.windowBackgroundArgb)
    }

    /**
     * 从设置页返回时同步 TTS 音量。
     *
     * MobileActivity 打开 SettingsActivity 后并不销毁，返回时触发本回调；此时把
     * 最新的音量推入 WebView，使网页播放器即时生效，无需重新加载页面。
     */
    override fun onResume() {
        super.onResume()
        if (pageLoaded) {
            pushTtsVolume()
            tokenBridge.injectNow()
        }
        if (WebViewReloadPolicy.shouldReload(baseUrl, ServerConfig.BASE_URL)) {
            baseUrl = ServerConfig.BASE_URL
            webViewRef?.loadUrl(buildMainUrl())
        }
    }

    /** 读取当前 TTS 音量（0-100）并推入 WebView 全局钩子（网页端可不存在，静默忽略） */
    private fun pushTtsVolume() {
        val webView = webViewRef ?: return
        val volume = com.xehuri.kinship.service.DataCollectorService.getTtsVolume(this)
        try {
            webView.evaluateJavascript(
                "window.__axeuhSetTtsVolume && window.__axeuhSetTtsVolume($volume)",
                null
            )
        } catch (_: Exception) {
            // WebView 已销毁或尚未就绪；下次 onPageFinished / onResume 会重试
        }
    }

    /** 读取 prefs 中的最新 token（原生 401 重登会续期） */
    private fun currentAuthToken(): String = prefs.getString("auth_token", "").orEmpty()

    /**
     * 构造主页面 URL：每次现读 prefs，保证 retry 使用续期后的 token。
     *
     * device_id 供后端 TTS 设备路由识别同一台手机；tts_volume 是首屏兜底，
     * 之后由 onResume 实时同步。token 不 URL 编码（后端 token 为 token_urlsafe(32)）。
     */
    private fun buildMainUrl(): String {
        val token = currentAuthToken()
        val deviceId = com.xehuri.kinship.util.DeviceId.get(this)
        val ttsVolume = com.xehuri.kinship.service.DataCollectorService.getTtsVolume(this)
        val tokenPart = if (token.isNotEmpty()) "token=$token&" else ""
        return "$baseUrl/mobile/?${tokenPart}device_id=$deviceId&client=web&tts_volume=$ttsVolume"
    }

    override fun onDestroy() {
        if (::tokenBridge.isInitialized) tokenBridge.stop()
        if (::themeBridge.isInitialized) themeBridge.stop()
        pageLoaded = false
        val webView = webViewRef
        webViewRef = null
        webViewDestroyed = true
        webView?.apply {
            removeJavascriptInterface(WebThemeBridge.INTERFACE_NAME)
            destroy()
        }
        super.onDestroy()
    }
}
