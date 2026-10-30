package com.xehuri.kinship.ui.settings

import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.transport.AddressFamily
import com.xehuri.kinship.transport.HttpAddress
import com.xehuri.kinship.transport.Tier
import com.xehuri.kinship.transport.TierConfig
import com.xehuri.kinship.transport.TierKind
import com.xehuri.kinship.transport.TierTarget
import com.xehuri.kinship.transport.TransportHint
import com.xehuri.kinship.transport.validate
import org.junit.Test

class TierErrorTextTest {

    private fun messageOf(raw: String): String = tierErrorMessage(IllegalArgumentException(raw))

    private val network = HttpAddress.parse("https://example.com").getOrThrow()

    private fun networkTier(
        id: String = "tier-1",
        order: Int = 0,
        label: String = "主线路",
        target: TierTarget = TierTarget.Network(network),
    ): Tier = Tier(
        id = id,
        order = order,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.DIRECT,
        target = target,
        family = AddressFamily.AUTO,
        label = label,
    )

    @Test
    fun `maps every known tier error to chinese`() {
        assertThat(messageOf("tier config is read-only"))
            .isEqualTo("当前网络配置来自更高版本，暂时只能查看；请升级 App 后再编辑。")
        assertThat(messageOf("no available tier"))
            .isEqualTo("没有可用连接层。")
        assertThat(messageOf("pinned tier not found"))
            .isEqualTo("请选择一个已启用的网络连接层。")
        assertThat(messageOf("pinned selection requires an active tier"))
            .isEqualTo("请先选择要钉住的连接层。")
        assertThat(messageOf("selection references unknown tier"))
            .isEqualTo("所选连接层已被删除，请重新选择。")
        assertThat(messageOf("tier label is blank"))
            .isEqualTo("连接层名称不能为空，请编辑该连接层补全名称。")
        assertThat(messageOf("duplicate tier id"))
            .isEqualTo("连接层标识重复，请删除后重新添加。")
        assertThat(messageOf("pinned tls requires at least one pin"))
            .isEqualTo("固定证书需要至少填写一个 SHA-256 指纹。")
        assertThat(messageOf("url is blank")).isEqualTo("地址不能为空。")
        assertThat(messageOf("missing scheme")).isEqualTo("地址缺少 http:// 或 https:// 前缀。")
        assertThat(messageOf("unsupported scheme: ftp")).isEqualTo("只支持 http 或 https。")
        assertThat(messageOf("invalid url")).isEqualTo("地址格式无效，请检查主机与端口。")
        assertThat(messageOf("path must not contain ..")).isEqualTo("路径不能包含 ..。")
        assertThat(messageOf("userinfo is not allowed")).isEqualTo("地址不能包含用户名或密码。")
        assertThat(messageOf("query is not allowed")).isEqualTo("地址不能包含查询参数。")
        assertThat(messageOf("fragment is not allowed")).isEqualTo("地址不能包含片段。")
        assertThat(messageOf("http is allowed only for loopback hosts"))
            .isEqualTo("HTTP 仅允许本机回环地址；远程请使用 HTTPS。")
        assertThat(messageOf("peer id is blank")).isEqualTo("P2P 对端 ID 不能为空。")
        assertThat(messageOf("network tier requires a network target"))
            .isEqualTo("连接层类型与目标不匹配。")
        assertThat(messageOf("p2p tier requires a peer target"))
            .isEqualTo("连接层类型与目标不匹配。")
        assertThat(messageOf("p2p tier requires a network target"))
            .isEqualTo("连接层类型与目标不匹配。")
        assertThat(messageOf("tier id is blank")).isEqualTo("连接层标识不能为空，请删除后重新添加。")
        assertThat(messageOf("tier order must be >= 0")).isEqualTo("连接层排序无效，请重新排序。")
    }

