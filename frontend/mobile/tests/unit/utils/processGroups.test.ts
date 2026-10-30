import { describe, expect, it } from 'vitest'
import { compaction, makeTool, makeTurn, thinking } from '../components/chat/chatFixtures'
import {
  buildProcessGroups,
  processDurationMs,
  processHeader,
  processState,
  summarizeActivities,
} from '@/utils/processGroups'

describe('buildProcessGroups', () => {
  it('groups consecutive thinking and tool steps without counts', () => {
    const turn = makeTurn({
      steps: [
        thinking(),
        makeTool('read'),
        makeTool('bash'),
        makeTool('grep'),
      ],
    })

    const groups = buildProcessGroups(turn)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('读取文件、运行命令、搜索')
    expect(groups[0]?.steps).toHaveLength(4)
    expect(groups[0]?.label).not.toMatch(/请求|个工具|\d/)
  })

  it('breaks a group at a compaction step', () => {
    const turn = makeTurn({
      steps: [
        thinking(),
        makeTool('read'),
        compaction(),
        makeTool('bash'),
      ],
    })

    const groups = buildProcessGroups(turn)

    expect(groups.map((group) => group.label)).toEqual([
      '读取文件',
      '运行命令',
    ])
  })

  it('returns no groups for a turn with no process steps', () => {
    expect(buildProcessGroups(makeTurn({ steps: [compaction()] }))).toEqual([])
  })

  it('summarizes thinking only as 思考 and empty as 处理', () => {
    expect(summarizeActivities([thinking()])).toBe('思考')
    expect(summarizeActivities([])).toBe('处理')
  })
})

describe('process state and header', () => {
  it('maps live, stopped, error, tool work and thinking to states', () => {
    expect(processState(makeTurn({ live: true, steps: [thinking()] }))).toBe('running')
    expect(
      processState(
        makeTurn({
          terminal: { reason: 'aborted', at: 2000 },
          steps: [thinking()],
        }),
      ),
    ).toBe('stopped')
    expect(
      processState(
        makeTurn({
          terminal: { reason: 'error', at: 2000 },
          steps: [thinking()],
        }),
      ),
    ).toBe('error')
    expect(processState(makeTurn({ steps: [makeTool('read')] }))).toBe('done-tools')
    expect(processState(makeTurn({ steps: [thinking()] }))).toBe('done-thinking')
    expect(processState(makeTurn())).toBe('done')
  })

  it('formats the four process headers with state and duration only', () => {
    expect(
      processHeader(makeTurn({ startedAt: 1000, terminal: { reason: 'done', at: 43000 }, steps: [thinking(), makeTool('read')] })),
    ).toEqual({ state: 'done-tools', label: '已完成 · 用时 42.0s' })
    expect(
      processHeader(makeTurn({ startedAt: 1000, terminal: { reason: 'done', at: 5000 }, steps: [thinking()] })),
    ).toEqual({ state: 'done-thinking', label: '已思考 · 4.0s' })
    expect(
      processHeader(makeTurn({ startedAt: 1000, terminal: { reason: 'aborted', at: 46000 }, steps: [thinking()] })),
    ).toEqual({ state: 'stopped', label: '已停止 · 用时 45.0s' })
    expect(
      processHeader(makeTurn({ startedAt: 1000, terminal: { reason: 'error', at: 28000 }, steps: [makeTool('read')] })),
    ).toEqual({ state: 'error', label: '执行失败 · 用时 27.0s' })
  })

  it('omits the duration when the turn has no terminal timestamp', () => {
    expect(processHeader(makeTurn({ startedAt: 1000, steps: [thinking()] }))).toEqual({
      state: 'done-thinking',
      label: '已思考',
    })
  })

  it('computes live elapsed time from startedAt and now', () => {
    const turn = makeTurn({ live: true, startedAt: 87700, steps: [thinking()] })
    expect(processDurationMs(turn, 100000)).toBe(12300)
    expect(processHeader(turn, 100000)).toEqual({
      state: 'running',
      label: '正在处理 · 12.3s',
    })
  })
})
