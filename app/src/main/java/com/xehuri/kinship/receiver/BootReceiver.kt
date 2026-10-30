package com.xehuri.kinship.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.xehuri.kinship.service.DataCollectorService

/**
 * BootReceiver - 开机自启动
 *
 * 接收 BOOT_COMPLETED 广播后：若用户已开启上传，启动 [DataCollectorService]
 * 恢复后台采集（保活职责已并入该服务，全 App 仅此一条常驻前台服务）。
 *
 * 注意：BOOT_COMPLETED 是受保护的系统广播，第三方应用无法伪造，但「开机豁免」不等于
 * 「类型豁免」—— Android 14/15 起从 BOOT_COMPLETED 启动前台服务有类型白名单
 * （location | connectedDevice | remoteMessaging | health | systemExempted | specialUse），
 * 本服务的 microphone 不在其中（targetSdk 36 时 dataSync 也不在），故此处会抛
 * ForegroundServiceStartNotAllowedException 并被下方 catch 静默吞掉。
 * 即开机后不会自动恢复采集，需用户可见操作（打开 App，或点击「录音已中断」通知）。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (context == null) return
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return

        // 若上传已开启，恢复数据采集服务
        try {
            if (DataCollectorService.isUploadEnabled(context)) {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, DataCollectorService::class.java)
                )
                Log.i(TAG, "开机自启：DataCollectorService 已启动")
            }
        } catch (e: Exception) {
            Log.w(TAG, "开机启动 DataCollectorService 失败: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "AxeuhBoot"
    }
}
