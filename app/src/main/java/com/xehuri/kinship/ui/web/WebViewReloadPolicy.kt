package com.xehuri.kinship.ui.web

/**
 * WebView 重载策略：仅当当前基址与最新基址都非空、且去掉尾部斜杠后不同才重载。
 *
 * 设置页改完连接层返回时，[com.xehuri.kinship.MobileActivity] 用它判断是否需要
 * 重新加载页面；地址相同（含仅差尾部斜杠）时保持现有页面与登录态不变。
 */
object WebViewReloadPolicy {
    fun shouldReload(currentBaseUrl: String, latestBaseUrl: String): Boolean {
        val current = currentBaseUrl.trim()
        val latest = latestBaseUrl.trim()
        if (current.isEmpty() || latest.isEmpty()) return false
        return current.trimEnd('/') != latest.trimEnd('/')
    }
}
