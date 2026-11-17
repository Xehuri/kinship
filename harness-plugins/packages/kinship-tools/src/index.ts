/**
 * Kinship notification, reminder-board and TTS tools for the dsh preset.
 *
 * Loom ships these three features as one MCP server (`ai-template/mcp/ai_mcp.py`)
 * that talks HTTPS to the Kinship backend. On dsh they are native preset tools
 * that reach the same backend through the sibling `kinship-bridge` service, so a
 * Kinship Session needs no extra MCP process and no backend address or token of
 * its own: the backend pushes both to the bridge (`POST /v1/kinship/tool-auth`)
 * and the bridge keeps them in memory.
 *
 * The model-facing names, arguments and answer texts mirror the Loom MCP tools,
 * because the Kinship prompts and the daily workflow already reference them. The
 * bridge is resolved structurally (`ctx.get('kinshipBridge')`) instead of by
 * importing the bridge package, so the two plugins stay independently
 * installable; with no bridge or no pushed credentials every tool answers with a
 * clear text and never throws.
 *
 * @module kinship-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'

/** Parsed plugin configuration. */
export interface Config {
  /** Upper bound for one reminder-board body, measured after trimming. */
  maxReminderChars: number
}

/** Config schema shown by `dsh --dump-config-schema`. */
export const Config: z<Config> = z.object({
  maxReminderChars: z.number().step(1).min(1).default(2_000).description(
    'Maximum reminder-board body length in characters after trimming; matches the backend board limit.',
  ),
})

/** Stable Cordis plugin name. */
export const name = 'kinship-tools'

/** The tool registry plus the sibling bridge service that reaches the backend. */
export const inject = ['tools', 'kinshipBridge']

/** Outcome of one backend call, structurally mirroring `kinship-bridge`. */
export interface BridgeToolResult {
  readonly ok: boolean
  readonly status: number | null
  readonly data?: unknown
  readonly error?: string
}

/** Token-free tool-auth projection, structurally mirroring `kinship-bridge`. */
export interface BridgeToolAuthStatus {
  readonly configured: boolean
  readonly baseUrl: string | null
  readonly at: number | null
}

/** The bridge surface these tools need; every method stays optional. */
interface BridgeService {
  toolAuth?(): BridgeToolAuthStatus
  notify?(input: { readonly title: string; readonly content: string }): Promise<BridgeToolResult>
  remind?(input: { readonly text: string }): Promise<BridgeToolResult>
  listReminders?(): Promise<BridgeToolResult>
  tts?(input: {
    readonly text: string
    readonly voice?: string
    readonly style?: string
    readonly user_id?: string
  }): Promise<BridgeToolResult>
}

/** One bridge method this package calls. */
type BridgeMethod = 'notify' | 'remind' | 'listReminders' | 'tts'

/** Canonical tool value: the model-facing text plus the raw backend payload. */
export interface ToolOutcome {
  readonly ok: boolean
  readonly text: string
  readonly data?: JsonValue
}

/** Answer when this composition mounted no bridge at all. */
const BRIDGE_UNAVAILABLE = 'Kinship 桥服务不可用（本次启动未挂载 kinshipBridge），手机通知、提醒板和语音工具暂时不可用。'

/** Answer when the bridge exists but the backend never pushed its credentials. */
const TOOL_AUTH_MISSING = 'Kinship 桥尚未收到后端的工具授权（POST /v1/kinship/tool-auth），手机通知、提醒板和语音工具暂时不可用。'

/** Voice used when a TTS call omits `voice`; mirrors the Loom MCP tool. */
const DEFAULT_VOICE = 'mimo_default'

/** Longest TTS preview the acknowledgement quotes, mirroring the Loom tool. */
const TTS_PREVIEW_CHARS = 50

const OUTCOME_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' as const, required: true },
    text: { type: 'string' as const, required: true },
    data: { type: 'json' as const },
  },
} as const

const RESPONSE_FORMAT = {
  type: 'string' as const,
  enum: ['markdown', 'json'] as const,
  description: '输出格式：markdown（默认，便于直接读）或 json（返回后端原始 JSON）。',
}

function renderOutcome(_args: unknown, value: ToolOutcome): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value.text }]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build one canonical outcome, omitting `data` when the backend sent none. */
function outcome(ok: boolean, text: string, data?: unknown): ToolOutcome {
  return data === undefined ? { ok, text } : { ok, text, data: toJsonValue(data) }
}

