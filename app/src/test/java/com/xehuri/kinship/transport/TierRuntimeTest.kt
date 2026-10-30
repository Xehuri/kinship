package com.xehuri.kinship.transport

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.config.EndpointType
import com.xehuri.kinship.config.ServerConfig
import com.xehuri.kinship.network.AppHttpClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class TierRuntimeTest {

    private class FakeProbe(var healthy: (Tier) -> Boolean = { true }) : TierProbe {
        override suspend fun probe(tier: Tier): ProbeResult =
            if (healthy(tier)) ProbeResult.Healthy(1L) else ProbeResult.Unreachable("down")
    }

    private lateinit var context: Context
    private lateinit var prefs: SharedPreferences
    private lateinit var store: TierStore
    private var runtime: TierRuntime? = null
    private val probe = FakeProbe()
    private val applyUrls = mutableListOf<String>()
    private val profiles = mutableListOf<Pair<EndpointType?, Boolean?>>()

    private val frpUrl = "https://frp.health.example:8768"
    private val backupUrl = "https://backup.health.example:8768"

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        prefs = context.getSharedPreferences(TierStore.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        writeLegacyPrefs()
        AppHttpClient.resetTransportFailureCallback()
        ServerConfig.resetActiveTierProfile()
        ServerConfig.init(context)
    }

    @After
    fun tearDown() {
        runtime?.close()
        runtime = null
        TierRuntimeHolder.get()?.let { TierRuntimeHolder.clear(it) }
        AppHttpClient.resetTransportFailureCallback()
        ServerConfig.resetActiveTierProfile()
        prefs.edit().clear().commit()
        ServerConfig.init(context)
    }

    private fun writeLegacyPrefs() {
        val array = JSONArray()
        array.put(JSONObject().put("name", "frp").put("url", frpUrl).put("priority", 0))
        array.put(JSONObject().put("name", "backup").put("url", backupUrl).put("priority", 1))
        prefs.edit()
            .putString(TierStore.KEY_SERVER_URL, backupUrl)
            .putString(TierStore.KEY_ENDPOINT_CANDIDATES, array.toString())
            .putString(TierStore.KEY_TRANSPORT_MODE, "AUTO")
            .commit()
    }

    private fun legacySnapshot(): List<String?> = listOf(
        prefs.getString(TierStore.KEY_SERVER_URL, null),
        prefs.getString(TierStore.KEY_ENDPOINT_CANDIDATES, null),
        prefs.getString(TierStore.KEY_TRANSPORT_MODE, null),
    )

    private fun lateTier(): Tier = Tier(
        id = "late",
        order = 2,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.DIRECT,
        target = TierTarget.Network(
            HttpAddress.parse("https://late.health.example:8768/").getOrThrow()
        ),
        label = "late",
    )

    private fun addLateTierFromAnotherInstance() {
        val side = TierStore(prefs)
        side.update { config ->
            config.copy(tiers = config.tiers + lateTier().copy(order = config.tiers.size))
        }
        side.close()
    }

    private fun createRuntime(scope: CoroutineScope, inMemoryApplyUrl: Boolean = false): TierRuntime {
        store = TierStore(prefs)
        val selector = TierSelector({ store.state.value }, probe)
        val profileRecorder: (EndpointType?, Boolean?) -> Unit = { type, prefer ->
            profiles += type to prefer
        }
        val created = if (inMemoryApplyUrl) {
            TierRuntime(
                store = store,
                selector = selector,
                scope = scope,
                applyProfile = profileRecorder,
            )
        } else {
            TierRuntime(
                store = store,
                selector = selector,
                scope = scope,
                applyUrl = { applyUrls += it },
                applyProfile = profileRecorder,
            )
        }
        runtime = created
        return created
    }

    @Test
    fun `bootstrap migrates config and applies the selected tier`() = runTest {
        val before = legacySnapshot()
        val rt = createRuntime(this)

        val tier = rt.bootstrap()

        assertThat(tier).isNotNull()
        val selectedId = tier!!.id
        assertThat(applyUrls).containsExactly(frpUrl)
        assertThat(profiles).containsExactly(EndpointType.FRP to true)
        assertThat(store.state.value.selection.activeTierId).isEqualTo(selectedId)
        val persisted = JSONObject(prefs.getString(TierStore.KEY_CONFIG, "{}") ?: "{}")
        assertThat(persisted.getJSONObject("selection").getString("activeTierId"))
            .isEqualTo(selectedId)
        assertThat(legacySnapshot()).isEqualTo(before)
    }

    @Test
    fun `applyUrl only updates memory and never rewrites server_url`() = runTest {
        val storedServerUrl = prefs.getString(TierStore.KEY_SERVER_URL, null)
        val rt = createRuntime(this, inMemoryApplyUrl = true)

        rt.bootstrap()

        assertThat(ServerConfig.BASE_URL).isEqualTo(frpUrl)
        assertThat(prefs.getString(TierStore.KEY_SERVER_URL, null)).isEqualTo(storedServerUrl)
    }

    @Test
    fun `transport failure selects the next healthy tier`() = runTest {
        probe.healthy = { it.label == "frp" }
        val rt = createRuntime(this)
        val first = rt.bootstrap()
        assertThat(first?.label).isEqualTo("frp")

        applyUrls.clear()
        profiles.clear()
        probe.healthy = { it.label != "frp" }
        rt.notifyTransportFailure(frpUrl)
        advanceUntilIdle()

        assertThat(applyUrls).containsExactly(backupUrl)
        assertThat(profiles).containsExactly(EndpointType.CUSTOM to null)
    }

    @Test
    fun `unknown origin never triggers re-selection`() = runTest {
        val rt = createRuntime(this)
        rt.bootstrap()
        applyUrls.clear()

        rt.notifyTransportFailure("https://unknown.example:1234")
        advanceUntilIdle()

        assertThat(applyUrls).isEmpty()
    }

    @Test
    fun `pinned mode never switches tiers after transport failure`() = runTest {
        val migrationStore = TierStore(prefs)
        migrationStore.migrateIfNeeded()
        val frp = migrationStore.state.value.tiers.first { it.label == "frp" }
        migrationStore.update {
            it.copy(selection = TierSelection(SelectionMode.PINNED, frp.id))
        }

        val rt = createRuntime(this)
        val bootstrapped = rt.bootstrap()
        assertThat(bootstrapped?.id).isEqualTo(frp.id)
        assertThat(applyUrls).containsExactly(frpUrl)

        applyUrls.clear()
        rt.notifyTransportFailure(frpUrl)
        advanceUntilIdle()

        assertThat(applyUrls).containsExactly(frpUrl)
        assertThat(store.state.value.selection.activeTierId).isEqualTo(frp.id)
    }

    @Test
    fun `refresh keeps tiers saved after runtime bootstrap`() = runTest {
        val rt = createRuntime(this)
        rt.bootstrap()
        addLateTierFromAnotherInstance()

        rt.refresh(force = true)

        val persisted = TierStore(prefs).state.value
        assertThat(persisted.tiers.map { it.id }).contains("late")
        assertThat(persisted.tiers).hasSize(3)
        val activeId = persisted.selection.activeTierId
        assertThat(activeId).isNotNull()
        assertThat(persisted.tiers.map { it.id }).contains(activeId)
    }

    @Test
    fun `refresh(force=false) keeps tiers saved after runtime bootstrap`() = runTest {
        val rt = createRuntime(this)
        rt.bootstrap()
        addLateTierFromAnotherInstance()

        rt.refresh(force = false)

        val persisted = TierStore(prefs).state.value
        assertThat(persisted.tiers.map { it.id }).contains("late")
        assertThat(persisted.tiers).hasSize(3)
        val activeId = persisted.selection.activeTierId
        assertThat(activeId).isNotNull()
        assertThat(persisted.tiers.map { it.id }).contains(activeId)
    }

    @Test
    fun `transport failure keeps tiers saved after runtime bootstrap`() = runTest {
        val rt = createRuntime(this)
        rt.bootstrap()
        addLateTierFromAnotherInstance()

        probe.healthy = { it.label != "frp" }
        rt.notifyTransportFailure(frpUrl)
        advanceUntilIdle()

        val persisted = TierStore(prefs).state.value
        assertThat(persisted.tiers.map { it.id }).contains("late")
        assertThat(persisted.tiers).hasSize(3)
    }

    @Test
    fun `refresh after active tier deletion does not throw or persist dangling selection`() = runTest {
        val rt = createRuntime(this)
        val first = rt.bootstrap()
        assertThat(first).isNotNull()
        assertThat(first!!.label).isEqualTo("frp")

        val side = TierStore(prefs)
        side.update { config ->
            config.copy(
                tiers = config.tiers.filterNot { it.id == first.id },
                selection = config.selection.copy(activeTierId = null),
            )
        }
        side.close()

        val refreshed = rt.refresh(force = true)

        assertThat(refreshed).isNotNull()
        assertThat(refreshed!!.id).isNotEqualTo(first.id)
        val persisted = TierStore(prefs).state.value
        assertThat(persisted.tiers.map { it.id }).doesNotContain(first.id)
        val activeId = persisted.selection.activeTierId
        assertThat(activeId).isNotNull()
        assertThat(persisted.tiers.map { it.id }).contains(activeId)
    }

    @Test
    fun `close clears the transport failure callback`() = runTest {
        val rt = createRuntime(this)
        TierRuntimeHolder.install(rt)
        assertThat(AppHttpClient.onTransportFailure).isNotNull()
        assertThat(TierRuntimeHolder.get()).isSameInstanceAs(rt)

        rt.close()
        runtime = null

        assertThat(AppHttpClient.onTransportFailure).isNull()
        assertThat(TierRuntimeHolder.get()).isNull()
    }
}
