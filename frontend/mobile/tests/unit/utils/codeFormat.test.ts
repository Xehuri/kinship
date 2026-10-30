/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import {
  languageFromName,
  prettyJson,
  splitCodeLines,
} from '@/utils/codeFormat'

describe('prettyJson', () => {
  it('pretty-prints valid JSON with two spaces', () => {
    expect(prettyJson('{"b":2,"a":1}')).toBe('{\n  "b": 2,\n  "a": 1\n}')
  })

  it('pretty-prints array JSON', () => {
    expect(prettyJson('[1,2]')).toBe('[\n  1,\n  2\n]')
  })

  it('returns invalid JSON unchanged', () => {
    expect(prettyJson('{broken')).toBe('{broken')
  })

  it('returns plain text unchanged', () => {
    expect(prettyJson('plain text\nline two')).toBe('plain text\nline two')
  })

  it('returns an empty string unchanged', () => {
    expect(prettyJson('')).toBe('')
  })
})

describe('splitCodeLines', () => {
  it('splits LF lines', () => {
    expect(splitCodeLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('normalizes CRLF', () => {
    expect(splitCodeLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c'])
  })

  it('normalizes lone CR', () => {
    expect(splitCodeLines('a\rb')).toEqual(['a', 'b'])
  })

  it('preserves a trailing empty line', () => {
    expect(splitCodeLines('a\n')).toEqual(['a', ''])
  })

  it('returns no lines for an empty string', () => {
    expect(splitCodeLines('')).toEqual([])
  })

  it('preserves indentation', () => {
    expect(splitCodeLines('  a\n\tb')).toEqual(['  a', '\tb'])
  })
})

describe('languageFromName', () => {
  it('maps common extensions to language ids', () => {
    expect(languageFromName('app.py')).toBe('python')
    expect(languageFromName('main.ts')).toBe('typescript')
    expect(languageFromName('notes.txt')).toBe('text')
    expect(languageFromName('data.json')).toBe('json')
    expect(languageFromName('events.jsonl')).toBe('json')
  })

  it('is case-insensitive and accepts full paths', () => {
    expect(languageFromName('src/App.TSX')).toBe('tsx')
    expect(languageFromName('C:\\repo\\main.go')).toBe('go')
  })

  it('returns an empty language for unknown extensions', () => {
    expect(languageFromName('data.bin')).toBe('')
    expect(languageFromName('file-without-extension')).toBe('')
    expect(languageFromName('archive.tar.gz')).toBe('')
  })
})
