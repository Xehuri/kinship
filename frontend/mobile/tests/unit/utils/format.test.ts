/// <reference types="vitest/globals" />

import {
  formatTokenDisplay,
  formatSize,
  formatDate,
  formatTime,
  getFileIconClass,
} from '@/utils/format'

describe('formatTokenDisplay', () => {
  it('0 显示为 "0"', () => {
    expect(formatTokenDisplay(0)).toBe('0')
  })

  it('小于 10000 原样显示', () => {
    expect(formatTokenDisplay(9999)).toBe('9999')
  })

  it('恰好 10000 显示为 "1万"', () => {
    expect(formatTokenDisplay(10000)).toBe('1万')
  })

  it('15000 四舍五入显示为 "2万"', () => {
    expect(formatTokenDisplay(15000)).toBe('2万')
  })

  it('25500 显示为 "3万"', () => {
    expect(formatTokenDisplay(25500)).toBe('3万')
  })
})

describe('formatSize', () => {
  it('小于 1024 显示 B', () => {
    expect(formatSize(500)).toBe('500 B')
    expect(formatSize(0)).toBe('0 B')
  })

  it('KB 保留 1 位小数', () => {
    expect(formatSize(2048)).toBe('2.0 KB')
  })

  it('MB 保留 1 位小数', () => {
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('GB 保留 1 位小数', () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })
})

describe('formatDate', () => {
  it('本年日期显示为 "MM-DD"', () => {
    const now = new Date()
    const d = new Date(now.getFullYear(), 5, 23)
    expect(formatDate(d.toISOString())).toBe('06-23')
  })

  it('跨年日期显示为 "YYYY-MM-DD"', () => {
    const d = new Date(2020, 0, 5)
    expect(formatDate(d.toISOString())).toBe('2020-01-05')
  })

  it('无效日期原样返回', () => {
    expect(formatDate('invalid-date')).toBe('invalid-date')
  })
})

describe('formatTime', () => {
  it('返回 "HH:MM"', () => {
    const d = new Date(2026, 5, 23, 14, 30)
    expect(formatTime(d.toISOString())).toBe('14:30')
  })

  it('个位小时/分钟补零', () => {
    const d = new Date(2026, 5, 23, 9, 5)
    expect(formatTime(d.toISOString())).toBe('09:05')
  })

  it('无效日期原样返回', () => {
    expect(formatTime('invalid-date')).toBe('invalid-date')
  })
})

describe('getFileIconClass', () => {
  it('图片返回 fa-file-image', () => {
    expect(getFileIconClass('photo.PNG')).toBe('fa-file-image')
  })

  it('文本返回 fa-file-alt', () => {
    expect(getFileIconClass('readme.md')).toBe('fa-file-alt')
  })

  it('数据/代码返回 fa-file-code', () => {
    expect(getFileIconClass('data.json')).toBe('fa-file-code')
    expect(getFileIconClass('config.yaml')).toBe('fa-file-code')
    expect(getFileIconClass('main.ts')).toBe('fa-file-code')
  })

  it('音频返回 fa-file-audio', () => {
    expect(getFileIconClass('song.mp3')).toBe('fa-file-audio')
  })

  it('视频返回 fa-file-video', () => {
    expect(getFileIconClass('clip.mp4')).toBe('fa-file-video')
  })

  it('PDF 返回 fa-file-pdf', () => {
    expect(getFileIconClass('doc.pdf')).toBe('fa-file-pdf')
  })

  it('压缩包返回 fa-file-archive', () => {
    expect(getFileIconClass('pack.zip')).toBe('fa-file-archive')
  })

  it('Office 文档返回 fa-file-word', () => {
    expect(getFileIconClass('report.docx')).toBe('fa-file-word')
  })

  it('未知扩展名返回 fa-file', () => {
    expect(getFileIconClass('mystery.xyz')).toBe('fa-file')
  })
})
