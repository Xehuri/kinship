package com.xehuri.kinship.ui.settings

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class NetworkSettingsPageTest {

    @Test
    fun `apply button is enabled only when idle and writable`() {
        assertThat(tierApplyEnabled(loading = false, readOnly = false)).isTrue()
        assertThat(tierApplyEnabled(loading = true, readOnly = false)).isFalse()
        assertThat(tierApplyEnabled(loading = false, readOnly = true)).isFalse()
        assertThat(tierApplyEnabled(loading = true, readOnly = true)).isFalse()
    }
}
