/**
 * Acceptance for `kinship-tools`: the four native Kinship tools that replace the
 * ai_mcp MCP server, driven over a fake `kinshipBridge` service and a fake Cordis
 * context.
 *
 * The cases pin the contract the Loom prompts already rely on: the tool names,
 * their arguments, the answer texts of `ai_mcp.py`, the reminder-board length
 * bound, and the two degradation paths (no bridge, no pushed credentials), which
 * must answer text instead of throwing.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, apply, inject, name } from '../../packages/kinship-tools/src/index.js'
import type { ToolOutcome } from '../../packages/kinship-tools/src/index.js'

/** Outcome shape structurally mirroring `kinship-bridge`'s `ToolResult`. */
interface BridgeToolResult {
  readonly ok: boolean
  readonly status: number | null
  readonly data?: unknown
  readonly error?: string
}

interface BridgeAuthStatus {
  readonly configured: boolean
  readonly baseUrl: string | null
  readonly at: number | null
}

type NotifyMock = Mock<(input: { title: string, content: string }) => Promise<BridgeToolResult>>
type RemindMock = Mock<(input: { text: string }) => Promise<BridgeToolResult>>
type ListMock = Mock<() => Promise<BridgeToolResult>>
type TtsMock = Mock<(input: {
  text: string
  voice?: string
  style?: string
  user_id?: string
}) => Promise<BridgeToolResult>>

interface FakeBridge {
  readonly notify: NotifyMock
  readonly remind: RemindMock
  readonly listReminders: ListMock
  readonly tts: TtsMock
  readonly service: object
}

interface HarnessOptions {
  /** Mount no bridge at all: `ctx.get` answers undefined. */
  readonly bridge?: false
  /** Push credentials into the fake bridge; default true. */
  readonly configured?: boolean
  /** Make the bridge's `toolAuth()` throw. */
  readonly toolAuthThrows?: boolean
  /** Reminder-board length bound; default 2000. */
  readonly maxReminderChars?: number
}

interface Harness {
  readonly tools: ToolDefinition[]
  readonly defined: Map<string, ToolDefinition>
  readonly bridge: FakeBridge | null
  readonly info: string[]
  readonly warnings: string[]
  dispose(): void
}

const harnesses: Harness[] = []

/** Answer every bridge call with "backend said nothing useful". */
function emptyResult(): BridgeToolResult {
  return { ok: true, status: 200, data: {} }
}

function createFakeBridge(options: HarnessOptions): FakeBridge {
  const configured = options.configured ?? true
  const toolAuth = (): BridgeAuthStatus => {
    if (options.toolAuthThrows === true) throw new Error('bridge exploded')
    return configured
      ? { configured: true, baseUrl: 'http://127.0.0.1:18768', at: 1_794_759_000_000 }
      : { configured: false, baseUrl: null, at: null }
  }
  const notify = vi.fn<(input: { title: string, content: string }) => Promise<BridgeToolResult>>(
    async () => ({ ok: true, status: 200, data: { status: 'ok' } }),
  )
  const remind = vi.fn<(input: { text: string }) => Promise<BridgeToolResult>>(
    async () => emptyResult(),
  )
  const listReminders = vi.fn<() => Promise<BridgeToolResult>>(async () => emptyResult())
  const tts = vi.fn<(input: {
    text: string
    voice?: string
    style?: string
    user_id?: string
  }) => Promise<BridgeToolResult>>(async () => ({ ok: true, status: 200, data: { status: 'ok' } }))
  return {
    notify,
    remind,
    listReminders,
    tts,
    service: { toolAuth, notify, remind, listReminders, tts },
  }
}

/**
 * Compose the plugin over a minimal fake Cordis context.
 *
 * @param options - which bridge, if any, this composition carries.
 * @returns the registered tools, the fake bridge, the log sinks, and a disposer.
 */
function createHarness(options: HarnessOptions = {}): Harness {
  const tools: ToolDefinition[] = []
  const info: string[] = []
  const warnings: string[] = []
  const disposers: (() => void)[] = []
  const bridge = options.bridge === false ? null : createFakeBridge(options)

  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    get: (key: string) => (key === 'kinshipBridge' ? bridge?.service : undefined),
    logger: {
      info: (format: string) => {
        info.push(format)
      },
      warn: (format: string) => {
        warnings.push(format)
      },
      error: () => undefined,
      debug: () => undefined,
    },
    effect: (execute: () => () => void) => {
      disposers.push(execute())
      return () => undefined
    },
  } as unknown as Context

  apply(ctx, { maxReminderChars: options.maxReminderChars ?? 2_000 })

  const defined = new Map(tools.map(tool => [tool.name, tool]))
  const harness: Harness = {
    tools,
    defined,
    bridge,
    info,
    warnings,
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
  harnesses.push(harness)
  return harness
}

