package com.xehuri.kinship.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.xehuri.kinship.service.DataCollectorService
import timber.log.Timber
import java.util.concurrent.TimeUnit

/**
 * WidgetSyncWorker - AI 提醒卡 WorkManager 周期兜底通道
 *
 * 机制镜像原演示轮询 Worker（演示波已删）：App 进程被杀后唯一存活的 widget 数据通道；
 * 代价是周期地板 15 分钟（WorkManager MIN_PERIODIC_INTERVAL，再小被钳制），弱网/省电可漂移。
 * 与演示波的语义差异：不再需要用户在演示页手动开关——由 DataCollectorService.onCreate
 * 随服务启动即注册 unique periodic work，生产常驻兜底。
 *
 * 失败语义沿用"恒 Result.success()"：周期任务的下一轮由系统排程驱动、与本次返回值无关；
 * 特意不用 Result.retry()——retry 会在退避后**提前**重跑本轮，破坏 15 分钟节拍语义。
 */
class WidgetSyncWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        // 总开关停用：不联网同步，但仍 updateAll 刷一次——触发重组、渲染端现读标志换占位卡
        if (!DataCollectorService.isWidgetsEnabled(context)) {
            runCatching { ReminderWidget().updateAll(context) }
            return Result.success()
        }
        if (ReminderStore.syncFromServer(context)) {
            runCatching { ReminderWidget().updateAll(context) }
        } else {
            // syncFromServer 内部已记 Timber.w；这里只留通道观测点，网络失败下轮系统排程自然重试
            Timber.w("WidgetSyncWorker 本轮提醒同步未成功（保留旧缓存，下轮再试）")
        }
        return Result.success()
    }

    companion object {
        /** unique work 名：KEEP 策略下同名任务已存在则保留（幂等，服务反复启动不重置节拍） */
        const val WORK_NAME = "widget_reminder_sync"

        /**
         * 注册 15 分钟周期兜底（服务启动即调，幂等）。
         * 不声明网络约束——同步走既有 AppHttpClient 通道，失败静默下轮再试即可；
         * 加 CONNECTIVITY 约束只会让排程更保守，收益为零。
         */
        fun schedule(context: Context) {
            runCatching {
                val request = PeriodicWorkRequestBuilder<WidgetSyncWorker>(15, TimeUnit.MINUTES).build()
                WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
                    WORK_NAME,
                    ExistingPeriodicWorkPolicy.KEEP,
                    request,
                )
            }.onFailure { Timber.w("提醒兜底通道注册失败: ${it.message}") }
        }
    }
}