/**
 * Copy one backend payload into the lossless JSON value a tool may return.
 *
 * The bridge hands over `JSON.parse` output, so this normally copies plain JSON;
 * a value that cannot represent JSON (a fake bridge in a test, a programming
 * error) degrades to `null` instead of failing the call the model is waiting on.
 */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(item => toJsonValue(item))
  if (isRecord(value)) {
    const record: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value)) record[key] = toJsonValue(item)
    return record
  }
  return null
}

/** Read one string field off an unknown JSON payload, or null. */
function payloadString(payload: unknown, key: string): string | null {
  if (!isRecord(payload)) return null
  const value = payload[key]
  return typeof value === 'string' ? value : null
}

/** True when the payload carries the field at all, even with a null value. */
function payloadHas(payload: unknown, key: string): boolean {
  return isRecord(payload) && Object.hasOwn(payload, key)
}

/** `data.status in ("ok", "sent")`, mirroring the Loom tools. */
function payloadSucceeded(payload: unknown): boolean {
  const status = payloadString(payload, 'status')
  return status === 'ok' || status === 'sent'
}

/**
 * Format one reminder-board timestamp.
 *
 * The backend stores Unix seconds; an invalid value falls back to its raw string
 * so rendering never crashes on an unexpected payload.
 */
function formatBoardTimestamp(value: unknown): string {
  const seconds = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(seconds)) return String(value)
  const date = new Date(seconds * 1_000)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (input: number): string => String(input).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Fold one failed bridge call into the Loom tool's error text.
 *
 * `ai_mcp.py` mapped `httpx` failures to a fixed set of sentences; the bridge
 * performs the same request, so the same mapping applies to its status code and
 * to the connection/timeout cases it reports with a null status.
 */
function describeFailure(result: BridgeToolResult): string {
  const status = result.status
  if (status === null) {
    const detail = result.error ?? ''
    if (/timed? ?out/i.test(detail)) return 'Error: Request timed out. Please try again.'
    return 'Error: Cannot connect to backend. Make sure the Kinship backend is running.'
  }
  switch (status) {
    case 401:
      return 'Error: Authentication failed. Token may be expired.'
    case 403:
      return "Error: Permission denied. You don't have access to this resource."
    case 404:
      return 'Error: Resource not found. Please check the ID is correct.'
    case 429:
      return 'Error: Rate limit exceeded. Please wait before making more requests.'
    case 500:
      return 'Error: Server error. The Kinship backend may not be running.'
    default:
      return `Error: API request failed with status ${String(status)}`
  }
}

/** Render one canonical outcome as the model-facing string it stands for. */
function toJsonText(payload: unknown): string {
  return payload === undefined ? '{}' : JSON.stringify(toJsonValue(payload), null, 2)
}

/** Resolve the sibling bridge service, or null when this composition has none. */
function bridgeOf(ctx: Context): BridgeService | null {
  try {
    const service = ctx.get('kinshipBridge') as BridgeService | undefined
    return service === undefined || service === null ? null : service
  } catch {
    return null
  }
}

/** True when the backend already pushed its tool auth into the bridge. */
function toolAuthConfigured(bridge: BridgeService): boolean {
  try {
    return bridge.toolAuth?.().configured === true
  } catch {
    return false
  }
}

/** Answer of one bridge call: either the backend result or a local failure text. */
type BridgeCall =
  | { readonly ok: true; readonly result: BridgeToolResult }
  | { readonly ok: false; readonly text: string }

/**
 * Invoke one bridge method, folding the local failure modes into a text.
 *
 * A missing service, a bridge that never received the push, and a throwing
 * service all answer a readable sentence: the model must be able to react
 * without a harness-level tool error.
 *
 * @param ctx - preset context carrying the bridge service.
 * @param method - bridge method name, used only to check it exists.
 * @param invoke - the actual call, run only when the bridge can serve it.
 * @returns the backend result, or the local failure text.
 */
async function callBridge(
  ctx: Context,
  method: BridgeMethod,
  invoke: (bridge: BridgeService) => Promise<BridgeToolResult>,
): Promise<BridgeCall> {
  const bridge = bridgeOf(ctx)
  if (bridge === null || typeof bridge[method] !== 'function') {
    return { ok: false, text: BRIDGE_UNAVAILABLE }
  }
  if (!toolAuthConfigured(bridge)) return { ok: false, text: TOOL_AUTH_MISSING }
  try {
    return { ok: true, result: await invoke(bridge) }
  } catch (error) {
    return { ok: false, text: `Kinship 桥调用失败：${messageOf(error)}` }
  }
}

