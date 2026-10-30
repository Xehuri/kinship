// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isAllowedDownload, sanitizeDownloadFilename } from '../../src/main/shell/downloads'

const ORIGIN = 'https://health.example:8768'

describe('sanitizeDownloadFilename', () => {
  it('keeps safe names intact', () => {
    expect(sanitizeDownloadFilename('health-report.pdf')).toBe('health-report.pdf')
    expect(sanitizeDownloadFilename('报告 2026.txt')).toBe('报告 2026.txt')
  })

  it('strips directory components', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeDownloadFilename('/tmp/report.csv')).toBe('report.csv')
  })

  it('replaces reserved characters', () => {
    expect(sanitizeDownloadFilename('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt')
    expect(sanitizeDownloadFilename('line\nbreak.txt')).toBe('line_break.txt')
  })

  it('falls back when the name is empty', () => {
    expect(sanitizeDownloadFilename('')).toBe('download.bin')
  })

  it('caps the filename length', () => {
    const sanitized = sanitizeDownloadFilename('a'.repeat(400))
    expect(sanitized).toHaveLength(180)
  })
})

describe('isAllowedDownload', () => {
  it('allows downloads from the configured origin', () => {
    expect(isAllowedDownload(`${ORIGIN}/api/download`, ORIGIN)).toBe(true)
    expect(isAllowedDownload(`${ORIGIN}/api/download`, `${ORIGIN}/`)).toBe(true)
  })

  it('rejects other origins and schemes', () => {
    expect(isAllowedDownload('https://cdn.example/file.zip', ORIGIN)).toBe(false)
    expect(isAllowedDownload('http://health.example:8768/file.zip', ORIGIN)).toBe(false)
    expect(isAllowedDownload('https://health.example:87680/file.zip', ORIGIN)).toBe(false)
    expect(isAllowedDownload('file:///tmp/file.zip', ORIGIN)).toBe(false)
    expect(isAllowedDownload('not a url', ORIGIN)).toBe(false)
  })

  it('rejects everything when no origin is configured', () => {
    expect(isAllowedDownload(`${ORIGIN}/api/download`, null)).toBe(false)
  })
})
