package com.xehuri.kinship.ui

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.content.Context
import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import com.xehuri.kinship.network.AppHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream

// ========== 数据模型 ==========

/** 注册的说话人信息 */
private data class SpeakerInfo(
    val speakerId: String,
    val name: String,
    val createdAt: String,
    val remark: String = ""
)

/** 录音状态：空闲 / 录音中 / 上传处理中 */
private enum class RecState { IDLE, RECORDING, UPLOADING }

// ========== 主面板 ==========

/**
 * 声纹管理面板
 *
 * 3 个功能区：注册声纹 / 已注册声纹 / 声纹识别测试
 * 录音为手动启停：按下「开始录音」→ 录制任意时长 → 按下「停止录音」→ 自动上传
 */
@Composable
fun VoiceprintPanel(onClose: () -> Unit, serverUrl: String? = null) {
    val scope = rememberCoroutineScope()
    val baseUrl = serverUrl ?: "https://localhost:8767"
    val context = LocalContext.current

    // ── 共享状态 ──
    var speakers by remember { mutableStateOf<List<SpeakerInfo>>(emptyList()) }
    var loadingList by remember { mutableStateOf(true) }

    // ── 注册声纹状态 ──
    var enrollName by remember { mutableStateOf("") }
    var enrollState by remember { mutableStateOf(RecState.IDLE) }
    var enrollMsg by remember { mutableStateOf("") }
    var enrollActive by remember { mutableStateOf(false) }
    var enrollElapsed by remember { mutableIntStateOf(0) }

    // ── 声纹识别状态 ──
    var identifyState by remember { mutableStateOf(RecState.IDLE) }
    var identifyMsg by remember { mutableStateOf("") }
    var identifyResult by remember { mutableStateOf("") }
    var identifyActive by remember { mutableStateOf(false) }
    var identifyElapsed by remember { mutableIntStateOf(0) }

    // ── 加载声纹列表 ──
    fun loadSpeakers() {
        scope.launch {
            loadingList = true
            val httpClient = AppHttpClient(context.applicationContext)
            speakers = withContext(Dispatchers.IO) { fetchSpeakers(context, baseUrl, httpClient) }
            loadingList = false
        }
    }
    LaunchedEffect(Unit) { loadSpeakers() }

    // ════════════════════════════════════════
    // 注册声纹 — 开始录音
    // ════════════════════════════════════════
    fun startEnroll() {
        val name = enrollName.trim()
        if (name.isEmpty()) { enrollMsg = "请输入声纹名称"; return }
        enrollState = RecState.RECORDING
        enrollMsg = "录音中，点击「停止录音」结束"
        enrollActive = true
        val startMs = System.currentTimeMillis()

        scope.launch(Dispatchers.IO) {
            // 计时器协程
            val timerJob = launch {
                while (enrollActive && isActive) {
                    enrollElapsed = ((System.currentTimeMillis() - startMs) / 1000).toInt()
                    delay(200)
                }
                enrollElapsed = 0
            }

            val wav = recordWavManual { enrollActive }
            timerJob.cancel()
            enrollElapsed = 0

            if (wav == null || !isActive) {
                enrollActive = false
                enrollState = RecState.IDLE
                if (wav == null) enrollMsg = "录音失败，请检查麦克风权限"
                return@launch
            }

            enrollState = RecState.UPLOADING
            enrollMsg = "上传注册中..."

            val enrollHttpClient = AppHttpClient(context.applicationContext)
            val (ok, data) = enrollVoice(context, baseUrl, name, wav, enrollHttpClient)
            if (ok) {
                val spk = data as SpeakerInfo
                enrollMsg = "注册成功: ${spk.name}"
                // 直接追加到本地列表，避免重新 HTTP 拉取
                speakers = speakers + spk
            } else {
                enrollMsg = "失败: $data"
                Log.w("VoiceprintUI", "enroll fail: $data")
            }
            enrollState = RecState.IDLE
            enrollActive = false
        }
    }

    /** 注册声纹 — 停止录音 */
    fun stopEnroll() {
        enrollActive = false
        enrollMsg = "处理中..."
        enrollState = RecState.UPLOADING
    }

    // ════════════════════════════════════════
    // 声纹识别 — 开始录音
    // ════════════════════════════════════════
    fun startIdentify() {
        identifyState = RecState.RECORDING
        identifyMsg = "录音中，点击「停止识别」结束"
        identifyResult = ""
        identifyActive = true
        val startMs = System.currentTimeMillis()

        scope.launch(Dispatchers.IO) {
            val timerJob = launch {
                while (identifyActive && isActive) {
                    identifyElapsed = ((System.currentTimeMillis() - startMs) / 1000).toInt()
                    delay(200)
                }
                identifyElapsed = 0
            }

            val wav = recordWavManual { identifyActive }
            timerJob.cancel()
            identifyElapsed = 0

            if (wav == null || !isActive) {
                identifyActive = false
                identifyState = RecState.IDLE
                return@launch
            }

            identifyState = RecState.UPLOADING
            identifyMsg = "识别中..."

            val idHttpClient = AppHttpClient(context.applicationContext)
            val (ok, result) = identifyVoice(context, baseUrl, wav, idHttpClient)
            if (ok) {
                identifyResult = result
                identifyMsg = ""
            } else {
                identifyResult = ""
                identifyMsg = "识别失败: $result"
                Log.w("VoiceprintUI", "identify fail: $result")
            }
            identifyState = RecState.IDLE
            identifyActive = false
        }
    }

    /** 声纹识别 — 停止录音 */
    fun stopIdentify() {
        identifyActive = false
        identifyMsg = "识别中..."
        identifyState = RecState.UPLOADING
    }

    // ════════════════════════════════════════
    // 播放注册音频
    // ════════════════════════════════════════
    var playingSpeakerId by remember { mutableStateOf("") }

    fun playAudio(speakerId: String) {
        if (playingSpeakerId == speakerId) { playingSpeakerId = ""; return }
        playingSpeakerId = speakerId
        scope.launch(Dispatchers.IO) {
            try {
                val httpClient = AppHttpClient(context.applicationContext)
                val token = getAuthToken(context)
                val requestBuilder = Request.Builder()
                    .url("$baseUrl/api/screen/speakers/$speakerId/audio")
                if (token.isNotEmpty()) {
                    requestBuilder.header("Authorization", "Bearer $token")
                }
                val response = httpClient.getClient().newCall(requestBuilder.build()).execute()
                if (!response.isSuccessful) {
                    if (response.code == 401) {
                        Log.w("VoiceprintUI", "playAudio 401, force logout")
                        com.xehuri.kinship.network.AppHttpClient.forceLogout(context)
                    }
                    playingSpeakerId = ""
                    return@launch
                }
                val audioBytes = response.body?.bytes() ?: run { playingSpeakerId = ""; return@launch }

                val tmpFile = java.io.File.createTempFile("vp_", ".wav")
                tmpFile.writeBytes(audioBytes)
                val mp = MediaPlayer()
                mp.setDataSource(tmpFile.absolutePath)
                mp.setOnCompletionListener { mp.release(); tmpFile.delete(); playingSpeakerId = "" }
                mp.setOnErrorListener { _, _, _ -> mp.release(); tmpFile.delete(); playingSpeakerId = ""; true }
                mp.prepare()
                mp.start()
            } catch (e: Exception) {
                Log.w("VoiceprintUI", "playAudio err", e)
                playingSpeakerId = ""
            }
        }
    }

    // ════════════════════════════════════════
    // 删除声纹
    // ════════════════════════════════════════
    fun doDelete(speakerId: String) {
        scope.launch {
            val deleteHttpClient = AppHttpClient(context.applicationContext)
            withContext(Dispatchers.IO) { deleteSpeaker(context, baseUrl, speakerId, deleteHttpClient) }
            loadSpeakers()
        }
    }

    // ════════════════════════════════════════
    // UI 渲染
    // ════════════════════════════════════════
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())
    ) {
        // ── 标题 ──
        Text("声纹管理", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text("注册和识别说话人声纹", fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface)

        Spacer(Modifier.height(16.dp))

        // ════════════════════════════════════════
        // 1. 注册声纹
        // ════════════════════════════════════════
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(Modifier.padding(14.dp)) {
                Text("注册声纹", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(4.dp))
                Text("输入说话人名称 → 开始录音 → 停止录音 → 自动注册", fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface)

                Spacer(Modifier.height(10.dp))

                OutlinedTextField(
                    value = enrollName,
                    onValueChange = { enrollName = it },
                    label = { Text("说话人名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = enrollState == RecState.IDLE
                )

                Spacer(Modifier.height(10.dp))

                // 录制 / 停止按钮
                if (enrollState == RecState.RECORDING) {
                    Button(
                        onClick = { stopEnroll() },
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error
                        )
                    ) {
                        Text("■ 停止录音  ${enrollElapsed}s", fontSize = 15.sp,
                            color = MaterialTheme.colorScheme.onError)
                    }
                } else {
                    Button(
                        onClick = { startEnroll() },
                        enabled = enrollState == RecState.IDLE,
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.primary
                        )
                    ) {
                        if (enrollState == RecState.UPLOADING) {
                            CircularProgressIndicator(
                                Modifier.height(20.dp).width(20.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(
                            when (enrollState) {
                                RecState.UPLOADING -> "上传注册中..."
                                else -> "开始录音"
                            }
                        )
                    }
                }

                // 提示消息
                if (enrollMsg.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    val msgColor = when {
                        enrollMsg.startsWith("注册成功") -> MaterialTheme.colorScheme.primary
                        enrollMsg.startsWith("录音中") || enrollMsg.contains("处理中") ->
                            MaterialTheme.colorScheme.onSurface
                        else -> MaterialTheme.colorScheme.error
                    }
                    Text(enrollMsg, fontSize = 12.sp, color = msgColor)
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // ════════════════════════════════════════
        // 2. 已注册声纹
        // ════════════════════════════════════════
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(Modifier.padding(14.dp)) {
                Text("已注册声纹", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(4.dp))
                Text("共 ${speakers.size} 个注册说话人", fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface)
                Spacer(Modifier.height(8.dp))

                if (loadingList) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(Modifier.padding(16.dp))
                    }
                } else if (speakers.isEmpty()) {
                    Text("暂无注册声纹", fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.padding(vertical = 8.dp))
                } else {
                    speakers.forEachIndexed { idx, spk ->
                        if (idx > 0) HorizontalDivider(Modifier.padding(vertical = 4.dp))
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(spk.name, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                                if (spk.remark.isNotEmpty()) {
                                    Text(spk.remark, fontSize = 11.sp,
                                        color = MaterialTheme.colorScheme.onSurface)
                                }
                                Text(
                                    "ID: ${spk.speakerId.take(16)}... | ${spk.createdAt}",
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurface
                                )
                            }
                            // 播放注册音频
                            TextButton(
                                onClick = { playAudio(spk.speakerId) },
                                enabled = playingSpeakerId != spk.speakerId || playingSpeakerId.isEmpty()
                            ) {
                                Text(
                                    if (playingSpeakerId == spk.speakerId) "..." else "▶",
                                    fontSize = 13.sp,
                                    color = MaterialTheme.colorScheme.primary
                                )
                            }
                            TextButton(onClick = { doDelete(spk.speakerId) }) {
                                Text("删除", fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // ════════════════════════════════════════
        // 3. 声纹识别测试
        // ════════════════════════════════════════
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(Modifier.padding(14.dp)) {
                Text("声纹识别测试", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(4.dp))
                Text("录制语音并识别是哪位注册说话人", fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface)

                Spacer(Modifier.height(10.dp))

                // 录制 / 停止按钮
                if (identifyState == RecState.RECORDING) {
                    Button(
                        onClick = { stopIdentify() },
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error
                        )
                    ) {
                        Text("■ 停止识别  ${identifyElapsed}s", fontSize = 15.sp,
                            color = MaterialTheme.colorScheme.onError)
                    }
                } else {
                    Button(
                        onClick = { startIdentify() },
                        enabled = identifyState == RecState.IDLE,
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.secondary
                        )
                    ) {
                        if (identifyState == RecState.UPLOADING) {
                            CircularProgressIndicator(
                                Modifier.height(20.dp).width(20.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onSecondary
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(
                            when (identifyState) {
                                RecState.UPLOADING -> "识别中..."
                                else -> "开始录音并识别"
                            }
                        )
                    }
                }

                // 识别结果
                if (identifyResult.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    IdentifyResultContent(identifyResult)
                }

                if (identifyMsg.isNotEmpty() && identifyResult.isEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(identifyMsg, fontSize = 12.sp,
                        color = if (identifyMsg.contains("识别中")) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurface)
                }
            }
        }

        Spacer(Modifier.height(24.dp))

        // ── 返回按钮 ──
        OutlinedButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) {
            Text("返回")
        }

        Spacer(Modifier.height(16.dp))
    }
}

// ========== 识别结果子组件 ==========

@Composable
private fun IdentifyResultContent(resultJson: String) {
    val parsed = remember(resultJson) {
        try {
            val json = JSONObject(resultJson)
            val matches = json.optJSONArray("matches")
            if (matches != null && matches.length() > 0) {
                val top = matches.optJSONObject(0)
                val name = top.optString("name", "?")
                val score = top.optDouble("similarity", 0.0)
                val th = json.optDouble("threshold", 0.4)
                val others = (1 until matches.length()).map { i ->
                    val m = matches.optJSONObject(i)
                    Pair(m?.optString("name", "?") ?: "?", m?.optDouble("similarity", 0.0) ?: 0.0)
                }
                Quadruple(name, score, th, others)
            } else null
        } catch (_: Exception) { null }
    }
    if (parsed == null) {
        Text("识别结果解析失败", fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
        return
    }
    val (matchedName, matchedScore, threshold, otherMatches) = parsed
    Text(
        "匹配: $matchedName",
        fontSize = 16.sp,
        fontWeight = FontWeight.Bold,
        color = if (matchedScore >= threshold) MaterialTheme.colorScheme.primary
        else MaterialTheme.colorScheme.error
    )
    Text(
        "相似度: ${"%.2f".format(matchedScore * 100)}% (阈值: ${"%.0f".format(threshold * 100)}%)",
        fontSize = 13.sp,
        color = MaterialTheme.colorScheme.onSurface
    )
    if (otherMatches.isNotEmpty()) {
        Text("其他匹配:", fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurface)
        otherMatches.forEach { (name, score) ->
            Text("  $name (${"%.1f".format(score * 100)}%)", fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface)
        }
    }
}

/** 用于 remember 的数据容器 */
private data class Quadruple<A, B, C, D>(
    val first: A, val second: B, val third: C, val fourth: D
)

// ========== 网络调用 ==========

/** 读取存储在 SharedPreferences 中的 auth_token */
private fun getAuthToken(context: Context): String {
    val prefs = context.getSharedPreferences("axeuh_prefs", Context.MODE_PRIVATE)
    return prefs.getString("auth_token", "") ?: ""
}

/** 获取已注册的声纹列表 */
private fun fetchSpeakers(context: Context, baseUrl: String, httpClient: AppHttpClient): List<SpeakerInfo> {
    try {
        val token = getAuthToken(context)
        val requestBuilder = Request.Builder().url("$baseUrl/api/screen/speakers")
        if (token.isNotEmpty()) {
            requestBuilder.header("Authorization", "Bearer $token")
        }
        val response = httpClient.getClient().newCall(requestBuilder.build()).execute()
        if (response.code == 401) {
            Log.w("VoiceprintUI", "fetchSpeakers 401, force logout")
            com.xehuri.kinship.network.AppHttpClient.forceLogout(context)
            return emptyList()
        }
        val json = response.body?.string() ?: return emptyList()
        val obj = JSONObject(json)
        if (obj.optString("status") != "ok") return emptyList()
        val arr = obj.optJSONArray("speakers") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val s = arr.optJSONObject(i) ?: return@mapNotNull null
            SpeakerInfo(
                speakerId = s.optString("speaker_id", ""),
                name = s.optString("name", ""),
                createdAt = s.optString("created_at", ""),
                remark = s.optString("remark", "")
            )
        }
    } catch (e: Exception) {
        Log.w("VoiceprintUI", "fetchSpeakers err", e)
        return emptyList()
    }
}

/**
 * 注册声纹：上传 AAC（优先）/ WAV + 名称
 * @return Pair(成功=true/失败=false, SpeakerInfo或错误描述)
 */
private fun enrollVoice(context: Context, baseUrl: String, name: String, wav: ByteArray, httpClient: AppHttpClient): Pair<Boolean, Any> {
    try {
        val token = getAuthToken(context)
        val multipartBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("name", name)
            .addFormDataPart("file", "audio.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .build()
        val requestBuilder = Request.Builder()
            .url("$baseUrl/api/screen/speakers/enroll")
            .post(multipartBody)
        if (token.isNotEmpty()) {
            requestBuilder.header("Authorization", "Bearer $token")
        }
        val response = httpClient.getClient().newCall(requestBuilder.build()).execute()
        val code = response.code
        if (code == 401) {
            Log.w("VoiceprintUI", "enrollVoice 401, force logout")
            com.xehuri.kinship.network.AppHttpClient.forceLogout(context)
            return Pair(false, "未授权，token 已过期")
        }
        val resp = response.body?.string() ?: return Pair(false, "空响应")
        if (!response.isSuccessful) {
            val msg = "HTTP $code - ${resp.take(120)}"
            Log.w("VoiceprintUI", "enroll $msg")
            return Pair(false, msg)
        }
        val json = JSONObject(resp)
        if (json.optString("status") != "ok") {
            val msg = json.optString("message", "status != ok")
            return Pair(false, "API: $msg")
        }
        val spk = json.optJSONObject("speaker") ?: return Pair(false, "响应缺少 speaker 字段")
        return Pair(true, SpeakerInfo(
            speakerId = spk.optString("speaker_id", ""),
            name = spk.optString("name", ""),
            createdAt = spk.optString("created_at", "")
        ))
    } catch (e: Exception) {
        val msg = e.message ?: e.javaClass.simpleName
        Log.w("VoiceprintUI", "enrollVoice err: $msg", e)
        return Pair(false, msg)
    }
}

// ========== AAC 编码 ==========

/** PCM 16-bit → AAC ADTS 编码（~1/8 体积） */
private fun encodePcmToAac(pcmBytes: ByteArray, sampleRate: Int): ByteArray? {
    try {
        val codec = MediaCodec.createEncoderByType("audio/mp4a-latm")
        val format = MediaFormat.createAudioFormat("audio/mp4a-latm", sampleRate, 1)
        format.setInteger(MediaFormat.KEY_BIT_RATE, 64000)
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()

        val output = java.io.ByteArrayOutputStream()
        val bufferInfo = MediaCodec.BufferInfo()
        val timeout = 10000L
        var offset = 0
        val frame = 2048  // 1024 samples * 2 bytes

        while (offset < pcmBytes.size || bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM == 0) {
            if (offset < pcmBytes.size) {
                val inIdx = codec.dequeueInputBuffer(timeout)
                if (inIdx >= 0) {
                    val buf = codec.getInputBuffer(inIdx)!!
                    buf.clear()
                    val chunk = minOf(frame, pcmBytes.size - offset)
                    buf.put(pcmBytes, offset, chunk)
                    offset += chunk
                    val pts = (offset * 1000000L) / (sampleRate * 2)
                    val f = if (offset >= pcmBytes.size) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0
                    codec.queueInputBuffer(inIdx, 0, chunk, pts, f)
                }
            }
            val outIdx = codec.dequeueOutputBuffer(bufferInfo, timeout)
            if (outIdx >= 0) {
                if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && bufferInfo.size > 0) {
                    val buf = codec.getOutputBuffer(outIdx)!!
                    val data = ByteArray(bufferInfo.size).also { buf.get(it) }; buf.clear()
                    val adts = createAdtsHeader(bufferInfo.size + 7, sampleRate)
                    output.write(adts); output.write(data)
                }
                codec.releaseOutputBuffer(outIdx, false)
            }
        }
        codec.stop(); codec.release()
        return output.toByteArray().takeIf { it.isNotEmpty() }
    } catch (e: Exception) {
        Log.w("VoiceprintUI", "AAC编码失败", e)
        return null
    }
}

/** AAC ADTS 头部（7字节，无CRC） */
private fun createAdtsHeader(frameLen: Int, sampleRate: Int): ByteArray {
    val srIdx = when (sampleRate) {
        96000 -> 0; 88200 -> 1; 64000 -> 2; 48000 -> 3
        44100 -> 4; 32000 -> 5; 24000 -> 6; 22050 -> 7
        16000 -> 8; 12000 -> 9; 11025 -> 10; 8000 -> 11
        else -> 4
    }
    val h = ByteArray(7)
    h[0] = 0xFF.toByte(); h[1] = 0xF9.toByte()
    h[2] = ((0x01 shl 6) or (srIdx shl 2) or (0x01 shr 2)).toByte()
    h[3] = (((0x01 and 0x03) shl 6) or (frameLen shr 11 and 0x03)).toByte()
    h[4] = (frameLen shr 3 and 0xFF).toByte()
    h[5] = ((frameLen and 0x07) shl 5 or 0x1F).toByte()
    h[6] = 0xFC.toByte()
    return h
}

/** 声纹识别：上传 WAV → 返回 JSON 字符串或错误描述 */
private fun identifyVoice(context: Context, baseUrl: String, wav: ByteArray, httpClient: AppHttpClient): Pair<Boolean, String> {
    try {
        val token = getAuthToken(context)
        val multipartBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", "a.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .build()
        val requestBuilder = Request.Builder()
            .url("$baseUrl/api/screen/speakers/identify")
            .post(multipartBody)
        if (token.isNotEmpty()) {
            requestBuilder.header("Authorization", "Bearer $token")
        }
        val response = httpClient.getClient().newCall(requestBuilder.build()).execute()
        val code = response.code
        if (code == 401) {
            Log.w("VoiceprintUI", "identifyVoice 401, force logout")
            com.xehuri.kinship.network.AppHttpClient.forceLogout(context)
            return Pair(false, "未授权，token 已过期")
        }
        val resp = response.body?.string() ?: return Pair(false, "空响应")
        if (!response.isSuccessful) {
            val msg = "HTTP $code - ${resp.take(120)}"
            Log.w("VoiceprintUI", "identify $msg")
            return Pair(false, msg)
        }
        return Pair(true, resp)
    } catch (e: Exception) {
        val msg = e.message ?: e.javaClass.simpleName
        Log.w("VoiceprintUI", "identifyVoice err: $msg", e)
        return Pair(false, msg)
    }
}

/** 删除声纹 */
private fun deleteSpeaker(context: Context, baseUrl: String, speakerId: String, httpClient: AppHttpClient): Boolean {
    try {
        val token = getAuthToken(context)
        val requestBuilder = Request.Builder()
            .url("$baseUrl/api/screen/speakers/$speakerId")
            .delete()
        if (token.isNotEmpty()) {
            requestBuilder.header("Authorization", "Bearer $token")
        }
        val response = httpClient.getClient().newCall(requestBuilder.build()).execute()
        val code = response.code
        if (code == 401) {
            Log.w("VoiceprintUI", "deleteSpeaker 401, force logout")
            com.xehuri.kinship.network.AppHttpClient.forceLogout(context)
            return false
        }
        return code in 200..299
    } catch (e: Exception) {
        Log.w("VoiceprintUI", "deleteSpeaker err", e)
        return false
    }
}

// ========== 录音 ==========

/**
 * 手动启停录音
 * @param shouldContinue 返回 true=继续录音, false=停止
 * @return WAV 字节数组，失败返回 null
 */
private fun recordWavManual(shouldContinue: () -> Boolean): ByteArray? {
    val sr = 16000
    val bufSize = AudioRecord.getMinBufferSize(sr, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (bufSize <= 0) return null
    val sources = intArrayOf(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        MediaRecorder.AudioSource.MIC,
        MediaRecorder.AudioSource.CAMCORDER
    )
    var ar: AudioRecord? = null
    for (src in sources) {
        try {
            val a = AudioRecord(src, sr, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize * 4)
            if (a.state == AudioRecord.STATE_INITIALIZED) { ar = a; break }
            a.release()
        } catch (_: Exception) {}
    }
    if (ar == null) return null

    val buf = ShortArray(bufSize / 2)
    val pcm = ByteArrayOutputStream()

    try {
        ar.startRecording()
        while (shouldContinue() && !Thread.interrupted()) {
            val n = ar.read(buf, 0, buf.size)
            if (n <= 0) continue
            // AudioRecord 返回小端 PCM，必须用小端写入
            val bb = java.nio.ByteBuffer.allocate(n * 2)
            bb.order(java.nio.ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until n) bb.putShort(buf[i])
            pcm.write(bb.array())
        }
        ar.stop()
    } catch (e: Exception) {
        Log.w("VoiceprintUI", "record err", e)
        return null
    } finally {
        ar.release()
    }

    val pcmBytes = pcm.toByteArray()
    if (pcmBytes.size < 320) return null // 至少 20ms 有效数据
    return pcmToWav(pcmBytes, sr)
}

/** PCM 原始数据 → WAV 格式（正确的小端字节序） */
private fun pcmToWav(pcm: ByteArray, sr: Int): ByteArray {
    val baos = ByteArrayOutputStream(44 + pcm.size)
    val bps = 16; val ch = 1
    val byteRate = sr * ch * bps / 8
    val blockAlign = ch * bps / 8
    val dataSize = pcm.size
    val riffSize = 36 + dataSize
    // WAV 是小端（little-endian），手动写字节
    fun writeLE16(v: Int) { baos.write(v and 0xff); baos.write(v ushr 8 and 0xff) }
    fun writeLE32(v: Int) { baos.write(v and 0xff); baos.write(v ushr 8 and 0xff); baos.write(v ushr 16 and 0xff); baos.write(v ushr 24 and 0xff) }
    baos.write("RIFF".toByteArray())
    writeLE32(riffSize)
    baos.write("WAVE".toByteArray())
    baos.write("fmt ".toByteArray())
    writeLE32(16)            // chunk size
    writeLE16(1)             // audio format: PCM
    writeLE16(ch)            // channels: mono
    writeLE32(sr)            // sample rate
    writeLE32(byteRate)      // byte rate
    writeLE16(blockAlign)    // block align
    writeLE16(bps)           // bits per sample
    baos.write("data".toByteArray())
    writeLE32(dataSize)      // data chunk size
    baos.write(pcm)
    baos.close()
    return baos.toByteArray()
}

// TrustAllSSL 已迁移到 AppHttpClient 集中管理
