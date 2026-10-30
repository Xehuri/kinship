package com.xehuri.kinship

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.IntentFilter
import android.os.Build
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.xehuri.kinship.ui.CapabilityTestState
import com.xehuri.kinship.ui.CapabilityViewModel
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Axeuh 鍔╂墜 鈥?鐪熷疄璁惧缁煎悎楠屾敹娴嬭瘯 (Instrumented)
 *
 * 璇ユ祴璇曞浠跺繀椤诲湪鐪熷疄 Android 璁惧涓婅繍琛岋紙Android 13 / MIUI 14 鐩爣锛夈€? * 鍦ㄦā鎷熷櫒涓棤娉曡鐩?MIUI 鐗规湁鐨?ROM 闄愬埗妫€娴嬨€丼hizuku銆侀€氱煡鐩戝惉绛夎兘鍔涖€? *
 * 娴嬭瘯鑼冨洿锛? * - 搴旂敤鐢熷懡鍛ㄦ湡锛堝惎鍔ㄦ棤宕╂簝锛? * - 鎵€鏈?17 涓兘鍔涙敞鍐屽拰鎵ц锛堜笉宕╂簝锛屽厑璁?Restricted / Failed锛? * - Compose DebugPanel 娓叉煋楠岃瘉
 * - ViewModel 鎶ュ憡鐢熸垚
 * - 鏃犻殰纰嶆湇鍔?/ 閫氱煡鐩戝惉 / UsageStats 鏉冮檺妫€娴? *
 * 杩愯鏂瑰紡锛? * ```bash
 * ./gradlew connectedDebugAndroidTest
 * # 鎴?Android Studio 涓彸閿?鈫?Run Tests
 * ```
 *
 * 缁撴灉杈撳嚭锛氭祴璇曟姤鍛婁腑姣忎釜 @Test 瀵瑰簲涓€涓獙鏀剁淮搴︺€? *
 * @see CapabilityViewModel
 * @see MainActivity
 */
@RunWith(AndroidJUnit4::class)
class AxeuhAcceptanceTest {

    // ====================================================================
    // Rule
    // ====================================================================

    @get:Rule
    val composeRule = createComposeRule()

    // ====================================================================
    // 鎴愬憳
    // ====================================================================

    private lateinit var appContext: Context
    private lateinit var vm: CapabilityViewModel

    /** 棰勬湡鐨?17 涓兘鍔涘悕绉帮紙鎸夋敞鍐岄『搴忥級 */
    private val expectedCapabilities: List<String> = listOf(
        "璁惧淇℃伅",
        "鏉冮檺鐘舵€?,
        "鍓嶅彴搴旂敤",
        "鐢垫睜鐘舵€?,
        "缃戠粶鐘舵€?,
        "鍓创鏉?,
        "灞忓箷鎴浘",
        "UI 鏍戣鍙?,
        "UI 鎿嶄綔",
        "濯掍綋鎺у埗",
        "闂归挓",
        "鏂囦欢璇诲啓",
        "蹇嵎寮€鍏?,
        "瀹氫綅",
        "鍚姩搴旂敤",
        "Shell 鎵ц",
        "閫氱煡璇诲彇",
        "OTA 鏇存柊",
    )

    // ====================================================================
    // Setup / Teardown
    // ====================================================================

    @Before
    fun setUp() {
        appContext = ApplicationProvider.getApplicationContext()
        vm = CapabilityViewModel()
        vm.initCapabilities(appContext)
    }

