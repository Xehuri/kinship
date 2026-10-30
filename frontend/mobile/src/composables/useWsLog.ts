/**
 * WS 日志 Composable
 *
 * 模块级单例: App 注册 WebSocket 消息处理器, 设置页「WS 日志」行与
 * WsLogDrawer 共享同一份日志和开关状态。
 */

import { readonly, ref, type Ref } from 'vue'
import type { WSMessageHandler } from '@/api/ws'

export interface WsLogEntry {
  time: string
  message: string
}

export interface UseWsLogReturn {
  /** 日志条目 (最多 200 条, 超出后保留最近 100 条) */
  logs: Readonly<Ref<readonly WsLogEntry[]>>
  /** 抽屉是否打开 */
  visible: Readonly<Ref<boolean>>
  /** 打开抽屉 */
  open: () => void
  /** 关闭抽屉 */
  close: () => void
  /** 切换抽屉 */
  toggle: () => void
  /** 清空日志 */
  clear: () => void
  /** WS 消息处理器 (供 App 注册到 useRealTime) */
  handler: WSMessageHandler
}

const MAX_LOGS = 200
const TRIM_TO = 100

const logs = ref<WsLogEntry[]>([])
const visible = ref(false)

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function timestamp(): string {
  const now = new Date()
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function push(message: string): void {
  logs.value.push({ time: timestamp(), message })
  if (logs.value.length > MAX_LOGS) {
    logs.value = logs.value.slice(-TRIM_TO)
  }
}

function stringify(data: unknown): string {
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

const handler: WSMessageHandler = (data: unknown) => {
  if (data && typeof data === 'object') {
    const msg = data as Record<string, unknown>
    if (msg.type === 'tts_audio_chunk' || msg.type === 'tts_audio') return
    if (msg.type === 'tts_start' || msg.type === 'tts_end') {
      push(
        JSON.stringify({
          type: msg.type,
          text: (msg.text || '')?.toString()?.substring(0, 50),
        }),
      )
      return
    }
  }

  push(stringify(data))
}

export function useWsLog(): UseWsLogReturn {
  return {
    logs: readonly(logs),
    visible: readonly(visible),
    open: () => {
      visible.value = true
    },
    close: () => {
      visible.value = false
    },
    toggle: () => {
      visible.value = !visible.value
    },
    clear: () => {
      logs.value = []
    },
    handler,
  }
}

/** 重置单例状态 (仅供单元测试) */
export function resetWsLog(): void {
  logs.value = []
  visible.value = false
}
