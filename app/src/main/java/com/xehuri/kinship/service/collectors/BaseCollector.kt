package com.xehuri.kinship.service.collectors

import android.content.Context
import timber.log.Timber
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.service.state.SensorStateHolder

/**
 * 所有传感器采集器的基类。
 *
 * 定义采集器的公共生命周期和共享依赖([Context], [SensorStateHolder], [AppHttpClient])。
 * 子类必须实现 [start] 和 [stop]。
 */
abstract class BaseCollector(
    protected val context: Context,
    protected val stateHolder: SensorStateHolder,
    protected val httpClient: AppHttpClient
) {

    /** 开始采集传感器数据。子类必须实现此方法。 */
    abstract fun start()

    /** 停止采集传感器数据。子类必须实现此方法。 */
    abstract fun stop()

    /** 此采集器是否已启用。默认返回 false，子类可覆盖。 */
    open val isEnabled: Boolean get() = false

    /** 此采集器当前是否正在运行（用于权限复核时判断是否需要启停）。默认 false，子类可覆盖。 */
    open val isRunning: Boolean get() = false

    /** 日志标签，默认使用类名。 */
    protected open val tag: String get() = this::class.java.simpleName

    /** 统一的错误处理方法。 */
    protected fun handleError(message: String, e: Exception? = null) {
        Timber.e(e, message)
    }
}
