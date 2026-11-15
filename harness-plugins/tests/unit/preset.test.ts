import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const PRESET = join(ROOT, 'presets', 'kinship.patch.yml')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('kinship preset patch', () => {
  const source = readFileSync(PRESET, 'utf8')

  it('declares the Kinship preset at order 5 with a persona prefix only', () => {
    expect(source).toContain('id: preset-kinship')
    expect(source).toContain('id: kinship')
    expect(source).toContain('name: Kinship')
    expect(source).toContain('order: 5')
    expect(source).toContain('complete: false')
    expect(source).toContain("KINSHIP_AI_ROOT")
    expect(source).toContain("'agents'")
    expect(source).toContain("'main.md'")
  })

  it('mounts the requested tools and no memory/context-watch/QQ rows', () => {
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
      expect(source).toContain(`id: ${id}`)
    }
    expect(source).not.toContain('id: agent-instructions')
    expect(source).not.toContain('id: kinship-memory')
    expect(source).not.toContain('id: kinship-context-watch')
    expect(source).not.toContain('id: kinship-qq')
  })

  it('keeps Kinship sessions out of the AGENTS.md instruction chain', () => {
    // dsh-web-app disables the base `agent-instructions` row and lets each Web
    // preset mount it; a preset that omits it receives no user-global, agents-home
    // or project AGENTS.md text. Kinship's persona is the whole instruction set, so
    // production dsh-home/AGENTS.md must not leak into these Sessions.
    expect(source).not.toContain('id: agent-instructions')
    const bundlePatch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
    expect(bundlePatch).not.toContain('id: agent-instructions')
  })

  it('orders todo before the compatibility alias and plan before compat', () => {
    expect(source.indexOf('id: tool-todo')).toBeLessThan(source.indexOf('id: kinship-task-compat'))
    expect(source.indexOf('id: kinship-plan')).toBeLessThan(source.indexOf('id: kinship-task-compat'))
  })

  it('evaluates the persona expression against KINSHIP_AI_ROOT', () => {
    const line = source.split('\n').find(item => item.includes('prefix: !!js '))
    expect(line).toBeDefined()
    const marker = 'prefix: !!js '
    const expression = line === undefined ? '' : line.slice(line.indexOf(marker) + marker.length)
    expect(expression).not.toBe('')

    const root = mkdtempSync(join(tmpdir(), 'kinship-persona-'))
    roots.push(root)
    mkdirSync(join(root, 'agents'), { recursive: true })
    writeFileSync(join(root, 'agents', 'main.md'), '# persona\n\nPERSONA-MARKER\n', 'utf8')

    const previous = process.env['KINSHIP_AI_ROOT']
    process.env['KINSHIP_AI_ROOT'] = root
    try {
      const factory = new Function('process', `return (${expression})`)
      const evaluate = (runtime: NodeJS.Process): string => {
        const result: unknown = factory(runtime)
        if (typeof result !== 'string') throw new Error('persona expression did not return a string')
        return result
      }
      expect(evaluate(process)).toContain('PERSONA-MARKER')
      delete process.env['KINSHIP_AI_ROOT']
      expect(() => evaluate(process)).toThrow('KINSHIP_AI_ROOT')
    } finally {
      if (previous === undefined) delete process.env['KINSHIP_AI_ROOT']
      else process.env['KINSHIP_AI_ROOT'] = previous
    }
  })
})
