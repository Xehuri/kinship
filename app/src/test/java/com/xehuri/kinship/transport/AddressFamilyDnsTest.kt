package com.xehuri.kinship.transport

import com.google.common.truth.Truth.assertThat
import okhttp3.Dns
import org.junit.Test
import java.net.InetAddress

class AddressFamilyDnsTest {

    private fun addr(host: String): InetAddress = InetAddress.getByName(host)

    private fun dnsOf(
        addrs: List<InetAddress>,
        seenHosts: MutableList<String>? = null,
    ): Dns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            seenHosts?.add(hostname)
            return addrs
        }
    }

    @Test
    fun `prefer v4 orders ipv4 first and keeps every address`() {
        val v6a = addr("2001:db8::1")
        val v6b = addr("2001:db8::2")
        val v4a = addr("10.0.0.1")
        val v4b = addr("10.0.0.2")

        val resolved = AddressFamilyDns
            .forFamily(AddressFamily.PREFER_V4, dnsOf(listOf(v6a, v4a, v6b, v4b)))
            .lookup("example.com")

        assertThat(resolved).containsExactly(v4a, v4b, v6a, v6b).inOrder()
    }

    @Test
    fun `prefer v6 orders ipv6 first and keeps every address`() {
        val v4a = addr("10.0.0.1")
        val v4b = addr("10.0.0.2")
        val v6a = addr("2001:db8::1")
        val v6b = addr("2001:db8::2")

        val resolved = AddressFamilyDns
            .forFamily(AddressFamily.PREFER_V6, dnsOf(listOf(v4a, v6a, v4b, v6b)))
            .lookup("example.com")

        assertThat(resolved).containsExactly(v6a, v6b, v4a, v4b).inOrder()
    }

    @Test
    fun `auto preserves the system ordering`() {
        val v6 = addr("2001:db8::1")
        val v4 = addr("10.0.0.1")

        val resolved = AddressFamilyDns
            .forFamily(AddressFamily.AUTO, dnsOf(listOf(v6, v4)))
            .lookup("example.com")

        assertThat(resolved).containsExactly(v6, v4).inOrder()
    }

    @Test
    fun `auto returns the provided system dns unchanged`() {
        val system = dnsOf(listOf(addr("10.0.0.1")))

        assertThat(AddressFamilyDns.forFamily(AddressFamily.AUTO, system)).isSameInstanceAs(system)
    }

    @Test
    fun `single address is returned unchanged for both preferences`() {
        val only = addr("10.0.0.1")

        val v4 = AddressFamilyDns.forFamily(AddressFamily.PREFER_V4, dnsOf(listOf(only)))
        val v6 = AddressFamilyDns.forFamily(AddressFamily.PREFER_V6, dnsOf(listOf(only)))

        assertThat(v4.lookup("example.com")).containsExactly(only)
        assertThat(v6.lookup("example.com")).containsExactly(only)
    }

    @Test
    fun `same family ordering keeps the original relative order`() {
        val v4a = addr("10.0.0.1")
        val v4b = addr("10.0.0.2")
        val v4c = addr("10.0.0.3")

        val resolved = AddressFamilyDns
            .forFamily(AddressFamily.PREFER_V4, dnsOf(listOf(v4b, v4a, v4c)))
            .lookup("example.com")

        assertThat(resolved).containsExactly(v4b, v4a, v4c).inOrder()
    }

    @Test
    fun `lookup delegates to the provided dns with the same hostname`() {
        val seen = mutableListOf<String>()

        AddressFamilyDns
            .forFamily(AddressFamily.PREFER_V4, dnsOf(listOf(addr("10.0.0.1")), seen))
            .lookup("health.example.com")

        assertThat(seen).containsExactly("health.example.com")
    }
}
