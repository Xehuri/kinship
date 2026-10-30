package com.xehuri.kinship.util

import android.content.Context
import java.util.UUID

/**
 * 设备唯一标识提供器
 *
 * 在 SharedPreferences("axeuh_prefs") 中持久化一个随机 UUID，生成一次后不再变化。
 * 供两处使用，保证二者共享同一设备标识：
 *  - 通知下行 WebSocket：`/ws?...&client=native&device_id=<uuid>`
 *  - WebView 加载 SPA：`/mobile/?token=...&device_id=<uuid>&client=web`
 *
 * 后端据此实现 TTS 设备路由（哪台设备发消息，语音回复就回哪台）。
 */
object DeviceId {

    private const val PREFS_NAME = "axeuh_prefs"
    private const val KEY_DEVICE_UUID = "device_uuid"

    /** 读取或首次生成设备 UUID（SharedPreferences 线程安全） */
    fun get(context: Context): String {
        val prefs = context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val existing = prefs.getString(KEY_DEVICE_UUID, null)
        if (!existing.isNullOrEmpty()) return existing
        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_UUID, generated).apply()
        return generated
    }
}