/** Look one tool up, failing loudly when the name is not registered. */
function toolOf(harness: Harness, toolName: string): ToolDefinition {
  const tool = harness.defined.get(toolName)
  if (tool === undefined) throw new Error(`tool ${toolName} is not registered`)
  return tool
}

/** Invoke the tool body the way the executor does, with only what it reads. */
async function callTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const exec = {
    signal: new AbortController().signal,
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  } as unknown as ToolRunContext
  return await tool.execute(args, exec) as ToolOutcome
}

/** Project one canonical outcome to its model-facing text. */
function contentText(tool: ToolDefinition, value: ToolOutcome): string {
  const render = tool.output.render
  const blocks = render({}, value as unknown as Parameters<typeof render>[1])
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
}

const TOOL_NAMES = [
  'ai-mcp_send_notification',
  'ai-mcp_send_reminder',
  'ai-mcp_list_reminders',
  'tts_speak',
] as const

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.dispose()
})

describe('kinship-tools plugin surface', () => {
  it('declares the stable identity and injects the tool and bridge seams', () => {
    expect(name).toBe('kinship-tools')
    expect(inject).toEqual(['tools', 'kinshipBridge'])
    expect(Config).toBeDefined()
  })

  it('registers exactly the four Loom-compatible tool names', () => {
    const harness = createHarness()
    expect(harness.tools.map(tool => tool.name)).toEqual([...TOOL_NAMES])
    expect(harness.info.some(line => line.includes('ai-mcp_send_notification'))).toBe(true)
  })

  it('declares the Loom argument surface for every tool', () => {
    const harness = createHarness()
    const notification = toolOf(harness, 'ai-mcp_send_notification').parameters
    expect(notification['required']).toEqual(['title', 'content'])
    const notificationProps = notification['properties'] as Record<string, Record<string, unknown>>
    expect(notificationProps['response_format']?.['enum']).toEqual(['markdown', 'json'])

    const reminder = toolOf(harness, 'ai-mcp_send_reminder').parameters
    expect(reminder['required']).toEqual(['text'])

    const list = toolOf(harness, 'ai-mcp_list_reminders').parameters
    expect(list['required']).toBeUndefined()

    const tts = toolOf(harness, 'tts_speak').parameters
    expect(tts['required']).toEqual(['text'])
    const ttsProps = tts['properties'] as Record<string, Record<string, unknown>>
    expect(Object.keys(ttsProps).sort()).toEqual(
      ['response_format', 'style', 'text', 'user_id', 'voice'],
    )
  })

  it('unregisters every tool on dispose', () => {
    const harness = createHarness()
    expect(harness.tools).toHaveLength(4)
    harness.dispose()
    expect(harness.tools).toHaveLength(0)
  })
})

describe('kinship-tools without a usable bridge', () => {
  it('answers a readable text when no bridge is mounted', async () => {
    const harness = createHarness({ bridge: false })
    const value = await callTool(toolOf(harness, 'ai-mcp_send_notification'), {
      title: '标题',
      content: '正文',
    })
    expect(value.ok).toBe(false)
    expect(value.text).toContain('Kinship 桥服务不可用')
    expect(contentText(toolOf(harness, 'ai-mcp_send_notification'), value)).toBe(value.text)
  })

  it('answers a readable text when the backend never pushed credentials', async () => {
    const harness = createHarness({ configured: false })
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    const value = await callTool(toolOf(harness, 'ai-mcp_list_reminders'), {})
    expect(value.ok).toBe(false)
    expect(value.text).toContain('尚未收到后端的工具授权')
    expect(bridge.listReminders).not.toHaveBeenCalled()
  })

  it('treats a throwing toolAuth as unconfigured', async () => {
    const harness = createHarness({ toolAuthThrows: true })
    const value = await callTool(toolOf(harness, 'tts_speak'), { text: '你好' })
    expect(value.ok).toBe(false)
    expect(value.text).toContain('尚未收到后端的工具授权')
  })

  it('folds a throwing bridge call into an error text', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.notify.mockRejectedValue(new Error('socket hang up'))

    const value = await callTool(toolOf(harness, 'ai-mcp_send_notification'), {
      title: '标题',
      content: '正文',
    })
    expect(value.ok).toBe(false)
    expect(value.text).toContain('Kinship 桥调用失败：socket hang up')
  })
})