/** True when the call asked for the raw JSON envelope. */
function wantsJson(format: string | undefined): boolean {
  return format === 'json'
}

/**
 * Mount the four Kinship tools over `ctx.tools` and the sibling bridge.
 *
 * @param ctx - preset context: the tool registry plus `kinshipBridge`.
 * @param config - reminder-board length bound.
 */
export function apply(ctx: Context, config: Config): void {
  const maxReminderChars = config.maxReminderChars

  const sendNotification: ToolDefinition = defineTool({
    name: 'ai-mcp_send_notification',
    description:
      '给用户的手机发送一条系统通知。当你想提醒用户重要事项、系统状态、任务完成、倒计时等场景时使用；'
      + '通知会推送至用户的手机并在通知栏显示。返回发送结果文本。',
    parameters: {
      title: { type: 'string', required: true, description: '通知标题，如「系统提醒」「任务完成」。' },
      content: { type: 'string', required: true, description: '通知正文，简要说明通知内容。' },
      response_format: RESPONSE_FORMAT,
    },
    output: {
      schema: OUTCOME_SCHEMA,
      render: renderOutcome,
    },
    async execute(args): Promise<ToolOutcome> {
      const title = args.title
      const content = args.content
      if (title.trim() === '') return outcome(false, '通知发送失败: title 不能为空')
      if (content.trim() === '') return outcome(false, '通知发送失败: content 不能为空')

      const call = await callBridge(ctx, 'notify', bridge => {
        if (bridge.notify === undefined) throw new Error('notify is unavailable')
        return bridge.notify({ title, content })
      })
      if (!call.ok) return outcome(false, call.text)

      const result = call.result
      if (!result.ok) return outcome(false, describeFailure(result))
      if (wantsJson(args.response_format)) {
        return outcome(true, toJsonText(result.data), result.data)
      }
      if (payloadSucceeded(result.data)) return outcome(true, `通知已发送: ${title}`, result.data)
      const message = payloadString(result.data, 'message') ?? '未知错误'
      return outcome(false, `通知发送失败: ${message}`, result.data)
    },
  })

  const sendReminder: ToolDefinition = defineTool({
    name: 'ai-mcp_send_reminder',
    description:
      '整块覆盖写入桌面「AI 提醒」板（单一文本板模型）。标准工作流：先 list_reminders 读当前全文 → '
      + '在其基础上编辑（增改删）→ 本工具写回整段（传空串清空提醒板）。本工具是全量覆盖：'
      + `没包含进 text 的旧内容会直接消失，务必先读后写；去首尾空白后上限 ${String(maxReminderChars)} 字符。`,
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: `提醒板全文（整块覆盖；去首尾空白后上限 ${String(maxReminderChars)} 字符；空串 = 清空整块提醒板）。`,
      },
      response_format: RESPONSE_FORMAT,
    },
    output: {
      schema: OUTCOME_SCHEMA,
      render: renderOutcome,
    },
    async execute(args): Promise<ToolOutcome> {
      const text = args.text.trim()
      if (text.length > maxReminderChars) {
        return outcome(
          false,
          `提醒板写入失败: 全文 ${String(text.length)} 字符，超过上限 ${String(maxReminderChars)} 字符`,
        )
      }

      const call = await callBridge(ctx, 'remind', bridge => {
        if (bridge.remind === undefined) throw new Error('remind is unavailable')
        return bridge.remind({ text })
      })
      if (!call.ok) return outcome(false, call.text)

      const result = call.result
      if (!result.ok) return outcome(false, describeFailure(result))
      if (wantsJson(args.response_format)) {
        return outcome(true, toJsonText(result.data), result.data)
      }
      if (!payloadHas(result.data, 'text')) {
        const detail = payloadString(result.data, 'detail')
          ?? payloadString(result.data, 'message')
          ?? '未知错误'
        return outcome(false, `提醒板写入失败: ${detail}`, result.data)
      }
      if (payloadString(result.data, 'text') === '') {
        return outcome(true, '提醒板已清空', result.data)
      }
      const updatedAt = isRecord(result.data) ? result.data['updated_at'] : undefined
      return outcome(true, `提醒板已更新（${formatBoardTimestamp(updatedAt ?? 0)}）`, result.data)
    },
  })

  const listReminders: ToolDefinition = defineTool({
    name: 'ai-mcp_list_reminders',
    description:
      '读取当前用户「AI 提醒」板的全文（单一文本板）。标准工作流第一步：send_reminder 整块覆盖之前'
      + '必须先经本工具读回当前全文，在其基础上编辑后整段写回，否则没写回的旧内容会丢失。'
      + '用户问「我现在的提醒/待办有哪些」时也用它。',
    parameters: {
      response_format: RESPONSE_FORMAT,
    },
    output: {
      schema: OUTCOME_SCHEMA,
      render: renderOutcome,
    },
    async execute(args): Promise<ToolOutcome> {
      const call = await callBridge(ctx, 'listReminders', bridge => {
        if (bridge.listReminders === undefined) throw new Error('listReminders is unavailable')
        return bridge.listReminders()
      })
      if (!call.ok) return outcome(false, call.text)

      const result = call.result
      if (!result.ok) return outcome(false, describeFailure(result))
      if (wantsJson(args.response_format)) {
        return outcome(true, toJsonText(result.data), result.data)
      }
      if (!isRecord(result.data)) {
        return outcome(false, '提醒板读取失败: 后端返回的不是对象', result.data)
      }
      const text = payloadString(result.data, 'text') ?? ''
      const updatedAt = result.data['updated_at'] ?? 0
      if (text === '') {
        return outcome(true, `提醒板当前为空（updated_at=${String(updatedAt)}）`, result.data)
      }
      return outcome(
        true,
        `提醒板全文（updated_at=${String(updatedAt)}，${formatBoardTimestamp(updatedAt)}）:\n`
        + `\`\`\`\n${text}\n\`\`\``,
        result.data,
      )
    },
  })

  const ttsSpeak: ToolDefinition = defineTool({
    name: 'tts_speak',
    description:
      '使用 TTS 语音合成并播放文本。当需要语音回复用户时使用；工具在成功发送请求后立即返回，'
      + '不等待播放完成，说话人会听到这段语音。',
    parameters: {
      text: { type: 'string', required: true, description: '要朗读的文本内容。' },
      voice: { type: 'string', description: `音色，默认 ${DEFAULT_VOICE}。` },
      style: { type: 'string', description: '风格，如开心、悲伤、东北话等。' },
      user_id: { type: 'string', description: '目标用户 ID，不传则广播给所有用户。' },
      response_format: RESPONSE_FORMAT,
    },
    output: {
      schema: OUTCOME_SCHEMA,
      render: renderOutcome,
    },
    async execute(args): Promise<ToolOutcome> {
      const text = args.text
      if (text.trim() === '') return outcome(false, 'TTS发送失败: text 不能为空')
      const voice = args.voice === undefined || args.voice.trim() === '' ? DEFAULT_VOICE : args.voice

      const call = await callBridge(ctx, 'tts', bridge => {
        if (bridge.tts === undefined) throw new Error('tts is unavailable')
        return bridge.tts({
          text,
          voice,
          ...(args.style === undefined ? {} : { style: args.style }),
          ...(args.user_id === undefined ? {} : { user_id: args.user_id }),
        })
      })
      if (!call.ok) return outcome(false, call.text)

      const result = call.result
      if (!result.ok) return outcome(false, describeFailure(result))
      if (wantsJson(args.response_format)) {
        return outcome(true, toJsonText(result.data), result.data)
      }
      if (payloadSucceeded(result.data)) {
        const preview = text.slice(0, TTS_PREVIEW_CHARS)
          + (text.length > TTS_PREVIEW_CHARS ? '...' : '')
        return outcome(true, `TTS语音已成功发送: "${preview}"`, result.data)
      }
      const message = payloadString(result.data, 'message') ?? '未知错误'
      return outcome(false, `TTS发送失败: ${message}`, result.data)
    },
  })

  const disposed: ToolDefinition[] = [
    sendNotification,
    sendReminder,
    listReminders,
    ttsSpeak,
  ]
  const disposers = disposed.map(definition => ctx.tools.register(definition))
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'kinship-tools registrations')

  ctx.logger.info(
    `kinship-tools: mounted ${disposed.map(definition => definition.name).join(', ')}`,
  )
}
