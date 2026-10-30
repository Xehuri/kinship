/// <reference types="vitest/globals" />

import { beforeEach, describe, expect, it } from 'vitest'
import { resetWsLog, useWsLog } from '@/composables/useWsLog'

describe('useWsLog', () => {
  beforeEach(() => {
    resetWsLog()
    useWsLog().close()
  })

  it('records string payloads verbatim with a HH:MM:SS timestamp', () => {
    const { logs, handler } = useWsLog()

    handler('hello')

    expect(logs.value).toHaveLength(1)
    expect(logs.value[0].message).toBe('hello')
    expect(logs.value[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('records object payloads as JSON', () => {
    const { logs, handler } = useWsLog()

    handler({ type: 'file_changed', path: '/tmp/a' })

    expect(logs.value[0].message).toBe('{"type":"file_changed","path":"/tmp/a"}')
  })

  it('skips TTS audio chunks and audio frames', () => {
    const { logs, handler } = useWsLog()

    handler({ type: 'tts_audio_chunk', data: 'base64' })
    handler({ type: 'tts_audio', data: 'base64' })

    expect(logs.value).toHaveLength(0)
  })

  it('logs TTS start/end without the audio payload', () => {
    const { logs, handler } = useWsLog()

    handler({ type: 'tts_start', text: 'x'.repeat(80), data: 'base64' })

    expect(logs.value).toHaveLength(1)
    const parsed = JSON.parse(logs.value[0].message) as { type: string; text: string }
    expect(parsed.type).toBe('tts_start')
    expect(parsed.text).toBe('x'.repeat(50))
  })

  it('trims the log to the most recent 100 entries past 200', () => {
    const { logs, handler } = useWsLog()

    for (let index = 0; index < 201; index += 1) {
      handler(String(index))
    }

    expect(logs.value).toHaveLength(100)
    expect(logs.value[0].message).toBe('101')
    expect(logs.value[99].message).toBe('200')
  })

  it('toggles visibility and clears entries', () => {
    const { logs, visible, handler, open, close, toggle, clear } = useWsLog()
    handler('one')
    handler('two')

    expect(visible.value).toBe(false)
    open()
    expect(visible.value).toBe(true)
    toggle()
    expect(visible.value).toBe(false)
    open()
    close()
    expect(visible.value).toBe(false)

    clear()
    expect(logs.value).toHaveLength(0)
  })

  it('shares one singleton state between callers', () => {
    const first = useWsLog()
    const second = useWsLog()

    first.handler('shared')

    expect(second.logs.value).toHaveLength(1)
    second.open()
    expect(first.visible.value).toBe(true)
  })
})