    @Test
    fun `handles null and blank errors`() {
        assertThat(tierErrorMessage(null)).isEqualTo("保存失败，请重试。")
        assertThat(tierErrorMessage(IllegalArgumentException())).isEqualTo("保存失败，请重试。")
        assertThat(messageOf("   ")).isEqualTo("保存失败，请重试。")
    }

    @Test
    fun `unknown raw message returns chinese fallback`() {
        assertThat(messageOf("boom")).isEqualTo("保存失败，请检查填写内容后重试。")
        assertThat(messageOf("Kein Netzwerk")).isEqualTo("保存失败，请检查填写内容后重试。")
    }

    @Test
    fun `matches known messages embedded in validation output`() {
        assertThat(messageOf("tier-1: tier label is blank"))
            .isEqualTo("连接层名称不能为空，请编辑该连接层补全名称。")
        assertThat(messageOf("duplicate tier id: tier-1"))
            .isEqualTo("连接层标识重复，请删除后重新添加。")
        assertThat(messageOf("tier-1: tier id is blank"))
            .isEqualTo("连接层标识不能为空，请删除后重新添加。")
        assertThat(messageOf("tier-1: tier order must be >= 0"))
            .isEqualTo("连接层排序无效，请重新排序。")
        assertThat(messageOf("tier-1: peer id is blank")).isEqualTo("P2P 对端 ID 不能为空。")
        assertThat(messageOf("tier-1: network tier requires a network target"))
            .isEqualTo("连接层类型与目标不匹配。")
        assertThat(messageOf("tier-1: p2p tier requires a peer target"))
            .isEqualTo("连接层类型与目标不匹配。")
    }

    @Test
    fun `maps real address parse failures`() {
        fun failureOf(raw: String): String =
            messageOf(HttpAddress.parse(raw).exceptionOrNull()?.message.orEmpty())

        assertThat(failureOf("   ")).isEqualTo("地址不能为空。")
        assertThat(failureOf("example.com:8767")).isEqualTo("地址缺少 http:// 或 https:// 前缀。")
        assertThat(failureOf("ftp://example.com")).isEqualTo("只支持 http 或 https。")
        assertThat(failureOf("https://exa mple.com")).isEqualTo("地址格式无效，请检查主机与端口。")
        assertThat(failureOf("https://example.com/../etc")).isEqualTo("路径不能包含 ..。")
        assertThat(failureOf("https://user:pass@example.com/"))
            .isEqualTo("地址不能包含用户名或密码。")
        assertThat(failureOf("https://example.com/path?x=1")).isEqualTo("地址不能包含查询参数。")
        assertThat(failureOf("https://example.com/#frag")).isEqualTo("地址不能包含片段。")
        assertThat(failureOf("http://example.com")).isEqualTo("HTTP 仅允许本机回环地址；远程请使用 HTTPS。")
    }

    @Test
    fun `maps real tier validation failures`() {
        fun errorOf(tier: Tier): String = messageOf(tier.validate().first())
        fun configErrorOf(config: TierConfig): String = messageOf(config.validate().first())

        assertThat(errorOf(networkTier(id = " ")))
            .isEqualTo("连接层标识不能为空，请删除后重新添加。")
        assertThat(errorOf(networkTier(order = -1))).isEqualTo("连接层排序无效，请重新排序。")
        assertThat(errorOf(networkTier(target = TierTarget.Peer("peer-1"))))
            .isEqualTo("连接层类型与目标不匹配。")

        val p2pTier = networkTier().copy(kind = TierKind.P2P, target = TierTarget.Peer(" "))
        assertThat(errorOf(p2pTier)).isEqualTo("P2P 对端 ID 不能为空。")
        assertThat(errorOf(p2pTier.copy(target = TierTarget.Network(network))))
            .isEqualTo("连接层类型与目标不匹配。")

        val duplicate = TierConfig(tiers = listOf(networkTier(), networkTier(label = "备用")))
        assertThat(configErrorOf(duplicate)).isEqualTo("连接层标识重复，请删除后重新添加。")
    }
}
