package com.xehuri.kinship.service.collectors

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Address
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import androidx.annotation.RequiresApi
import androidx.core.location.LocationManagerCompat
import timber.log.Timber
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.DataCollectorService
import com.xehuri.kinship.service.state.SensorStateHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import kotlin.coroutines.resume

/**
 * GPS 位置采集器 —— 从 [com.xehuri.kinship.service.DataCollectorService]
 * 提取的 GPS 定位采集。
 *
 * 默认使用 [LocationManager] 获取最后已知位置（latitude/longitude），
 * 以 `"latitude,longitude,accuracy"` 三元组字符串格式存储到 [SensorStateHolder]。
 * 与原始 DataCollectorService 的 JSON 字段名（"gps"）完全一致。
 *
 * 可选行为（均逐轮重读，设置页改动即时生效）：
 * - `gps_accuracy_priority`：provider 尝试顺序
 * - `gps_min_displacement_m`：最小位移过滤
 * - `gps_max_accuracy_m`：最大可接受精度
 * - `gps_fix_timeout_ms`：>0 时主动请求一次新鲜定位并等待，超时回退缓存（默认 0=关闭）
 * - `gps_reverse_geocode`：开启后把坐标解析为可读地址（默认关闭）
 *
 * 采集间隔：5 分钟（慢采集周期），通过协程循环实现。
 * 遵循 [BaseCollector] 生命周期：start() 启动循环，stop() 取消循环。
 *
 * ## 权限
 * 需要 `android.permission.ACCESS_FINE_LOCATION`。无权限时记录警告并跳过。
 */
