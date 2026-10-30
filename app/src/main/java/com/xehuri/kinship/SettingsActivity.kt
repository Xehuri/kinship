@file:SuppressLint("SetTextI18n")

package com.xehuri.kinship

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.service.DataCollectorService
import com.xehuri.kinship.service.state.SensorStateHolder
import com.xehuri.kinship.ui.settings.AccountPage
import com.xehuri.kinship.ui.settings.AdvancedPage
import com.xehuri.kinship.ui.settings.AudioSettingsPage
import com.xehuri.kinship.ui.settings.BackgroundPage
import com.xehuri.kinship.ui.settings.CollectionControlPage
import com.xehuri.kinship.ui.settings.DevicePage
import com.xehuri.kinship.ui.settings.GpsSettingsPage
import com.xehuri.kinship.ui.settings.HealthDataPage
import com.xehuri.kinship.ui.settings.LoginNavigationPolicy
import com.xehuri.kinship.ui.settings.NetworkSettingsPage
import com.xehuri.kinship.ui.settings.NotificationPage
import com.xehuri.kinship.ui.settings.ensureServiceRunning
import com.xehuri.kinship.ui.settings.hasAccessibilityServiceEnabled
import com.xehuri.kinship.ui.settings.hasLocationPermission
import com.xehuri.kinship.ui.settings.hasNotificationListenerPermission
import com.xehuri.kinship.ui.settings.hasRuntimePermission
import com.xehuri.kinship.ui.settings.hasHealthDataAccess
import com.xehuri.kinship.ui.settings.OverviewState
import com.xehuri.kinship.ui.settings.OverviewSwitchKey
import com.xehuri.kinship.ui.settings.OverviewTarget
import com.xehuri.kinship.ui.settings.PermissionDialogs
import com.xehuri.kinship.ui.settings.RunStatusCard
import com.xehuri.kinship.ui.settings.RunStatusModel
import com.xehuri.kinship.ui.settings.RunStatusPage
import com.xehuri.kinship.ui.settings.SecurityPage
import com.xehuri.kinship.ui.settings.SettingsLaunchReason
import com.xehuri.kinship.ui.settings.SettingsNavRow
import com.xehuri.kinship.ui.settings.SettingsOverviewModel
import com.xehuri.kinship.ui.settings.SettingsSection
import com.xehuri.kinship.ui.settings.SettingsSectionDivider
import com.xehuri.kinship.ui.settings.SettingsSwitchNavRow
import com.xehuri.kinship.ui.settings.SettingsViewModel
import com.xehuri.kinship.ui.settings.SoundPage
import com.xehuri.kinship.ui.settings.SystemStateSettingsPage
import com.xehuri.kinship.ui.settings.VoiceprintSection
import com.xehuri.kinship.ui.settings.WakeWordSettingsPage
import com.xehuri.kinship.ui.settings.WidgetsSettingsPage
import com.xehuri.kinship.ui.theme.AxeuhSettingsTheme
import com.xehuri.kinship.ui.theme.SettingsAnim
import kotlinx.coroutines.delay

/**
 * 设置页面。
 *
 * Activity 只负责:
 * - 生命周期管理
 * - 创建 AppHttpClient / SensorStateHolder / SettingsViewModel 工厂
 * - 权限 launcher 声明（需要 Activity Context）
 *
 * UI 由 [SettingsRootScreen] 承载:
 * - 概览页：纯列表行（标题 + 摘要 + 箭头），点击进入对应子页面
 * - 子页面经 NavHost 导航，全程共享同一个图作用域 SettingsViewModel
 *
 * **交互约定（2026-09-16 重整）**：一级页面只放「列表行 + 开关」，详细配置一律在二级页；
 * 全App 设置页不再使用展开/折叠卡片（原 ExpandableSettingsCard 已无调用方）。
 */
class SettingsActivity : ComponentActivity() {

    companion object {
        const val EXTRA_LAUNCH_REASON = "settings_launch_reason"
    }

