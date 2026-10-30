package com.xehuri.kinship.transport

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TierStoreTest {

    private lateinit var prefs: SharedPreferences
    private lateinit var store: TierStore

    private val ipv6Url = "https://v6.health.example:8768"
    private val frpUrl = "https://frp.health.example:8768"

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        prefs = context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        store = TierStore(prefs)
    }

    @After
    fun tearDown() {
        store.close()
        TierStore.resetSharedForTest()
    }

    private fun candidates(vararg items: Pair<String, String>): String {
        val array = JSONArray()
        items.forEachIndexed { index, (name, url) ->
            array.put(
                JSONObject().apply {
                    put("name", name)
                    put("url", url)
                    put("priority", index)
                }
            )
        }
        return array.toString()
    }

    private fun validTier(id: String, order: Int = 0): Tier = Tier(
        id = id,
        order = order,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.DIRECT,
        target = TierTarget.Network(HttpAddress.parse("https://example.com:443/").getOrThrow()),
        label = id,
    )

    private fun assertIllegalArgument(block: () -> Unit) {
        try {
            block()
            fail("expected IllegalArgumentException")
        } catch (expected: IllegalArgumentException) {
            assertThat(expected).isNotNull()
        }
    }

    @Test
    fun `empty prefs migrate to empty config without inventing localhost`() {
        val result = store.migrateIfNeeded()

        assertThat(result.migrated).isTrue()
        assertThat(result.config.tiers).isEmpty()
        assertThat(result.config.selection.mode).isEqualTo(SelectionMode.AUTO_CHAIN)
        assertThat(result.config.selection.activeTierId).isNull()
        assertThat(result.config.revision).isEqualTo(0)
        assertThat(prefs.contains(TierStore.KEY_SERVER_URL)).isFalse()
        assertThat(prefs.contains(TierStore.KEY_ENDPOINT_CANDIDATES)).isFalse()
        assertThat(prefs.contains(TierStore.KEY_TRANSPORT_MODE)).isFalse()
    }

    @Test
    fun `candidates migrate in priority order and match server url`() {
        prefs.edit()
            .putString(
                TierStore.KEY_ENDPOINT_CANDIDATES,
                candidates("ipv6" to ipv6Url, "frp" to frpUrl),
            )
            .putString(TierStore.KEY_SERVER_URL, frpUrl)
            .commit()

        val result = store.migrateIfNeeded()
        val sorted = result.config.sortedTiers()

        assertThat(sorted.map { it.label }).containsExactly("ipv6", "frp").inOrder()
        assertThat(sorted.map { it.order }).containsExactly(0, 1).inOrder()
        assertThat(sorted[0].transportHint).isEqualTo(TransportHint.DIRECT)
        assertThat(sorted[1].transportHint).isEqualTo(TransportHint.FRP)
        assertThat(sorted[0].family).isEqualTo(AddressFamily.PREFER_V6)
        assertThat(sorted[1].family).isEqualTo(AddressFamily.PREFER_V4)
        assertThat(result.config.selection.activeTierId).isEqualTo(sorted[1].id)
    }

    @Test
    fun `server url outside candidates is prepended and selected`() {
        prefs.edit()
            .putString(TierStore.KEY_ENDPOINT_CANDIDATES, candidates("frp" to frpUrl))
            .putString(TierStore.KEY_SERVER_URL, "https://other.health.example:8768")
            .commit()

        val result = store.migrateIfNeeded()
        val sorted = result.config.sortedTiers()

        assertThat(sorted.map { it.label }).containsExactly("当前服务器", "frp").inOrder()
        assertThat(sorted[0].order).isEqualTo(0)
        assertThat(sorted[1].order).isEqualTo(1)
        assertThat(sorted[0].kind).isEqualTo(TierKind.NETWORK_ADDRESS)
        assertThat(result.config.selection.activeTierId).isEqualTo(sorted[0].id)
    }

    @Test
    fun `force frp migrates to pinned with first frp tier active`() {
        prefs.edit()
            .putString(
                TierStore.KEY_ENDPOINT_CANDIDATES,
                candidates("ipv6" to ipv6Url, "frp" to frpUrl),
            )
            .putString(TierStore.KEY_TRANSPORT_MODE, "FORCE_FRP")
            .commit()

        val result = store.migrateIfNeeded()
        val active = result.config.tiers.first { it.id == result.config.selection.activeTierId }

        assertThat(result.config.selection.mode).isEqualTo(SelectionMode.PINNED)
        assertThat(active.transportHint).isEqualTo(TransportHint.FRP)
    }

    @Test
    fun `force frp without frp tier stays auto chain with warning`() {
        prefs.edit()
            .putString(TierStore.KEY_ENDPOINT_CANDIDATES, candidates("ipv6" to ipv6Url))
            .putString(TierStore.KEY_TRANSPORT_MODE, "FORCE_FRP")
            .commit()

        val result = store.migrateIfNeeded()

        assertThat(result.config.selection.mode).isEqualTo(SelectionMode.AUTO_CHAIN)
        assertThat(result.warnings.any { it.contains("FORCE_FRP has no FRP tier") }).isTrue()
    }

    @Test
    fun `second migrate is a no-op with the same tiers`() {
        prefs.edit()
            .putString(
                TierStore.KEY_ENDPOINT_CANDIDATES,
                candidates("ipv6" to ipv6Url, "frp" to frpUrl),
            )
            .commit()
        val first = store.migrateIfNeeded()

        val second = store.migrateIfNeeded()

        assertThat(second.migrated).isFalse()
        assertThat(second.config.tiers).hasSize(first.config.tiers.size)
        assertThat(second.config.tiers.map { it.id })
            .containsExactlyElementsIn(first.config.tiers.map { it.id })
    }

    @Test
    fun `save increments revision and persists across a new store instance`() {
        store.migrateIfNeeded()
        store.save(store.state.value)

        assertThat(store.state.value.revision).isEqualTo(1)

        val reopened = TierStore(prefs)
        assertThat(reopened.state.value.revision).isEqualTo(1)
        assertThat(reopened.state.value.tiers).isEmpty()
        assertThat(reopened.readOnly).isFalse()
        reopened.close()
    }

    @Test
    fun `save invalid config throws and leaves stored value unchanged`() {
        store.save(TierConfig())
        val before = prefs.getString(TierStore.KEY_CONFIG, null)
        val invalid = TierConfig(tiers = listOf(validTier("dup"), validTier("dup", order = 1)))

        assertIllegalArgument { store.save(invalid) }

        assertThat(prefs.getString(TierStore.KEY_CONFIG, null)).isEqualTo(before)
        assertThat(store.state.value.revision).isEqualTo(1)
    }

    @Test
    fun `corrupt existing key is read only and never overwritten`() {
        prefs.edit().putString(TierStore.KEY_CONFIG, "{broken").commit()
        val corruptStore = TierStore(prefs)

        assertThat(corruptStore.readOnly).isTrue()
        val result = corruptStore.migrateIfNeeded()

        assertThat(result.migrated).isFalse()
        assertThat(result.warnings).isNotEmpty()
        assertThat(prefs.getString(TierStore.KEY_CONFIG, null)).isEqualTo("{broken")
        corruptStore.close()
    }

    @Test
    fun `read only store rejects save and keeps raw bytes`() {
        prefs.edit().putString(TierStore.KEY_CONFIG, "{broken").commit()
        val corruptStore = TierStore(prefs)

        assertIllegalArgument { corruptStore.save(TierConfig()) }

        assertThat(prefs.getString(TierStore.KEY_CONFIG, null)).isEqualTo("{broken")
        corruptStore.close()
    }

    @Test
    fun `migration never deletes or rewrites legacy keys`() {
        val legacyCandidates = candidates("ipv6" to ipv6Url)
        prefs.edit()
            .putString(TierStore.KEY_ENDPOINT_CANDIDATES, legacyCandidates)
            .putString(TierStore.KEY_SERVER_URL, ipv6Url)
            .putString(TierStore.KEY_TRANSPORT_MODE, "AUTO")
            .commit()

        store.migrateIfNeeded()

        assertThat(prefs.getString(TierStore.KEY_SERVER_URL, null)).isEqualTo(ipv6Url)
        assertThat(prefs.getString(TierStore.KEY_ENDPOINT_CANDIDATES, null))
            .isEqualTo(legacyCandidates)
        assertThat(prefs.getString(TierStore.KEY_TRANSPORT_MODE, null)).isEqualTo("AUTO")
    }

    @Test
    fun `updateSelection preserves tiers written by another instance`() {
        store.migrateIfNeeded()
        store.save(TierConfig(tiers = listOf(validTier("a"))))

        val other = TierStore(prefs)
        other.update { config -> config.copy(tiers = config.tiers + validTier("b", order = 1)) }
        other.close()

        val updated = store.updateSelection { it.copy(activeTierId = "b") }

        assertThat(updated.tiers.map { it.id }).containsExactly("a", "b")
        assertThat(updated.selection.activeTierId).isEqualTo("b")
        assertThat(updated.revision).isEqualTo(3L)
        assertThat(store.state.value).isEqualTo(updated)
        val persisted = TierStore(prefs).state.value
        assertThat(persisted.tiers.map { it.id }).containsExactly("a", "b")
        assertThat(persisted.selection.activeTierId).isEqualTo("b")
    }

    @Test
    fun `updateSelection rejects a dangling active tier without writing`() {
        store.save(TierConfig(tiers = listOf(validTier("a"))))
        val before = prefs.getString(TierStore.KEY_CONFIG, null)

        assertIllegalArgument { store.updateSelection { it.copy(activeTierId = "missing") } }

        assertThat(prefs.getString(TierStore.KEY_CONFIG, null)).isEqualTo(before)
    }

    @Test
    fun `shared store is one instance with monotonic revision`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        TierStore.resetSharedForTest()
        val first = TierStore.shared(context)
        val second = TierStore.shared(context)
        assertThat(second).isSameInstanceAs(first)

        first.save(TierConfig(tiers = listOf(validTier("shared"))))
        second.updateSelection { it.copy(activeTierId = "shared") }

        val third = TierStore.shared(context)
        assertThat(third).isSameInstanceAs(first)
        assertThat(third.state.value.revision).isEqualTo(2L)
        assertThat(third.state.value.tiers.map { it.id }).containsExactly("shared")
        assertThat(third.state.value.selection.activeTierId).isEqualTo("shared")
    }

    @Test
    fun `blank candidate name migrates to a human host and port label`() {
        prefs.edit()
            .putString(TierStore.KEY_ENDPOINT_CANDIDATES, candidates("" to ipv6Url))
            .commit()

        val result = store.migrateIfNeeded()

        assertThat(result.config.tiers).hasSize(1)
        assertThat(result.config.tiers[0].label).isEqualTo("v6.health.example:8768")
        assertThat(result.config.tiers[0].label).isNotEqualTo(result.config.tiers[0].id)
    }

    @Test
    fun `duplicate candidate names get numeric suffixes in candidate order`() {
        prefs.edit()
            .putString(
                TierStore.KEY_ENDPOINT_CANDIDATES,
                candidates(
                    "FRP" to frpUrl,
                    "frp" to ipv6Url,
                    "Frp" to "https://other.health.example:8768",
                ),
            )
            .commit()

        val labels = store.migrateIfNeeded().config.sortedTiers().map { it.label }

        assertThat(labels).containsExactly("FRP", "frp（2）", "Frp（3）").inOrder()
    }

    @Test
    fun `migration that fails validation is not written and keeps the store writable`() {
        prefs.edit()
            .putString(TierStore.KEY_ENDPOINT_CANDIDATES, candidates("frp" to frpUrl))
            .commit()

        val result = store.migrateIfNeeded { listOf("forced invalid") }

        assertThat(result.migrated).isFalse()
        assertThat(result.warnings.any { it.contains("migration produced invalid config") }).isTrue()
        assertThat(prefs.contains(TierStore.KEY_CONFIG)).isFalse()
        assertThat(store.readOnly).isFalse()

        store.save(TierConfig())
        assertThat(prefs.contains(TierStore.KEY_CONFIG)).isTrue()
    }

    @Test
    fun `legacy uuid label is repaired from the target on load`() {
        val legacy = validTier("3f1a5b6c-0000-4000-8000-000000000000")
        prefs.edit()
            .putString(TierStore.KEY_CONFIG, TierCodec.encode(TierConfig(tiers = listOf(legacy))))
            .commit()

        val loaded = TierStore(prefs)
        val result = loaded.migrateIfNeeded()

        assertThat(loaded.state.value.tiers[0].label).isEqualTo("example.com:443")
        assertThat(result.config.tiers[0].label).isEqualTo("example.com:443")
        assertThat(loaded.readOnly).isFalse()
        loaded.close()
    }

    @Test
    fun `persisted migration output never uses the tier id as a label`() {
        prefs.edit()
            .putString(TierStore.KEY_ENDPOINT_CANDIDATES, candidates("" to ipv6Url, "" to frpUrl))
            .commit()

        store.migrateIfNeeded()
        val stored = prefs.getString(TierStore.KEY_CONFIG, null).orEmpty()
        val tiers = JSONObject(stored).getJSONArray("tiers")

        for (index in 0 until tiers.length()) {
            val tier = tiers.getJSONObject(index)
            assertThat(tier.getString("label")).isNotEmpty()
            assertThat(tier.getString("label")).isNotEqualTo(tier.getString("id"))
        }
    }

    @Test
    fun `invalid server url warns without adding a tier`() {
        prefs.edit().putString(TierStore.KEY_SERVER_URL, "not-a-url").commit()

        val result = store.migrateIfNeeded()

        assertThat(result.config.tiers).isEmpty()
        assertThat(result.config.selection.activeTierId).isNull()
        assertThat(result.warnings.any { it.contains("server_url is invalid") }).isTrue()
    }
}
