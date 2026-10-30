package com.xehuri.kinship

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * 产品品牌回归测试：App 对外展示名称必须是 Kinship。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BrandingTest {

    @Test
    fun `app name is Kinship`() {
        val context = RuntimeEnvironment.getApplication()
        assertEquals("Kinship", context.getString(R.string.app_name))
    }
}
