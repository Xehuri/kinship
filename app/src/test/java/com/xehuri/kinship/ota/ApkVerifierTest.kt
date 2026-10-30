package com.xehuri.kinship.ota

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class ApkVerifierTest {

    @Test
    fun `isSamePackage returns true when package matches`() {
        assertThat(ApkVerifier.isSamePackage("com.xehuri.kinship", "com.xehuri.kinship")).isTrue()
    }

    @Test
    fun `isSamePackage returns false when package differs`() {
        assertThat(ApkVerifier.isSamePackage("com.axeuh.health.monitor", "com.xehuri.kinship")).isFalse()
    }

    @Test
    fun `isSamePackage returns false when archive package is null`() {
        assertThat(ApkVerifier.isSamePackage(null, "com.xehuri.kinship")).isFalse()
    }
}
