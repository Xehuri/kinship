package com.xehuri.kinship.network

import com.google.common.truth.Truth.assertThat
import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress

/**
 * 验证 [AudioStreamClient.preferIpv4First] 的地址排序逻辑。
 *
 * 背景：服务端域名双栈且 IPv6 入口不可达时，OkHttp 会先连 IPv6 并等满
 * `connectTimeout`（15 秒）才回退 IPv4；该排序保证首个尝试即走 IPv4。
 * 纯 JVM 测试，不触网、不需要 Robolectric。
 */
class AudioStreamClientDnsTest {

    private fun v4(host: String): InetAddress = InetAddress.getByName(host)

    @Test
    fun `moves IPv4 ahead of IPv6 while keeping both`() {
        val v6a = v4("2001:db8::2")
        val v6b = v4("fe80::1")
        val v4a = v4("192.0.2.10")
        val v4b = v4("10.0.0.1")

        val out = AudioStreamClient.preferIpv4First(listOf(v6a, v4a, v6b, v4b))

        assertEquals(4, out.size)
        assertThat(out[0]).isEqualTo(v4a)
        assertThat(out[1]).isEqualTo(v4b)
        assertThat(out[2]).isEqualTo(v6a)
        assertThat(out[3]).isEqualTo(v6b)
    }

    @Test
    fun `single address is returned unchanged`() {
        val only = v4("192.0.2.10")
        val out = AudioStreamClient.preferIpv4First(listOf(only))
        assertEquals(listOf(only), out)
    }

    @Test
    fun `all IPv6 keeps original order`() {
        val a = v4("fe80::1")
        val b = v4("fe80::2")
        val out = AudioStreamClient.preferIpv4First(listOf(a, b))
        assertEquals(listOf(a, b), out)
    }

    @Test
    fun `all IPv4 keeps original order`() {
        val a = v4("10.0.0.1")
        val b = v4("10.0.0.2")
        val out = AudioStreamClient.preferIpv4First(listOf(a, b))
        assertEquals(listOf(a, b), out)
    }

    @Test
    fun `dnsFor keeps system ordering for ipv6 endpoint`() {
        val v6 = v4("2001:db8::2")
        val v4a = v4("192.0.2.10")
        val system = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = listOf(v6, v4a)
        }

        val resolved = AudioStreamClient.dnsFor(preferIpv4 = false, system = system).lookup("example.com")

        assertEquals(listOf(v6, v4a), resolved)
    }

    @Test
    fun `dnsFor reorders for frp endpoint`() {
        val v6 = v4("2001:db8::2")
        val v4a = v4("192.0.2.10")
        val system = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = listOf(v6, v4a)
        }

        val resolved = AudioStreamClient.dnsFor(preferIpv4 = true, system = system).lookup("example.com")

        assertEquals(listOf(v4a, v6), resolved)
    }
}
