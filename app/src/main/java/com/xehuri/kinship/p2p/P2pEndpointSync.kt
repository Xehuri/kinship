package com.xehuri.kinship.p2p

import com.xehuri.kinship.config.EndpointCandidate
import com.xehuri.kinship.config.ServerConfig
import kotlinx.coroutines.CancellationException

/**
 * 把后端 P2P 状态同步为 [ServerConfig] 的端点候选。
 *
 * 仅在 `enabled && endpoints.isNotEmpty()` 时写入；其余情况返回 false，让旧版
 * `server_url` 行为保持不变。
 */
object P2pEndpointSync {

    suspend fun refresh(
        statusProvider: suspend () -> P2pStatus,
        update: (List<EndpointCandidate>) -> Unit = { ServerConfig.updateEndpointCandidates(it) }
    ): Boolean {
        val status = try {
            statusProvider()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return false
        }
        return apply(status, update)
    }

    internal fun apply(
        status: P2pStatus,
        update: (List<EndpointCandidate>) -> Unit
    ): Boolean {
        if (!status.enabled || status.endpoints.isEmpty()) return false
        update(status.endpointCandidates())
        return true
    }
}
