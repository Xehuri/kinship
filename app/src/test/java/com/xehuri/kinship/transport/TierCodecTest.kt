package com.xehuri.kinship.transport

import com.google.common.truth.Truth.assertThat
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TierCodecTest {

    private fun networkTier(): Tier = Tier(
        id = "net-1",
        order = 0,
        kind = TierKind.NETWORK_ADDRESS,
        transportHint = TransportHint.FRP,
        target = TierTarget.Network(HttpAddress.parse("https://health.example:8768/").getOrThrow()),
        family = AddressFamily.PREFER_V4,
        tls = TlsPolicy.Pinned(listOf("aa", "bb")),
        enabled = true,
        label = "FRP",
    )

    private fun peerTier(): Tier = Tier(
        id = "peer-1",
        order = 1,
        kind = TierKind.P2P,
        transportHint = TransportHint.UNKNOWN,
        target = TierTarget.Peer("home"),
        family = AddressFamily.AUTO,
        tls = TlsPolicy.InsecureDev,
        enabled = false,
        label = "P2P",
    )

    private fun config(): TierConfig = TierConfig(
        schemaVersion = 1,
        revision = 7,
        tiers = listOf(networkTier(), peerTier()),
        selection = TierSelection(SelectionMode.PINNED, "net-1"),
    )

    private fun tierJson(
        id: String,
        extra: String = "",
        family: String = "AUTO",
        label: String = id,
    ): String =
        """
        {"id":"$id","order":0,"kind":"NETWORK_ADDRESS","transportHint":"DIRECT",
         "enabled":true,"label":"$label","family":"$family",
         "address":{"scheme":"https","host":"example.com","port":443,"pathPrefix":"/"},
         "tls":{"mode":"SYSTEM","pins":[]}$extra}
        """.trimIndent()

    private fun rootJson(tiers: String, version: Int = 1, extra: String = ""): String =
        """
        {"schemaVersion":$version,"revision":3,
         "selection":{"mode":"AUTO_CHAIN","activeTierId":null},
         "tiers":[$tiers]$extra}
        """.trimIndent()

    @Test
    fun `blank label decodes to a human host and port label`() {
        val decoded = TierCodec.decode(rootJson(tierJson("t1", label = "")))

        assertThat(decoded.config.tiers[0].label).isEqualTo("example.com:443")
        assertThat(decoded.config.tiers[0].displayLabel()).isEqualTo("example.com:443")
    }

    @Test
    fun `label equal to id decodes to a human host and port label`() {
        val uuid = "3f1a5b6c-0000-4000-8000-000000000000"
        val decoded = TierCodec.decode(rootJson(tierJson(uuid, label = uuid)))

        assertThat(decoded.config.tiers[0].label).isEqualTo("example.com:443")
        assertThat(decoded.config.tiers[0].label).isNotEqualTo(uuid)
    }

    @Test
    fun `repaired label survives round trip with key order unchanged`() {
        val raw = rootJson(tierJson("t1", label = "t1"))
        val decoded = TierCodec.decode(raw)
        val encoded = TierCodec.encode(decoded.config, raw)

        assertThat(TierCodec.decode(encoded).config).isEqualTo(decoded.config)
        assertThat(encoded.indexOf("\"id\"")).isLessThan(encoded.indexOf("\"order\""))
        assertThat(encoded.indexOf("\"label\"")).isLessThan(encoded.indexOf("\"family\""))
        assertThat(encoded.indexOf("\"family\"")).isLessThan(encoded.indexOf("\"tls\""))
    }

    @Test
    fun `unknown tier field is preserved while the repaired label is written`() {
        val raw = rootJson(tierJson("t1", extra = ",\"customFlag\":\"keep-me\"", label = ""))
        val decoded = TierCodec.decode(raw)

        val tier = JSONObject(TierCodec.encode(decoded.config, raw))
            .getJSONArray("tiers")
            .getJSONObject(0)

        assertThat(tier.getString("label")).isEqualTo("example.com:443")
        assertThat(tier.getString("customFlag")).isEqualTo("keep-me")
    }

    @Test
    fun `p2p tier with id label decodes to the human placeholder`() {
        val raw = """
            {"schemaVersion":1,"revision":3,
             "selection":{"mode":"AUTO_CHAIN","activeTierId":null},
             "tiers":[{"id":"peer-1","order":0,"kind":"P2P","label":"peer-1",
                       "peer":{"peerId":"home"},"tls":{"mode":"SYSTEM","pins":[]}}]}
        """.trimIndent()

        val decoded = TierCodec.decode(raw)

        assertThat(decoded.config.tiers[0].label).isEqualTo("P2P 对端（未接入）")
        assertThat(decoded.config.tiers[0].displaySubtitle()).isEqualTo("home")
    }

    @Test
    fun `round trips network and p2p tiers with all fields`() {
        val encoded = TierCodec.encode(config())
        val decoded = TierCodec.decode(encoded)

        assertThat(decoded.readOnly).isFalse()
        assertThat(decoded.warnings).isEmpty()
        assertThat(decoded.config).isEqualTo(config())
    }

    @Test
    fun `encode uses deterministic known key order`() {
        val encoded = TierCodec.encode(config())

        assertThat(encoded.indexOf("\"schemaVersion\""))
            .isLessThan(encoded.indexOf("\"revision\""))
        assertThat(encoded.indexOf("\"revision\""))
            .isLessThan(encoded.indexOf("\"selection\""))
        assertThat(encoded.indexOf("\"selection\""))
            .isLessThan(encoded.indexOf("\"tiers\""))
        assertThat(encoded.indexOf("\"id\"")).isLessThan(encoded.indexOf("\"order\""))
        assertThat(encoded.indexOf("\"family\"")).isLessThan(encoded.indexOf("\"tls\""))
    }

    @Test
    fun `unknown top level key survives encode with preservation source`() {
        val raw = rootJson(tierJson("t1"), extra = ",\"future\":{\"keep\":[1,2]}")
        val decoded = TierCodec.decode(raw)

        val root = JSONObject(TierCodec.encode(decoded.config, raw))

        assertThat(root.getJSONObject("future").getJSONArray("keep").length()).isEqualTo(2)
    }

    @Test
    fun `unknown tier field survives for the same id`() {
        val raw = rootJson(tierJson("t1", extra = ",\"customFlag\":\"keep-me\""))
        val decoded = TierCodec.decode(raw)

        val root = JSONObject(TierCodec.encode(decoded.config, raw))
        val tier = root.getJSONArray("tiers").getJSONObject(0)

        assertThat(tier.getString("customFlag")).isEqualTo("keep-me")
    }

    @Test
    fun `unknown kind tier survives raw but is absent from config`() {
        val raw = rootJson(
            """${tierJson("t1")},{"id":"quic","order":1,"kind":"QUIC","label":"Q"}"""
        )
        val decoded = TierCodec.decode(raw)

        assertThat(decoded.config.tiers.map { it.id }).containsExactly("t1")
        assertThat(decoded.warnings.any { it.contains("unknown kind") }).isTrue()

        val tiers = JSONObject(TierCodec.encode(decoded.config, raw)).getJSONArray("tiers")
        val ids = (0 until tiers.length()).map { tiers.getJSONObject(it).getString("id") }

        assertThat(ids).containsExactly("t1", "quic")
        assertThat(tiers.getJSONObject(1).getString("kind")).isEqualTo("QUIC")
    }

    @Test
    fun `unknown family defaults to auto and keeps tier`() {
        val raw = rootJson(tierJson("t1", family = "PREFER_V7"))
        val decoded = TierCodec.decode(raw)

        assertThat(decoded.config.tiers).hasSize(1)
        assertThat(decoded.config.tiers[0].family).isEqualTo(AddressFamily.AUTO)
        assertThat(decoded.warnings.any { it.contains("unknown family") }).isTrue()
    }

    @Test
    fun `unknown transport hint and tls mode default with warnings`() {
        val raw = rootJson(
            tierJson("t1").replace("\"transportHint\":\"DIRECT\"", "\"transportHint\":\"SATELLITE\"")
                .replace("\"mode\":\"SYSTEM\"", "\"mode\":\"TRUST_ALL\"")
        )
        val decoded = TierCodec.decode(raw)

        assertThat(decoded.config.tiers[0].transportHint).isEqualTo(TransportHint.UNKNOWN)
        assertThat(decoded.config.tiers[0].tls).isEqualTo(TlsPolicy.System)
        assertThat(decoded.warnings.any { it.contains("unknown transportHint") }).isTrue()
        assertThat(decoded.warnings.any { it.contains("unknown tls mode") }).isTrue()
    }

    @Test
    fun `schema version above one decodes best effort and is read only`() {
        val decoded = TierCodec.decode(rootJson(tierJson("t1"), version = 2))

        assertThat(decoded.readOnly).isTrue()
        assertThat(decoded.warnings.any { it.contains("unsupported schemaVersion 2") }).isTrue()
        assertThat(decoded.config.tiers.map { it.id }).containsExactly("t1")
    }

    @Test
    fun `invalid json is read only and never throws`() {
        val decoded = TierCodec.decode("{not json")

        assertThat(decoded.readOnly).isTrue()
        assertThat(decoded.config.tiers).isEmpty()
        assertThat(decoded.warnings).isNotEmpty()
    }

    @Test
    fun `wrong root type is read only`() {
        val decoded = TierCodec.decode("[1,2,3]")

        assertThat(decoded.readOnly).isTrue()
        assertThat(decoded.warnings).isNotEmpty()
    }

    @Test
    fun `missing config decodes empty and writable`() {
        for (raw in listOf(null, "", "   ")) {
            val decoded = TierCodec.decode(raw)

            assertThat(decoded.readOnly).isFalse()
            assertThat(decoded.config).isEqualTo(TierConfig())
            assertThat(decoded.warnings).containsExactly("no config")
        }
    }
}