class GpsCollector(
    context: Context,
    stateHolder: SensorStateHolder,
    httpClient: AppHttpClient
) : BaseCollector(context, stateHolder, httpClient) {

    companion object {
        /** 位置最大可接受年龄：10 分钟（AN-M3，超过视为过期缓存，丢弃） */
        private const val MAX_LOCATION_AGE_MS = 10 * 60 * 1000L

        /** 逆地理编码最长等待：3 秒（无地址服务/无网络时快速降级为「无地址」） */
        private const val GEOCODE_TIMEOUT_MS = 3_000L

        /** 地址最大长度（避免超长地址撑爆上行 payload） */
        private const val MAX_ADDRESS_CHARS = 120
    }

    /** 单次位置评估结论。 */
    private enum class LocationDecision {
        /** 位置可用，采纳 */
        ACCEPT,

        /** 位置不可用（过期/精度不足），尝试下一个来源 */
        REJECT,

        /** 位移不足，本轮不更新位置（视为已处理） */
        SKIP_DISPLACEMENT
    }

    // ── 系统服务（by lazy 避免构造时获取，便于测试） ──

    private val locationManager: LocationManager? by lazy {
        context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    }

    // ── 最小位移过滤基准 ──

    /** 上次采纳的纬度（null 表示尚未采纳过位置） */
    private var lastAcceptedLat: Double? = null

    /** 上次采纳的经度 */
    private var lastAcceptedLon: Double? = null

    // ── 协程生命周期 ──

    private var scope: CoroutineScope? = null

    override val isEnabled: Boolean
        get() = DataCollectorService.isGpsEnabled(context)

    override val isRunning: Boolean
        get() = scope != null

    /**
     * 启动 GPS 采集循环。
     * 间隔由 `gps_interval_ms` 决定（默认 5 分钟），每轮重新读取以便设置即时生效。
     * 重复调用安全（不会创建多个协程作用域）。
     */
    override fun start() {
        if (scope != null) return
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope!!.launch {
            Timber.i("GPS 采集已启动")
            while (isActive) {
                try {
                    // 逐轮复查开关：关闭后由 CollectorManager.applyToggle 停止
                    if (isEnabled) collectLocation()
                } catch (e: Exception) {
                    Timber.w("GPS 采集异常: ${e.message}")
                }
                // 每轮重读间隔键，使设置页改动即时生效
                delay(DataCollectorService.getGpsIntervalMs(context))
            }
        }
    }

    /**
     * 停止 GPS 采集循环。
     * 取消作用域会中断正在等待的主动定位（其 CancellationSignal 被取消，回调不再触发），
     * 不会泄漏 LocationListener。
     * 重复调用安全（cancel 空作用域不抛异常）。
     */
    override fun stop() {
        scope?.cancel()
        scope = null
        Timber.i("GPS 采集已停止")
    }

    // ======================== GPS 位置采集 ========================

    /**
     * 单次 GPS 位置采集。
     *
     * `internal`（包可见）以便测试直接调用。
     *
     * 采集流程：
     * 1. 检查 [LocationManager] 是否可用
     * 2. 检查 [Manifest.permission.ACCESS_FINE_LOCATION] 权限
     * 3. 若 `gps_fix_timeout_ms` > 0：主动请求一次新鲜定位并等待该时长；
     *    取得可用位置则直接采纳，超时/失败/被过滤则回退到第 4 步
     * 4. 按精度优先级决定的顺序依次尝试 PASSIVE / GPS / NETWORK provider 的最后已知位置
     * 5. 丢弃过期位置、精度差于 `gps_max_accuracy_m` 的位置
     * 6. 位移不足 `gps_min_displacement_m` 时本轮不更新
     * 7. 将结果以 `"latitude,longitude,accuracy"` 格式更新到 [SensorStateHolder]；
     *    若 `gps_reverse_geocode` 开启，另将地址写入独立的地址状态
     *
     * 与原始 DataCollectorService 的 GPS 缓存读取逻辑一致：
     * - 格式：`"${loc.latitude},${loc.longitude},${loc.accuracy}"`
     * - 默认（balanced）顺序：PASSIVE > GPS > NETWORK
     * - 无权限时清除旧值
     */
    internal suspend fun collectLocation() {
        val lm = locationManager ?: run {
            Timber.w("LocationManager 不可用，跳过定位")
            return
        }

        // 检查 ACCESS_FINE_LOCATION 权限
        if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Timber.w("GPS 无 ACCESS_FINE_LOCATION 权限")
            stateHolder.updateLastGps("")
            return
        }

        // 每轮重读行为选项，使设置页改动即时生效
        val maxAccuracyM = DataCollectorService.getGpsMaxAccuracyM(context).toFloat()
        val minDisplacementM = DataCollectorService.getGpsMinDisplacementM(context).toFloat()
        val fixTimeoutMs = DataCollectorService.getGpsFixTimeoutMs(context)
        val reverseGeocode = DataCollectorService.isGpsReverseGeocode(context)

        // ── 选项 1：主动等待一次新鲜定位（可取消，超时回退缓存）──
        if (fixTimeoutMs > 0L) {
            val fresh = awaitFreshFix(lm, fixTimeoutMs)
            if (fresh != null) {
                when (decideLocation("主动定位", fresh, maxAccuracyM, minDisplacementM)) {
                    LocationDecision.ACCEPT -> {
                        acceptLocation(fresh, "主动定位", reverseGeocode)
                        return
                    }
                    LocationDecision.SKIP_DISPLACEMENT -> return
                    LocationDecision.REJECT -> Timber.i("GPS 主动定位被过滤，回退缓存")
                }
            } else {
                Timber.i("GPS 主动定位超时或无结果，回退缓存")
            }
        }

        // ── 回退路径：按优先级顺序尝试各 provider 的缓存位置 ──
        for (provider in providerOrder()) {
            try {
                val loc = lm.getLastKnownLocation(provider) ?: continue
                when (decideLocation(provider, loc, maxAccuracyM, minDisplacementM)) {
                    LocationDecision.REJECT -> continue
                    LocationDecision.SKIP_DISPLACEMENT -> return
                    LocationDecision.ACCEPT -> {
                        acceptLocation(loc, provider, reverseGeocode)
                        return  // 找到可用位置即返回
                    }
                }
            } catch (_: SecurityException) {
                Timber.w("GPS 无权限访问 provider: $provider")
            } catch (_: Exception) {
                // 单个 provider 异常不干扰后续尝试
                Timber.w("GPS provider $provider 异常，尝试下一个")
            }
        }

        // 所有 provider 均无缓存位置
        Timber.w("GPS: 所有 provider 均无可用位置")
    }

    /**
     * 主动请求一次新鲜定位，最多等待 [timeoutMs]。
     *
     * 使用 [LocationManagerCompat.getCurrentLocation]（内部在 API 30+ 走系统
     * `getCurrentLocation`，低版本走兼容实现），回调投递到 IO 线程。
     *
     * 可取消性：协程被取消（如采集器 stop）时，[CancellationSignal.cancel] 被调用，
     * 系统注册的监听随即注销，不会泄漏；超时由 [withTimeoutOrNull] 统一处理。
     *
     * @return 拿到定位则返回，超时/无权限/异常返回 null（由调用方回退缓存）
     */
    private suspend fun awaitFreshFix(lm: LocationManager, timeoutMs: Long): Location? {
        val provider = freshFixProvider(lm)
        return withTimeoutOrNull(timeoutMs) {
            suspendCancellableCoroutine { cont ->
                val signal = CancellationSignal()
                cont.invokeOnCancellation { signal.cancel() }
                try {
                    LocationManagerCompat.getCurrentLocation(
                        lm,
                        provider,
                        signal,
                        Dispatchers.IO.asExecutor()
                    ) { location ->
                        if (cont.isActive) cont.resume(location)
                    }
                } catch (e: SecurityException) {
                    Timber.w("GPS 主动定位无权限: ${e.message}")
                    if (cont.isActive) cont.resume(null)
                } catch (e: Exception) {
                    Timber.w("GPS 主动定位失败: ${e.message}")
                    if (cont.isActive) cont.resume(null)
                }
            }
        }
    }

    /** 主动定位使用的 provider：跟随精度优先级顺序，取第一个已启用的 provider。 */
    private fun freshFixProvider(lm: LocationManager): String =
        providerOrder().firstOrNull { lm.isProviderEnabled(it) } ?: LocationManager.GPS_PROVIDER

    /**
     * 评估单个位置：过期/精度不足判定为 [LocationDecision.REJECT]，
     * 位移不足判定为 [LocationDecision.SKIP_DISPLACEMENT]，否则 [LocationDecision.ACCEPT]。
     */
    private fun decideLocation(
        provider: String,
        loc: Location,
        maxAccuracyM: Float,
        minDisplacementM: Float
    ): LocationDecision {
        // AN-M3: 按 loc.time 丢弃过期位置（time<=0 视为未知时间，不丢弃）
        val ageMs = if (loc.time > 0L) System.currentTimeMillis() - loc.time else 0L
        if (loc.time > 0L && ageMs > MAX_LOCATION_AGE_MS) {
            Timber.i("GPS($provider) 位置过期 ${ageMs / 1000}s，跳过")
            return LocationDecision.REJECT
        }
        // 精度阈值过滤：精度差于阈值的定位视为不可用，尝试下一个来源
        if (maxAccuracyM > 0f && loc.accuracy > maxAccuracyM) {
            Timber.i("GPS($provider) 精度 ${loc.accuracy}m 差于阈值 ${maxAccuracyM}m，跳过")
            return LocationDecision.REJECT
        }
        // 最小位移过滤：与上次采纳位置的距离不足阈值时本轮不更新
        if (minDisplacementM > 0f && isWithinMinDisplacement(loc, minDisplacementM)) {
            Timber.i("GPS($provider) 位移不足 ${minDisplacementM}m，跳过本轮更新")
            return LocationDecision.SKIP_DISPLACEMENT
        }
        return LocationDecision.ACCEPT
    }

    /** 精度优先级 -> provider 尝试顺序（默认 balanced 保持既有顺序）。 */
    private fun providerOrder(): List<String> =
        when (DataCollectorService.getGpsAccuracyPriority(context)) {
            DataCollectorService.GPS_PRIORITY_HIGH -> listOf(
                LocationManager.GPS_PROVIDER,
                LocationManager.PASSIVE_PROVIDER,
                LocationManager.NETWORK_PROVIDER
            )
            DataCollectorService.GPS_PRIORITY_LOW_POWER -> listOf(
                LocationManager.NETWORK_PROVIDER,
                LocationManager.PASSIVE_PROVIDER,
                LocationManager.GPS_PROVIDER
            )
            else -> listOf(
                LocationManager.PASSIVE_PROVIDER,
                LocationManager.GPS_PROVIDER,
                LocationManager.NETWORK_PROVIDER
            )
        }

    /** 与上次采纳位置的直线距离是否小于阈值（尚无基准时返回 false，即允许更新）。 */
    private fun isWithinMinDisplacement(loc: Location, minDisplacementM: Float): Boolean {
        val lastLat = lastAcceptedLat ?: return false
        val lastLon = lastAcceptedLon ?: return false
        val results = FloatArray(1)
        Location.distanceBetween(lastLat, lastLon, loc.latitude, loc.longitude, results)
        return results[0] < minDisplacementM
    }

    /**
     * 采纳一个位置：更新坐标状态、记录位移基准，并按需解析地址。
     *
     * 坐标格式保持 `"latitude,longitude,accuracy"` 不变；地址写入独立的
     * [SensorStateHolder.updateLastGpsAddress]，不混入坐标字符串。
     * 关闭逆地理编码或解析失败时写入空串，避免旧地址与新坐标错配。
     */
    private suspend fun acceptLocation(loc: Location, provider: String, reverseGeocode: Boolean) {
        val gpsStr = "${loc.latitude},${loc.longitude},${loc.accuracy}"
        stateHolder.updateLastGps(gpsStr)
        lastAcceptedLat = loc.latitude
        lastAcceptedLon = loc.longitude
        val address = if (reverseGeocode) resolveAddress(loc.latitude, loc.longitude) else null
        stateHolder.updateLastGpsAddress(address ?: "")
        Timber.i(
            "GPS($provider): ${loc.latitude},${loc.longitude} 精度=${loc.accuracy}m " +
                "addr=${address ?: "-"}"
        )
    }

    // ======================== 逆地理编码 ========================

    /**
     * 坐标 -> 可读地址。任何失败（无服务/无网络/超时/异常）都返回 null，
     * 由调用方降级为「无地址」，绝不影响坐标采集。
     */
    private suspend fun resolveAddress(lat: Double, lon: Double): String? {
        if (!Geocoder.isPresent()) return null
        return try {
            withTimeoutOrNull(GEOCODE_TIMEOUT_MS) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    awaitAddressApi33(lat, lon)
                } else {
                    // API 33 以下无异步重载，放 IO 线程执行阻塞调用
                    withContext(Dispatchers.IO) { fetchAddressBlocking(lat, lon) }
                }
            }
        } catch (e: Exception) {
            Timber.w("GPS 逆地理编码失败: ${e.message}")
            null
        }
    }

    /** API 33+ 的异步逆地理编码。 */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private suspend fun awaitAddressApi33(lat: Double, lon: Double): String? =
        suspendCancellableCoroutine { cont ->
            try {
                Geocoder(context, Locale.getDefault()).getFromLocation(
                    lat,
                    lon,
                    1,
                    object : Geocoder.GeocodeListener {
                        override fun onGeocode(addresses: MutableList<Address>) {
                            if (cont.isActive) {
                                cont.resume(addresses.firstOrNull()?.let { formatAddress(it) })
                            }
                        }

                        override fun onError(errorMessage: String?) {
                            if (cont.isActive) cont.resume(null)
                        }
                    }
                )
            } catch (e: Exception) {
                Timber.w("GPS 逆地理编码(异步)失败: ${e.message}")
                if (cont.isActive) cont.resume(null)
            }
        }

    /** API 33 以下的阻塞逆地理编码（调用方保证在 IO 线程）。 */
    private fun fetchAddressBlocking(lat: Double, lon: Double): String? =
        try {
            Geocoder(context, Locale.getDefault())
                .getFromLocation(lat, lon, 1)
                ?.firstOrNull()
                ?.let { formatAddress(it) }
        } catch (e: Exception) {
            Timber.w("GPS 逆地理编码(阻塞)失败: ${e.message}")
            null
        }

    /** [Address] -> 单行可读地址；优先首行，缺失时用行政区划拼接兜底。 */
    private fun formatAddress(address: Address): String? {
        val line = address.getAddressLine(0)
        if (!line.isNullOrBlank()) return line.take(MAX_ADDRESS_CHARS)
        val parts = listOfNotNull(
            address.adminArea,
            address.subAdminArea,
            address.locality,
            address.subLocality,
            address.thoroughfare,
            address.countryName
        ).filter { it.isNotBlank() }
        return if (parts.isEmpty()) null else parts.joinToString("").take(MAX_ADDRESS_CHARS)
    }
}
