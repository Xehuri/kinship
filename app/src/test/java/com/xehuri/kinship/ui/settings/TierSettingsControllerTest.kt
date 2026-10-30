package com.xehuri.kinship.ui.settings

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.xehuri.kinship.network.AppHttpClient
import com.xehuri.kinship.transport.AddressFamily
import com.xehuri.kinship.transport.HttpAddress
import com.xehuri.kinship.transport.HttpTierProbe
import com.xehuri.kinship.transport.ProbeResult
import com.xehuri.kinship.transport.SelectionMode
import com.xehuri.kinship.transport.Tier
import com.xehuri.kinship.transport.TierKind
import com.xehuri.kinship.transport.TierProbe
import com.xehuri.kinship.transport.TierRuntime
import com.xehuri.kinship.transport.TierRuntimeHolder
import com.xehuri.kinship.transport.TierSelection
import com.xehuri.kinship.transport.TierSelector
import com.xehuri.kinship.transport.TierSettingsController
import com.xehuri.kinship.transport.TierStore
import com.xehuri.kinship.transport.TierTarget
import com.xehuri.kinship.transport.TlsPolicy
import com.xehuri.kinship.transport.TransportHint
import com.xehuri.kinship.transport.sortedTiers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TierSettingsControllerTest {

    private class FakeProbe(var healthy: (Tier) -> Boolean = { true }) : TierProbe {
        var calls = 0

        override suspend fun probe(tier: Tier): ProbeResult {
            calls++
            return when {
                tier.kind == TierKind.P2P -> ProbeResult.Skipped("p2p not integrated")
                tier.enabled && healthy(tier) -> ProbeResult.Healthy(1L)
                else -> ProbeResult.Unreachable("down")
            }
        }
    }

    /**
     * 每个探针启动后都挂在同一个 gate 上；只有 [expectedStarts] 个探针都启动，
     * [awaitAllStarted] 才会返回。顺序探测时第二个探针永远不会启动。
     */
    private class GatedProbe(private val expectedStarts: Int = 2) : TierProbe {
        private val started = AtomicInteger(0)
        private val allStarted = CompletableDeferred<Unit>()
        private val gate = CompletableDeferred<Unit>()

        val startedCount: Int get() = started.get()

        override suspend fun probe(tier: Tier): ProbeResult {
            if (started.incrementAndGet() >= expectedStarts) allStarted.complete(Unit)
            gate.await()
            return ProbeResult.Healthy(1L)
        }

        suspend fun awaitAllStarted() {
            allStarted.await()
        }

        fun release() {
            gate.complete(Unit)
        }
    }

    private lateinit var context: Context
    private lateinit var prefs: SharedPreferences
    private lateinit var store: TierStore
    private lateinit var probe: FakeProbe
    private lateinit var selector: TierSelector
    private lateinit var controller: TierSettingsController

    private val frpUrl = "https://frp.health.example:8768"
    private val backupUrl = "https://backup.health.example:8768"

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext<Context>()
        prefs = context.getSharedPreferences(TierStore.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        TierStore.resetSharedForTest()
        store = TierStore(prefs)
        probe = FakeProbe()
        selector = TierSelector({ store.state.value }, probe)
        controller = TierSettingsController(store, selector, probe)
        AppHttpClient.resetTransportFailureCallback()
        TierRuntimeHolder.get()?.let { TierRuntimeHolder.clear(it) }
    }

    @After
    fun tearDown() {
        TierRuntimeHolder.get()?.let { TierRuntimeHolder.clear(it) }
        AppHttpClient.resetTransportFailureCallback()
        store.close()
        TierStore.resetSharedForTest()
        prefs.edit().clear().commit()
    }

    private fun networkTier(
        id: String = "net-1",
        label: String = id,
        host: String = "example.com",
        order: Int = 0,
        enabled: Boolean = true,
        hint: TransportHint = TransportHint.DIRECT,
    ): Tier = Tier(
        id = id,
        order = order,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = hint,
        target = TierTarget.Network(HttpAddress.parse("https://$host:8768/").getOrThrow()),
        family = AddressFamily.AUTO,
        tls = TlsPolicy.System,
        enabled = enabled,
        label = label,
    )

    private fun p2pTier(id: String = "p2p-1", peerId: String = "peer-1"): Tier = Tier(
        id = id,
        order = 0,
        kind = TierKind.P2P,
        transportHint = TransportHint.UNKNOWN,
        target = TierTarget.Peer(peerId),
        label = id,
    )

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

    private fun writeReadOnlyConfig() {
        val tier = JSONObject()
            .put("id", "net-ro")
            .put("order", 0)
            .put("kind", "NETWORK_ADDRESS")
            .put("transportHint", "DIRECT")
            .put("enabled", true)
            .put("label", "net-ro")
            .put("family", "AUTO")
            .put(
                "address",
                JSONObject()
                    .put("scheme", "https")
                    .put("host", "ro.example")
                    .put("port", 8768)
                    .put("pathPrefix", "/"),
            )
            .put("tls", JSONObject().put("mode", "SYSTEM").put("pins", JSONArray()))
        prefs.edit()
            .putString(
                TierStore.KEY_CONFIG,
                JSONObject()
                    .put("schemaVersion", 2)
                    .put("revision", 3)
                    .put("selection", JSONObject().put("mode", "AUTO_CHAIN").put("activeTierId", "net-ro"))
                    .put("tiers", JSONArray().put(tier))
                    .toString(),
            )
            .commit()
    }

    @Test
    fun `upsert valid network tier persists and appears in config`() = runTest {
        val tier = networkTier()

        val result = controller.upsert(tier)

        assertThat(result.isSuccess).isTrue()
        val config = controller.config.value
        assertThat(config.tiers.map { it.id }).containsExactly(tier.id)
        assertThat(config.revision).isEqualTo(1L)
        assertThat(prefs.getString(TierStore.KEY_CONFIG, null)).isNotNull()
    }

    @Test
    fun `upsert invalid tier fails and leaves store unchanged`() = runTest {
        val before = controller.config.value

        val result = controller.upsert(p2pTier(peerId = ""))

        assertThat(result.exceptionOrNull()).isInstanceOf(IllegalArgumentException::class.java)
        assertThat(controller.config.value).isEqualTo(before)
        assertThat(prefs.getString(TierStore.KEY_CONFIG, null)).isNull()
    }

    @Test
    fun `delete removes tier and resets active selection`() = runTest {
        val tier = networkTier()
        controller.upsert(tier)
        assertThat(controller.setSelectionMode(SelectionMode.PINNED, tier.id).isSuccess).isTrue()

        val result = controller.delete(tier.id)

        assertThat(result.isSuccess).isTrue()
        val config = controller.config.value
        assertThat(config.tiers).isEmpty()
        assertThat(config.selection).isEqualTo(TierSelection(SelectionMode.AUTO_CHAIN, null))
    }

    @Test
    fun `move reorders tiers by order`() = runTest {
        controller.upsert(networkTier(id = "a"))
        controller.upsert(networkTier(id = "b"))
        controller.upsert(networkTier(id = "c"))

        val result = controller.move("c", delta = -1)

        assertThat(result.isSuccess).isTrue()
        val sorted = controller.config.value.sortedTiers()
        assertThat(sorted.map { it.id }).containsExactly("a", "c", "b").inOrder()
        assertThat(sorted.map { it.order }).containsExactly(0, 1, 2).inOrder()
    }

    @Test
    fun `disable pinned active tier switches selection to auto chain`() = runTest {
        val tier = networkTier()
        controller.upsert(tier)
        controller.setSelectionMode(SelectionMode.PINNED, tier.id)

        val result = controller.setEnabled(tier.id, enabled = false)

        assertThat(result.isSuccess).isTrue()
        val config = controller.config.value
        assertThat(config.tiers.single().enabled).isFalse()
        assertThat(config.selection).isEqualTo(TierSelection(SelectionMode.AUTO_CHAIN, null))
    }

    @Test
    fun `setSelectionMode pinned requires a known enabled network tier`() = runTest {
        val unknown = controller.setSelectionMode(SelectionMode.PINNED, "missing")
        assertThat(unknown.isFailure).isTrue()
        assertThat(unknown.exceptionOrNull()?.message).isEqualTo("pinned tier not found")

        controller.upsert(p2pTier())
        val p2p = controller.setSelectionMode(SelectionMode.PINNED, "p2p-1")
        assertThat(p2p.isFailure).isTrue()

        val tier = networkTier()
        controller.upsert(tier)
        val valid = controller.setSelectionMode(SelectionMode.PINNED, tier.id)
        assertThat(valid.isSuccess).isTrue()
        assertThat(controller.config.value.selection)
            .isEqualTo(TierSelection(SelectionMode.PINNED, tier.id))
    }

    @Test
    fun `upsert editing the pinned tier into p2p resets selection to auto chain`() = runTest {
        val tier = networkTier()
        controller.upsert(tier)
        assertThat(controller.setSelectionMode(SelectionMode.PINNED, tier.id).isSuccess).isTrue()

        val result = controller.upsert(
            tier.copy(kind = TierKind.P2P, target = TierTarget.Peer("peer-1")),
        )

        assertThat(result.isSuccess).isTrue()
        val config = controller.config.value
        assertThat(config.tiers.single().kind).isEqualTo(TierKind.P2P)
        assertThat(config.selection).isEqualTo(TierSelection(SelectionMode.AUTO_CHAIN, null))
    }

    @Test
    fun `upsert disabling the pinned tier resets selection to auto chain`() = runTest {
        val tier = networkTier()
        controller.upsert(tier)
        assertThat(controller.setSelectionMode(SelectionMode.PINNED, tier.id).isSuccess).isTrue()

        val result = controller.upsert(tier.copy(enabled = false))

        assertThat(result.isSuccess).isTrue()
        val config = controller.config.value
        assertThat(config.tiers.single().enabled).isFalse()
        assertThat(config.selection).isEqualTo(TierSelection(SelectionMode.AUTO_CHAIN, null))
    }

    @Test
    fun `upsert keeps a valid auto chain active tier`() = runTest {
        val tier = networkTier()
        controller.upsert(tier)
        assertThat(controller.setSelectionMode(SelectionMode.AUTO_CHAIN, tier.id).isSuccess).isTrue()

        val result = controller.upsert(tier.copy(label = "renamed"))

        assertThat(result.isSuccess).isTrue()
        assertThat(controller.config.value.selection)
            .isEqualTo(TierSelection(SelectionMode.AUTO_CHAIN, tier.id))
    }

    @Test
    fun `upsert preserves the disabled flag on edit`() = runTest {
        val tier = networkTier(enabled = false)
        controller.upsert(tier)

        val result = controller.upsert(tier.copy(label = "renamed"))

        assertThat(result.isSuccess).isTrue()
        assertThat(controller.config.value.tiers.single().enabled).isFalse()
    }

    @Test
    fun `auto chain mode keeps a valid active tier when requested id is null`() = runTest {
        val tier = networkTier()
        controller.upsert(tier)
        assertThat(controller.setSelectionMode(SelectionMode.PINNED, tier.id).isSuccess).isTrue()

        val result = controller.setSelectionMode(SelectionMode.AUTO_CHAIN, null)

        assertThat(result.isSuccess).isTrue()
        assertThat(controller.config.value.selection)
            .isEqualTo(TierSelection(SelectionMode.AUTO_CHAIN, tier.id))
    }

    @Test
    fun `auto chain mode keeps a valid requested tier`() = runTest {
        val first = networkTier(id = "net-a")
        val second = networkTier(id = "net-b")
        controller.upsert(first)
        controller.upsert(second)
        assertThat(controller.setSelectionMode(SelectionMode.AUTO_CHAIN, first.id).isSuccess).isTrue()

        val result = controller.setSelectionMode(SelectionMode.AUTO_CHAIN, second.id)

        assertThat(result.isSuccess).isTrue()
        assertThat(controller.config.value.selection)
            .isEqualTo(TierSelection(SelectionMode.AUTO_CHAIN, second.id))
    }

    @Test
    fun `auto chain mode ignores an invalid requested tier and keeps the current active`() = runTest {
        val tier = networkTier()
        val p2p = p2pTier()
        controller.upsert(tier)
        controller.upsert(p2p)
        assertThat(controller.setSelectionMode(SelectionMode.AUTO_CHAIN, tier.id).isSuccess).isTrue()

        val result = controller.setSelectionMode(SelectionMode.AUTO_CHAIN, p2p.id)

        assertThat(result.isSuccess).isTrue()
        assertThat(controller.config.value.selection)
            .isEqualTo(TierSelection(SelectionMode.AUTO_CHAIN, tier.id))
    }

    @Test
    fun `testAndApply selects first healthy tier and keeps legacy prefs frozen`() = runTest {
        writeLegacyPrefs()
        controller.migrate()
        probe.healthy = { it.transportHint == TransportHint.FRP }
        val before = legacySnapshot()

        val tier = controller.testAndApply().getOrThrow()

        assertThat(tier.transportHint).isEqualTo(TransportHint.FRP)
        assertThat(controller.config.value.selection.activeTierId).isEqualTo(tier.id)
        assertThat(controller.selection.value.activeTierId).isEqualTo(tier.id)
        assertThat(legacySnapshot()).isEqualTo(before)
    }

    @Test
    fun `holder runtime path reloads config and returns the applied tier`() = runTest {
        val tier = networkTier()
        controller.upsert(tier)
        assertThat(controller.activeTier()).isNull()

        val runtimeStore = TierStore(prefs)
        val runtimeSelector = TierSelector({ runtimeStore.state.value }, probe)
        val runtime = TierRuntime(
            runtimeStore,
            runtimeSelector,
            CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )
        TierRuntimeHolder.install(runtime)

        try {
            val appliedTier = controller.testAndApply().getOrThrow()

            assertThat(controller.config.value.selection.activeTierId).isEqualTo(appliedTier.id)
            assertThat(controller.activeTier()?.id).isEqualTo(appliedTier.id)
            assertThat(runtime.state.value.activeTierId).isEqualTo(appliedTier.id)
        } finally {
            runtime.close()
            AppHttpClient.resetTransportFailureCallback()
            TierRuntimeHolder.clear(runtime)
        }
    }

    @Test
    fun `activeTier follows the persisted selection after the holder runtime applies another tier`() = runTest {
        val first = networkTier(id = "net-a", label = "net-a", host = "a.health.example", order = 0)
        val second = networkTier(id = "net-b", label = "net-b", host = "b.health.example", order = 1)
        controller.upsert(first)
        controller.upsert(second)

        probe.healthy = { it.id == first.id }
        assertThat(controller.testAndApply().getOrThrow().id).isEqualTo(first.id)
        assertThat(controller.selection.value.activeTierId).isEqualTo(first.id)
        assertThat(controller.activeTier()?.id).isEqualTo(first.id)

        probe.healthy = { it.id == second.id }
        val runtimeStore = TierStore(prefs)
        val runtime = TierRuntime(
            store = runtimeStore,
            selector = TierSelector({ runtimeStore.state.value }, probe),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )
        TierRuntimeHolder.install(runtime)

        try {
            assertThat(runtime.bootstrap()?.id).isEqualTo(second.id)

            assertThat(controller.config.value.selection.activeTierId).isEqualTo(first.id)
            assertThat(controller.activeTier()?.id).isEqualTo(second.id)
            assertThat(TierStore(prefs).state.value.selection.activeTierId).isEqualTo(second.id)
        } finally {
            runtime.close()
            TierRuntimeHolder.clear(runtime)
        }
    }

    @Test
    fun `shared store keeps page tiers through the production testAndApply path`() = runTest {
        writeLegacyPrefs()
        val sharedStore = TierStore.shared(context)
        val runtime = TierRuntime(
            store = sharedStore,
            selector = TierSelector({ sharedStore.state.value }, probe),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )
        TierRuntimeHolder.install(runtime)

        try {
            runtime.bootstrap()
            assertThat(sharedStore.state.value.tiers).hasSize(2)

            val pageController = TierSettingsController(
                store = sharedStore,
                selector = TierSelector({ sharedStore.state.value }, probe),
                probe = probe,
            )
            val pageTiers = listOf(
                networkTier(id = "page-a", label = "page-a", host = "a.health.example"),
                networkTier(id = "page-b", label = "page-b", host = "b.health.example"),
                networkTier(id = "page-c", label = "page-c", host = "c.health.example"),
            )
            pageTiers.forEach { tier ->
                assertThat(pageController.upsert(tier).isSuccess).isTrue()
            }

            val applied = pageController.testAndApply().getOrThrow()

            val persisted = TierStore(prefs).state.value
            assertThat(persisted.tiers).hasSize(5)
            assertThat(persisted.tiers.map { it.id })
                .containsAtLeast("page-a", "page-b", "page-c")
            assertThat(persisted.tiers.map { it.id }).contains(applied.id)
            assertThat(pageController.activeTier()?.id).isEqualTo(applied.id)
        } finally {
            runtime.close()
            TierRuntimeHolder.clear(runtime)
        }
    }

    @Test
    fun `testAndApply does not drop tiers saved after runtime bootstrap`() = runTest {
        writeLegacyPrefs()
        val runtimeStore = TierStore(prefs)
        val runtime = TierRuntime(
            store = runtimeStore,
            selector = TierSelector({ runtimeStore.state.value }, probe),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )
        TierRuntimeHolder.install(runtime)

        try {
            runtime.bootstrap()

            val pageTiers = listOf(
                networkTier(id = "page-a", label = "page-a", host = "a.health.example", order = 0),
                networkTier(id = "page-b", label = "page-b", host = "b.health.example", order = 1),
                networkTier(id = "page-c", label = "page-c", host = "c.health.example", order = 2),
            )
            pageTiers.forEach { tier ->
                assertThat(controller.upsert(tier).isSuccess).isTrue()
            }

            val applied = controller.testAndApply().getOrThrow()

            val persisted = TierStore(prefs).state.value
            assertThat(persisted.tiers.map { it.id })
                .containsExactly("page-a", "page-b", "page-c")
                .inOrder()
            val activeId = persisted.selection.activeTierId
            assertThat(activeId).isNotNull()
            assertThat(persisted.tiers.map { it.id }).contains(activeId)
            assertThat(applied.id).isEqualTo(activeId)
            assertThat(controller.config.value.tiers.map { it.id })
                .containsExactly("page-a", "page-b", "page-c")
                .inOrder()
            assertThat(controller.activeTier()?.id).isEqualTo(activeId)
        } finally {
            runtime.close()
            TierRuntimeHolder.clear(runtime)
        }
    }

    @Test
    fun `read only store reports read only and rejects selection writes`() {
        prefs.edit()
            .putString(
                TierStore.KEY_CONFIG,
                JSONObject()
                    .put("schemaVersion", 2)
                    .put("revision", 3)
                    .put("tiers", JSONArray())
                    .put("selection", JSONObject().put("mode", "AUTO_CHAIN"))
                    .toString(),
            )
            .commit()
        store.load()

        assertThat(controller.readOnly).isTrue()
        val result = controller.setSelectionMode(SelectionMode.AUTO_CHAIN, null)

        assertThat(result.isFailure).isTrue()
        assertThat(result.exceptionOrNull()?.message).isEqualTo("tier config is read-only")
    }

    @Test
    fun `read only testAndApply fails without probing or writing`() = runTest {
        writeReadOnlyConfig()
        store.load()
        val before = prefs.all.toMap()

        val result = controller.testAndApply()

        assertThat(result.isFailure).isTrue()
        assertThat(result.exceptionOrNull()).isInstanceOf(IllegalArgumentException::class.java)
        assertThat(result.exceptionOrNull()?.message).isEqualTo("tier config is read-only")
        assertThat(probe.calls).isEqualTo(0)
        assertThat(prefs.all.toMap()).isEqualTo(before)
    }

    @Test
    fun `testAndApply without a usable tier fails with no available tier`() = runTest {
        val result = controller.testAndApply()

        assertThat(result.isFailure).isTrue()
        assertThat(result.exceptionOrNull()).isInstanceOf(IllegalStateException::class.java)
        assertThat(result.exceptionOrNull()?.message).isEqualTo("no available tier")
        assertThat(prefs.getString(TierStore.KEY_CONFIG, null)).isNull()
    }

    @Test
    fun `probeAll returns skipped for a p2p tier`() = runTest {
        val p2p = p2pTier()
        controller.upsert(p2p)
        val realController = TierSettingsController(
            store = store,
            selector = TierSelector({ store.state.value }, HttpTierProbe()),
            probe = HttpTierProbe(),
        )

        val results = realController.probeAll()

        assertThat(results[p2p.id]).isEqualTo(ProbeResult.Skipped("p2p not integrated"))
    }

    @Test
    fun `probeAll starts every tier probe concurrently and preserves config order`() = runTest {
        val gated = GatedProbe()
        val gatedController = TierSettingsController(
            store = store,
            selector = TierSelector({ store.state.value }, gated),
            probe = gated,
        )
        val first = networkTier(id = "net-a", label = "net-a", host = "a.health.example")
        val second = networkTier(id = "net-b", label = "net-b", host = "b.health.example")
        gatedController.upsert(first)
        gatedController.upsert(second)

        val pending = async { gatedController.probeAll() }
        try {
            withTimeout(2_000) { gated.awaitAllStarted() }
            assertThat(gated.startedCount).isEqualTo(2)
        } finally {
            gated.release()
        }

        val results = pending.await()
        assertThat(results.keys).containsExactly(first.id, second.id).inOrder()
        assertThat(results.values)
            .containsExactly(ProbeResult.Healthy(1L), ProbeResult.Healthy(1L))
            .inOrder()
    }
}