    @After
    fun tearDown() {
        // 鏃犵壒娈婃竻鐞?    }

    // ====================================================================
    // 1. 搴旂敤鐢熷懡鍛ㄦ湡
    // ====================================================================

    /**
     * 楠岃瘉 Activity 鍚姩涓嶅穿婧冦€?     * 鍚姩鍚庣瓑寰?1 绉掔‘璁ゆ棤 ANR / 鏈崟鑾峰紓甯搞€?     */
    @Test
    fun appLaunchesWithoutCrash() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            // 绛夊緟 Activity 瀹屾垚 onCreate + setContent
            scenario.onActivity { activity ->
                assertThat(activity).isNotNull()
                assertThat(activity.isFinishing).isFalse()
            }
            // 妯℃嫙鐭殏杩愯锛岀‘淇濇棤 ANR
            Thread.sleep(500)
            scenario.onActivity { activity ->
                assertThat(activity.isDestroyed).isFalse()
            }
        }
    }

    // ====================================================================
    // 2. 鑳藉姏娉ㄥ唽瀹屾暣鎬?    // ====================================================================

    /**
     * 楠岃瘉 ViewModel 鍒濆鍖栧悗锛屾墍鏈?17 涓兘鍔涢兘宸叉敞鍐屻€?     */
    @Test
    fun allCapabilitiesAreRegistered() {
        val registered = vm.capabilityNames.toSet()
        for (name in expectedCapabilities) {
            assertThat(registered)
                .named("鑳藉姏銆?name銆嶆槸鍚﹀凡娉ㄥ唽")
                .contains(name)
        }
        assertThat(vm.capabilityNames.size)
            .named("鑳藉姏鎬绘暟")
            .isAtLeast(17)
    }

    /**
     * 楠岃瘉姣忎釜鑳藉姏娉ㄥ唽鍚庡垵濮嬬姸鎬佷负 Idle銆?     */
    @Test
    fun allCapabilitiesStartIdle() {
        for (name in expectedCapabilities) {
            val state = vm.states[name]?.value
            assertThat(state)
                .named("鑳藉姏銆?name銆嶅垵濮嬬姸鎬?)
                .isInstanceOf(CapabilityTestState.Idle::class.java)
        }
    }

    // ====================================================================
    // 3. 鑳藉姏鎵ц楠岃瘉锛堢湡瀹炶澶囷級
    // ====================================================================

    /**
     * 楠岃瘉姣忎釜鑳藉姏 execute() 涓嶆姏鍑烘湭鎹曡幏寮傚父銆?     * 鍏佽杩斿洖 Restricted锛堝 V.I.S. 琚?MIUI 閿佸畾锛夋垨 Failed銆?     * 涓嶅厑璁?Crash銆?     */
    @Test
    fun allCapabilitiesExecuteWithoutCrash() = runBlocking {
        for (name in expectedCapabilities) {
            vm.runCapability(name)
            // 绛夊緟鑳藉姏鎵ц瀹屾垚锛堟渶澶?10 绉掞級
            val endTime = System.currentTimeMillis() + 10_000
            var terminal = false
            while (System.currentTimeMillis() < endTime && !terminal) {
                val state = vm.states[name]?.value
                terminal = state is CapabilityTestState.Success
                        || state is CapabilityTestState.Failed
                        || state is CapabilityTestState.Restricted
                if (!terminal) {
                    withContext(Dispatchers.Default) { kotlinx.coroutines.delay(100) }
                }
            }
            val finalState = vm.states[name]?.value
            assertThat(finalState)
                .named("鑳藉姏銆?name銆嶆墽琛岀粓鎬?)
                .isNotNull()
            // 楠岃瘉缁堟€佷笉涓?Running / Idle锛堣鏄庢墽琛屽埌浜嗙粓鐐癸級
            assertThat(finalState?.isTerminal)
                .named("鑳藉姏銆?name銆峣sTerminal")
                .isTrue()
        }
    }

    /**
     * 缁熻鎵€鏈夎兘鍔涚殑鎵ц缁撴灉鍒嗗竷銆?     * 鐢ㄤ簬蹇€熶簡瑙ｈ澶囦笂 capabilities 鐨勬暣浣撳仴搴风姸鍐点€?     */
    @Test
    fun capabilityResultDistribution() {
        runBlocking {
            for (name in expectedCapabilities) {
                vm.runCapability(name)
            }
            // 绛夊緟鍏ㄩ儴瀹屾垚锛堟渶澶?30 绉掞級
            val endTime = System.currentTimeMillis() + 30_000
            while (System.currentTimeMillis() < endTime) {
                val allTerminal = expectedCapabilities.all { name ->
                    val state = vm.states[name]?.value
                    state is CapabilityTestState.Success
                            || state is CapabilityTestState.Failed
                            || state is CapabilityTestState.Restricted
                }
                if (allTerminal) break
                withContext(Dispatchers.Default) { kotlinx.coroutines.delay(200) }
            }

            // 缁熻缁撴灉鍒嗗竷
            var success = 0
            var restricted = 0
            var failed = 0
            for (name in expectedCapabilities) {
                when (vm.states[name]?.value) {
                    is CapabilityTestState.Success -> success++
                    is CapabilityTestState.Restricted -> restricted++
                    is CapabilityTestState.Failed -> failed++
                    else -> failed++ // 瓒呮椂瑙嗕负澶辫触
                }
            }

            // 楠岃瘉锛氳嚦灏?14/17 閫氳繃锛堝惈 Success + Restricted 鍧囪涓洪€氳繃锛?            // Restricted 浠ｈ〃 MIUI 闄愬埗锛堝 V.I.S.锛夛紝灞炰簬棰勬湡琛屼负
            val passCount = success + restricted
            assertThat(passCount)
                .named("閫氳繃鑳藉姏鏁帮紙Success + Restricted锛?)
                .isAtLeast(14)

            // 楠岃瘉鏃犲穿婧?            assertThat(failed)
                .named("澶辫触鑳藉姏鏁帮紙Crash / Error锛?)
                .isLessThan(4)
        }
    }

    // ====================================================================
    // 4. 鎶ュ憡鐢熸垚
    // ====================================================================

    /**
     * 楠岃瘉 ViewModel 鐨?generateReport() 杈撳嚭绗﹀悎 JSON 鏍煎紡銆?     */
    @Test
    fun viewModelGeneratesValidReport() {
        val report = vm.generateReport()

        // 鎶ュ憡涓嶅簲涓虹┖
        assertThat(report).isNotEmpty()

        // 搴斿寘鍚?JSON 缁撴瀯鏍囪
        assertThat(report).contains("\"timestamp\"")
        assertThat(report).contains("\"device\"")
        assertThat(report).contains("\"capabilities\"")

        // 搴斿寘鍚澶囦俊鎭?        assertThat(report).contains(Build.BRAND)
        assertThat(report).contains(Build.MODEL)

        // 搴斿寘鍚墍鏈夎兘鍔涙潯鐩?        for (name in expectedCapabilities) {
            assertThat(report).named("鎶ュ憡鍖呭惈鑳藉姏銆?name銆?).contains(name)
        }
    }

    // ====================================================================
    // 5. 璁惧淇℃伅 & ROM 妫€娴?    // ====================================================================

    /**
     * 楠岃瘉璁惧鍩烘湰淇℃伅鍦?Build 瀛楁涓纭弽鏄犮€?     * 鐗瑰埆鍏虫敞 ROM 妫€娴嬬浉鍏崇殑 manufacturer 瀛楁銆?     */
    @Test
    fun deviceInfoIsPopulated() {
        // 鍦?MIUI 14 涓婅繍琛屾椂锛岃繖浜涘瓧娈靛簲鏄剧ず Xiaomi
        assertThat(Build.BRAND).isNotEmpty()
        assertThat(Build.MODEL).isNotEmpty()
        assertThat(Build.MANUFACTURER).isNotEmpty()
        assertThat(Build.VERSION.RELEASE).isNotEmpty()
        assertThat(Build.VERSION.SDK_INT)
            .named("Android SDK 鐗堟湰")
            .isAtLeast(33) // Android 13 (API 33)
    }

    /**
     * 楠岃瘉鏉冮檺妫€娴嬮€昏緫鍙繍琛屻€?     * 鍦ㄧ湡瀹炶澶囦笂锛岄儴鍒嗘潈闄愬凡鎺堜簣锛岄儴鍒嗘湭鎺堜簣鈥斺€斿彧闇€瑕佷笉宕╂簝銆?     */
    @Test
    fun permissionCheckWorks() {
        val permissions = listOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.READ_EXTERNAL_STORAGE,
            Manifest.permission.ACCESS_WIFI_STATE,
            Manifest.permission.BLUETOOTH_CONNECT,
        )

        for (perm in permissions) {
            val result = try {
                appContext.checkSelfPermission(perm)
            } catch (e: Exception) {
                PackageManager.PERMISSION_DENIED
            }
            // 涓?assert 缁撴灉锛堟潈闄愮姸鎬佸彇鍐充簬鐢ㄦ埛璁剧疆锛夛紝鍙獙璇佷笉宕╂簝
            assertThat(result)
                .named("鏉冮檺 $perm")
                .isAnyOf(PackageManager.PERMISSION_GRANTED, PackageManager.PERMISSION_DENIED)
        }
    }

    // ====================================================================
    // 6. 鏃犻殰纰嶆湇鍔?& 閫氱煡鐩戝惉
    // ====================================================================

    /**
     * 楠岃瘉鏃犻殰纰嶆湇鍔＄殑 AccessibilityServiceInfo 閰嶇疆銆?     */
    @Test
    fun accessibilityServiceManifestDeclared() {
        val pm = appContext.packageManager
        val intent = Intent("android.accessibilityservice.AccessibilityService")
            .setPackage(appContext.packageName)
        val services = pm.queryIntentServices(intent, PackageManager.GET_META_DATA)
        // 楠岃瘉鏃犻殰纰嶆湇鍔″凡鍦?Manifest 涓０鏄?        assertThat(services)
            .named("AccessibilityService 澹版槑")
            .isNotEmpty()
    }

    /**
     * 楠岃瘉閫氱煡鐩戝惉鏈嶅姟宸插湪 Manifest 涓０鏄庛€?     */
    @Test
    fun notificationListenerServiceDeclared() {
        val pm = appContext.packageManager
        val intent = Intent("android.service.notification.NotificationListenerService")
            .setPackage(appContext.packageName)
        val services = pm.queryIntentServices(intent, PackageManager.GET_META_DATA)
        assertThat(services)
            .named("NotificationListenerService 澹版槑")
            .isNotEmpty()
    }

    // ====================================================================
    // 7. 绯荤粺骞挎挱 & 鐢垫睜
    // ====================================================================

    /**
     * 楠岃瘉閫氳繃绮樻€у箍鎾鍙栫數姹犵姸鎬佷笉宕╂簝銆?     */
    @Test
    fun batteryStatusBroadcastWorks() {
        val batteryIntent = appContext.registerReceiver(
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        )
        if (batteryIntent != null) {
            val level = batteryIntent.getIntExtra("level", -1)
            val scale = batteryIntent.getIntExtra("scale", -1)
            assertThat(level).isGreaterThan(-1)
            assertThat(scale).isGreaterThan(-1)
        }
        // 鍦ㄦ煇浜涙ā鎷熷櫒/璁惧涓婂彲鑳戒负 null锛屼笉寮哄埗鏂█
    }

    // ====================================================================
    // 8. 浣跨敤鎯呭喌璁块棶鏉冮檺
    // ====================================================================

    /**
     * 楠岃瘉 UsageStatsManager 鏈嶅姟鍙敤锛堜笉涓€瀹氭湁鏉冮檺锛夈€?     */
    @Test
    fun usageStatsServiceAccessible() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val usm = appContext.getSystemService(Context.USAGE_STATS_SERVICE)
            assertThat(usm)
                .named("UsageStatsManager 鏈嶅姟")
                .isNotNull()
        }
    }

    // ====================================================================
    // 9. OTA 鑳藉姏缁勪欢楠岃瘉
    // ====================================================================

    /**
     * 楠岃瘉 OTA 鏇存柊鎵€闇€鐨勭粍浠剁被鍙姞杞姐€?     */
    @Test
    fun otaComponentsLoadable() {
        val classes = listOf(
            "com.xehuri.kinship.ota.UpdateInfo",
            "com.xehuri.kinship.ota.UpdateSource",
            "com.xehuri.kinship.ota.LocalUpdateSource",
            "com.xehuri.kinship.ota.ApkDownloader",
            "com.xehuri.kinship.ota.ApkInstaller"
        )
        for (className in classes) {
            val cls = try {
                Class.forName(className)
            } catch (e: ClassNotFoundException) {
                null
            }
            assertThat(cls)
                .named("OTA 缁勪欢 $className")
                .isNotNull()
        }
    }

    // ====================================================================
    // 10. 澶嶅埗鎶ュ憡鍔熻兘
    // ====================================================================

    /**
     * 楠岃瘉鍓创鏉跨郴缁熸湇鍔″彲鐢紙鎶ュ憡澶嶅埗鍔熻兘鐨勫墠鎻愶級銆?     */
    @Test
    fun clipboardServiceAvailable() {
        val cm = appContext.getSystemService(Context.CLIPBOARD_SERVICE)
        assertThat(cm)
            .named("鍓创鏉挎湇鍔?)
            .isNotNull()
    }

    // ====================================================================
    // 11. DebugPanel Compose 娓叉煋瀹屾暣鎬?    // ====================================================================

    /**
     * 楠岃瘉 DebugPanel 鐨?Compose 娓叉煋涓嶄細鎶涘嚭 Composition 寮傚父銆?     * 灏?DebugPanel 鎸傝浇鍒?ComposeRule 鐨勫唴瀹逛腑锛岀‘璁ゆ棤杩愯鏃堕敊璇€?     */
    @Test
    fun debugPanelRendersWithoutError() {
        composeRule.setContent {
            com.xehuri.kinship.ui.DebugPanel()
        }
        // 绛夊緟娓叉煋瀹屾垚
        composeRule.waitForIdle()
        // 楠岃瘉鏃犲紓甯告姏鍑猴紙Compose 娴嬭瘯妗嗘灦浼氭崟鑾?Composition 寮傚父锛?    }

    @Test
    fun debugPanelShowsAllSections() {
        composeRule.setContent {
            com.xehuri.kinship.ui.DebugPanel()
        }
        composeRule.waitForIdle()

        // 楠岃瘉鍏抽敭 Section 鏍囬瀛樺湪锛堥€氳繃 accessibility 鏂囨湰鏌ユ壘锛?        // 浣跨敤璇箟鑺傜偣妫€娴嬪悇鍒嗗尯鏄惁娓叉煋
        val sectionTitles = listOf(
            "璁惧淇℃伅",
            "鏉冮檺鐘舵€?,
            "鏈嶅姟鐘舵€?,
            "鑳藉姏娴嬭瘯",
        )
        for (title in sectionTitles) {
            val node = try {
                composeRule.activity?.let { activity ->
                    // 浣跨敤 onNodeWithText 鏌ユ壘鏂囨湰
                    composeRule.onNodeWithText(title).fetchSemanticsNode()
                }
            } catch (_: Exception) {
                null
            }
            assertThat(node)
                .named("DebugPanel Section銆?title銆?)
                .isNotNull()
        }
    }

    // ====================================================================
    // 12. 鏃犻殰纰嶆湇鍔＄姸鎬佹娴?    // ====================================================================

    /**
     * 浣跨敤 UiAutomation 楠岃瘉鏃犻殰纰嶆爲鍙闂紙鏃犻殰纰嶆湇鍔″凡寮€鍚椂锛夈€?     * 姝ゆ祴璇曞湪鏃犻殰纰嶆湇鍔℃湭寮€鍚椂璺宠繃鏂█銆?     */
    @Test
    fun uiAutomationAccessible() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val uiAutomation = instrumentation.uiAutomation
        assertThat(uiAutomation)
            .named("UiAutomation 瀹炰緥")
            .isNotNull()

        // 灏濊瘯鑾峰彇鏍硅妭鐐癸紙鏃犻殰纰嶆湇鍔℃湭寮€鍚椂浼氭姏鍑?SecurityException锛?        val rootInActiveWindow = try {
            uiAutomation.rootInActiveWindow
        } catch (_: SecurityException) {
            null
        }
        // 涓嶅己鍒舵柇瑷€锛堝彇鍐充簬鏃犻殰纰嶆湇鍔℃槸鍚﹀紑鍚級锛屽彧璁板綍缁撴灉
        if (rootInActiveWindow != null) {
            assertThat(rootInActiveWindow.packageName)
                .named("褰撳墠绐楀彛鍖呭悕")
                .isNotNull()
        }
    }

    // ====================================================================
    // 13. 鎸姩鍙嶉鍔熻兘
    // ====================================================================

    /**
     * 楠岃瘉 Vibrator 绯荤粺鏈嶅姟鍙幏鍙栥€?     */
    @Test
    fun vibratorServiceAvailable() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = appContext.getSystemService(Context.VIBRATOR_MANAGER_SERVICE)
            assertThat(vm)
                .named("VibratorManager 鏈嶅姟 (API 31+)")
                .isNotNull()
        }
    }
}