describe('ai-mcp_send_notification', () => {
  it('reports the sent title in markdown mode', async () => {
    const harness = createHarness()
    const tool = toolOf(harness, 'ai-mcp_send_notification')

    const value = await callTool(tool, { title: '系统提醒', content: '任务完成' })

    expect(value).toEqual({ ok: true, text: '通知已发送: 系统提醒', data: { status: 'ok' } })
    expect(contentText(tool, value)).toBe('通知已发送: 系统提醒')
    expect(harness.bridge?.notify).toHaveBeenCalledWith({ title: '系统提醒', content: '任务完成' })
  })

  it('returns the raw backend envelope in json mode', async () => {
    const harness = createHarness()
    const tool = toolOf(harness, 'ai-mcp_send_notification')
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.notify.mockResolvedValue({ ok: true, status: 200, data: { status: 'ok', message_id: 7 } })

    const value = await callTool(tool, { title: 't', content: 'c', response_format: 'json' })

    expect(value.ok).toBe(true)
    expect(JSON.parse(value.text)).toEqual({ status: 'ok', message_id: 7 })
  })

  it('reports a backend status that is not ok', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.notify.mockResolvedValue({ ok: true, status: 200, data: { status: 'error', message: '推送失败' } })

    const value = await callTool(toolOf(harness, 'ai-mcp_send_notification'), {
      title: 't',
      content: 'c',
    })
    expect(value).toEqual({ ok: false, text: '通知发送失败: 推送失败', data: { status: 'error', message: '推送失败' } })
  })

  it('mirrors the Loom error texts for the backend failures', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    const tool = toolOf(harness, 'ai-mcp_send_notification')

    bridge.notify.mockResolvedValue({ ok: false, status: 401, error: 'HTTP 401' })
    expect((await callTool(tool, { title: 't', content: 'c' })).text)
      .toBe('Error: Authentication failed. Token may be expired.')

    bridge.notify.mockResolvedValue({ ok: false, status: 403, error: 'HTTP 403' })
    expect((await callTool(tool, { title: 't', content: 'c' })).text)
      .toBe("Error: Permission denied. You don't have access to this resource.")

    bridge.notify.mockResolvedValue({ ok: false, status: 429, error: 'HTTP 429' })
    expect((await callTool(tool, { title: 't', content: 'c' })).text)
      .toBe('Error: Rate limit exceeded. Please wait before making more requests.')

    bridge.notify.mockResolvedValue({ ok: false, status: 502, error: 'HTTP 502' })
    expect((await callTool(tool, { title: 't', content: 'c' })).text)
      .toBe('Error: API request failed with status 502')

    bridge.notify.mockResolvedValue({ ok: false, status: null, error: 'connect ECONNREFUSED 127.0.0.1:8768' })
    expect((await callTool(tool, { title: 't', content: 'c' })).text)
      .toBe('Error: Cannot connect to backend. Make sure the Kinship backend is running.')

    bridge.notify.mockResolvedValue({ ok: false, status: null, error: 'request timed out after 30000ms' })
    expect((await callTool(tool, { title: 't', content: 'c' })).text)
      .toBe('Error: Request timed out. Please try again.')
  })

  it('refuses a blank title before calling the backend', async () => {
    const harness = createHarness()
    const value = await callTool(toolOf(harness, 'ai-mcp_send_notification'), {
      title: '   ',
      content: '正文',
    })
    expect(value).toEqual({ ok: false, text: '通知发送失败: title 不能为空' })
    expect(harness.bridge?.notify).not.toHaveBeenCalled()
  })
})

describe('ai-mcp_send_reminder', () => {
  it('trims the body and reports the board update time', async () => {
    const harness = createHarness()
    const tool = toolOf(harness, 'ai-mcp_send_reminder')
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.remind.mockResolvedValue({
      ok: true,
      status: 200,
      data: { text: '记得喝水', updated_at: 1_794_759_000 },
    })

    const value = await callTool(tool, { text: '  记得喝水  ' })

    expect(value.ok).toBe(true)
    expect(value.text).toMatch(/^提醒板已更新（\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}）$/)
    expect(bridge.remind).toHaveBeenCalledWith({ text: '记得喝水' })
  })

  it('reports a cleared board for an empty body', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.remind.mockResolvedValue({ ok: true, status: 200, data: { text: '', updated_at: 1 } })

    const value = await callTool(toolOf(harness, 'ai-mcp_send_reminder'), { text: '' })

    expect(value).toEqual({ ok: true, text: '提醒板已清空', data: { text: '', updated_at: 1 } })
    expect(bridge.remind).toHaveBeenCalledWith({ text: '' })
  })

  it('refuses a body over the character bound without calling the backend', async () => {
    const harness = createHarness({ maxReminderChars: 5 })
    const tool = toolOf(harness, 'ai-mcp_send_reminder')

    const tooLong = await callTool(tool, { text: ' 123456 ' })
    expect(tooLong.ok).toBe(false)
    expect(tooLong.text).toBe('提醒板写入失败: 全文 6 字符，超过上限 5 字符')

    const exact = await callTool(tool, { text: '12345' })
    expect(exact.text).not.toContain('超过上限')
    expect(harness.bridge?.remind).toHaveBeenCalledTimes(1)
  })

  it('reports a missing text field from the backend envelope', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.remind.mockResolvedValue({ ok: true, status: 200, data: { detail: 'text 太长' } })

    const value = await callTool(toolOf(harness, 'ai-mcp_send_reminder'), { text: 'x' })
    expect(value).toEqual({ ok: false, text: '提醒板写入失败: text 太长', data: { detail: 'text 太长' } })
  })

  it('returns the raw envelope in json mode', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.remind.mockResolvedValue({ ok: true, status: 200, data: { text: 'x', updated_at: 2 } })

    const value = await callTool(toolOf(harness, 'ai-mcp_send_reminder'), {
      text: 'x',
      response_format: 'json',
    })
    expect(JSON.parse(value.text)).toEqual({ text: 'x', updated_at: 2 })
  })
})

