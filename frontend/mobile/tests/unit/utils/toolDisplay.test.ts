import { describe, expect, it } from 'vitest'
import { makeResult } from '../components/chat/chatFixtures'
import {
  formatDurationMs,
  formatToolArguments,
  INLINE_ARGS_LIMIT,
  inlineResultText,
  resultNeedsFocus,
  toolArgumentSummary,
} from '@/utils/toolDisplay'

describe('toolDisplay', () => {
  it('builds one-line argument summaries per tool intent', () => {
    expect(toolArgumentSummary('bash', { command: 'npm run\n test' })).toBe('npm run test')
    expect(toolArgumentSummary('read', { path: '/demo/health.json' })).toBe('/demo/health.json')
    expect(toolArgumentSummary('grep', { query: '静息心率' })).toBe('静息心率')
    expect(toolArgumentSummary('web_fetch', { url: 'https://example.com/demo' })).toBe(
      'https://example.com/demo',
    )
    expect(toolArgumentSummary('task', { title: '整理文件' })).toBe('整理文件')
  })

  it('summarizes camelCase file path arguments', () => {
    expect(
      toolArgumentSummary('read', { filePath: 'ai/data/daily/2026-10-24/health.json' }),
    ).toBe('ai/data/daily/2026-10-24/health.json')
    expect(toolArgumentSummary('edit', { filepath: 'src/app.ts' })).toBe('src/app.ts')
  })

  it('redacts secrets in the generic fallback', () => {
    const summary = toolArgumentSummary('unknown_tool', {
      token: 'super-secret-token',
      note: 'hello',
    })

    expect(summary).toContain('[redacted]')
    expect(summary).not.toContain('super-secret-token')
  })

  it('truncates inline result text and hides base64 image payloads', () => {
    const long = 'A'.repeat(1500)
    expect(inlineResultText(makeResult(long)).length).toBe(1200)
    expect(inlineResultText(makeResult('data:image/png;base64,AAAA'))).toBe(
      '图片数据已省略（不渲染 base64）',
    )
  })

  it('flags long or truncated results for the focus action', () => {
    expect(resultNeedsFocus(makeResult('short'))).toBe(false)
    expect(resultNeedsFocus(makeResult('A'.repeat(1200)))).toBe(true)
    expect(resultNeedsFocus(makeResult('short', { truncated: true }))).toBe(true)
  })

  it('formats durations with one decimal below a minute', () => {
    expect(formatDurationMs(12300)).toBe('12.3s')
    expect(formatDurationMs(42000)).toBe('42.0s')
    expect(formatDurationMs(500)).toBe('<1s')
    expect(formatDurationMs(90000)).toBe('1m 30s')
    expect(formatDurationMs(null)).toBe('')
  })

  it('stringifies unknown arguments safely', () => {
    expect(formatToolArguments(null)).toBe('无参数')
    expect(formatToolArguments({ a: 1 })).toBe('{"a":1}')
  })

  it('keeps full arguments up to the inline arguments limit', () => {
    const long = 'a'.repeat(INLINE_ARGS_LIMIT + 10)
    const formatted = formatToolArguments(long)

    expect(INLINE_ARGS_LIMIT).toBe(4000)
    expect(formatted).toHaveLength(INLINE_ARGS_LIMIT + 1)
    expect(formatted.endsWith('…')).toBe(true)
  })

  it('redacts secrets when formatting full arguments', () => {
    const formatted = formatToolArguments({ api_key: 'sk-live-secret', note: 'hello' })

    expect(formatted).toContain('[redacted]')
    expect(formatted).not.toContain('sk-live-secret')
  })
})
