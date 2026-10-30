package com.xehuri.kinship.widget

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * WidgetSnapshot - 桌面组件数据桥（写侧 + 读侧单实现）
 *
 * 背景（docs/archive/research/research-android-widget-2026-10-12.md §3.3）：widget 视图树活在 launcher 进程，
 * 组合只运行约 45 秒且不会自动感知数据源变化；冷启动间隙（广播拉起进程时内存单例为空）
 * 决定了"快照落盘"是必需项而非优化。因此本 object 把 [com.xehuri.kinship.service.DataCollectorService]
 * 每轮 updateSnapshot() 聚合出的实时值写入**独立** prefs 文件，widget 组合与冷启动渲染都只读这里。
 *
 * 刻意与 data_collector 调参 prefs 分离：互不干扰、无淘汰逻辑、只存非敏感数值（严禁写入 token 等凭证）。
 */
object WidgetSnapshot {
    /** 独立 prefs 文件名（MODE_PRIVATE；provider 回调与 Service 同进程读写，无跨进程问题） */
    const val PREFS_NAME = "widget_snapshot"

    private const val KEY_HR = "hr"
    private const val KEY_STEPS = "steps"
    private const val KEY_COLLECTING = "collecting"
    private const val KEY_UPDATED_AT = "updated_at"

    /** 聚合卡显示档位（configureActivity 配置页写入） */
    const val MODE_FULL = "full"
    const val MODE_HR_ONLY = "hr_only"
    private const val KEY_SUMMARY_MODE = "summary_mode"

    /** 心率/步数无数据时的哨兵值（与 SensorStateHolder 的 -1 初值口径一致） */
    const val VALUE_NONE = -1

    /**
     * 写快照：updated_at 恒取当前时刻，widget 端渲染为 "更新于 HH:mm"。
     * apply() 异步落盘，采集主循环（默认 30s 一轮）调用无感。
     */
    fun write(context: Context, hr: Int, steps: Int, collecting: Boolean) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putInt(KEY_HR, hr)
            .putInt(KEY_STEPS, steps)
            .putBoolean(KEY_COLLECTING, collecting)
            .putLong(KEY_UPDATED_AT, System.currentTimeMillis())
            .apply()
    }

    /** 读心率：-1 表示尚无数据 */
    fun readHeartRate(context: Context): Int =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getInt(KEY_HR, VALUE_NONE)

    /** 读步数：-1 表示尚无数据 */
    fun readSteps(context: Context): Int =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getInt(KEY_STEPS, VALUE_NONE)

    /** 读采集运行状态 */
    fun readCollecting(context: Context): Boolean =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean(KEY_COLLECTING, false)

    /** 读快照时间戳（ms）：0 表示从未写过 */
    fun readUpdatedAt(context: Context): Long =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getLong(KEY_UPDATED_AT, 0L)

    /** 格式化 "更新于 HH:mm"；从未写过时显示占位符（冷启动首次钉选即命中此分支） */
    fun readUpdatedText(context: Context): String {
        val ts = readUpdatedAt(context)
        if (ts <= 0L) return "更新于 --:--"
        return "更新于 " + SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ts))
    }

    /** 一次性读取渲染所需全部字段（供 provideGlance 在 IO 线程取数） */
    fun readView(context: Context): WidgetSnapshotView = WidgetSnapshotView(
        heartRate = readHeartRate(context),
        steps = readSteps(context),
        collecting = readCollecting(context),
        updatedText = readUpdatedText(context),
        summaryMode = readSummaryMode(context),
    )

    /**
     * 仅刷新 updated_at（hr/steps/collecting 原值回写）。
     * 供写侧需要单独续期"更新于 HH:mm"时间戳时使用；receiver 回调窗口（约 10 秒）内
     * 这类 prefs 读写属轻活，网络等重活必须转投 Worker（研究报告 §1.1 动作约束）。
     */
    fun touch(context: Context) =
        write(context, readHeartRate(context), readSteps(context), readCollecting(context))

    /** 读聚合卡显示档位（缺省双指标；configureActivity 写入） */
    fun readSummaryMode(context: Context): String =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_SUMMARY_MODE, MODE_FULL) ?: MODE_FULL

    /** 写聚合卡显示档位（非法值归一 full，防手改 prefs 炸渲染） */
    fun writeSummaryMode(context: Context, mode: String) {
        val safe = if (mode == MODE_HR_ONLY) MODE_HR_ONLY else MODE_FULL
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_SUMMARY_MODE, safe).apply()
    }
}

/** 组件渲染视图：widget 组合消费的只读快照 */
data class WidgetSnapshotView(
    val heartRate: Int,
    val steps: Int,
    val collecting: Boolean,
    val updatedText: String,
    val summaryMode: String = WidgetSnapshot.MODE_FULL,
)