    /** Android 13+ 通知权限请求 */
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Log.i("Settings", "通知权限: ${if (granted) "已授予" else "已拒绝"}")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }

        // Android 13+ 申请通知权限（前台服务通知需要）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        // 创建依赖: 统一网络层 + 传感器状态（ViewModel 由图作用域惰性创建）
        val httpClient = AppHttpClient(this)
        val sensorStateHolder = SensorStateHolder.shared
        val viewModelFactory = SettingsViewModel.Factory(this, httpClient, sensorStateHolder)
        val launchReason = SettingsLaunchReason.fromExtra(
            intent?.getStringExtra(EXTRA_LAUNCH_REASON)
        )

        setContent {
            AxeuhSettingsTheme {
                SettingsRootScreen(
                    onBack = { finish() },
                    onOpenMainApp = {
                        startActivity(
                            Intent(this@SettingsActivity, MobileActivity::class.java).apply {
                                putExtra("baseUrl", ServerConfig.BASE_URL)
                            }
                        )
                        finishAffinity()
                    },
                    launchReason = launchReason,
                    viewModelFactory = viewModelFactory
                )
            }
        }
    }
}

// ─── 导航目的地 ─────────────────────────────────────────────────────

/** 设置导航图的路由名（图作用域 ViewModel 的宿主） */
private const val SETTINGS_GRAPH_ROUTE = "settings_graph"

private enum class SettingsDestination(val route: String) {
    Overview("settings_overview"),
    RunStatus("settings_run_status"),
    CollectionControl("settings_collection_control"),
    Notifications("settings_notifications"),
    HealthData("settings_health_data"),
    Widgets("settings_widgets"),
    Audio("settings_audio"),
    WakeWord("settings_wake_word"),
    Gps("settings_gps"),
    SystemState("settings_system_state"),
    Account("settings_account"),
    Network("settings_network"),
    Device("settings_device"),
    Background("settings_background"),
    Sound("settings_sound"),
    Security("settings_security"),
    Advanced("settings_advanced")
}

// ─── 根节点：NavHost + 共享 ViewModel ──────────────────────────────

/**
 * 设置根界面。
 *
 * 通过在导航图上取 `NavBackStackEntry`（图作用域）共享唯一的 [SettingsViewModel]，
 * 所有目的地与全局覆盖层（预览轮询 / 权限弹窗）复用同一实例。
 */