describe('ai-mcp_list_reminders', () => {
  it('reports an empty board', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.listReminders.mockResolvedValue({ ok: true, status: 200, data: { text: '', updated_at: 0 } })

    const value = await callTool(toolOf(harness, 'ai-mcp_list_reminders'), {})
    expect(value).toEqual({
      ok: true,
      text: '提醒板当前为空（updated_at=0）',
      data: { text: '', updated_at: 0 },
    })
  })

  it('wraps the board body in a fenced block', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.listReminders.mockResolvedValue({
      ok: true,
      status: 200,
      data: { text: '第一行\n第二行', updated_at: 1_794_759_000 },
    })

    const value = await callTool(toolOf(harness, 'ai-mcp_list_reminders'), {})

    expect(value.ok).toBe(true)
    expect(value.text).toContain('提醒板全文（updated_at=1794759000，')
    expect(value.text).toContain('```\n第一行\n第二行\n```')
  })

  it('returns the raw envelope in json mode', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.listReminders.mockResolvedValue({ ok: true, status: 200, data: { text: 'a', updated_at: 3 } })

    const value = await callTool(toolOf(harness, 'ai-mcp_list_reminders'), {
      response_format: 'json',
    })
    expect(JSON.parse(value.text)).toEqual({ text: 'a', updated_at: 3 })
  })
})

describe('tts_speak', () => {
  it('sends the default voice and quotes a preview', async () => {
    const harness = createHarness()
    const tool = toolOf(harness, 'tts_speak')

    const value = await callTool(tool, { text: '你好呀' })

    expect(value).toEqual({ ok: true, text: 'TTS语音已成功发送: "你好呀"', data: { status: 'ok' } })
    expect(harness.bridge?.tts).toHaveBeenCalledWith({ text: '你好呀', voice: 'mimo_default' })
  })

  it('truncates the preview to the Loom 50-character window', async () => {
    const harness = createHarness()
    const text = 'a'.repeat(60)
    const value = await callTool(toolOf(harness, 'tts_speak'), { text })
    expect(value.text).toBe(`TTS语音已成功发送: "${'a'.repeat(50)}..."`)
  })

  it('passes voice, style and user_id through when present', async () => {
    const harness = createHarness()
    await callTool(toolOf(harness, 'tts_speak'), {
      text: '你好',
      voice: 'v2',
      style: '开心',
      user_id: 'u1',
    })
    expect(harness.bridge?.tts).toHaveBeenCalledWith({
      text: '你好',
      voice: 'v2',
      style: '开心',
      user_id: 'u1',
    })
  })

  it('reports a backend rejection', async () => {
    const harness = createHarness()
    const bridge = harness.bridge
    if (bridge === null) throw new Error('fake bridge missing')
    bridge.tts.mockResolvedValue({ ok: true, status: 200, data: { status: 'error', message: '声纹未就绪' } })

    const value = await callTool(toolOf(harness, 'tts_speak'), { text: '你好' })
    expect(value).toEqual({ ok: false, text: 'TTS发送失败: 声纹未就绪', data: { status: 'error', message: '声纹未就绪' } })
  })

  it('refuses blank text before calling the backend', async () => {
    const harness = createHarness()
    const value = await callTool(toolOf(harness, 'tts_speak'), { text: '  ' })
    expect(value).toEqual({ ok: false, text: 'TTS发送失败: text 不能为空' })
    expect(harness.bridge?.tts).not.toHaveBeenCalled()
  })
})
