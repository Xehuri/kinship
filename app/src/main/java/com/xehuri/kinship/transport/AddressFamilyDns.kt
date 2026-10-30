package com.xehuri.kinship.transport

import okhttp3.Dns
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress

internal object AddressFamilyDns {

    fun forFamily(family: AddressFamily, system: Dns = Dns.SYSTEM): Dns = when (family) {
        AddressFamily.AUTO -> system
        AddressFamily.PREFER_V4 -> ReorderingDns(system) { addresses ->
            addresses.sortedBy { if (it is Inet4Address) 0 else 1 }
        }
        AddressFamily.PREFER_V6 -> ReorderingDns(system) { addresses ->
            addresses.sortedBy { if (it is Inet6Address) 0 else 1 }
        }
    }

    private class ReorderingDns(
        private val system: Dns,
        private val reorder: (List<InetAddress>) -> List<InetAddress>,
    ) : Dns {
        override fun lookup(hostname: String): List<InetAddress> = reorder(system.lookup(hostname))
    }
}
