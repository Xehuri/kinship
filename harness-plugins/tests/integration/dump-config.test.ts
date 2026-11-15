import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  installTempProfile,
  runDsh,
  type RunResult,
  type TempProfile,
} from '../helpers/temp-profile.js'

function topLevelBlock(text: string, id: string): string {
  const marker = `- id: ${id}`
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const next = text.indexOf('\n- id:', start + marker.length)
  return text.slice(start, next < 0 ? undefined : next)
}

describe('kinship preset in a real dsh Web composition', () => {
  let profile: TempProfile
  let result: RunResult
  let dump: string

  beforeAll(async () => {
    profile = installTempProfile()
    result = await runDsh(['--profile', 'kinship-test', '--dump-config'], profile)
    dump = result.stdout
  })

  afterAll(() => {
    profile?.cleanup()
  })

  it('composes without a load error', () => {
    expect(result.code, result.stderr).toBe(0)
    expect(dump.length).toBeGreaterThan(0)
  })

  it('inserts the host-level bridge beside the preset', () => {
    const bridge = topLevelBlock(dump, 'kinship-bridge')
    expect(bridge).toContain('name: kinship-bridge')
    expect(bridge).toContain('host: !!js')
    expect(bridge).toContain('policy: !!js')
    expect(bridge).toContain('bodyLimitBytes: 65536')

    const preset = topLevelBlock(dump, 'preset-kinship')
    expect(preset).toContain("name: '@deepseek-ai/dsh-agent-preset'")
    expect(preset).toContain('id: kinship')
    expect(preset).toContain('name: Kinship')
    expect(preset).toContain('order: 5')
    expect(preset).toContain('complete: false')
  })

  it('inserts the browser panel row beside the bridge', () => {
    const ui = topLevelBlock(dump, 'kinship-ui')
    expect(ui).toContain('name: kinship-ui')
  })

  it('mounts the requested tools and omits memory/context-watch/QQ rows', () => {
    const preset = topLevelBlock(dump, 'preset-kinship')
    for (const id of [
      'tool-bash',
      'tool-pwsh',
      'tool-fs',
      'tool-fs-search',
      'tool-todo',
      'tool-ask-user',
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-control',
      'compaction-basic',
      'command-compact',
      'tool-result-pruner',
      'kinship-plan',
      'kinship-task-compat',
    ]) {
      expect(preset).toContain(`id: ${id}`)
    }
    expect(preset).not.toContain('agent-instructions')
    expect(preset).not.toContain('kinship-memory')
    expect(preset).not.toContain('kinship-context-watch')
    expect(preset).not.toContain('kinship-qq')
  })

  it('keeps the shipped presets and their order untouched', () => {
    expect(topLevelBlock(dump, 'preset-standard')).toContain('order: 1')
    expect(topLevelBlock(dump, 'preset-ptc')).toContain('order: 2')
    expect(topLevelBlock(dump, 'preset-minimal')).toContain('order: 3')
    expect(topLevelBlock(dump, 'preset-cordis')).toContain('order: 4')
  })
})
