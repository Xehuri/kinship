package com.xehuri.kinship.service.collectors

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import timber.log.Timber
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.DataCollectorService
import com.xehuri.kinship.service.state.SensorStateHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 健康数据采集器 —— 从 Gadgetbridge SQLite 数据库读取手环健康数据。
 *
 * 采集内容（5分钟间隔/慢采集）：
 * 1. 心率 (heart rate)
 * 2. 步数 (steps)
 * 3. 压力 (stress)
 * 4. 血氧饱和度 (SpO2)
 *
 * 使用 copy-then-read-then-delete-temp-file 模式读取 Gadgetbridge 数据库，
 * 避免长时间持有数据库锁。
 * 支持增量同步（通过 last_sync_ts 锚点）。
 * 更新 SensorStateHolder 的状态并通过 AppHttpClient 上传到 health 端点。
 */
class HealthDataCollector(
    context: Context,
    stateHolder: SensorStateHolder,
    httpClient: AppHttpClient
) : BaseCollector(context, stateHolder, httpClient) {

    companion object {
        private const val PREFS_SENSORS = "sensor_toggles"
        private const val KEY_DB_PATH = "gadgetbridge_db_path"
        private const val DEFAULT_DB_PATH = "/storage/emulated/0/Android/data/nodomain.freeyourgadget.gadgetbridge/files/Gadgetbridge"
        private const val LEGACY_DB_PATH = "/storage/emulated/0/Gadgetbridge.db"
        private const val KEY_LAST_SYNC_TS = "last_sync_ts"
        private const val KEY_DB_URI = "gadgetbridge_db_uri"
    }

    private var scope: CoroutineScope? = null

    /** 采集互斥锁：防止「定时时段调度触发」与「内部间隔循环」重叠执行。 */
    private val collectMutex = Mutex()

    override val isEnabled: Boolean
        get() = DataCollectorService.isHealthEnabled(context)

    override val isRunning: Boolean
        get() = scope != null

    override fun start() {
        if (scope != null) return
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope!!.launch {
            Timber.i("健康数据采集已启动")
            while (isActive) {
                try {
                    // 逐轮复查开关：关闭后由 CollectorManager.applyToggle 停止
                    if (isEnabled &&
                        DataCollectorService.getHealthUploadMode(context) != DataCollectorService.HEALTH_MODE_SCHEDULE
                    ) {
                        // 间隔模式由本循环触发；定时时段模式交由服务调度器触发
                        val ok = collectNow()
                        if (!ok) Timber.w("健康数据采集未成功，保留锚点待下次重试")
                    }
                } catch (e: Exception) {
                    Timber.w("健康数据采集异常: ${e.message}")
                }
                // 每轮重读间隔键，使设置页改动即时生效
                delay(DataCollectorService.getHealthIntervalMs(context))
            }
        }
    }

    override fun stop() {
        scope?.cancel()
        scope = null
        Timber.i("健康数据采集已停止")
    }

    /**
     * 带互斥的一次采集入口（供内部循环与服务调度器共用）。
     *
     * 若已有采集在执行则直接跳过（返回 true，避免误报失败），保证
     * 「定时时段触发」与「间隔循环」不会并发访问同一个临时 DB。
     */
    suspend fun collectNow(): Boolean {
        if (!collectMutex.tryLock()) {
            Timber.d("健康采集已在执行，跳过本次触发")
            return true
        }
        return try {
            collectHealthData()
        } catch (e: Throwable) {
            // 本入口由服务调度器调用，任何异常都不能外泄，否则会中断后续调度
            Timber.w("健康采集异常: ${e.message}")
            false
        } finally {
            collectMutex.unlock()
        }
    }

    /**
     * 供 [com.xehuri.kinship.service.DataCollectorService] 调度器调用：
     * 确保采集器运行态后，在其 IO 作用域异步执行一次带互斥的采集。
     */
    fun requestCollect() {
        if (scope == null) start()
        scope?.launch {
            try {
                collectNow()
            } catch (e: Exception) {
                Timber.w("调度触发健康采集异常: ${e.message}")
            }
        }
    }

    // ── 数据库路径配置 ──

    /** 获取 Gadgetbridge DB 文件路径，按优先级：用户配置 > 自动检测 */
    private fun getDbFilePath(): String {
        val prefs = context.getSharedPreferences(PREFS_SENSORS, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_DB_PATH, null)
        if (saved != null) return saved

        // 自动检测：优先 Gadgetbridge 原生路径，回退旧版 .db 路径
        if (File(DEFAULT_DB_PATH).exists()) return DEFAULT_DB_PATH
        if (File(LEGACY_DB_PATH).exists()) return LEGACY_DB_PATH
        return DEFAULT_DB_PATH  // 不存在也返回默认值，由调用方处理
    }

    private fun getDbFile(): File = File(getDbFilePath())

    // ── 增量同步锚点 ──

    private fun getLastSyncTs(): Long {
        return context.getSharedPreferences("data_collector", Context.MODE_PRIVATE)
            .getLong(KEY_LAST_SYNC_TS, 0L)
    }

    private fun setLastSyncTs(ts: Long) {
        context.getSharedPreferences("data_collector", Context.MODE_PRIVATE)
            .edit().putLong(KEY_LAST_SYNC_TS, ts).apply()
    }

    // ── 主采集流程 ──

    /**
     * 单次健康数据采集。
     * 1. 优先通过 content URI（SAF 持久化）复制 Gadgetbridge DB 到临时文件
     * 2. 回退：直接文件路径读取
     * 3. 打开临时 DB 并处理数据
     * 4. 删除临时文件
     *
     * @return 采集并处理成功返回 true；DB 不可用或处理失败返回 false
     */
    private suspend fun collectHealthData(): Boolean {
        // 临时文件构建本身也可能抛异常（如 cacheDir 不可用），统一纳入 try 兜底
        var tmpDb: File? = null
        return try {
            val tmp = File(context.cacheDir, "gb_health_${System.currentTimeMillis()}.db")
            tmpDb = tmp
            if (!copyDbToTemp(tmp)) return false

            val db = SQLiteDatabase.openDatabase(
                tmp.absolutePath, null, SQLiteDatabase.OPEN_READONLY
            )
            db.use { processHealthData(it) }
        } catch (e: Exception) {
            Timber.w("健康数据采集失败: ${e.message}")
            false
        } finally {
            tmpDb?.delete()
        }
    }

    /** 将 Gadgetbridge DB 复制到临时文件。优先使用 SAF content URI，回退直接文件路径。 */
    private fun copyDbToTemp(tmpDb: File): Boolean {
        // 1) 尝试通过 SAF content URI 读取（Android 11+ 持久化权限）
        val dbUriStr = context.getSharedPreferences(PREFS_SENSORS, Context.MODE_PRIVATE)
            .getString(KEY_DB_URI, null)
        if (dbUriStr != null) {
            try {
                val uri = android.net.Uri.parse(dbUriStr)
                val inputStream = context.contentResolver.openInputStream(uri)
                if (inputStream != null) {
                    inputStream.use { src ->
                        tmpDb.outputStream().use { dst -> src.copyTo(dst) }
                    }
                    Timber.i("通过 content URI 复制 DB 成功")
                    return true
                }
            } catch (e: Exception) {
                Timber.w("content URI 读取失败: ${e.message}，回退文件路径")
            }
        }

        // 2) 回退：直接读取文件路径
        val dbFile = getDbFile()
        if (!dbFile.exists()) {
            Timber.w("Gadgetbridge DB 不存在: ${dbFile.absolutePath}")
            return false
        }
        dbFile.inputStream().use { src ->
            tmpDb.outputStream().use { dst -> src.copyTo(dst) }
        }
        Timber.i("通过文件路径复制 DB 成功")
        return true
    }

    /**
     * 处理从 Gadgetbridge DB 读取的健康数据。
     * 可直接在测试中使用 mock SQLiteDatabase 调用。
     *
     * 处理步骤：
     * 1. 读取最新心率、步数（当天总和）、压力、血氧
     * 2. 更新 SensorStateHolder
     * 3. 增量上传新数据到后端
     *
     * @return 处理成功返回 true（无新增数据也视为成功）
     */
    internal suspend fun processHealthData(db: SQLiteDatabase): Boolean {
        // 当天0点（北京时间）
        val cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"))
        cal.set(Calendar.HOUR_OF_DAY, 0)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        val todayMidnight = cal.timeInMillis / 1000

        // 1. 心率：最新有效值（30 < HR < 250）
        var heartRate = -1
        db.rawQuery(
            "SELECT TIMESTAMP, HEART_RATE FROM XIAOMI_ACTIVITY_SAMPLE " +
                "WHERE HEART_RATE > 30 AND HEART_RATE < 250 ORDER BY TIMESTAMP DESC LIMIT 1",
            null
        ).use { c ->
            if (c.moveToFirst()) {
                heartRate = c.getInt(1)
                Timber.i("心率: $heartRate bpm @ ts=${c.getLong(0)}")
            }
        }

        // 2. 步数：当天增量总和
        var steps = -1
        db.rawQuery(
            "SELECT SUM(STEPS) FROM XIAOMI_ACTIVITY_SAMPLE " +
                "WHERE STEPS > 0 AND TIMESTAMP >= $todayMidnight",
            null
        ).use { c ->
            if (c.moveToFirst()) {
                val totalSteps = c.getInt(0)
                if (totalSteps > 0) {
                    steps = totalSteps
                    Timber.i("步数(当天): $steps")
                }
            }
        }

        // 3. 压力：最新有效值（排除0）
        var stress = -1
        db.rawQuery(
            "SELECT TIMESTAMP, STRESS FROM XIAOMI_ACTIVITY_SAMPLE " +
                "WHERE STRESS > 0 ORDER BY TIMESTAMP DESC LIMIT 1",
            null
        ).use { c ->
            if (c.moveToFirst()) {
                stress = c.getInt(1)
                Timber.i("压力: $stress @ ts=${c.getLong(0)}")
            }
        }

        // 4. 血氧：最新有效值（排除无效值）
        var spo2 = -1
        db.rawQuery(
            "SELECT TIMESTAMP, SPO2 FROM XIAOMI_ACTIVITY_SAMPLE " +
                "WHERE SPO2 > 0 AND SPO2 < 100 ORDER BY TIMESTAMP DESC LIMIT 1",
            null
        ).use { c ->
            if (c.moveToFirst()) {
                spo2 = c.getInt(1)
                Timber.i("血氧: ${spo2}% @ ts=${c.getLong(0)}")
            }
        }

        // 更新状态
        if (heartRate > 0) stateHolder.updateHeartRate(heartRate)
        if (steps > 0) stateHolder.updateSteps(steps)
        if (stress > 0) stateHolder.updateStress(stress)
        if (spo2 > 0) stateHolder.updateSpo2(spo2)

        // 增量同步（返回是否成功，用于决定是否推进锚点）
        return uploadIncrementalData(db)
    }

    /**
     * 增量上传健康数据（基于 last_sync_ts 锚点）。
     * 查询时间戳大于锚点的新数据并上传到后端。
     *
     * 重要：仅在上传成功后推进锚点，否则失败数据会在下次同步时丢失。
     *
     * @return 上传成功（或无需上传）返回 true
     */
    private suspend fun uploadIncrementalData(db: SQLiteDatabase): Boolean {
        val lastSyncTs = getLastSyncTs()
        val samples = JSONArray()
        var maxTs = lastSyncTs
        var count = 0

        db.rawQuery(
            "SELECT TIMESTAMP, HEART_RATE, STEPS, STRESS, SPO2 FROM XIAOMI_ACTIVITY_SAMPLE " +
                "WHERE TIMESTAMP > ? - 86400 ORDER BY TIMESTAMP",
            arrayOf(lastSyncTs.toString())
        ).use { c ->
            while (c.moveToNext()) {
                val ts = c.getLong(0)
                val hr = c.getInt(1)
                val stepsVal = c.getInt(2)
                val stressVal = c.getInt(3)
                val spo2Val = c.getInt(4)
                if (hr <= 0 && stepsVal <= 0 && stressVal <= 0 && spo2Val <= 0) continue
                if (ts < 1_700_000_000L) continue
                val s = JSONObject()
                s.put("t", ts.toInt())
                try {
                    val sdf = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
                    s.put("t_iso", sdf.format(Date(ts * 1000L)))
                } catch (_: Exception) {}
                if (hr > 0) s.put("hr", hr)
                if (stepsVal > 0) s.put("steps", stepsVal)
                if (stressVal > 0) s.put("stress", stressVal)
                if (spo2Val > 0) s.put("spo2", spo2Val)
                samples.put(s)
                if (ts > maxTs) maxTs = ts
                count++
            }
        }

        // 读取睡眠数据（两遍查询：先读会话聚合，再读逐阶段细节）
        val sleepStages = JSONArray()
        var sleepDuration = 0
        var deepMin = 0
        var lightMin = 0
        var remMin = 0
        var awakeMin = 0

        // 第一遍：从 XIAOMI_SLEEP_TIME_SAMPLE 读取睡眠会话聚合指标
        // TIMESTAMP/WAKEUP_TIME 是毫秒，需 /1000 转为秒再与 lastSyncTs 比较
        val sleepSessions = mutableListOf<Pair<Long, Long>>()
        db.rawQuery(
            "SELECT TIMESTAMP, WAKEUP_TIME, TOTAL_DURATION, DEEP_SLEEP_DURATION, " +
                "LIGHT_SLEEP_DURATION, REM_SLEEP_DURATION, AWAKE_DURATION " +
                "FROM XIAOMI_SLEEP_TIME_SAMPLE " +
                "WHERE TIMESTAMP / 1000 > ? - 86400 * 2 ORDER BY TIMESTAMP",
            arrayOf(lastSyncTs.toString())
        ).use { c ->
            while (c.moveToNext()) {
                val tsMs = c.getLong(0)       // TIMESTAMP 毫秒
                val wakeupMs = c.getLong(1)    // WAKEUP_TIME 毫秒
                if (tsMs < 1_700_000_000_000L) continue
                val totalDur = c.getInt(2)
                val deepDur = c.getInt(3)
                val lightDur = c.getInt(4)
                val remDur = c.getInt(5)
                val awakeDur = c.getInt(6)
                sleepDuration += totalDur
                deepMin += deepDur
                lightMin += lightDur
                remMin += remDur
                awakeMin += awakeDur
                sleepSessions.add(Pair(tsMs, wakeupMs))
            }
        }

        // 第二遍：从 XIAOMI_SLEEP_STAGE_SAMPLE 读取逐阶段细节（每个睡眠会话范围内）
        for ((sessionStart, sessionEnd) in sleepSessions) {
            if (sessionStart <= 0L || sessionEnd <= 0L) continue
            db.rawQuery(
                "SELECT TIMESTAMP, STAGE FROM XIAOMI_SLEEP_STAGE_SAMPLE " +
                    "WHERE TIMESTAMP >= ? AND TIMESTAMP <= ? ORDER BY TIMESTAMP",
                arrayOf(sessionStart.toString(), sessionEnd.toString())
            ).use { c ->
                while (c.moveToNext()) {
                    val stageTs = c.getLong(0)
                    val stageType = c.getInt(1)
                    if (stageTs < 1_700_000_000_000L) continue
                    val sdf = SimpleDateFormat("HH:mm", Locale.getDefault())
                    val timeStr = sdf.format(Date(stageTs))
                    val stageObj = JSONObject()
                    stageObj.put("t", timeStr)
                    stageObj.put("stage", when (stageType) {
                        2 -> "deep"
                        3 -> "light"
                        4 -> "rem"
                        5 -> "awake"
                        else -> "unknown"
                    })
                    sleepStages.put(stageObj)
                }
            }
        }

        val sleepData: JSONObject? = if (sleepStages.length() > 0 || sleepDuration > 0) {
            JSONObject().apply {
                put("duration_min", sleepDuration)
                put("deep_min", deepMin)
                put("light_min", lightMin)
                put("rem_min", remMin)
                put("awake_min", awakeMin)
                put("stages", sleepStages)
            }
        } else null

        if (count > 0) {
            val uploaded = uploadToBackend(samples, sleepData)
            if (uploaded) {
                // 仅上传成功才推进锚点，失败则保留旧锚点下次重试（AN-H4）
                setLastSyncTs(maxTs)
                Timber.i("增量上传: $count 条, maxTs=$maxTs")
            } else {
                Timber.w("增量上传失败，保留锚点 $lastSyncTs 待下次重试")
            }
            return uploaded
        } else {
            Timber.d("无新增健康数据")
            return true
        }
    }

    /**
     * 通过 httpClient 上传健康数据到后端 health/sync 端点。
     *
     * @return 上传成功返回 true，异常返回 false
     */
    private suspend fun uploadToBackend(samples: JSONArray, sleepData: JSONObject? = null): Boolean {
        return try {
            val baseUrl = com.xehuri.kinship.config.ServerConfig.BASE_URL
            val healthUrl = "$baseUrl/api/health/sync"
            val body = JSONObject().apply {
                put("samples", samples)
                if (sleepData != null) put("sleep_data", sleepData)
                put("device_name", com.xehuri.kinship.config.ServerConfig.effectiveDeviceName)
            }
            httpClient.post(healthUrl, body.toString())
            Timber.i("健康数据已上传: ${samples.length()} 条${if (sleepData != null) " + 睡眠" else ""}")
            true
        } catch (e: Exception) {
            Timber.w("上传健康数据失败: ${e.message}")
            false
        }
    }
}
