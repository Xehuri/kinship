package com.xehuri.kinship

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import timber.log.Timber
import com.xehuri.kinship.logging.AxeuhTimberTree
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.service.DataCollectorService
import com.xehuri.kinship.ui.settings.SettingsLaunchReason

/**
 * 主 Activity — Kinship 启动入口
 *
 * 启动流程（不阻塞、不做前置网络检查）：
 * 1. 检查 SharedPreferences 中是否有 auth_token
 * 2. 无 token → 跳转 SettingsActivity（登录页），本次启动仅此一次
 * 3. 有 token → 直接跳转 MobileActivity（WebView 手机页）
 * 4. 服务不可用时由 MobileActivity 的本地错误页兜底
 * 5. 跳转后 finish() 自身，不留在回退栈
 *
 * 认证失效策略：运行时（后台采集/上传）收到 401 不再跳转，仅静默清除 token，
 * 避免打断用户操作；下次打开 App 再由此处路由到登录页。
 */
class MainActivity : ComponentActivity() {

    companion object {
        private const val TAG = "AxeuhMain"
    }

    /** Android 13+ 通知权限请求 */
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Log.i(TAG, "通知权限: ${if (granted) "已授予" else "已拒绝"}")
    }

    /** Android 13+ 申请通知权限（前台服务、通知轮询需要） */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // 安装启动图：冷启动到首帧期间显示深色启动图，替代白屏（须在 super.onCreate 之前调用）
        installSplashScreen()
        super.onCreate(savedInstanceState)

        Timber.plant(AxeuhTimberTree())
        ServerConfig.init(this)

        // 认证失效处理：运行时（后台采集/上传等）收到 401 不再跳转，避免打断用户操作。
        // 失效时由 AppHttpClient 静默清除 token，下次打开 App 由本页路由到设置页登录。
        AppHttpClient.resetAuthFailureFlag()

        // 全局未捕获异常处理：记录后委托给上一层处理器，保留系统默认崩溃行为（AN-M2）
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        if (previousHandler !is AxeuhCrashHandler) {
            Thread.setDefaultUncaughtExceptionHandler(AxeuhCrashHandler(previousHandler))
        }

        // Android 13+ 申请通知权限（前台服务通知需要）
        requestNotificationPermission()

        // 读取已保存的 token
        val prefs = getSharedPreferences("axeuh_prefs", MODE_PRIVATE)
        val token = prefs.getString("auth_token", null)
        val customUrl = ServerConfig.BASE_URL

        if (token.isNullOrEmpty()) {
            // 无 token → 跳转设置页登录（本次启动仅此一次，不阻塞）
            Log.i(TAG, "无 token，跳转设置页")
            startActivity(Intent(this, SettingsActivity::class.java).apply {
                putExtra(
                    SettingsActivity.EXTRA_LAUNCH_REASON,
                    SettingsLaunchReason.LOGIN_GATE.name
                )
            })
        } else {
            // 有 token → 直接进入 WebView，不做任何前置网络检查。
            // 服务不可用时由 MobileActivity 的本地错误页兜底，避免白屏等待。
            startActivity(Intent(this@MainActivity, MobileActivity::class.java).apply {
                putExtra("baseUrl", customUrl)
                putExtra("token", token)
            })
        }
        finish()

        // 延迟启动前台服务（等 Activity 完全进入前台后再启动，ColorOS 需要）
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                if (isRestartAudioRequested) {
                    // 用户点击「录音已中断」通知进入前台：显式重启音频采集链路
                    startDataCollectorWithRestart()
                } else {
                    startDataCollectorServiceIfEnabled()
                }
            } catch (e: Exception) {
                Log.e(TAG, "启动服务失败: ${e.message}", e)
            }
        }, 300)
    }

    /**
     * 通知点击复用已存在的 Activity 实例时（singleTop）再次进入此回调。
     * 只要携带 restart extra，就重新触发音频链路重启。
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(DataCollectorService.EXTRA_RESTART_AUDIO, false)) {
            startDataCollectorWithRestart()
        }
    }

    /** 启动 Intent 是否携带「重启音频」extra（来自「录音已中断」通知点击） */
    private val isRestartAudioRequested: Boolean
        get() = intent?.getBooleanExtra(DataCollectorService.EXTRA_RESTART_AUDIO, false) == true

    /** 如果之前开启了上传，启动 DataCollectorService */
    private fun startDataCollectorServiceIfEnabled() {
        try {
            if (DataCollectorService.isUploadEnabled(this)) {
                val intent = Intent(this, DataCollectorService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(intent)
                } else {
                    startService(intent)
                }
                Log.i(TAG, "自动启动 DataCollectorService（upload 已开启）")
            }
        } catch (_: Exception) { }
    }

    /**
     * 携带 force_restart 启动采集服务，触发音频链路重启。
     *
     * Android 12+ 禁止后台启动 microphone 类型前台服务，故只能由用户点击通知
     * 把 App 拉到前台后，在此前台上下文中重启采集。
     */
    private fun startDataCollectorWithRestart() {
        try {
            val intent = Intent(this, DataCollectorService::class.java).apply {
                putExtra("force_restart", true)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            Log.i(TAG, "已请求重启音频采集链路")
        } catch (e: Exception) {
            Log.e(TAG, "重启音频采集失败: ${e.message}", e)
        }
    }
}

/**
 * 全局未捕获异常处理器（AN-M2）
 *
 * 记录异常日志后调用上一层默认处理器，确保崩溃上报/系统默认行为不被破坏。
 */
private class AxeuhCrashHandler(
    private val previous: Thread.UncaughtExceptionHandler?
) : Thread.UncaughtExceptionHandler {
    override fun uncaughtException(thread: Thread, e: Throwable) {
        Log.e(TAG, "全局未捕获异常: ${e.message}", e)
        previous?.uncaughtException(thread, e)
    }

    companion object {
        private const val TAG = "AxeuhCrash"
    }
}
