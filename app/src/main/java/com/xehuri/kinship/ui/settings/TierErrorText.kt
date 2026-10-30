package com.xehuri.kinship.ui.settings

const val TIER_READ_ONLY_MESSAGE = "当前网络配置来自更高版本，暂时只能查看；请升级 App 后再编辑。"

/** 把 tier 写入失败的原生英文错误翻译成可直接展示的中文提示。 */
fun tierErrorMessage(error: Throwable?): String {
    val raw = error?.message?.trim().orEmpty()
    if (raw.isEmpty()) return "保存失败，请重试。"
    return when {
        raw.contains("tier config is read-only") -> TIER_READ_ONLY_MESSAGE
        raw.contains("no available tier") -> "没有可用连接层。"
        raw.contains("pinned tier not found") -> "请选择一个已启用的网络连接层。"
        raw.contains("pinned selection requires an active tier") -> "请先选择要钉住的连接层。"
        raw.contains("selection references unknown tier") -> "所选连接层已被删除，请重新选择。"
        raw.contains("tier label is blank") -> "连接层名称不能为空，请编辑该连接层补全名称。"
        raw.contains("duplicate tier id") -> "连接层标识重复，请删除后重新添加。"
        raw.contains("pinned tls requires at least one pin") -> "固定证书需要至少填写一个 SHA-256 指纹。"
        raw.contains("url is blank") -> "地址不能为空。"
        raw.contains("missing scheme") -> "地址缺少 http:// 或 https:// 前缀。"
        raw.contains("unsupported scheme") -> "只支持 http 或 https。"
        raw.contains("invalid url") -> "地址格式无效，请检查主机与端口。"
        raw.contains("path must not contain ..") -> "路径不能包含 ..。"
        raw.contains("userinfo is not allowed") -> "地址不能包含用户名或密码。"
        raw.contains("query is not allowed") -> "地址不能包含查询参数。"
        raw.contains("fragment is not allowed") -> "地址不能包含片段。"
        raw.contains("http is allowed only for loopback hosts") ->
            "HTTP 仅允许本机回环地址；远程请使用 HTTPS。"
        raw.contains("peer id is blank") -> "P2P 对端 ID 不能为空。"
        raw.contains("network tier requires a network target") ||
            raw.contains("p2p tier requires a peer target") ||
            raw.contains("p2p tier requires a network target") -> "连接层类型与目标不匹配。"
        raw.contains("tier id is blank") -> "连接层标识不能为空，请删除后重新添加。"
        raw.contains("tier order must be >= 0") -> "连接层排序无效，请重新排序。"
        else -> "保存失败，请检查填写内容后重试。"
    }
}
