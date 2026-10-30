package com.xehuri.kinship.ui.settings

/** 设置页的启动原因：登录门禁（MainActivity 无 token 拉起）或用户主动打开。 */
enum class SettingsLaunchReason {
    LOGIN_GATE,
    MANUAL;

    companion object {
        fun fromExtra(raw: String?): SettingsLaunchReason =
            entries.firstOrNull { it.name.equals(raw?.trim(), ignoreCase = true) } ?: MANUAL
    }
}

/** 决定设置页在登录成功后是否自动进入主应用。 */
object LoginNavigationPolicy {
    fun shouldOpenMainApp(
        reason: SettingsLaunchReason,
        wasAuthenticated: Boolean,
        isAuthenticated: Boolean
    ): Boolean = reason == SettingsLaunchReason.LOGIN_GATE && !wasAuthenticated && isAuthenticated
}
