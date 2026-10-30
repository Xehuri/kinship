package com.xehuri.kinship.service.state

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SensorStateHolderTest {

    // ── 默认值测试 ──

    @Test
    fun `default vadStatus is idle`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.vadStatus.first()).isEqualTo("idle")
    }

    @Test
    fun `default currentDbLevel is -80f`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.currentDbLevel.first()).isEqualTo(-80f)
    }

    @Test
    fun `default debugStateJson is empty object`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.debugStateJson.first()).isEqualTo("{}")
    }

    @Test
    fun `default lastSensorText is empty`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.lastSensorText.first()).isEqualTo("")
    }

    @Test
    fun `default lastResponseText is empty`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.lastResponseText.first()).isEqualTo("")
    }

    @Test
    fun `default lastGps is empty`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.lastGps.first()).isEqualTo("")
    }

    @Test
    fun `default lastMediaText is empty`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.lastMediaText.first()).isEqualTo("")
    }

    @Test
    fun `default lastHeartRate is -1`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.lastHeartRate.first()).isEqualTo(-1)
    }

    @Test
    fun `default lastSteps is -1`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.lastSteps.first()).isEqualTo(-1)
    }

    @Test
    fun `default lastStress is -1`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.lastStress.first()).isEqualTo(-1)
    }

    @Test
    fun `default lastSpo2 is -1`() = runTest {
        val holder = SensorStateHolder()
        assertThat(holder.lastSpo2.first()).isEqualTo(-1)
    }

    // ── Update 方法测试 ──

    @Test
    fun `updateVadStatus emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateVadStatus("listening")
        assertThat(holder.vadStatus.first()).isEqualTo("listening")
    }

    @Test
    fun `updateDbLevel emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateDbLevel(-42.5f)
        assertThat(holder.currentDbLevel.first()).isEqualTo(-42.5f)
    }

    @Test
    fun `updateDebugState emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateDebugState("""{"running":true}""")
        assertThat(holder.debugStateJson.first()).isEqualTo("""{"running":true}""")
    }

    @Test
    fun `updateLastSensorText emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateLastSensorText("心率 72 bpm | 步数 5000")
        assertThat(holder.lastSensorText.first()).isEqualTo("心率 72 bpm | 步数 5000")
    }

    @Test
    fun `updateLastResponseText emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateLastResponseText("好的，已记录")
        assertThat(holder.lastResponseText.first()).isEqualTo("好的，已记录")
    }

    @Test
    fun `updateLastGps emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateLastGps("39.9042,116.4074,10.0")
        assertThat(holder.lastGps.first()).isEqualTo("39.9042,116.4074,10.0")
    }

    @Test
    fun `updateLastMediaText emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateLastMediaText("[playing] 晴天 - 周杰伦")
        assertThat(holder.lastMediaText.first()).isEqualTo("[playing] 晴天 - 周杰伦")
    }

    @Test
    fun `updateHeartRate emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateHeartRate(72)
        assertThat(holder.lastHeartRate.first()).isEqualTo(72)
    }

    @Test
    fun `updateSteps emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateSteps(5000)
        assertThat(holder.lastSteps.first()).isEqualTo(5000)
    }

    @Test
    fun `updateStress emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateStress(35)
        assertThat(holder.lastStress.first()).isEqualTo(35)
    }

    @Test
    fun `updateSpo2 emits new value`() = runTest {
        val holder = SensorStateHolder()
        holder.updateSpo2(98)
        assertThat(holder.lastSpo2.first()).isEqualTo(98)
    }

    // ── Snapshot 方法测试 ──

    @Test
    fun `snapshotVadStatus returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateVadStatus("speaking")
        assertThat(holder.snapshotVadStatus()).isEqualTo("speaking")
    }

    @Test
    fun `snapshotDbLevel returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateDbLevel(-30f)
        assertThat(holder.snapshotDbLevel()).isEqualTo(-30f)
    }

    @Test
    fun `snapshotDebugState returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateDebugState("""{"vad":"speaking"}""")
        assertThat(holder.snapshotDebugState()).isEqualTo("""{"vad":"speaking"}""")
    }

    @Test
    fun `snapshotLastSensorText returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateLastSensorText("心率 72 bpm")
        assertThat(holder.snapshotLastSensorText()).isEqualTo("心率 72 bpm")
    }

    @Test
    fun `snapshotLastResponseText returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateLastResponseText("收到")
        assertThat(holder.snapshotLastResponseText()).isEqualTo("收到")
    }

    @Test
    fun `snapshotLastGps returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateLastGps("39.9,116.4,10.0")
        assertThat(holder.snapshotLastGps()).isEqualTo("39.9,116.4,10.0")
    }

    @Test
    fun `snapshotLastMediaText returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateLastMediaText("一首简单的歌 - 王力宏")
        assertThat(holder.snapshotLastMediaText()).isEqualTo("一首简单的歌 - 王力宏")
    }

    @Test
    fun `snapshotHeartRate returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateHeartRate(85)
        assertThat(holder.snapshotHeartRate()).isEqualTo(85)
    }

    @Test
    fun `snapshotSteps returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateSteps(12345)
        assertThat(holder.snapshotSteps()).isEqualTo(12345)
    }

    @Test
    fun `snapshotStress returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateStress(50)
        assertThat(holder.snapshotStress()).isEqualTo(50)
    }

    @Test
    fun `snapshotSpo2 returns latest value`() {
        val holder = SensorStateHolder()
        holder.updateSpo2(99)
        assertThat(holder.snapshotSpo2()).isEqualTo(99)
    }

    // ── 多步骤更新测试 ──

    @Test
    fun `state can be updated multiple times`() = runTest {
        val holder = SensorStateHolder()
        holder.updateVadStatus("listening")
        assertThat(holder.vadStatus.first()).isEqualTo("listening")

        holder.updateVadStatus("speaking")
        assertThat(holder.vadStatus.first()).isEqualTo("speaking")

        holder.updateVadStatus("idle")
        assertThat(holder.vadStatus.first()).isEqualTo("idle")
    }

    @Test
    fun `heartRate can be updated multiple times`() = runTest {
        val holder = SensorStateHolder()
        holder.updateHeartRate(60)
        holder.updateHeartRate(72)
        holder.updateHeartRate(85)
        assertThat(holder.lastHeartRate.first()).isEqualTo(85)
    }

    // ── 多观察者测试 ──
    // 注意：StateFlow 是 conflated 的，需要在每次 update 后 advanceUntilIdle()
    // 否则中间值会被跳过

    @Test
    fun `multiple observers receive same state updates`() = runTest {
        val holder = SensorStateHolder()

        // 两个独立的观察者收集 5 个值后完成
        val results1 = mutableListOf<String>()
        val results2 = mutableListOf<String>()

        launch { holder.vadStatus.take(5).toList(results1) }
        launch { holder.vadStatus.take(5).toList(results2) }

        advanceUntilIdle() // 确保两个 collector 都已启动，收到 "idle"

        holder.updateVadStatus("listening")
        advanceUntilIdle() // 收到 "listening"

        holder.updateVadStatus("speaking")
        advanceUntilIdle() // 收到 "speaking"

        holder.updateVadStatus("idle")
        advanceUntilIdle() // 收到 "idle"

        holder.updateVadStatus("done")
        advanceUntilIdle() // 收到 "done"，take(5) 完成

        assertThat(results1).containsExactly("idle", "listening", "speaking", "idle", "done")
        assertThat(results2).containsExactly("idle", "listening", "speaking", "idle", "done")
    }

    @Test
    fun `multiple observers receive heartRate updates`() = runTest {
        val holder = SensorStateHolder()

        val results1 = mutableListOf<Int>()
        val results2 = mutableListOf<Int>()

        launch { holder.lastHeartRate.take(4).toList(results1) }
        launch { holder.lastHeartRate.take(4).toList(results2) }

        advanceUntilIdle() // 收到 -1

        holder.updateHeartRate(72)
        advanceUntilIdle() // 收到 72

        holder.updateHeartRate(85)
        advanceUntilIdle() // 收到 85

        holder.updateHeartRate(-2)
        advanceUntilIdle() // 收到 -2, take(4) 完成

        assertThat(results1).containsExactly(-1, 72, 85, -2)
        assertThat(results2).containsExactly(-1, 72, 85, -2)
    }

    // ── 独立状态隔离测试 ──

    @Test
    fun `states are isolated from each other`() = runTest {
        val holder = SensorStateHolder()

        holder.updateVadStatus("speaking")
        holder.updateDbLevel(-20f)
        holder.updateHeartRate(75)

        // 更新一个不影响其他
        assertThat(holder.vadStatus.first()).isEqualTo("speaking")
        assertThat(holder.currentDbLevel.first()).isEqualTo(-20f)
        assertThat(holder.lastHeartRate.first()).isEqualTo(75)

        // 确认未被更新的状态仍为默认值
        assertThat(holder.lastGps.first()).isEqualTo("")
        assertThat(holder.lastSteps.first()).isEqualTo(-1)
    }
}
