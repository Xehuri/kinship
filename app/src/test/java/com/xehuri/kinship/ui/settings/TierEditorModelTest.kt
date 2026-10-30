package com.xehuri.kinship.ui.settings

import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.transport.AddressFamily
import com.xehuri.kinship.transport.HttpAddress
import com.xehuri.kinship.transport.Tier
import com.xehuri.kinship.transport.TierKind
import com.xehuri.kinship.transport.TierTarget
import com.xehuri.kinship.transport.TlsPolicy
import com.xehuri.kinship.transport.TransportHint
import org.junit.Test

class TierEditorModelTest {

    private val target: TierTarget =
        TierTarget.Network(HttpAddress.parse("https://example.com:8768/").getOrThrow())

    private fun tier(
        id: String = "tier-1",
        order: Int = 3,
        enabled: Boolean = true,
        label: String = id,
    ): Tier = Tier(
        id = id,
        order = order,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.DIRECT,
        target = target,
        enabled = enabled,
        label = label,
    )

    private fun build(initial: Tier?, nextOrder: Int = 7, label: String = "saved"): Tier =
        buildTierForSave(
            initial = initial,
            nextOrder = nextOrder,
            label = label,
            kind = TierKind.NETWORK_ADDRESS,
            target = target,
            family = AddressFamily.AUTO,
            tls = TlsPolicy.System,
            transportHint = TransportHint.DIRECT,
        )

    @Test
    fun `new tier defaults to enabled and uses next order`() {
        val saved = build(initial = null, nextOrder = 7, label = " new tier ")

        assertThat(saved.enabled).isTrue()
        assertThat(saved.order).isEqualTo(7)
        assertThat(saved.id).isNotEmpty()
        assertThat(saved.label).isEqualTo("new tier")
    }

    @Test
    fun `editing a disabled tier keeps it disabled`() {
        val saved = build(initial = tier(enabled = false))

        assertThat(saved.enabled).isFalse()
        assertThat(saved.id).isEqualTo("tier-1")
        assertThat(saved.order).isEqualTo(3)
    }

    @Test
    fun `editing an enabled tier keeps it enabled`() {
        val saved = build(initial = tier(enabled = true))

        assertThat(saved.enabled).isTrue()
        assertThat(saved.id).isEqualTo("tier-1")
        assertThat(saved.order).isEqualTo(3)
    }
}
