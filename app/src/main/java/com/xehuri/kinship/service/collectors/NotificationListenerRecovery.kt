package com.xehuri.kinship.service.collectors

/**
 * 通知监听断连恢复策略（纯 Kotlin，无 Android 依赖，便于单测）。
 *
 * 处理「通知读取权限已授予，但系统未绑定 NotificationListenerService
 * （currentInstance == null）」的场景。策略按采集轮询节拍被调用：
 *
 * 1. **宽限期**：首次发现断连后的 [graceMs] 内不做任何动作，避免服务短暂重连
 *    或轮询抖动触发无谓的重绑和告警。
 * 2. **请求系统重绑**：权限仍在时，按 [rebindIntervalMs] 节流调用
 *    `NotificationListenerService.requestRebind`，尝试让系统重新绑定监听服务。
 * 3. **系统告警**：权限缺失（重绑无意义）或断连持续超过 [alertAfterMs] 时，
 *    发出可点击恢复的系统通知；同类告警按 [alertIntervalMs] 节流。
 *
 * 时间戳一律由调用方传入（生产用 `SystemClock.elapsedRealtime()`），
 * 本类不读取时钟，保证可测试。内部哨兵使用 [Long.MIN_VALUE] 而非 0L，
 * 因为 elapsedRealtime 在测试环境（Robolectric）中可能为 0。
 */
internal class NotificationListenerRecovery(
    /** 宽限期：断连持续不足该时长时不采取任何动作（ms） */
    private val graceMs: Long = 15_000L,
    /** 系统重绑请求的最小间隔（ms） */
    private val rebindIntervalMs: Long = 60_000L,
    /** 断连持续超过该时长后发出告警（ms） */
    private val alertAfterMs: Long = 120_000L,
    /** 同类告警的最小间隔（ms） */
    private val alertIntervalMs: Long = 15 * 60_000L,
) {

    /**
     * 单轮断连判定结果。
     *
     * [requestRebind] 为 true 表示本轮应请求系统重新绑定监听服务；
     * [showAlert] 为 true 表示本轮应弹出恢复提醒。
     */
    data class Decision(
        val requestRebind: Boolean = false,
        val showAlert: Boolean = false,
    )

    /** 是否处于断连状态（首次断连轮询时置 true） */
    private var broken = false

    /** 本轮断连的起始时间戳；未断连时为 [Long.MIN_VALUE] */
    private var missingSinceMs = Long.MIN_VALUE

    /** 上次请求系统重绑的时间戳；从未请求过为 [Long.MIN_VALUE] */
    private var lastRebindMs = Long.MIN_VALUE

    /** 上次告警的时间戳；从未告警过为 [Long.MIN_VALUE] */
    private var lastAlertMs = Long.MIN_VALUE

    /**
     * 记录一次成功连接。
     *
     * 若此前处于断连状态（[onDisconnected] 曾把 broken 置 true），返回 true，
     * 调用方可据此撤销告警；随后重置全部断连状态（含宽限期与两项节流计时）。
     * [nowMs] 仅为契约对称保留，当前实现不需要。
     */
    fun onConnected(nowMs: Long): Boolean {
        val wasBroken = broken
        broken = false
        missingSinceMs = Long.MIN_VALUE
        lastRebindMs = Long.MIN_VALUE
        lastAlertMs = Long.MIN_VALUE
        return wasBroken
    }

    /**
     * 记录一次断连轮询并返回本轮应执行的动作。
     *
     * [permissionGranted] 为通知读取权限的当前授予状态；权限缺失时不再请求重绑，
     * 改为直接告警引导用户重新授权。
     */
    fun onDisconnected(nowMs: Long, permissionGranted: Boolean): Decision {
        // 首次断连：记录起点，宽限期从此刻开始算
        if (!broken) {
            broken = true
            missingSinceMs = nowMs
        }

        // 宽限期内不采取任何动作，避免短暂断连触发重绑/告警
        if (nowMs - missingSinceMs < graceMs) return Decision()

        var requestRebind = false
        if (permissionGranted &&
            (lastRebindMs == Long.MIN_VALUE || nowMs - lastRebindMs >= rebindIntervalMs)
        ) {
            requestRebind = true
            lastRebindMs = nowMs
        }

        var showAlert = false
        if ((!permissionGranted || nowMs - missingSinceMs >= alertAfterMs) &&
            (lastAlertMs == Long.MIN_VALUE || nowMs - lastAlertMs >= alertIntervalMs)
        ) {
            showAlert = true
            lastAlertMs = nowMs
        }

        return Decision(requestRebind = requestRebind, showAlert = showAlert)
    }
}
