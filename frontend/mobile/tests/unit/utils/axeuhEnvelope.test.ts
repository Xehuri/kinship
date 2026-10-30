/// <reference types="vitest/globals" />

import { describe, it, expect } from 'vitest'
import { stripAxeuhHomeSystem } from '@/utils/axeuhEnvelope'

const OPEN = '<Axeuh-home-system>\n系统注入内容\n'
const CLOSE = '</Axeuh-home-system>'

describe('stripAxeuhHomeSystem', () => {
  it('没有信封时原样返回 (含首尾空白也不裁剪)', () => {
    expect(stripAxeuhHomeSystem('  普通消息  ')).toBe('  普通消息  ')
  })

  it('剥离信封, 返回闭合标签之后的用户文本 (去首尾空白)', () => {
    expect(stripAxeuhHomeSystem(`${OPEN}${CLOSE}\n  今晚吃什么  \n`)).toBe('今晚吃什么')
  })

  it('多个闭合标签时按最后一个截断 (与后端锚点语义一致)', () => {
    const text = `${OPEN}${CLOSE}第一段${OPEN}${CLOSE}最终文本`
    expect(stripAxeuhHomeSystem(text)).toBe('最终文本')
  })

  it('闭合标签只出现一次时保留其后的全部内容', () => {
    expect(stripAxeuhHomeSystem(`前缀${CLOSE}多行\n内容`)).toBe('多行\n内容')
  })

  it('闭合标签后为空时返回空串', () => {
    expect(stripAxeuhHomeSystem(`${OPEN}${CLOSE}   `)).toBe('')
  })

  it('只有开始标签没有闭合标签时原样返回', () => {
    const text = `${OPEN}未闭合`
    expect(stripAxeuhHomeSystem(text)).toBe(text)
  })

  it('空串原样返回', () => {
    expect(stripAxeuhHomeSystem('')).toBe('')
  })
})
