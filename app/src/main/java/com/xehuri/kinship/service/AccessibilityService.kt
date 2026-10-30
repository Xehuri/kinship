package com.xehuri.kinship.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityEvent

/**
 * AxeuhAccessibilityService - 无障碍服务
 * 提供 UI 树读取、模拟点击、手势操作等核心自动化能力
 * 注意：类名避免与父类 android.accessibilityservice.AccessibilityService 冲突
 */
class AxeuhAccessibilityService : AccessibilityService() {

    companion object {
        /** 当前运行的 AccessibilityService 实例（可能为 null） */
        @Volatile
        var currentInstance: AxeuhAccessibilityService? = null
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        currentInstance = this
        val info = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPES_ALL_MASK
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
            notificationTimeout = 100
        }
        serviceInfo = info
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // TODO: Wave 2 T6 - 事件 emit 到 SharedFlow
    }

    override fun onInterrupt() {
        // TODO: Wave 2 T6 - 中断处理
    }

    override fun onDestroy() {
        super.onDestroy()
        currentInstance = null
    }
}
