/**
 * 待回复 Promise 控制器 (FE-H5)
 *
 * 从 useStreamingMessage 拆出的 pending promise 状态机:
 *   - 每次 createPendingReply 递增请求序号;
 *   - 新请求会先把上一个未完成的 pending resolve 掉 (视为被取代), 避免悬挂;
 *   - 120s 超时回调只在序号未被取代时才 resolve, 不会误触发新请求的 promise。
 *
 * 状态为模块级, 与单例 useStreamingMessage 共享同一控制器。
 */

/** assistant 回复的 pending promise resolve 回调 */
let _resolveAssistantReply: (() => void) | null = null

/** 待回复请求序号 */
let _pendingSeq = 0

/** 当前 pending 对应的请求序号 */
let _activePendingSeq = 0

/** pending 超时定时器句柄 (resolve/清理时必须清除) */
let _pendingTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 解析并清理当前 pending promise (幂等)
 */
export function resolvePendingReply(): void {
  if (_pendingTimer !== null) {
    clearTimeout(_pendingTimer)
    _pendingTimer = null
  }
  _activePendingSeq = 0
  if (_resolveAssistantReply) {
    const r = _resolveAssistantReply
    _resolveAssistantReply = null
    r()
  }
}

/**
 * 创建待回复 Promise (FE-H5)
 *
 * 发送消息后调用。流式正常完成由 resolvePendingReply() resolve。
 */
export function createPendingReply(): Promise<void> {
  // 旧的 pending 若仍存在, 先 resolve (被新请求取代)
  resolvePendingReply()

  const seq = ++_pendingSeq
  return new Promise<void>((resolve) => {
    _resolveAssistantReply = resolve
    _activePendingSeq = seq

    // 120 秒超时兜底: 仅当仍是当前请求时才 resolve
    _pendingTimer = setTimeout(() => {
      _pendingTimer = null
      if (_activePendingSeq === seq) {
        resolvePendingReply()
      }
    }, 120000)
  })
}

/** 是否有待回复的 Promise */
export function hasPendingReply(): boolean {
  return _resolveAssistantReply !== null
}