@Composable
fun SettingsRootScreen(
    onBack: () -> Unit,
    onOpenMainApp: () -> Unit,
    launchReason: SettingsLaunchReason,
    viewModelFactory: SettingsViewModel.Factory
) {
    val navController = rememberNavController()

    NavHost(
        navController = navController,
        startDestination = SettingsDestination.Overview.route,
        route = SETTINGS_GRAPH_ROUTE,
        // 子页面转场：统一使用 SettingsAnim 的快速时长，前进左滑入、返回右滑入
        enterTransition = {
            slideIntoContainer(
                towards = AnimatedContentTransitionScope.SlideDirection.Left,
                animationSpec = SettingsAnim.slideSpec
            )
        },
        exitTransition = {
            slideOutOfContainer(
                towards = AnimatedContentTransitionScope.SlideDirection.Left,
                animationSpec = SettingsAnim.slideSpec
            )
        },
        popEnterTransition = {
            slideIntoContainer(
                towards = AnimatedContentTransitionScope.SlideDirection.Right,
                animationSpec = SettingsAnim.slideSpec
            )
        },
        popExitTransition = {
            slideOutOfContainer(
                towards = AnimatedContentTransitionScope.SlideDirection.Right,
                animationSpec = SettingsAnim.slideSpec
            )
        }
    ) {
        composable(SettingsDestination.Overview.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            OverviewScreen(
                viewModel = vm,
                onBack = onBack,
                onOpenAccount = { navController.navigate(SettingsDestination.Account.route) },
                onOpenCollection = { navController.navigate(SettingsDestination.CollectionControl.route) },
                onOpenNotifications = { navController.navigate(SettingsDestination.Notifications.route) },
                onOpenHealthData = { navController.navigate(SettingsDestination.HealthData.route) },
                onOpenWidgets = { navController.navigate(SettingsDestination.Widgets.route) },
                onOpenAudio = { navController.navigate(SettingsDestination.Audio.route) },
                onOpenWakeWord = { navController.navigate(SettingsDestination.WakeWord.route) },
                onOpenGps = { navController.navigate(SettingsDestination.Gps.route) },
                onOpenSystemState = { navController.navigate(SettingsDestination.SystemState.route) },
                onOpenBackground = { navController.navigate(SettingsDestination.Background.route) },
                onOpenSecurity = { navController.navigate(SettingsDestination.Security.route) },
                onOpenDevice = { navController.navigate(SettingsDestination.Device.route) },
                onOpenSound = { navController.navigate(SettingsDestination.Sound.route) },
                onOpenNetwork = { navController.navigate(SettingsDestination.Network.route) },
                onOpenAdvanced = { navController.navigate(SettingsDestination.Advanced.route) },
                onOpenRunStatus = { navController.navigate(SettingsDestination.RunStatus.route) }
            )
        }

        composable(SettingsDestination.RunStatus.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            RunStatusPage(
                viewModel = vm,
                onBack = { navController.popBackStack() },
                onOpenDataCollection = {
                    navController.navigate(SettingsDestination.CollectionControl.route)
                },
                onOpenNetwork = { navController.navigate(SettingsDestination.Network.route) },
                onOpenBackground = { navController.navigate(SettingsDestination.Background.route) }
            )
        }

        composable(SettingsDestination.CollectionControl.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            CollectionControlPage(
                viewModel = vm,
                onBack = { navController.popBackStack() }
            )
        }

        composable(SettingsDestination.Audio.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            AudioSettingsPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.WakeWord.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            WakeWordSettingsPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Gps.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            GpsSettingsPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.SystemState.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            SystemStateSettingsPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Notifications.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            NotificationPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.HealthData.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            HealthDataPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Widgets.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            WidgetsSettingsPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Account.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            AccountPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Background.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            BackgroundPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Sound.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            SoundPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Security.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            SecurityPage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Device.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            DevicePage(viewModel = vm, onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Network.route) {
            NetworkSettingsPage(onBack = { navController.popBackStack() })
        }

        composable(SettingsDestination.Advanced.route) { entry ->
            val vm = sharedSettingsViewModel(navController, entry, viewModelFactory)
            AdvancedPage(viewModel = vm, onBack = { navController.popBackStack() })
        }
    }

    // ── 全局覆盖层 ────────────────────────────────────────────────
    // NavHost 首帧组合完成后导航图才建立，届时才能取到图作用域 entry。
    var graphReady by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { graphReady = true }
    if (graphReady) {
        val graphEntry = remember(navController) {
            navController.getBackStackEntry(SETTINGS_GRAPH_ROUTE)
        }
        val sharedViewModel: SettingsViewModel = viewModel(
            viewModelStoreOwner = graphEntry,
            factory = viewModelFactory
        )
        val isLoggedIn by sharedViewModel.isLoggedIn.collectAsState()
        var wasLoggedIn by remember { mutableStateOf(isLoggedIn) }
        LaunchedEffect(isLoggedIn) {
            if (LoginNavigationPolicy.shouldOpenMainApp(launchReason, wasLoggedIn, isLoggedIn)) {
                onOpenMainApp()
            }
            wasLoggedIn = isLoggedIn
        }
        // 全局传感器预览轮询（概览页与子页面共用）
        LaunchedEffect(sharedViewModel) {
            while (true) {
                sharedViewModel.refreshSensorPreviews()
                delay(2000)
            }
        }
        PermissionDialogs(viewModel = sharedViewModel)
    }
}

/** 从导航图作用域的 NavBackStackEntry 取唯一的 SettingsViewModel */
@Composable
private fun sharedSettingsViewModel(
    navController: NavHostController,
    entry: NavBackStackEntry,
    factory: SettingsViewModel.Factory
): SettingsViewModel {
    val graphEntry = remember(entry) {
        navController.getBackStackEntry(SETTINGS_GRAPH_ROUTE)
    }
    return viewModel(viewModelStoreOwner = graphEntry, factory = factory)
}

// ─── 概览页 ─────────────────────────────────────────────────────────

/**
 * 概览页：五段发丝行导航（部分行带行内开关）。
 *
 * 信息架构与摘要全部来自 [SettingsOverviewModel]（纯 Kotlin、可单测）；
 * 本组只负责收集状态、把行映射到导航/开关回调，并渲染分组。
 * 权限引导（无障碍 / 存储 / 麦克风 / 定位 / 通知监听）在本页处理，
 * 与旧的「数据采集」页行为一致。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OverviewScreen(
    viewModel: SettingsViewModel,
    onBack: () -> Unit,
    onOpenAccount: () -> Unit,
    onOpenCollection: () -> Unit,
    onOpenNotifications: () -> Unit,
    onOpenHealthData: () -> Unit,
    onOpenWidgets: () -> Unit,
    onOpenAudio: () -> Unit,
    onOpenWakeWord: () -> Unit,
    onOpenGps: () -> Unit,
    onOpenSystemState: () -> Unit,
    onOpenBackground: () -> Unit,
    onOpenSecurity: () -> Unit,
    onOpenDevice: () -> Unit,
    onOpenSound: () -> Unit,
    onOpenNetwork: () -> Unit,
    onOpenAdvanced: () -> Unit,
    onOpenRunStatus: () -> Unit
) {
    val context = LocalContext.current
    val widgetsEnabled by viewModel.widgetsEnabled.collectAsState()
    val uploadEnabled by viewModel.uploadEnabled.collectAsState()
    val cacheEnabled by viewModel.cacheEnabled.collectAsState()
    val healthEnabled by viewModel.healthEnabled.collectAsState()
    val audioEnabled by viewModel.audioEnabled.collectAsState()
    val wakeWordEnabled by viewModel.localKwsEnabled.collectAsState()
    val gpsEnabled by viewModel.gpsEnabled.collectAsState()
    val foregroundEnabled by viewModel.foregroundEnabled.collectAsState()
    val wifiEnabled by viewModel.wifiEnabled.collectAsState()
    val bluetoothEnabled by viewModel.bluetoothEnabled.collectAsState()
    val screenStateEnabled by viewModel.screenStateEnabled.collectAsState()
    val inputContentEnabled by viewModel.inputContentEnabled.collectAsState()
    val batteryEnabled by viewModel.batteryEnabled.collectAsState()
    val notificationEnabled by viewModel.notificationEnabled.collectAsState()
    val isLoggedIn by viewModel.isLoggedIn.collectAsState()
    val savedUsername by viewModel.savedUsername.collectAsState()
    val serverUrl by viewModel.serverUrl.collectAsState()
    val sslVerify by viewModel.sslVerify.collectAsState()
    val serviceRunning by viewModel.serviceRunning.collectAsState()
    val tierConfig by viewModel.tierConfig.collectAsState()
    val permissionChecks by viewModel.permissionChecks.collectAsState()
    val batteryOptimized by viewModel.batteryOptimized.collectAsState()
    val collectionInterval by viewModel.collectionInterval.collectAsState()
    val syncText by viewModel.syncStatusText.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshRunStatus() }

    // ── 权限引导弹窗状态 ──────────────────────────────────────────
    var showAccessibilityDialog by remember { mutableStateOf(false) }
    var showStoragePermissionDialog by remember { mutableStateOf(false) }
    var showNotificationListenerDialog by remember { mutableStateOf(false) }

    fun setHealthEnabled(enabled: Boolean) {
        viewModel.toggleSensor("health", enabled)
        ensureServiceRunning(context, enabled)
    }

    // ── 权限 Launcher ─────────────────────────────────────────────
    val audioPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            viewModel.toggleSensor("audio", true)
            ensureServiceRunning(context, true)
        }
        // 授权返回即刷新运行状态卡，避免待处理数停留在进入页面时的快照
        viewModel.refreshRunStatus()
    }

    val locationPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions()
    ) { /* 定位权限：用户授权后需再次点开关（与旧行为一致） */ }

    val accessibilitySettingsLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) {
        if (hasAccessibilityServiceEnabled(context)) {
            viewModel.toggleSensor("inputContent", true)
            ensureServiceRunning(context, true)
        }
        viewModel.refreshRunStatus()
    }

    val manageStorageLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) {
        if (hasHealthDataAccess(context)) {
            setHealthEnabled(true)
        }
        viewModel.refreshRunStatus()
    }

    val readStorageLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { _ ->
        if (hasHealthDataAccess(context)) {
            setHealthEnabled(true)
        }
        viewModel.refreshRunStatus()
    }

    val notificationListenerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) {
        if (hasNotificationListenerPermission(context)) {
            viewModel.setNotificationEnabled(true)
            ensureServiceRunning(context, true)
        }
        viewModel.refreshRunStatus()
    }

    /**
     * 概览页行内开关：与旧「数据采集」页逐项同口径。
     *
     * 需要权限的开关在未授权时只弹引导（或拉起系统授权），不提前写 prefs；
     * 授权返回后由对应 launcher 回填开关并拉起采集服务。
     */
    fun handleOverviewSwitch(key: OverviewSwitchKey, enabled: Boolean) {
        when (key) {
            OverviewSwitchKey.HEALTH -> {
                if (enabled && !hasHealthDataAccess(context)) {
                    showStoragePermissionDialog = true
                } else {
                    setHealthEnabled(enabled)
                }
            }

            OverviewSwitchKey.AUDIO -> {
                if (enabled && !hasRuntimePermission(
                        context,
                        android.Manifest.permission.RECORD_AUDIO
                    )
                ) {
                    audioPermissionLauncher.launch(android.Manifest.permission.RECORD_AUDIO)
                } else {
                    viewModel.toggleSensor("audio", enabled)
                    ensureServiceRunning(context, enabled)
                }
            }

            OverviewSwitchKey.WAKE_WORD -> {
                viewModel.setLocalKwsEnabled(enabled)
                if (enabled) ensureServiceRunning(context, true)
            }

            OverviewSwitchKey.GPS -> {
                if (enabled && !hasLocationPermission(context)) {
                    locationPermissionLauncher.launch(
                        arrayOf(
                            android.Manifest.permission.ACCESS_FINE_LOCATION,
                            android.Manifest.permission.ACCESS_COARSE_LOCATION
                        )
                    )
                } else {
                    viewModel.toggleSensor("gps", enabled)
                    ensureServiceRunning(context, enabled)
                }
            }

            OverviewSwitchKey.SYSTEM_STATE -> {
                viewModel.toggleSensor("foreground", enabled)
                viewModel.toggleSensor("wifi", enabled)
                viewModel.toggleSensor("bluetooth", enabled)
                viewModel.toggleSensor("screen", enabled)
                ensureServiceRunning(context, enabled)
            }

            OverviewSwitchKey.INPUT_CONTENT -> {
                if (enabled && !hasAccessibilityServiceEnabled(context)) {
                    showAccessibilityDialog = true
                } else {
                    viewModel.toggleSensor("inputContent", enabled)
                    ensureServiceRunning(context, enabled)
                }
            }

            OverviewSwitchKey.BATTERY -> viewModel.toggleSensor("battery", enabled)

            OverviewSwitchKey.NOTIFICATION -> {
                if (enabled && !hasNotificationListenerPermission(context)) {
                    showNotificationListenerDialog = true
                } else {
                    viewModel.setNotificationEnabled(enabled)
                    ensureServiceRunning(context, enabled)
                }
            }
        }
    }

    val systemStateEnabled =
        foregroundEnabled || wifiEnabled || bluetoothEnabled || screenStateEnabled

    val overviewState = OverviewState(
        uploadEnabled = uploadEnabled,
        healthEnabled = healthEnabled,
        notificationEnabled = notificationEnabled,
        widgetsEnabled = widgetsEnabled,
        isLoggedIn = isLoggedIn,
        username = savedUsername,
        serverUrl = serverUrl,
        sslVerify = sslVerify,
        serviceRunning = serviceRunning,
        networkLabel = RunStatusModel.activeTierLabel(tierConfig),
        networkMode = tierConfig.selection.mode.name,
        pendingPermissionCount = RunStatusModel.pendingRequiredCount(permissionChecks),
        batteryOptimized = batteryOptimized,
        cacheEnabled = cacheEnabled,
        audioEnabled = audioEnabled,
        wakeWordEnabled = wakeWordEnabled,
        gpsEnabled = gpsEnabled,
        systemStateEnabled = systemStateEnabled,
        inputContentEnabled = inputContentEnabled,
        batteryEnabled = batteryEnabled,
        syncText = syncText,
        collectionIntervalMs = collectionInterval.toLong()
    )
    val sections = SettingsOverviewModel.sections(overviewState)
    val statusCard = SettingsOverviewModel.statusCard(overviewState)
    val callbacks: Map<OverviewTarget, () -> Unit> = mapOf(
        OverviewTarget.COLLECTION_CONTROL to onOpenCollection,
        OverviewTarget.HEALTH_DATA to onOpenHealthData,
        OverviewTarget.AUDIO to onOpenAudio,
        OverviewTarget.WAKE_WORD to onOpenWakeWord,
        OverviewTarget.GPS to onOpenGps,
        OverviewTarget.SYSTEM_STATE to onOpenSystemState,
        OverviewTarget.NOTIFICATIONS to onOpenNotifications,
        OverviewTarget.WIDGETS to onOpenWidgets,
        OverviewTarget.NOTIFICATION_HISTORY to {
            context.startActivity(Intent(context, NotificationHistoryActivity::class.java))
        },
        OverviewTarget.ACCOUNT to onOpenAccount,
        OverviewTarget.NETWORK to onOpenNetwork,
        OverviewTarget.DEVICE to onOpenDevice,
        OverviewTarget.BACKGROUND to onOpenBackground,
        OverviewTarget.SOUND to onOpenSound,
        OverviewTarget.SECURITY to onOpenSecurity,
        OverviewTarget.ADVANCED to onOpenAdvanced,
        OverviewTarget.SYNC to { viewModel.syncNow() }
    )

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置", style = MaterialTheme.typography.titleLarge) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回"
                        )
                    }
                }
            )
        }
    ) { paddingValues ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)
        ) {
            item(key = "run_status") {
                RunStatusCard(
                    title = statusCard.title,
                    subtitle = statusCard.subtitle,
                    healthy = statusCard.healthy,
                    onClick = onOpenRunStatus
                )
            }
            sections.forEach { section ->
                item(key = section.title) {
                    SettingsSection(title = section.title) {
                        section.rows.forEachIndexed { index, row ->
                            if (index > 0) {
                                SettingsSectionDivider()
                            }
                            val switch = row.switch
                            when {
                                row.target == OverviewTarget.VOICEPRINT ->
                                    VoiceprintSection(viewModel = viewModel)

                                switch != null -> SettingsSwitchNavRow(
                                    title = row.title,
                                    subtitle = row.subtitle,
                                    checked = switch.checked,
                                    onCheckedChange = {
                                        handleOverviewSwitch(switch.key, it)
                                    },
                                    onClick = row.target?.let { callbacks[it] },
                                    enabled = switch.enabled
                                )

                                else -> SettingsNavRow(
                                    title = row.title,
                                    subtitle = row.subtitle,
                                    onClick = row.target?.let { callbacks[it] } ?: {}
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    // ── 权限引导弹窗 ──────────────────────────────────────────────

    if (showAccessibilityDialog) {
        AlertDialog(
            onDismissRequest = { showAccessibilityDialog = false },
            title = { Text("无障碍服务权限") },
            text = { Text("需要开启无障碍服务才能收集键盘输入内容。请在系统设置中为「Kinship」开启此权限。") },
            confirmButton = {
                Button(onClick = {
                    showAccessibilityDialog = false
                    accessibilitySettingsLauncher.launch(
                        Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    )
                }) { Text("去设置") }
            },
            dismissButton = {
                TextButton(onClick = { showAccessibilityDialog = false }) { Text("取消") }
            }
        )
    }

    if (showStoragePermissionDialog) {
        AlertDialog(
            onDismissRequest = { showStoragePermissionDialog = false },
            title = { Text("存储权限") },
            text = { Text("需要授予存储权限才能直接读取 Gadgetbridge 手环数据库。请在系统设置中为「Kinship」开启「所有文件访问权限」。") },
            confirmButton = {
                Button(onClick = {
                    showStoragePermissionDialog = false
                    if (Build.VERSION.SDK_INT >= 30) {
                        manageStorageLauncher.launch(
                            Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                                data = android.net.Uri.parse("package:${context.packageName}")
                            }
                        )
                    } else {
                        readStorageLauncher.launch(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    }
                }) { Text("去设置") }
            },
            dismissButton = {
                TextButton(onClick = { showStoragePermissionDialog = false }) { Text("取消") }
            }
        )
    }

    if (showNotificationListenerDialog) {
        AlertDialog(
            onDismissRequest = { showNotificationListenerDialog = false },
            title = { Text("通知监听权限") },
            text = { Text("需要开启「通知监听」权限才能读取系统通知内容。请在系统设置中为「Kinship」开启此权限。") },
            confirmButton = {
                Button(onClick = {
                    showNotificationListenerDialog = false
                    notificationListenerLauncher.launch(
                        Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                    )
                }) { Text("去设置") }
            },
            dismissButton = {
                TextButton(onClick = { showNotificationListenerDialog = false }) { Text("取消") }
            }
        )
    }
}
